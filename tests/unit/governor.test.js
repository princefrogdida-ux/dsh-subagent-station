/**
 * 入口治理（L2 / 方案 5.1–5.3）的集成测试。
 *
 * 与前一个文件的区别：这里真的走 `agent/created` → `governor.attachTo()`
 * → `tools.guard()` 这条链路，然后调 `prepareScheduledExecution` 观察**拒绝是否真的发生**。
 *
 * 为什么要用 `prepareScheduledExecution`：guard 在 `prepareExecution` 里被调用
 * （`.host-src/dsh-tools.js:3337` 的 `this.guardReason(exec)`），而不是在裸 `execute()`。
 * 走裸 `execute` 会得到「guard 从未被调用」的假绿——这一点在阶段 1 已经实测确认过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeAgent, startStation } from '../host-fixture.js';

/** 注册一个假的派生工具，模拟原生入口 `subagent`。 */
function registerFakeTool(host, name) {
  host.tools.register({
    name,
    description: `假的 ${name}，用于验证入口治理`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      return 'should not run';
    },
  });
}

/**
 * 用真实 guard 链路判断一次调用是否被拒绝。
 *
 * @returns {Promise<{denied: boolean, reason: string|undefined}>}
 */
async function attemptCall(host, name, agent) {
  const controller = new AbortController();
  const prepared = await host.tools.prepareScheduledExecution({
    name,
    arguments: {},
    callId: `call-${Math.random()}`,
    rootCallId: `root-${Math.random()}`,
    signal: controller.signal,
    ...(agent === undefined ? {} : { agent }),
  });
  if (prepared.kind === 'post-result') {
    const text = prepared.result?.content?.map((b) => b.text).join('\n') ?? '';
    return { denied: true, reason: text };
  }
  return { denied: false, reason: undefined };
}

/**
 * 触发 `agent/created` 并等监听器跑完。
 *
 * `agent/created` 是 serial 模式（`docs/contract-evidence.md` C2），
 * 所以这里必须 await，否则 guard 可能还没挂上就开始调用。
 */
async function announceAgent(host, agent) {
  await host.ctx.parallel('agent/created', { agent });
}

test('受管根会话：原生派生入口被 guard 拒绝，本插件入口放行', async () => {
  const host = await startStation();
  try {
    for (const name of ['subagent', 'subagent_fork', 'workflow']) registerFakeTool(host, name);

    const agent = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, agent);

    for (const name of ['subagent', 'subagent_fork', 'workflow']) {
      const outcome = await attemptCall(host, name, agent);
      assert.equal(outcome.denied, true, `受管根会话必须拦 ${name}`);
      assert.match(outcome.reason, /dispatch_agent/, '拒绝文案必须给出替代路径');
    }

    // 本插件的受控路径不该被自己的 guard 拦。
    const own = await attemptCall(host, 'dispatch_agent', agent);
    assert.equal(own.denied, false, 'dispatch_agent 是受控路径，不得被自己的 guard 拦');
  } finally {
    await host.stop();
  }
});

test('受管子会话：连 dispatch_agent 一起拦（孙级禁令）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');

    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, child);

    // 孙级：本插件入口也必须拦。
    const nested = await attemptCall(host, 'dispatch_agent', child);
    assert.equal(nested.denied, true, '子会话不得再派孙级');
    assert.match(nested.reason, /带回主会话/, '要给用户可执行的下一步');

    // 原生入口同样拦。
    const native = await attemptCall(host, 'subagent', child);
    assert.equal(native.denied, true);
  } finally {
    await host.stop();
  }
});

test('未受管会话不被 guard 干预', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    // 一个既不是 root-1 也不是它孩子的会话。
    const outsider = makeAgent({ id: 'free-1', rootSessionId: 'free-1', depth: 0, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, outsider);

    const outcome = await attemptCall(host, 'subagent', outsider);
    assert.equal(outcome.denied, false, '未受管会话不在治理范围内');
  } finally {
    await host.stop();
  }
});

test('停止类与只读类工具永不被拦（不牺牲用户能力）', async () => {
  const host = await startStation();
  try {
    // `dispatch_roles` 由插件自己注册，不重复注册。
    registerFakeTool(host, 'interrupt_agent');

    // 子会话是最严格的位置：连这里也不该拦停止与只读。
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, child);

    assert.equal((await attemptCall(host, 'interrupt_agent', child)).denied, false, '停止能力不得被拦');
    assert.equal((await attemptCall(host, 'dispatch_roles', child)).denied, false, '只读发现不得被拦');
  } finally {
    await host.stop();
  }
});

test('关掉 blockNativeDelegation 后，受管根的原生入口不再被拦', async () => {
  const host = await startStation({ blockNativeDelegation: false });
  try {
    registerFakeTool(host, 'subagent');
    const agent = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, agent);

    assert.equal((await attemptCall(host, 'subagent', agent)).denied, false);
  } finally {
    await host.stop();
  }
});

test('blockedToolNames 里的私有入口在受管会话被拦', async () => {
  const host = await startStation({ blockedToolNames: ['in_house_delegate'] });
  try {
    registerFakeTool(host, 'in_house_delegate');
    const agent = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, agent);

    const outcome = await attemptCall(host, 'in_house_delegate', agent);
    assert.equal(outcome.denied, true, '用户登记的私有入口必须被拦');
  } finally {
    await host.stop();
  }
});

test('卸载后 guard 撤销，原生入口恢复可用', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const agent = makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: host.ctx.extend({}) });
    await announceAgent(host, agent);
    assert.equal((await attemptCall(host, 'subagent', agent)).denied, true);

    // 卸载插件：guard 必须随之撤销，否则会留下永久拒绝。
    await host.fiber.dispose();

    assert.equal(
      (await attemptCall(host, 'subagent', agent)).denied,
      false,
      '卸载后仍拒绝说明 guard 泄漏了',
    );
  } finally {
    await host.stop();
  }
});
