/**
 * v0.4 验收锚点与**时序矩阵**（方案 §2.2 / 改进方案 §11.1）。
 *
 * ### 为什么这份文件存在
 *
 * `TEST-RESULT-v0.3.md` §六指出：单元测试"结构上覆盖不到"问题 1，因为
 *
 * > 单元测试的夹具在 `apply()` 之前就把 `managedSessionIds` 配好了，
 * > 所以 `sweep()` 第一次跑就能挂上 guard。
 *
 * 这和 v0.2 的 P1-A（`startActivation` 替身只记 `provider`/`delivery`，于是主链路
 * 断了 97 项测试还全绿）是**同一类错误**：
 *
 * > **替身比真机"更理想"——它替真的那个东西，恰好是唯一能通过的时序。**
 *
 * 所以这里不是"多加断言"，而是把**时序**本身作为被测对象：
 *
 * | 轴 | 取值 | 含义 |
 * | --- | --- | --- |
 * | A（配置） | A1 早于加载 / A2 加载后写入 / A3 加载时为空、后来写入 | 用户什么时候写 `managedSessionIds` |
 * | B（会话） | B1 早于加载 / B2 加载后创建 | 会话什么时候存在 |
 *
 * 六格里只有 A3×B1（配置最后到、会话早就在）能复现问题 1——也正因如此，
 * v0.3 的夹具一格都覆盖不到。v0.4 的 T59 必须在这一格里通过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callDispatch, callStatus, makeAgent, registerFakeTool, startStation } from '../host-fixture.js';

/** 用真实 guard 链路判断一次调用是否被拒绝。 */
async function attempt(host, name, agent, args = {}) {
  const prepared = await host.tools.prepareScheduledExecution({
    name,
    arguments: args,
    callId: `c-${Math.random()}`,
    rootCallId: `r-${Math.random()}`,
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  });
  if (prepared.kind === 'post-result') {
    return { denied: true, reason: prepared.result?.content?.map((b) => b.text).join('\n') ?? '' };
  }
  return { denied: false, reason: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// T59：验收锚点（A3 × B1 —— 问题 1 的现场）
// ─────────────────────────────────────────────────────────────────────────────

test('V1 锚点 A3×B1：插件以空配置加载 + 会话早已存在 + 之后才写入受管名单 → 立刻受管', async () => {
  // `managedSessionIds: []` = 插件加载时用户还没写任何东西（这是真实首装形态）。
  const host = await startStation(
    { managedSessionIds: [] },
    { existingAgents: [{ id: 'root-1', rootSessionId: 'root-1', depth: 0 }] },
  );
  try {
    registerFakeTool(host, 'subagent');
    const root = host.existing[0];

    // ── 前置：此刻确实**不受管**（否则后面的断言就没意义了）─────────────
    const before = await attempt(host, 'subagent', root);
    assert.equal(before.denied, false, '前提：配置为空时不该拦——插件不能擅自接管既有会话');
    const statusBefore = await callStatus(host, {}, { agent: root });
    assert.match(statusBefore, /未受管/, '前提：状态必须如实说"未受管"');

    // ── 真实用户动作：通过设置界面写入受管名单（volatile 热更新）─────────
    //
    // 这一步**不触发**任何 `agent/created`、不重载插件、不重启宿主。
    // v0.3 在这里会失败：guard 是挂载时判定的，配置晚到就永远不生效。
    host.setConfig('managedSessionIds', ['root-1']);

    // ── 断言：下一个调用立刻被拦（零窗口，G1）────────────────────────────
    const after = await attempt(host, 'subagent', root);
    assert.equal(
      after.denied,
      true,
      '配置写入后的**下一个**调用就必须被拦——这就是"零窗口"。'
      + '若这里放行，说明判定被缓存在了挂载时刻（问题 1 复发）。',
    );
    assert.match(after.reason, /dispatch_agent/, '拒绝必须给出替代路径');

    // ── 状态也必须立刻改口（否则"诊断在撒谎"，问题 6）───────────────────
    const statusAfter = await callStatus(host, {}, { agent: root });
    assert.match(statusAfter, /受管/, '状态必须随配置立刻改口');
    assert.doesNotMatch(
      statusAfter.split('\n')[0],
      /未受管/,
      '第一行不能再自称"未受管"——那正是 v0.3 撒谎的地方',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 时序矩阵（改进方案 §11.1）：A × B 六格
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 跑一格时序，返回"配置写入后第一次调用是否被拦"。
 *
 * **关键设计**：配置写入**之前**必须先真的调用一次工具。
 *
 * 为什么：如果只在配置写入后才第一次调用，那么"挂载时点判定"的实现也能通过
 * （它第一次调用时读到的就是新配置）。红-2（把现算换成挂载时快照）证明了这一点——
 * 早期的 T59b 六格全绿，而 T59 红了。差别只在于 T59 先调了一次。
 *
 * 所以矩阵必须模拟真实用户动作序列：**用 → 改配置 → 再用**。
 *
 * @param {object} cell
 * @param {'early'|'late'|'empty-then-write'} cell.configWhen
 * @param {'before-load'|'after-load'} cell.sessionWhen
 * @returns {Promise<{denied: boolean, deniedAfter: boolean, deniedBefore: boolean}>}
 */
async function runCell({ configWhen, sessionWhen }) {
  // A1：配置早于加载 ⇒ 直接在 `startStation` 前配好。
  const earlyConfig = configWhen === 'early' ? ['root-1'] : [];

  const host = await startStation(
    { managedSessionIds: earlyConfig },
    sessionWhen === 'before-load'
      // B1：会话早于加载 ⇒ 用 existingAgents（`apply()` 之前就登记进 agents 服务）。
      ? { existingAgents: [{ id: 'root-1', rootSessionId: 'root-1', depth: 0 }] }
      : {},
  );
  try {
    registerFakeTool(host, 'subagent');

    // B2：会话晚于加载 ⇒ 加载后才创建（并广播 `agent/created`）。
    let agent;
    if (sessionWhen === 'before-load') {
      agent = host.existing[0];
    } else {
      agent = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
      await host.announce(agent, 'startup');
    }

    // ── 先调用一次（配置写入**之前**）──────────────────────────────────────
    //
    // 这一步是矩阵的灵魂：它让"首次判定被缓存"的实现把**错误的**结论记下来。
    const before = await attempt(host, 'subagent', agent);

    // A2/A3：加载后（或首次为空之后）写入配置。
    if (configWhen !== 'early') {
      host.setConfig('managedSessionIds', ['root-1']);
    }

    const after = await attempt(host, 'subagent', agent);
    return { denied: after.denied, deniedBefore: before.denied, deniedAfter: after.denied };
  } finally {
    await host.stop();
  }
}

test('V2 时序矩阵 A×B 全六格：用→改配置→再用，第二用必须被拦', async () => {
  const cells = [];
  for (const configWhen of ['early', 'late', 'empty-then-write']) {
    for (const sessionWhen of ['before-load', 'after-load']) {
      cells.push({ configWhen, sessionWhen });
    }
  }

  const results = [];
  for (const cell of cells) {
    const outcome = await runCell(cell);
    results.push({
      configWhen: cell.configWhen,
      sessionWhen: cell.sessionWhen,
      deniedBefore: outcome.deniedBefore,
      deniedAfter: outcome.deniedAfter,
    });
    assert.equal(
      outcome.denied,
      true,
      `时序格 A=${cell.configWhen} B=${cell.sessionWhen} 必须被拦。`
      + '六格里任何一格放行，都说明有一个时点让治理漏掉了。'
      + `\n全部结果：${JSON.stringify(results, null, 2)}`,
    );
  }

  assert.equal(results.length, 6, '必须是完整的 3×2 矩阵，不是抽样');

  // 配置早于一切的两格：修改前后都该拦（第一用就已经受管）。
  const early = results.filter((r) => r.configWhen === 'early');
  assert.equal(early.length, 2);
  for (const cell of early) {
    assert.equal(cell.deniedBefore, true, `A=early B=${cell.sessionWhen}：配置本来就到了，第一用就该拦`);
  }

  // 配置晚到的四格：第一用（配置为空时）必须放行 —— 否则插件在擅自接管既有会话。
  const late = results.filter((r) => r.configWhen !== 'early');
  assert.equal(late.length, 4);
  for (const cell of late) {
    assert.equal(
      cell.deniedBefore,
      false,
      `A=${cell.configWhen} B=${cell.sessionWhen}：配置还没写入时不得拦。`
      + '这一条同时把"永久拒绝"这种假绿挡在门外。',
    );
  }
});

test('V3 时序矩阵的反面：配置**从未**写入时六格都必须放行（插件不擅自接管）', async () => {
  // 这一条守的是对称性：如果"配置最终写入 ⇒ 拦"成立，而"配置从未写入 ⇒ 不拦"
  // 不成立，那就不是"零窗口"，而是"普遍越权"——同样不可接受。
  for (const sessionWhen of ['before-load', 'after-load']) {
    const host = await startStation(
      { managedSessionIds: [] },
      sessionWhen === 'before-load'
        ? { existingAgents: [{ id: 'root-1', rootSessionId: 'root-1', depth: 0 }] }
        : {},
    );
    try {
      registerFakeTool(host, 'subagent');
      const agent = sessionWhen === 'before-load'
        ? host.existing[0]
        : host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
      if (sessionWhen === 'after-load') await host.announce(agent, 'startup');

      const outcome = await attempt(host, 'subagent', agent);
      assert.equal(
        outcome.denied,
        false,
        `B=${sessionWhen}：配置从未写入时不得接管。受管模式的字面含义就是"只对名单里的生效"。`,
      );
    } finally {
      await host.stop();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T62：撤销受管（配置收紧的另一方向）
// ─────────────────────────────────────────────────────────────────────────────

test('V4 从受管名单里移除后，下一个调用立刻放行（不缓存"曾经受管"）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    assert.equal((await attempt(host, 'subagent', root)).denied, true, '前提：现在是受管的');

    host.setConfig('managedSessionIds', []);
    assert.equal(
      (await attempt(host, 'subagent', root)).denied,
      false,
      '撤销受管后必须立刻放行。v0.3 的 guard 一旦挂上就再也摘不掉，'
      + '这是"挂载时点"模型的另一个方向（I2 要求判定不缓存）。',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T69：启动扫描的职责收窄（v0.4 只剩 L4）
// ─────────────────────────────────────────────────────────────────────────────

test('V5 卸载后 guard 与锁定都撤销，且台账保留（I7 双向）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    assert.equal((await attempt(host, 'subagent', root)).denied, true);

    // 派一次，让台账里有东西。
    host.subagents.behaviour = () => ({ childId: 'child-9' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });
    assert.ok(host.children().length >= 1, '前提：台账里已有孩子');

    const childrenBefore = host.children().length;
    await host.fiber.dispose();

    // 卸载后：原生入口恢复（guard 撤销）。
    assert.equal(
      (await attempt(host, 'subagent', root)).denied,
      false,
      '卸载后仍拒绝说明 guard 泄漏了',
    );

    // 卸载后：子会话请求不再被压回（锁定撤销）。
    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-9', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    const config = await childCtx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'free', model: 'free-model' }),
    );
    assert.equal(config.model, 'free-model', '卸载后仍改写请求说明锁定泄漏了');

    // 台账数据保留（卸载不销毁审计痕迹）。
    assert.equal(host.children().length, childrenBefore, '卸载不该删台账里的孩子登记');
  } finally {
    await host.stop();
  }
});
