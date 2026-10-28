/**
 * v0.3 回归测试：T42–T58（方案第 15 节的验收矩阵）。
 *
 * 这个文件是**先写、先看着它红**才动产品代码的（方案 13.1 第 1 条）。
 * 每条测试的标题都带 T 编号，便于与 `TEST-REPORT.md` 的红→绿对照表逐条对应。
 *
 * 分组与方案的阶段对应：
 * - G1（§3）：T42–T44 —— 派出参数即契约
 * - G2/G3（§4–§5）：T45–T48 —— 治理覆盖不留时间窗、身份随时可重算
 * - G4（§6）：T49–T51 —— 台账状态机闭合
 * - G5（§7）：T52–T53 —— 快照可重建
 * - G6（§8）：T54–T58 —— 覆盖诊断不撒谎 + `station_status`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attemptCall,
  callDispatch,
  callStatus,
  makeAgent,
  registerFakeTool,
  seedChild,
  seedManagedRoot,
  seedReceipt,
  startStation,
} from '../host-fixture.js';

/** 受管根会话（`managedSessionIds` 默认含 `root-1`）。 */
function rootAgent(host, id = 'root-1') {
  return host.makeAgent({ id, rootSessionId: id, depth: 0 });
}

/** 受管子会话。 */
function childAgent(host, id = 'child-1', parentId = 'root-1', depth = 1) {
  return host.makeAgent({ id, rootSessionId: parentId, depth });
}

// ─────────────────────────────────────────────────────────────────────────────
// G1：派出参数即契约（§3）
// ─────────────────────────────────────────────────────────────────────────────

test('T42 派出的 startActivation 里 request.agentOptions 等于回执声明的路由', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    assert.equal(host.subagents.calls.length, 1);
    const spec = host.subagents.calls[0];
    assert.ok(
      spec.request !== undefined,
      'startActivation 必须带 request（v0.2 有，但 agentOptions 缺）',
    );
    assert.deepEqual(
      spec.request.agentOptions,
      { provider: 'vendorA', model: 'pro-model', reasoningEffort: 'high' },
      'agentOptions 必须由决定对象直接构造，等于岗位声明的那条路由',
    );

    // 回执里声明的路由必须与下发的完全一致（两侧不能各说各话）。
    const receipt = host.receipts()[0];
    assert.equal(spec.request.agentOptions.provider, receipt.route.provider);
    assert.equal(spec.request.agentOptions.model, receipt.route.model);
    assert.equal(spec.request.agentOptions.reasoningEffort, receipt.route.reasoningEffort);
  } finally {
    await host.stop();
  }
});

test('T43 首轮请求之前，子会话创建参数已是岗位值（不经请求锁）', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    // 白名单岗位 + 显式选 cheap：证明 agentOptions 跟着**决定**走，而不是岗位默认值
    // （scout 的默认是 cheap，但 reviewer 的默认是 strong，这里选 scout 才有区分度）。
    await callDispatch(
      host,
      { roleId: 'scout', routeId: 'cheap', description: 'x', prompt: 'y' },
      { agent },
    );

    const spec = host.subagents.calls[0];
    assert.deepEqual(
      spec.request.agentOptions,
      // cheap 只声明了 `efforts: ['low']`，没有声明 `defaultEffort`，
      // 因此正确的行为是**不携带** reasoningEffort（让适配器取自己的默认），
      // 而不是随手填一个 'low'。这正是方案 §3.2 第 2 条要求的「只在有值时出现」。
      { provider: 'vendorA', model: 'cheap-model' },
      '第一条请求之前，子会话的 AgentOptions 就必须是岗位值（这是 P1-A 的全部意义）',
    );
    assert.equal(
      'reasoningEffort' in spec.request.agentOptions,
      false,
      '未声明默认强度的路由不得携带 reasoningEffort 键（值为 undefined 与键不存在语义不同）',
    );
    // 这里刻意不调用任何 `agent/request`：如果只靠请求锁，断言会拿到 undefined。
    assert.equal(host.receipts()[0].status, 'started', '此时还在等首轮请求确认');
  } finally {
    await host.stop();
  }
});

test('T44 后端不声明 agentOptions 时仍然拒绝（预检没有退化成空操作）', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const original = host.subagents.getProvider.bind(host.subagents);
    host.subagents.getProvider = (name) => (
      name === 'spawn' ? { name: 'spawn', capabilities: { agentOptions: false } } : original(name)
    );

    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_BACKEND_INCAPABLE',
      '不支持 agentOptions 的后端会真的丢弃这个字段，此时拒绝派出是对的',
    );
    assert.equal(host.subagents.calls.length, 0, '拒绝必须发生在创建之前');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G2/G3：治理覆盖不留时间窗（§4–§5）
// ─────────────────────────────────────────────────────────────────────────────

test('T45 插件加载前已存在的受管根：加载后立即受 guard 约束', async () => {
  // 预置一个 live 受管根：`existingAgents` 在 `apply()` 之前就登记进 agents 服务。
  const host = await startStation({}, { existingAgents: [{ id: 'root-1', rootSessionId: 'root-1', depth: 0 }] });
  try {
    registerFakeTool(host, 'subagent');
    assert.equal(host.existing.length, 1, '夹具必须真的预置了会话');

    // 刻意**不**触发 `agent/created`：启动扫描必须自己发现它（W1）。
    const outcome = await attemptCall(host, 'subagent', host.existing[0]);
    assert.equal(outcome.denied, true, '加载前已存在的受管根必须已被 guard 覆盖');
    assert.match(outcome.reason, /dispatch_agent/, '拒绝文案必须给出替代路径');
  } finally {
    await host.stop();
  }
});

test('T46 插件加载前已存在的受管子会话：下一轮请求即被压回台账值', async () => {
  const host = await startStation({}, {
    existingAgents: [{ id: 'child-1', rootSessionId: 'root-1', depth: 1 }],
    seed: {
      receipts: [seedReceipt()],
      children: [seedChild({ childSessionId: 'child-1' })],
    },
  });
  try {
    const child = host.existing[0];
    // 不触发 agent/created：靠启动扫描挂上请求锁定。
    const config = await child.ctx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'sneaky', model: 'other', temperature: 0.1 }),
    );

    assert.equal(config.provider, 'vendorA', '恢复后的子会话下一轮就必须被压回');
    assert.equal(config.model, 'pro-model');
    assert.equal(config.temperature, 0.1, '未关注字段必须保留');
  } finally {
    await host.stop();
  }
});

test('T47 maxDepth: 2 的孙级：判定受管且根 id 正确', async () => {
  const host = await startStation();
  try {
    // 谱系：root-1 → child-1 → grand-1。孙级的 parentSession 是 child-1（不在受管名单里）。
    const child = childAgent(host, 'child-1', 'root-1', 1);
    const grand = host.makeAgent({ id: 'grand-1', rootSessionId: 'child-1', depth: 2 });

    const { classifyAgent } = await import('../../lib/host/entry-governor.js');
    const policy = { managedSessionIds: ['root-1'] };
    const result = classifyAgent(policy, grand, { sessions: host.sessions });

    assert.equal(result.managed, true, '孙级必须通过谱系向上走到受管根，而不是只看直接父');
    assert.equal(result.rootSessionId, 'root-1', '根 id 必须是真正的受管根，不是中间子会话');
    assert.equal(result.isChild, true);

    // 中间层也必须被判为受管（否则孙级的谱系在上一步就断了）。
    assert.equal(classifyAgent(policy, child, { sessions: host.sessions }).managed, true);
  } finally {
    await host.stop();
  }
});

test('T48 同一 agent 身份变更后重挂：isChild 刷新，孙级派出被拒', async () => {
  const host = await startStation();
  try {
    // 先以「根」身份挂载（此时 depth 0、无 parentSession）。
    const agent = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(agent, 'startup');
    assert.equal((await attemptCall(host, 'subagent', agent)).denied, true, '受管根：原生入口被拦');

    // 同一对象身份变成子会话（模拟 resume/clear 重建后 header 被替换）。
    agent.session.header = { parentSession: 'root-1', delegationDepth: 1, origin: 'subagent' };
    agent.options = { subagentDepth: 1 };

    // 场景 A：身份改变但**不再** announce（guard 不会重挂）。
    // 这是「guard 内现算 isChild」唯一能被单独验证的形态：resume/clear 之后
    // `agent.session.header` 被整体替换，而 `agent/created` 已经发过了。
    const withoutReattach = await attemptCall(host, 'dispatch_agent', agent);
    assert.equal(
      withoutReattach.denied,
      true,
      '身份改变后即使没有重新 announce，guard 也必须在每次调用时现算 isChild',
    );

    // 场景 B：再 announce 一次（guard 会按新身份重挂）。
    await host.announce(agent, 'resume');

    const nested = await attemptCall(host, 'dispatch_agent', agent);
    assert.equal(nested.denied, true, '身份刷新后，它已经是子会话，孙级派出必须被拒');
    assert.match(nested.reason, /带回主会话/, '要给用户可执行的下一步');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G4：台账状态机闭合（§6）
// ─────────────────────────────────────────────────────────────────────────────

test('T49 首次成功压回后回执从 started 变为 observed，且只变一次', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    const receiptId = host.receipts()[0].receiptId;
    assert.equal(host.receipt(receiptId).status, 'started', '派出的瞬间只可能到 started');

    const child = childAgent(host, 'child-1');
    await host.announce(child, 'startup');
    const requestOnce = () => child.ctx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'vendorA', model: 'pro-model' }),
    );

    await requestOnce();
    assert.equal(host.receipt(receiptId).status, 'observed', '首轮被压回后必须升到 observed');

    const observedAt = host.receipt(receiptId).updatedAt;
    await requestOnce();
    assert.equal(host.receipt(receiptId).status, 'observed', '第二轮不应改变状态');
    assert.equal(host.receipt(receiptId).updatedAt, observedAt, 'observed 只写一次');
  } finally {
    await host.stop();
  }
});

test('T50 子会话正常结束：回执 settled，note 含 stopReason', async () => {
  const host = await startStation();
  try {
    const root = rootAgent(host);
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });
    const receiptId = host.receipts()[0].receiptId;

    const child = childAgent(host, 'child-1');
    await host.announce(child, 'startup');
    await child.ctx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'vendorA', model: 'pro-model' }),
    );
    assert.equal(host.receipt(receiptId).status, 'observed');

    await host.emitSubagentEnd(root, {
      runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'completed',
    });

    const settled = host.receipt(receiptId);
    assert.equal(settled.status, 'settled', '正常结束必须落到终态');
    assert.match(settled.note, /completed/, 'note 必须留下 stopReason，而不是只写「已结束」');
  } finally {
    await host.stop();
  }
});

test('T51 子会话被中断：回执 interrupted，终态不再被改写', async () => {
  const host = await startStation();
  try {
    const root = rootAgent(host);
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });
    const receiptId = host.receipts()[0].receiptId;

    const child = childAgent(host, 'child-1');
    await host.announce(child, 'startup');

    await host.emitSubagentEnd(root, {
      runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'aborted',
    });
    assert.equal(host.receipt(receiptId).status, 'interrupted', 'aborted 必须映射到 interrupted');

    // 终态不可覆盖：随后再来一次（哪怕说完成了）也不能改写。
    await host.emitSubagentEnd(root, {
      runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'completed',
    });
    assert.equal(host.receipt(receiptId).status, 'interrupted', '终态不可覆盖');

    // 首轮请求也不能把一个已中断的回执「救」回 observed。
    const config = await child.ctx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'vendorA', model: 'pro-model' }),
    );
    assert.equal(config.model, 'pro-model', '请求仍按台账路由锁定（路由与回执状态是两件事）');
    assert.equal(host.receipt(receiptId).status, 'interrupted');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G5：快照可重建（§7）
// ─────────────────────────────────────────────────────────────────────────────

test('T52 空快照后补齐路由：下一次派出成功（不改 epoch）', async () => {
  // 现场复现（方案 §7.1、§1.3 的真实事故形态）：
  // 首次派出发生在「路由表为空」时，`stationRoutes: []` 被冻进台账；
  // 之后用户填好路由，而 `isNarrowing` 判定为 false（空集不含任何「不在 live 里」的 key）
  // ⇒ 快照永不更新 ⇒ 该根此后**每次**派出都报冲突，且用户没有任何办法让它生效。
  const host = await startStation({ allowedRoutes: [] });
  try {
    const agent = rootAgent(host);

    // 第一步：路由表为空时如实拒绝（不是静默成功，也不是假装已授权）。
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => typeof error.code === 'string' && error.code.startsWith('STATION_'),
      '空路由必须如实拒绝',
    );
    assert.equal(host.subagents.calls.length, 0, '拒绝时不得产生子会话');

    // 前提：台账里已经冻下了一个空快照（这就是事故的形态）。
    const frozen = host.managedRoots();
    assert.equal(frozen.length, 1, '拒绝之前已经冻结过快照');
    assert.equal(frozen[0].stationRoutes.length, 0, '前提：快照是空集');

    // 第二步：用户补齐路由，**不改 epoch**。
    host.setConfig('allowedRoutes', [
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
    ]);

    // 第三步：下一次派出必须成功——空集不是「授权为零」，而是「没授权过」。
    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /派出已受理/, '空快照必须自愈，否则空集就成了永久拒绝');
    assert.equal(host.subagents.calls.length, 1);

    const healed = host.managedRoots()[0];
    assert.equal(healed.stationRoutes.length, 1, '自愈后快照必须记下当前集合');
    assert.equal(healed.snapshotVersion, 2, '自愈同样要递增版本号，才能与旧快照区分');
    assert.match(healed.note, /空快照自愈/, '重建原因必须落盘，供事后解释');
  } finally {
    await host.stop();
  }
});

test('T53 snapshotEpoch 加 1：按新集合重算，snapshotVersion + 1，在跑子会话不受影响', async () => {
  const host = await startStation({
    allowedRoutes: [
      { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
    ],
  }, {
    seed: {
      // 已冻结的根：只允许 cheap。现在全局集合更大（多了 pro-model），
      // 但「放宽不会隐式生效」，所以 reviewer（固定用 strong）仍须被拒。
      managed_roots: [seedManagedRoot({
        snapshotVersion: 1,
        stationRoutes: [{ routeId: 'cheap', provider: 'vendorA', model: 'cheap-model' }],
      })],
      // 已在跑的子会话：台账里必须有它，请求锁才会正常放行并压回路由。
      receipts: [seedReceipt()],
      children: [seedChild({ childSessionId: 'child-running' })],
    },
  });
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_EMPTY_EFFECTIVE_SET',
      '放宽不得隐式生效：快照里没有 strong，就必须拒绝',
    );

    const before = host.managedRoots()[0];

    // 前提：在跑的子会话已按旧快照锁定（重建不得动它）。
    // 它必须是「我们派出的」，所以先登记进台账——否则请求锁会以 UNKNOWN_CHILD 拒绝，
    // 那会掩盖本测试真正要验的东西。
    const runningChild = host.makeAgent({ id: 'child-running', rootSessionId: 'root-1', depth: 1 });
    await host.announce(runningChild, 'startup');
    assert.ok(
      host.children().some((c) => c.childSessionId === 'child-running'),
      '前提：在跑的子会话已在台账登记',
    );

    // 唯一的放宽入口：把 snapshotEpoch 加 1。
    host.setConfig('snapshotEpoch', 1);

    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /派出已受理/, 'epoch 加 1 之后必须按当前集合重新冻结');

    const after = host.managedRoots()[0];
    assert.equal(after.snapshotVersion, 2, '重建必须让 snapshotVersion 递增，才能与旧快照区分');
    assert.equal(after.epoch, 1, '重建时要把 epoch 记下来，避免每次派出都重建');
    assert.equal(after.stationRoutes.length, 2, '重建后快照等于当前全局集合');
    assert.ok(after.createdAt >= before.createdAt);

    // 已在跑的子会话仍按自己的登记锁定，重建快照不改它的路由。
    const config = await runningChild.ctx.waterfall(
      'agent/request',
      { agent: runningChild, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'sneaky', model: 'other' }),
    );
    assert.equal(config.provider, 'vendorA');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G6：覆盖诊断不撒谎（§8）+ station_status（§10）
// ─────────────────────────────────────────────────────────────────────────────

test('T54 受管子会话遇目录外但名字像派生的入口（subagent_v2）→ 拒绝', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent_v2');
    const child = childAgent(host, 'child-1');
    await host.announce(child, 'startup');

    const outcome = await attemptCall(host, 'subagent_v2', child);
    assert.equal(
      outcome.denied,
      true,
      '目录外但名字像派生入口的工具，在子会话里必须被拦（否则「严格受管」是假话）',
    );
  } finally {
    await host.stop();
  }
});

test('T55 目录外的普通工具（read/bash）不被误拦，且进 unrecognized 清单', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'read');
    registerFakeTool(host, 'bash');
    const child = childAgent(host, 'child-1');
    await host.announce(child, 'startup');

    assert.equal((await attemptCall(host, 'read', child)).denied, false, '只读工具不得被拦');
    assert.equal((await attemptCall(host, 'bash', child)).denied, false, '目录外普通工具不得被拦');

    // 但必须看得见：诊断里要有一份「不像派生入口的目录外工具」清单。
    // v0.3 的 `coverage` 分两份（`global` / `scoped`，方案 §8.5），这里看全局视图。
    const snapshot = host.service.snapshot();
    const coverage = snapshot.coverage.global;
    assert.ok(
      coverage.unrecognized.includes('read'),
      `unrecognized 必须包含 read，实际：${JSON.stringify(coverage.unrecognized)}`,
    );
    assert.ok(coverage.unrecognized.includes('bash'));
    assert.deepEqual(coverage.unknown, [], '普通工具不得被算作「像派生入口」');
    // 关键：状态是 `unrecognized`（如实说「我看见不认识的东西」），而不是 `unknown-present`。
    // 后者会触发 strictCoverage 的拒绝，那会让引入 `read`/`bash` 就突然什么都派不出去。
    assert.equal(
      coverage.state,
      'unrecognized',
      '普通目录外工具必须进 unrecognized，但不得升级成 unknown-present',
    );
  } finally {
    await host.stop();
  }
});

test('T56 scoped 注册的入口出现在该 agent 的覆盖诊断里，且不影响全局视图', async () => {
  const host = await startStation();
  try {
    const child = childAgent(host, 'child-1');
    // 只在该 agent 的层里注册一个派生入口（模拟 preset / MCP / 第三方插件的 scoped 注册）。
    child.ctx.get('tools').register({
      name: 'scoped_delegate',
      description: '只在 child-1 可见的派生入口',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute() {
        return 'ok';
      },
    });

    const snapshot = host.service.snapshot(child);
    assert.ok(
      snapshot.coverage.scoped.unknown.includes('scoped_delegate'),
      `该 agent 的作用域视图必须看得见它，实际：${JSON.stringify(snapshot.coverage.scoped)}`,
    );
    assert.ok(
      !snapshot.coverage.global.unknown.includes('scoped_delegate'),
      '全局视图不该被一个 agent 的私有注册污染',
    );
  } finally {
    await host.stop();
  }
});

test('T57 卸载后启动扫描挂上的治理同样解除，台账保留', async () => {
  const host = await startStation({}, { existingAgents: [{ id: 'root-1', rootSessionId: 'root-1', depth: 0 }] });
  try {
    registerFakeTool(host, 'subagent');
    const agent = host.existing[0];
    assert.equal((await attemptCall(host, 'subagent', agent)).denied, true, '前提：扫描已挂上 guard');

    const receiptCountBefore = host.receipts().length;
    await host.fiber.dispose();

    assert.equal(
      (await attemptCall(host, 'subagent', agent)).denied,
      false,
      '卸载后仍然拒绝说明启动扫描的 disposer 泄漏了',
    );
    assert.equal(
      host.receipts().length,
      receiptCountBefore,
      '卸载不得删除台账（那是跨重启的解释依据）',
    );
  } finally {
    await host.stop();
  }
});

test('T58 未受管会话调 station_status：给出本会话 id、原因与两种纳入方式', async () => {
  const host = await startStation();
  try {
    const outsider = host.makeAgent({ id: 'free-1', rootSessionId: 'free-1', depth: 0 });
    const text = await callStatus(host, {}, { agent: outsider });

    assert.match(text, /派出所状态/, '第一行要是可识别的标题');
    assert.match(text, /free-1/, '必须告诉用户本会话 id，否则他没法把它加进配置');
    assert.match(text, /未受管/, '必须明确说没被管，而不是沉默');
    assert.match(text, /managedSessionIds/, '必须给出第一种纳入方式');
    assert.match(text, /manageAllNewRoots/, '必须给出第二种纳入方式（v0.3 新增开关）');
    assert.match(text, /安装：已加载/, '§10.4 要求第一段带安装自检');

    // 未受管用户也应该能拿到岗位 dry-run —— 那正是最需要诊断的人。
    // 但它必须**标明**这是「假如受管」的结果，不能让人误以为已经能派。
    const withRole = await callStatus(host, { roleId: 'reviewer' }, { agent: outsider });
    assert.match(withRole, /岗位 reviewer dry-run/, '未受管不应该是「连诊断都看不到」');
    assert.match(withRole, /决定：可派出/, 'dry-run 要给出可判断的结论');
    assert.match(withRole, /假如在受管根上派出/, '必须标明这是假设性结果，不能假装已经能派');
    assert.match(withRole, /实际无法派出/, '必须同时说清当前实际状态');
  } finally {
    await host.stop();
  }
});
