/**
 * 请求级锁定（L3）的单元测试——v0.4 全局挂载形态。
 *
 * 这里**不** mount 真实 `agent-loop`（那需要模型适配器与网络），而是按已核实的
 * 契约手工调用监听器：
 *
 *   'agent/request'(payload: { agent, turn, step, signal }, next) => Promise<LlmCallConfig>
 *
 * 契约出处：`docs/contract-evidence.md` C2；`next()` 返回值被 `deepFreeze` 过，
 * 所以监听器**必须**扩散返回，不能原地改。
 *
 * ### 与 v0.3 的最大区别
 *
 * v0.3 的 `attachRequestLock({ agentCtx, agent, … })` 把 `childSessionId` **捕获在闭包**里，
 * 靠宿主的 agent 作用域隔离保证"只收到自己的请求"。v0.4 改成全局挂载（S2-a 实测：
 * 普通上下文上的监听器收到**全部** agent 的请求），因此身份必须**从 payload 现读**。
 *
 * 本文件因此加了一组"闭包失效"测试：同一个监听器必须能正确服务**多个不同的**子会话，
 * 而这件事在 v0.3 的 API 上根本表达不出来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StationError } from '../../lib/shared/policy.js';
import { mountRequestLock } from '../../lib/host/request-lock.js';

/** 一个记录型 ctx：`on()` 保存监听器，返回可调用的撤销函数。 */
function fakeRootCtx() {
  const handlers = [];
  return {
    handlers,
    on(event, handler) {
      assert.equal(event, 'agent/request', '必须挂在 agent/request 上');
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}

/** 一个内存台账替身。 */
function fakeLedger(children) {
  const deviations = [];
  const observedCalls = [];
  return {
    deviations,
    observedCalls,
    getChild: (id) => children.get(id),
    async recordDeviation(d) {
      deviations.push(d);
      return `${d.childSessionId}#${d.turn}`;
    },
    async markObserved(id) {
      observedCalls.push(id);
    },
  };
}

/** 模拟宿主的 `next()`：返回被冻结的上游配置。 */
function frozenNext(config) {
  const value = Object.freeze({ ...config });
  return async () => value;
}

/**
 * 造一个子会话 agent（depth 1，父 root-1）。
 *
 * `resolveLineage` 与 `classify` 用**显式替身**：这个文件的目的是测监听器本身，
 * 不是测谱系解析（那由 `dispatch.test.js` 覆盖）。
 */
function makeChild(id = 'child-1', { depth = 1, parent = 'root-1', managed = true } = {}) {
  return {
    id,
    session: { id, header: { parentSession: parent, delegationDepth: depth, origin: 'subagent' } },
    options: { subagentDepth: depth },
    __managed: managed,
  };
}

/** 「台账还没打开」这个状态本身要被测，所以必须能显式传入 undefined。 */
const NO_LEDGER = Symbol('no-ledger');

/**
 * 挂载锁定器，返回 `{ ctx, ledger, dispose, call }`。
 *
 * @param {object} [options]
 * @param {object|symbol} [options.ledger] 省略 = 一个空台账替身；`NO_LEDGER` = 台账尚未就绪
 */
function mount({ ledger = fakeLedger(new Map()), enabled = () => true } = {}) {
  const ctx = fakeRootCtx();
  const store = ledger === NO_LEDGER ? undefined : ledger;
  const dispose = mountRequestLock({
    ctx,
    readLedger: () => store,
    readPolicy: () => ({ managedSessionIds: ['root-1'] }),
    resolveLineage: (agent) => ({ rootSessionId: 'root-1', lineage: 'full', hops: 1 }),
    classify: (_policy, agent) => ({
      managed: agent?.__managed !== false,
      isChild: (agent?.options?.subagentDepth ?? 0) >= 1,
      rootSessionId: 'root-1',
    }),
    isEnabled: enabled,
  });
  const call = (agent, config, turn = 1, seed = undefined) => {
    const base = { agent, turn, step: 1, signal: new AbortController().signal };
    return ctx.handlers[0](seed === undefined ? base : { ...base, ...seed }, frozenNext(config));
  };
  return { ctx, ledger: store, dispose, call };
}

test('每轮请求都被压回台账路由，即使上游换了模型', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'approved-model',
  }]]));
  const { call } = mount({ ledger });
  const child = makeChild();

  const config = await call(child, { provider: 'vendorB', model: 'sneaky-model', temperature: 0.3, maxTokens: 900 });

  assert.equal(config.provider, 'vendorA', '供应商必须被压回台账值');
  assert.equal(config.model, 'approved-model', '模型必须被压回台账值');
  // 未关注的字段必须保留（方案 3.2 第 3 条）。
  assert.equal(config.temperature, 0.3, 'temperature 不得丢失');
  assert.equal(config.maxTokens, 900, 'maxTokens 不得丢失');
  assert.equal(ledger.deviations.length, 1, '偏离必须被记录');
  assert.equal(ledger.deviations[0].turn, 3 - 2);
  assert.equal(ledger.deviations[0].attemptedModel, 'sneaky-model');
  assert.equal(ledger.deviations[0].kind, 'error', '真正换模型必须记为 error');
});

test('上游本来就是批准路由时不记偏离', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const { call } = mount({ ledger });

  await call(makeChild(), { provider: 'vendorA', model: 'm' });
  assert.equal(ledger.deviations.length, 0, '没有偏离就不该留下噪声记录');
});

test('空路由不是冲突，是尚未初始化：记为 notice 而非 error', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const { call } = mount({ ledger });

  const config = await call(makeChild(), {});
  assert.equal(config.model, 'm');
  assert.equal(ledger.deviations.length, 1, '整轮仍算一次偏离（事实是上游没给路由）');
  assert.equal(ledger.deviations[0].kind, 'notice', 'v0.4 必须把"未初始化"与"被换掉"分开（§7）');
});

test('台账里没有这个受管子会话时抛错，而不是放行', async () => {
  const { call } = mount({ ledger: fakeLedger(new Map()) });

  await assert.rejects(
    () => call(makeChild('stranger'), { provider: 'vendorZ', model: 'anything' }),
    (error) => error instanceof StationError && error.code === 'STATION_UNMANAGED_CHILD',
    'v0.4 起了更准的码名：STATION_UNMANAGED_CHILD（v0.3 叫 UNKNOWN_CHILD）',
  );
});

test('台账读取抛错时也拒绝，不把「读不到」当成「没记录」', async () => {
  const ledger = {
    getChild() {
      throw new Error('storage is gone');
    },
    async recordDeviation() {},
  };
  const { call } = mount({ ledger });

  await assert.rejects(
    () => call(makeChild(), { provider: 'vendorA', model: 'm' }),
    (error) => error instanceof StationError && error.code === 'STATION_POLICY_UNREADABLE',
  );
});

test('台账尚未就绪时拒绝，而不是放行', async () => {
  const { call } = mount({ ledger: NO_LEDGER });
  await assert.rejects(
    () => call(makeChild(), { provider: 'vendorA', model: 'm' }),
    (error) => error instanceof StationError && error.code === 'STATION_LEDGER_UNAVAILABLE',
    'fail-closed：没有台账就无法确认路由，不知道就不放行（I8）',
  );
});

test('台账里有 reasoningEffort 时一并压回', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1',
    provider: 'vendorA', model: 'm', reasoningEffort: 'high',
  }]]));
  const { call } = mount({ ledger });

  const config = await call(makeChild(), { provider: 'vendorA', model: 'm', reasoningEffort: 'low' });
  assert.equal(config.reasoningEffort, 'high', '思考强度必须锁回台账值');
});

test('插件停用后不再干预请求（卸载路径）', async () => {
  let enabled = true;
  const { call } = mount({ ledger: fakeLedger(new Map()), enabled: () => enabled });

  enabled = false;
  const config = await call(makeChild(), { provider: 'whatever', model: 'pass-through' });
  assert.equal(config.model, 'pass-through', '停用后必须原样放行');
});

test('返回的对象是新对象，不改动被冻结的上游配置', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const { ctx, ledger: store } = mount({ ledger });
  const child = makeChild();

  let captured;
  const next = async () => {
    captured = Object.freeze({ provider: 'vendorB', model: 'other' });
    return captured;
  };
  const config = await ctx.handlers[0](
    { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
    next,
  );

  assert.notEqual(config, captured, '必须返回新对象');
  assert.equal(Object.isFrozen(config), false, '返回的对象不应被冻结，宿主还要继续改写');
  assert.equal(captured.model, 'other', '上游对象必须保持原样');
  assert.equal(store.deviations.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// v0.4 新增：全局挂载后必须成立的三件事
// ─────────────────────────────────────────────────────────────────────────────

test('V35 同一个监听器服务多个子会话：身份从 payload 现读，不靠闭包', async () => {
  const ledger = fakeLedger(new Map([
    ['child-1', { childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'pro-model' }],
    ['child-2', { childSessionId: 'child-2', receiptId: 'r2', rootSessionId: 'root-1', provider: 'vendorA', model: 'cheap-model' }],
  ]));
  // **只挂一次**——v0.3 里这条测试不可能存在，因为每个子会话各挂一个监听器。
  const { ctx, call } = mount({ ledger });
  assert.equal(ctx.handlers.length, 1, '全局挂载：一个监听器服务全部子会话');

  const a = await call(makeChild('child-1'), { provider: 'up', model: 'up' });
  const b = await call(makeChild('child-2'), { provider: 'up', model: 'up' });

  assert.equal(a.model, 'pro-model', 'child-1 必须用自己的台账值');
  assert.equal(b.model, 'cheap-model', 'child-2 必须用自己的台账值——串了就是"看起来受管、实际用错模型"');
});

test('V36 根会话的请求不被改写（用户选的模型不该被插件覆盖）', async () => {
  const ledger = fakeLedger(new Map([['root-1', {
    childSessionId: 'root-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'pro-model',
  }]]));
  const { call } = mount({ ledger });
  const root = { id: 'root-1', session: { id: 'root-1', header: { delegationDepth: 0 } }, options: {} };

  const config = await call(root, { provider: 'vendorUser', model: 'user-choice' });
  assert.equal(config.model, 'user-choice', '根会话的模型选择必须被尊重（L3 按设计不锁根）');
  assert.equal(ledger.deviations.length, 0, '根请求不该产生任何偏离记录');
});

test('V37 未受管谱系里的子会话完全不受影响（插件不越权接管）', async () => {
  const { call } = mount({ ledger: fakeLedger(new Map()) });
  const outsider = makeChild('free-child', { parent: 'free-root', managed: false });

  const config = await call(outsider, { provider: 'p', model: 'm' });
  assert.equal(config.model, 'm', '未受管会话不在治理范围内——全局挂载不许变成"全部接管"');
});

test('V38 首次压回把回执升到 observed，且**只写一次**（不把存储变热路径）', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const { call } = mount({ ledger });
  const child = makeChild();

  await call(child, { provider: 'v', model: 'x' }, 1);
  await call(child, { provider: 'v', model: 'x' }, 2);
  await call(child, { provider: 'v', model: 'x' }, 3);

  assert.deepEqual(ledger.observedCalls, ['child-1'], 'observed 的全部含义是"至少有一轮被正确压回"');
});

test('V39 谱系不可解析时拒绝（LINEAGE_UNKNOWN），不靠猜', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const ctx = fakeRootCtx();
  mountRequestLock({
    ctx,
    readLedger: () => ledger,
    readPolicy: () => ({ managedSessionIds: ['root-1'] }),
    // 模拟"有 parentSession 却一层都走不出去"（父会话已不可达）。
    resolveLineage: () => ({ rootSessionId: '', lineage: 'limited', hops: 0 }),
    classify: () => ({ managed: true, isChild: true, rootSessionId: 'root-1' }),
    isEnabled: () => true,
  });

  await assert.rejects(
    () => ctx.handlers[0](
      { agent: makeChild(), turn: 1, step: 1, signal: new AbortController().signal },
      frozenNext({ provider: 'v', model: 'm' }),
    ),
    (error) => error instanceof StationError && error.code === 'STATION_LINEAGE_UNKNOWN',
  );

  await ctx.handlers[0].length; // 证明监听器确实挂上了（避免"没挂 = 没拒绝"的假绿）
  assert.equal(ctx.handlers.length, 1);
});

test('V40 台账根与现算谱系不一致时拒绝（LINEAGE_MISMATCH），不猜哪个对', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    // 台账说它属于 root-1
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const ctx = fakeRootCtx();
  mountRequestLock({
    ctx,
    readLedger: () => ledger,
    readPolicy: () => ({ managedSessionIds: ['root-1', 'root-2'] }),
    // 但现在的谱系指向 root-2。
    resolveLineage: () => ({ rootSessionId: 'root-2', lineage: 'full', hops: 1 }),
    classify: () => ({ managed: true, isChild: true, rootSessionId: 'root-2' }),
    isEnabled: () => true,
  });

  await assert.rejects(
    () => ctx.handlers[0](
      { agent: makeChild(), turn: 1, step: 1, signal: new AbortController().signal },
      frozenNext({ provider: 'v', model: 'm' }),
    ),
    (error) => error instanceof StationError && error.code === 'STATION_LINEAGE_MISMATCH',
    '脉系被改写过时不许按任一方继续跑',
  );
});

test('撤销函数清空 observed 记忆（热重载后不会跳过 markObserved）', async () => {
  const ledger = fakeLedger(new Map([['child-1', {
    childSessionId: 'child-1', receiptId: 'r1', rootSessionId: 'root-1', provider: 'vendorA', model: 'm',
  }]]));
  const { call, dispose, ctx } = mount({ ledger });
  await call(makeChild(), { provider: 'v', model: 'x' });
  assert.deepEqual(ledger.observedCalls, ['child-1']);

  dispose();
  assert.equal(ctx.handlers.length, 0, '撤销后监听器必须消失（I7：不留永久劫持）');
});
