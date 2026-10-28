/**
 * 端到端串联：`dispatch_agent` → 台账登记 → `agent/created` → `agent/request` 被锁定。
 *
 * 这是 G4 真正的承诺所在：前面 `request-lock.test.js` 单独验证了监听器的行为，
 * `acceptance.test.js` 验证了台账登记，但**没有一条测试**把两者串起来证明
 * 「派出后那个子会话的请求真的会被压回批准路由」。这条补上。
 *
 * 会话作用域说明：运行时把 agent 作用域挂在 `agent.ctx` 上（`docs/contract-evidence.md` C2），
 * 所以这里在子会话自己的 ctx 上 emit `agent/request`，与宿主内部 `waterfall` 的派发路径一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callDispatch, makeAgent, startStation } from '../host-fixture.js';

/** 触发 `agent/created` 并等监听器跑完（serial 模式）。 */
async function announceAgent(host, agent) {
  await host.ctx.parallel('agent/created', { agent });
}

/**
 * 在指定作用域发起一轮 `agent/request`，返回最终配置。
 *
 * @param {object} scopeCtx 该 agent 的 ctx
 * @param {object} agent
 * @param {object} upstreamConfig 上游（机器默认）配置
 */
async function requestConfig(scopeCtx, agent, upstreamConfig, turn = 1) {
  const frozen = Object.freeze({ ...upstreamConfig });
  return scopeCtx.waterfall(
    'agent/request',
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => frozen,
  );
}

test('派出后的子会话：每轮请求被压回台账路由，并留下偏离记录', async () => {
  const host = await startStation();
  try {
    // 1) 受管根会话按岗位派出。
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });
    host.subagents.behaviour = () => ({ childId: 'child-1' });

    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });
    assert.equal(host.subagents.calls.length, 1);

    // 2) 宿主创建子会话并广播。子会话深度 1、父会话是受管根。
    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await announceAgent(host, child);

    // 3) 子会话发起一轮请求，上游给的是别的模型（模拟「想换模型」）。
    const config = await requestConfig(childCtx, child, { provider: 'vendorX', model: 'sneaky', temperature: 0.2 });

    assert.equal(config.provider, 'vendorA', '供应商必须被压回台账值');
    assert.equal(config.model, 'pro-model', '模型必须被压回台账值');
    assert.equal(config.temperature, 0.2, '未关注字段必须保留');

    // 4) 偏离必须被记录，供事后核对。
    const opened = host.storage.opened.find((o) => o.spec.name === 'station_dispatch_ledger');
    const deviations = [...opened.stores.get('deviations').values()];
    assert.equal(deviations.length, 1, '偏离必须留痕');
    assert.equal(deviations[0].attemptedModel, 'sneaky');
    assert.equal(deviations[0].forcedModel, 'pro-model');
    assert.equal(deviations[0].turn, 1);
  } finally {
    await host.stop();
  }
});

test('未在台账里的子会话：请求被拒绝，不静默放行', async () => {
  const host = await startStation();
  try {
    // 直接广播一个插件没派出的子会话（模拟第三方插件或历史遗留）。
    const orphanCtx = host.ctx.extend({});
    const orphan = makeAgent({ id: 'orphan-1', rootSessionId: 'root-1', depth: 1, agentCtx: orphanCtx });
    await announceAgent(host, orphan);

    await assert.rejects(
      () => requestConfig(orphanCtx, orphan, { provider: 'any', model: 'anything' }),
      // v0.4 归位（方案 §6.1）：这个码的唯一定义是「受管谱系内、台账里没登记」。
      // v0.3 用 STATION_UNKNOWN_CHILD，那个名字说不清"受管但没登记"与"根本不归我管"的区别。
      (error) => error.code === 'STATION_UNMANAGED_CHILD',
      '不在台账里的受管子会话必须被拒绝，而不是放任使用任意模型',
    );
  } finally {
    await host.stop();
  }
});

test('受管根会话自己的请求不被改写（用户选的模型不该被插件覆盖）', async () => {
  const host = await startStation();
  try {
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });
    await announceAgent(host, root);

    const config = await requestConfig(rootCtx, root, { provider: 'vendorUser', model: 'user-choice' });
    assert.equal(config.provider, 'vendorUser', '根会话的模型选择必须被尊重');
    assert.equal(config.model, 'user-choice');
  } finally {
    await host.stop();
  }
});

test('未受管会话的请求完全不受影响', async () => {
  const host = await startStation();
  try {
    const ctx = host.ctx.extend({});
    const outsider = makeAgent({ id: 'free-1', rootSessionId: 'free-1', depth: 1, agentCtx: ctx });
    await announceAgent(host, outsider);

    // 即使是子会话，只要不在受管范围内就不干预。
    const config = await requestConfig(ctx, outsider, { provider: 'p', model: 'm' });
    assert.equal(config.model, 'm');
  } finally {
    await host.stop();
  }
});

test('多轮请求每轮都锁：第 2 轮上游再换模型仍被压回', async () => {
  const host = await startStation();
  try {
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });
    host.subagents.behaviour = () => ({ childId: 'child-2' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-2', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await announceAgent(host, child);

    const first = await requestConfig(childCtx, child, { provider: 'vendorX', model: 'sneaky-1' }, 1);
    assert.equal(first.model, 'pro-model');

    // 第二轮：即使上游「学会了」用另一个模型，仍必须被压回。
    const second = await requestConfig(childCtx, child, { provider: 'vendorY', model: 'sneaky-2' }, 2);
    assert.equal(second.model, 'pro-model', '第 2 轮仍必须锁定');

    const opened = host.storage.opened.find((o) => o.spec.name === 'station_dispatch_ledger');
    assert.equal(opened.stores.get('deviations').size, 2, '两轮各留一条偏离');
  } finally {
    await host.stop();
  }
});

test('插件卸载后不再锁定（不留永久劫持）', async () => {
  const host = await startStation();
  try {
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });
    host.subagents.behaviour = () => ({ childId: 'child-3' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-3', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await announceAgent(host, child);
    assert.equal((await requestConfig(childCtx, child, { provider: 'v', model: 'm' })).model, 'pro-model');

    await host.fiber.dispose();

    const after = await requestConfig(childCtx, child, { provider: 'v', model: 'free-again' });
    assert.equal(after.model, 'free-again', '插件停用后必须停止干预，否则会留下无法解除的劫持');
  } finally {
    await host.stop();
  }
});

test('两个不同岗位的子会话各自被自己的台账值锁定（不串路由）', async () => {
  const host = await startStation();
  try {
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });

    // 两次派出，两个岗位 → 两条不同路由。
    let counter = 0;
    host.subagents.behaviour = () => ({ childId: `child-${++counter}` });
    await callDispatch(host, { roleId: 'reviewer', description: 'a', prompt: 'p' }, { agent: root });
    await callDispatch(host, { roleId: 'scout', description: 'b', prompt: 'p', routeId: 'cheap' }, { agent: root });

    const strongCtx = host.ctx.extend({});
    const strongChild = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: strongCtx });
    const cheapCtx = host.ctx.extend({});
    const cheapChild = makeAgent({ id: 'child-2', rootSessionId: 'root-1', depth: 1, agentCtx: cheapCtx });
    await announceAgent(host, strongChild);
    await announceAgent(host, cheapChild);

    // 这条测试守的是一个真实的坑：监听器把 childSessionId 捕获在闭包里。
    // 如果只依赖宿主的作用域隔离，一旦事件被广播得更宽（或作用域挂错），
    // 就会把孩子 A 压到孩子 B 的路由上——「看起来受管、实际用错模型」。
    // 因此监听器自己比对 `payload.agent.session.id`，这里同时验证两条派发路径。
    const strongConfig = await requestConfig(strongCtx, strongChild, { provider: 'up', model: 'up' });
    const cheapConfig = await requestConfig(cheapCtx, cheapChild, { provider: 'up', model: 'up' });

    assert.equal(strongConfig.model, 'pro-model', 'reviewer 应被锁到自己的路由');
    assert.equal(cheapConfig.model, 'cheap-model', 'scout 应被锁到自己的路由，不能被串成 pro-model');
  } finally {
    await host.stop();
  }
});

test('监听器忽略不属于自己的请求（即使事件被广播到更宽的作用域）', async () => {
  const host = await startStation();
  try {
    const rootCtx = host.ctx.extend({});
    const root = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: rootCtx });

    let counter = 0;
    host.subagents.behaviour = () => ({ childId: `child-${++counter}` });
    await callDispatch(host, { roleId: 'reviewer', description: 'a', prompt: 'p' }, { agent: root });
    await callDispatch(host, { roleId: 'scout', description: 'b', prompt: 'p', routeId: 'cheap' }, { agent: root });

    const strongCtx = host.ctx.extend({});
    const strongChild = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: strongCtx });
    const cheapCtx = host.ctx.extend({});
    const cheapChild = makeAgent({ id: 'child-2', rootSessionId: 'root-1', depth: 1, agentCtx: cheapCtx });
    await announceAgent(host, strongChild);
    await announceAgent(host, cheapChild);

    // 在根作用域上替 child-2 发请求：两个孩子的监听器都可能收到。
    // child-1 的监听器必须识别出「这不是我的请求」并让开。
    const config = await requestConfig(rootCtx, cheapChild, { provider: 'up', model: 'up' });
    assert.equal(config.model, 'cheap-model', 'child-1 的监听器不得把 child-2 压成 pro-model');
  } finally {
    await host.stop();
  }
});
