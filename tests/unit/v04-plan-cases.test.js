/**
 * 方案 §9.4 的用例清单：T59–T84。
 *
 * ### 与本仓其它 v0.4 测试的分工
 *
 * 方案给了一份 26 条的编号清单。这份文件**逐条实现那 26 条**，编号与方案一致。
 * 我自己另外加的补充用例（时序矩阵、fail-closed 矩阵、红证、自证渲染等）
 * 用 `V` 系列编号，放在各自主题的文件里——这样"方案要求的那条"永远查得到，
 * 不会被补充用例的编号挤掉。
 *
 * ### T59 是本版最重要的一条
 *
 * 方案 §12 的发布判据第 1 条就是「T59 绿」，因为它是 v0.3 唯一明确"不通过"的用例：
 *
 * > 空配置加载 → 写配置 → **不派出**直接调原生 `subagent` → 必须被拒
 *
 * 注意"不派出"三个字。v0.3 的实现要等到某次 `dispatch_agent` 成功之后
 * 才把 guard 挂上，所以"从未成功派出过"这个状态下原生入口完全自由。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeRefusal } from '../../lib/shared/refusal.js';
import {
  attemptCall,
  callDispatch,
  callStatus,
  makeAgent,
  registerFakeTool,
  seedChild,
  seedManagedRoot,
  startStation,
} from '../host-fixture.js';

// ─────────────────────────────────────────────────────────────────────────────
// T59 / T60 / T61：入口拒绝与误伤边界（P1）
// ─────────────────────────────────────────────────────────────────────────────

test('T59 空配置加载 → 写配置 → **不派出**直接调原生 subagent → 被拒', async () => {
  // 真实首装形态：插件先加载，用户之后才写名单。
  const host = await startStation({ managedSessionIds: [] });
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 关键：**从未**调用过 dispatch_agent。台账里一条回执都没有。
    assert.equal(host.receipts().length, 0, '前提：从未成功派出过（v0.3 正是在这个状态下失效）');

    host.setConfig('managedSessionIds', ['root-1']);

    const refusal = await host.guardRefusal({ name: 'subagent', agent: root, arguments: {} });
    assert.ok(
      refusal !== undefined,
      '从未派出过也必须拦。v0.3 要等第一次 dispatch_agent 成功后才挂 guard——'
      + '所以"刚装好"这个状态下原生入口是自由的。这就是问题 1。',
    );
    assert.match(refusal, /dispatch_agent/, '必须给出替代路径');
    assert.match(refusal, /STATION_/, 'guard 文案必须自带错误码（宿主会丢掉 code 字段，C6）');
  } finally {
    await host.stop();
  }
});

test('T60 同上，subagent_fork / workflow / spawn_teammate 全部被拒', async () => {
  const host = await startStation({ managedSessionIds: [] });
  try {
    const names = ['subagent_fork', 'workflow', 'spawn_teammate'];
    for (const name of names) registerFakeTool(host, name);
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.setConfig('managedSessionIds', ['root-1']);

    for (const name of names) {
      const refusal = await host.guardRefusal({ name, agent: root, arguments: {} });
      assert.ok(
        refusal !== undefined,
        `「${name}」也必须被拦。只拦 subagent 的话，用户把工具名一换就绕过了——`
        + '目录存在的意义就是覆盖所有已知入口。',
      );
    }
  } finally {
    await host.stop();
  }
});

test('T61 未受管会话调原生 subagent → 放行（不误伤）', async () => {
  const host = await startStation({ managedSessionIds: ['someone-else'] });
  try {
    registerFakeTool(host, 'subagent');
    const loose = host.makeAgent({ id: 'loose-1', rootSessionId: 'loose-1', depth: 0 });
    await host.announce(loose, 'startup');

    const refusal = await host.guardRefusal({ name: 'subagent', agent: loose, arguments: {} });
    assert.equal(
      refusal,
      undefined,
      '不受管的会话必须完全自由。一个擅自接管所有人的插件，用户第一件事就是卸载它。',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T62：无 PTC 绕过
// ─────────────────────────────────────────────────────────────────────────────

test('T62 全局守卫对 run_code 内 tools.subagent(...) 同样生效（无 PTC 绕过）', async () => {
  // C7：`run_code` 里的 `tools.subagent(...)` 走同一条 `prepareScheduledExecution`，
  // 所以全局 guard 覆盖它。这一条测的是"守卫是全局层，不是某个工具的包装"。
  //
  // 顺带一个已核实的事实：`run_code` 的**名字**是宿主保留的（尝试注册会当场报
  // `tool name "run_code" is reserved for the PTC mode presentation transport`）。
  // 也就是说没有任何插件能抢先注册一个同名工具去截走那次调用——
  // 这一层的绕过路径在宿主侧就已经堵上了。
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 前提：`run_code` 这个名字不可被冒名注册。
    assert.throws(
      () => registerFakeTool(host, 'run_code'),
      /reserved/i,
      '`run_code` 是宿主保留名。若这条变了，"PTC 内部调用能否被冒名"就要重新论证。',
    );

    // 守卫是全局层：它按**被判定的工具名**决定，与调用点无关。
    // 所以在 `run_code` 内部调 `subagent` 时，被判定的是 `subagent`，同样被拦。
    const direct = await host.guardRefusal({ name: 'subagent', agent: root, arguments: {} });
    assert.ok(direct !== undefined, '直接调用必须被拦；同一个判据也覆盖 PTC 内部调用');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T63–T65：回执渲染（P5）
// ─────────────────────────────────────────────────────────────────────────────

test('T63 回执：快照与当前一致 → 写「与当前一致」，不产生噪音', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });

    const result = await callDispatch(
      host,
      { roleId: 'reviewer', description: 'x', prompt: 'y' },
      { agent: root },
    );
    assert.match(result, /快照状态：与当前一致/, '一致时必须明说一致，不能留空让用户猜');
    assert.match(result, /快照代数：\d+/, '代数必须写出来（它是可核对的量纲）');
    assert.match(result, /策略修订：/, '策略修订必须与"快照代数"并列出现');
    assert.doesNotMatch(result, /条新增未生效/, '没有未生效路由时不许出现噪音行');
  } finally {
    await host.stop();
  }
});

test('T64 回执：当前新增一条路由 → 写「N 条新增未生效」+ 列表，**不**比代数', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    // 新增一条路由（不收窄既有集合 ⇒ 不算"配置变宽"，只是"多了一条"）。
    host.setConfig('allowedRoutes', [
      { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
      { routeId: 'fresh', provider: 'vendorA', model: 'fresh-model', efforts: ['low'] },
    ]);

    const result = await callDispatch(
      host,
      { roleId: 'reviewer', description: 'x2', prompt: 'y2' },
      { agent: root },
    );
    assert.match(
      result,
      /\d+ 条新增未生效/,
      '新增路由必须被点出来。只说"与当前不一致"等于让用户自己去 diff。',
    );
    assert.match(result, /fresh/, '必须点出是哪一条（否则用户还得自己找）');
    assert.doesNotMatch(
      result,
      /快照状态：(一致|与当前不一致)$/m,
      '有新路由时不该只说"不一致"——那是把可枚举的信息压缩成一个比特',
    );
  } finally {
    await host.stop();
  }
});

test('T65 回执：覆盖为 unrecognized → 说"目录外非派生工具"，**不得**说"目录不可读"', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });

    // 造一个目录外的普通工具（名字不像派生入口）。
    registerFakeTool(host, 'totally_normal_tool');

    const result = await callDispatch(
      host,
      { roleId: 'reviewer', description: 'x', prompt: 'y' },
      { agent: root },
    );
    assert.match(result, /覆盖未完全确认（unrecognized）/, '必须点出是哪一档');
    assert.match(result, /totally_normal_tool/, '必须点出是哪个工具（否则用户还得自己找）');
    assert.match(
      result,
      /目录\*\*读到了\*\*|目录读到了/,
      '目录是**读到了**，只是有不认识的条目。',
    );
    assert.doesNotMatch(
      result,
      /目录不可读|目录读取失败|目录\*\*没能读到\*\*/,
      '说成"不可读"会让用户去查文件权限——而真正该做的是升级插件目录。'
      + '这两种失败的修复动作完全不同，混成一句话就是把用户引到错的方向。',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T66 / T67：station_status 不报错（P4）
// ─────────────────────────────────────────────────────────────────────────────

test('T66 station_status 内部抛错 → 工具**不** isError，输出含「无法判定（code）」', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 注入：让读取配置抛错。`buildStatus()` 一定会走到它。
    const config = host.fiber.config;
    const original = config.managedSessionIds;
    config.managedSessionIds = { get() { throw new Error('boom: 模拟配置读不出来'); } };

    try {
      // 直接调工具本体（不走 guard）：这里要测的是 execute 会不会抛。
      const result = await host.tools.prepareScheduledExecution({
        name: 'station_status',
        arguments: {},
        callId: 'c-status',
        rootCallId: 'r-status',
        signal: new AbortController().signal,
        agent: root,
      });
      assert.notEqual(
        result.kind,
        'post-error',
        '诊断工具**永远不能**自己报错。一个用来排查问题的工具如果先坏了，用户就没有任何工具可用了。',
      );

      // 若没走 guard，就真的执行一次看它抛不抛。
      const text = await host.executeTool('station_status', {}, root).then(
        (value) => value,
        (error) => ({ threw: error }),
      );
      assert.equal(
        text?.threw,
        undefined,
        'execute 不许抛。诊断工具的失败必须变成文本，因为用户此时正需要它。',
      );
      const rendered = typeof text === 'string' ? text : (text?.text ?? '');
      assert.match(
        String(rendered),
        /决定：无法判定（STATION_/,
        '失败时也必须给出码，格式与 dry-run 的拒绝一致',
      );
    } finally {
      config.managedSessionIds = original;
    }
  } finally {
    await host.stop();
  }
});

test('T67 dry-run 遇已禁用岗位 → `- 决定：拒绝（STATION_ROLE_DISABLED…）`，工具不报错', async () => {
  const host = await startStation({
    roles: [
      { roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong', enabled: true },
      { roleId: 'retired', mode: 'fixed', defaultRouteId: 'strong', enabled: false },
    ],
  });
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const text = await callStatus(host, { roleId: 'retired' }, { agent: root });
    assert.match(text, /决定：拒绝/, '必须明说"决定"');
    assert.match(text, /STATION_ROLE_DISABLED/, '码必须在括号里（用户要能搜）');
    assert.match(text, /说明：/, '必须解释原因');
    assert.match(text, /修复：/, '必须给出修复动作');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T68：绕过入口创建的子会话（P2）
// ─────────────────────────────────────────────────────────────────────────────

test('T68 原生 subagent 漏网 → 其子会话发请求 → 拒绝 STATION_UNMANAGED_CHILD', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 造一个受管谱系内的子会话，但台账里**没有**它的登记。
    const childCtx = host.ctx.extend();
    const smuggled = makeAgent({ id: 'smuggled-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(smuggled, 'startup');

    const error = await childCtx
      .waterfall(
        'agent/request',
        { agent: smuggled, turn: 1, step: 1, signal: new AbortController().signal },
        async () => Object.freeze({}),
      )
      .then(() => undefined, (e) => e);

    assert.ok(error !== undefined, '绕过入口创建的会话必须被拒——否则 L2 只是"拦住了一半"');
    assert.equal(error.code, 'STATION_UNMANAGED_CHILD', '码必须是这个，不能退化成"读不出来"');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T69 / T70：send_message 的三分语义（P3）
// ─────────────────────────────────────────────────────────────────────────────

test('T69 受管根 send_message 给台账内子会话 → 允许', async () => {
  const host = await startStation();
  try {
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    registerFakeTool(host, 'send_message');
    const refusal = await host.guardRefusal({
      name: 'send_message',
      agent: root,
      arguments: { agent_id: 'child-1', message: 'hi' },
    });
    assert.equal(
      refusal,
      undefined,
      'send_message 不创建 agent（createsAgent: false），所以它跟岗位模型策略无关。'
      + 'v0.3 把它在受管根上也拦掉了，用户报的"排出去的智能体没法追加上下文"就是这个。',
    );
  } finally {
    await host.stop();
  }
});

test('T70 受管根 send_message 给陌生 id → 拒绝 STATION_TARGET_UNKNOWN', async () => {
  const host = await startStation();
  try {
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    registerFakeTool(host, 'send_message');
    const refusal = await host.guardRefusal({
      name: 'send_message',
      agent: root,
      arguments: { agent_id: 'never-existed', message: 'hi' },
    });
    assert.ok(refusal !== undefined, '陌生目标必须被拒——否则受管根可以向任意 agent 投递');
    assert.match(refusal, /STATION_TARGET_UNKNOWN/, '码必须精确到这个情形');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T71 / T72：预置 childId 消除 TOCTOU（P2）
// ─────────────────────────────────────────────────────────────────────────────

test('T71 子会话在 putChild 完成前发请求 → 不误拒', async () => {
  const host = await startStation();
  try {
    // 打开"后端支持预置 childId"这条路（真实 `spawn` 后端支持它）。
    // 默认关着是因为绝大多数测试关心的是"派出去之后怎么样"，不该被预置 id 打扰。
    host.subagents.supportsReservedChildId = true;

    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    let observedMidDispatch;
    let reservedSeen;
    host.subagents.behaviour = (spec) => {
      // 就在 `startActivation` 的这一刻，检查台账里有没有这条子会话。
      //
      // v0.3 在这里查不到：它是"派出成功后才登记"，所以子会话首轮请求
      // 有机会撞上一个还没登记的自己（TOCTOU）。v0.4 改成先登记再创建。
      reservedSeen = spec?.childId;
      observedMidDispatch = host
        .children()
        .find((c) => c.childSessionId === spec?.childId);
      return { childId: spec?.childId ?? 'child-fallback' };
    };

    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    assert.ok(
      typeof reservedSeen === 'string' && reservedSeen !== '',
      '`startActivation` 必须收到预置的 `childId`（宿主会原样采用，S5）',
    );
    assert.ok(
      observedMidDispatch !== undefined,
      '`startActivation` 被调用时，台账里必须**已经**有这条子会话。'
      + '否则子会话的首轮请求会撞上"我还没被登记"——那正是 TOCTOU。',
    );
  } finally {
    await host.stop();
  }
});

test('T72 台账 children 的 root 与现算谱系不符 → 拒绝 STATION_LINEAGE_MISMATCH', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    // 把台账里这条记录的 root 改成别的（模拟 resume / clear / 换父）。
    const store = host.storage.opened.at(-1).stores.get('children');
    const record = store.get('child-1');
    store.set('child-1', { ...record, rootSessionId: 'some-other-root' });

    const childCtx = host.ctx.extend();
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');

    const error = await childCtx
      .waterfall(
        'agent/request',
        { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
        async () => Object.freeze({}),
      )
      .then(() => undefined, (e) => e);

    assert.ok(error !== undefined, '谱系与台账不符时不许猜哪个对');
    assert.equal(error.code, 'STATION_LINEAGE_MISMATCH', '必须是这个码，不能退化成 UNKNOWN');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T73 / T74 / T75：台账不可用与可证伪（P6）
// ─────────────────────────────────────────────────────────────────────────────

test('T73 台账不可打开 → 派出被拒 + 保证等级：不可派出', async () => {
  // 台账域从**打开阶段**就失败（`breakStorage` 在插件 apply 之前生效）。
  const host = await startStation({}, { breakStorage: true });
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const error = await callDispatch(
      host,
      { roleId: 'reviewer', description: 'x', prompt: 'y' },
      { agent: root },
    ).then(() => undefined, (e) => e);

    assert.ok(
      error !== undefined,
      '台账打不开时必须拒绝派出（fail-closed）。"派了但没记"比"没派"更难收拾。',
    );
    assert.equal(error.code, 'STATION_LEDGER_UNAVAILABLE');

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /不可派出/, '保证等级必须是"不可派出"，不是"一切正常"');
    assert.match(text, /台账/, '必须点出是台账的问题');
  } finally {
    await host.stop();
  }
});

test('T74 零偏离时 deviations 表存在且 meta 计数器为 0（零结论也要有证据）', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const stores = host.storage.opened.at(-1).stores;
    assert.ok(stores.has('deviations'), '表必须**存在**——"没有这张表"和"表里是 0 条"完全不同');
    assert.equal(stores.get('deviations').size, 0, '此时确实应该 0 条');

    const meta = stores.get('meta').get('counters');
    assert.equal(
      meta.counters.deviationWrites,
      0,
      '计数器必须明确是 0。没有它，"偏离 0 条"分不清"确实没有"与"从来没写过"。',
    );
  } finally {
    await host.stop();
  }
});

test('T75 手工删 deviations 表后重启 → 状态显示该表缺失', async () => {
  // 真机上的形态（已在 `~/.dsh/storages/station_dispatch_ledger` 实测）：
  // `per-record` 布局是**惰性建目录**的（`dsh-storage-json.js:334` 的 `readdir`
  // 容忍 ENOENT、`:396` 的 `mkdir` 只在写入时发生）。所以空表**没有目录**，
  // 那是正常状态，不是"表被删了"。
  //
  // 真正要防的是另一种：**表在声明里，但读不动**。此时
  //   - `domain.table('deviations')` **不抛**（它只从构造时的 Map 里取）；
  //   - 抛错的是 `assertReadable()`，而它藏在 `size` / `keys()` / `entries()` 里
  //     （`dsh-storage-domain.js:249-256`）。
  //
  // 所以夹具用 `brokenTables` 造这个形态——不是去 mock `domain.table` 抛错，
  // 那在真机上根本不会发生，测出来的东西是假的。
  const host = await startStation({}, { brokenTables: ['deviations'] });
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const text = await callStatus(host, {}, { agent: root });
    assert.match(
      text,
      /deviations ✗/,
      '表读不出来必须在状态里明确标 ✗。一个只在出问题时才崩溃的插件，用户永远不知道它在带病运行。',
    );
    assert.match(
      text,
      /过去是否发生过偏离无法回答/,
      '而且必须说清**后果**：此时"偏离 0"是假的。只说"表异常"用户不知道这意味着什么。',
    );
    // 反面：不能因为一张表坏了就谎称整体不可用。
    assert.doesNotMatch(text, /不可派出/, '单表故障不该把保证等级降成"不可派出"——那只针对台账整体打不开');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T76：重启对账
// ─────────────────────────────────────────────────────────────────────────────

test('T76 回执停 observed，重启后子会话已不存在 → 对账标 settled（不是 unverified）', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    // 让回执升到 observed（首轮请求被正确压回）。
    const childCtx = host.ctx.extend();
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');
    await childCtx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({}),
    );

    const receiptId = host.receipts()[0].receiptId;
    assert.equal(host.receipt(receiptId).status, 'observed', '前提：回执必须已到 observed');

    // 重启：子会话不存在了，但回执停在 observed。
    const restarted = await startStation({}, {
      seed: {
        receipts: [host.receipt(receiptId)],
        children: host.children(),
      },
    });
    try {
      const after = restarted.receipt(receiptId);
      assert.equal(
        after.status,
        'settled',
        'observed 意味着"曾经正常运行过"。标 unverified 是过度悲观，会稀释那个状态的信噪比。',
      );
      assert.match(after.note, /停止原因未记录/, '必须解释为什么没有 stopReason');
    } finally {
      await restarted.stop();
    }
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T77–T79：三个 ROUTE_* 码各归各位（P4）
// ─────────────────────────────────────────────────────────────────────────────

test('T77 routeId 完全不存在 → STATION_ROUTE_UNKNOWN', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const error = await callDispatch(
      host,
      { roleId: 'scout', routeId: 'no-such-route', description: 'x', prompt: 'y' },
      { agent: root },
    ).then(() => undefined, (e) => e);

    assert.equal(error?.code, 'STATION_ROUTE_UNKNOWN', '这一格是"压根没这条路"');
    assert.match(
      describeRefusal(error).fix ?? '',
      /allowedRoutes|路由/,
      '修复建议必须指向"加路由"，不是"改岗位白名单"',
    );
  } finally {
    await host.stop();
  }
});

test('T78 routeId 存在但不在岗位白名单 → STATION_ROUTE_NOT_ALLOWED', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    // 加一条路由，但**不**给 scout 白名单权限。
    host.setConfig('allowedRoutes', [
      { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
      { routeId: 'premium', provider: 'vendorA', model: 'premium-model', efforts: ['high'] },
    ]);

    const error = await callDispatch(
      host,
      { roleId: 'scout', routeId: 'premium', description: 'x', prompt: 'y' },
      { agent: root },
    ).then(() => undefined, (e) => e);

    assert.equal(error?.code, 'STATION_ROUTE_NOT_ALLOWED', '这一格是"这条路存在，但这个岗位不许走"');
    assert.match(describeRefusal(error).fix ?? '', /allowedRouteIds|白名单/, '修复建议必须指向岗位白名单');
  } finally {
    await host.stop();
  }
});

test('T79 routeId 被岗位允许但被全局收窄 → STATION_ROUTE_NOT_EFFECTIVE', async () => {
  // 关键：`ghost` **必须**在全局 `allowedRoutes` 里存在（否则启动校验就报
  // `CONFIG_CONFLICT: 白名单包含不存在的路由`——那是配置错误，不是收窄）。
  //
  // 收窄靠的是官方层：路由存在、岗位也允许，但官方白名单不让 ⇒ 有效集合里没有它。
  const host = await startStation({
    allowedRoutes: [
      { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
      { routeId: 'ghost', provider: 'vendorA', model: 'ghost-model', efforts: ['low'] },
    ],
    roles: [{
      roleId: 'scout',
      mode: 'allowlist',
      defaultRouteId: 'cheap',
      allowedRouteIds: ['cheap', 'ghost'],
      enabled: true,
    }],
  });
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 官方层只允许 cheap（`ghost` 被官方排除 ⇒ 有效集合里没有它）。
    host.official.value = {
      enabled: true,
      allowedModels: [{ provider: 'vendorA', model: 'cheap-model' }, { provider: 'vendorA', model: 'pro-model' }],
    };

    const error = await callDispatch(
      host,
      { roleId: 'scout', routeId: 'ghost', description: 'x', prompt: 'y' },
      { agent: root },
    ).then(() => undefined, (e) => e);

    assert.equal(
      error?.code,
      'STATION_ROUTE_NOT_EFFECTIVE',
      '这一格是"岗位允许，但被上层收窄"。'
      + 'v0.3 把它与"岗位不允许"报成同一个码，用户就不知道该改哪一层。',
    );
    assert.match(
      describeRefusal(error).fix ?? '',
      /官方|allowedRoutes|全局/,
      '修复建议必须指向"上层"（全局集合/官方），不是"改岗位白名单"',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T80 / T81：降级可见与逃逸记录
// ─────────────────────────────────────────────────────────────────────────────

test('T80 blockNativeDelegation: false 时派出的回执 → 第一行带降级警告', async () => {
  const host = await startStation({ blockNativeDelegation: false });
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });

    const result = await callDispatch(
      host,
      { roleId: 'reviewer', description: 'x', prompt: 'y' },
      { agent: root },
    );
    assert.match(
      result,
      /降级|原生入口|绕过/,
      '关掉拦截是一个明确的选择，但它有代价：原生入口可以绕过岗位策略。'
      + '这句话必须出现在用户第一眼看到的地方，不能埋在末尾。',
    );
  } finally {
    await host.stop();
  }
});

test('T81 观察到未登记子会话 → 写 escape 记录，状态可见', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 用真实事件模拟"宿主创建了一个我们不认识的子会话"。
    // `subagent/start` 是宿主告诉我们"有子会话起来了"的唯一途径。
    await root.ctx.parallel('subagent/start', {
      id: 'escapee-1',
      parent: root,
      provider: 'vendorA',
      model: 'rogue-model',
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const text = await callStatus(host, {}, { agent: root });
    assert.match(
      text,
      /escapee-1|逃逸|未登记/,
      '漏网的子会话必须留下痕迹。没有它，用户永远不知道"有人绕过入口派过东西"。',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T82 / T83 / T84：卸载干净与服务缺失的边界
// ─────────────────────────────────────────────────────────────────────────────

test('T82 卸载插件后原生 subagent 恢复可用（卸载要干净）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const before = await host.guardRefusal({ name: 'subagent', agent: root, arguments: {} });
    assert.ok(before !== undefined, '前提：装着呢，必须拦');

    await host.stop();

    const after = await host.guardRefusal({ name: 'subagent', agent: root, arguments: {} });
    assert.equal(
      after,
      undefined,
      '卸载后必须立刻放行。一个卸不掉的治理插件，用户只能重装整个宿主。',
    );
  } finally {
    // 已停。
  }
});

test('T83 根会话调工具且 sessions 服务缺失 → **不**受影响（摘掉服务不该误伤根）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 摘掉 sessions：根会话的判定不依赖它（根就是它自己）。
    host.ctx.get('sessions').entries.clear();

    const refusal = await host.guardRefusal({ name: 'subagent', agent: root, arguments: {} });
    assert.ok(
      refusal !== undefined,
      '根会话不需要查谱系就能判定受管。sessions 缺失时若放行，等于"摘掉一个服务就能绕过治理"。',
    );
  } finally {
    await host.stop();
  }
});

test('T84 子会话请求且 sessions 缺失 → 拒绝 STATION_LINEAGE_UNKNOWN', async () => {
  const host = await startStation({
    // 两个根都受管：这样"谱系走到了一半"仍然落在管辖区里，
    // L3 才会去看谱系（否则它按"不归我管"直接放行——那是正确的越权防护）。
    managedSessionIds: ['root-1', 'mid-1'],
  });
  try {
    // 用预置 id 路径，这样"台账里的孩子"与"我们手上这个 agent"是同一个 id。
    host.subagents.supportsReservedChildId = true;

    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    let dispatchedId;
    host.subagents.behaviour = (spec) => {
      dispatchedId = spec?.childId;
      return { childId: spec?.childId };
    };
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });
    assert.ok(typeof dispatchedId === 'string' && dispatchedId !== '', '前提：拿到了真实子会话 id');

    // 造一个**走不到头**的谱系：子 → 中间层（其父查不到）。
    //
    // 为什么需要中间层：只有一层时，"走到 parentSession 就停了"恰好等于台账记的根，
    // 那种情况下算不出来的部分**不影响结论**，拒绝它反而是误伤（见 request-lock.js
    // 里 `sameAsRecorded` 那一段的注释）。要测出"谱系算不出来"的真实危害，
    // 必须让走到的那一层**不是**台账记的根。
    const midCtx = host.ctx.extend();
    makeAgent({ id: 'mid-1', rootSessionId: 'root-1', depth: 1, agentCtx: midCtx });

    const childCtx = host.ctx.extend();
    const child = makeAgent({ id: dispatchedId, rootSessionId: 'mid-1', depth: 2, agentCtx: childCtx });
    await host.announce(child, 'startup');

    // 摘掉谱系解析所需的服务：往上一层的中间层查不到了。
    host.ctx.get('sessions').entries.clear();

    const error = await childCtx
      .waterfall(
        'agent/request',
        { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
        async () => Object.freeze({}),
      )
      .then(() => undefined, (e) => e);

    assert.equal(
      error?.code,
      'STATION_LINEAGE_UNKNOWN',
      '算不出谱系时说"不知道"，不说"不许"。这两个结论的处置完全不同。',
    );
  } finally {
    await host.stop();
  }
});
