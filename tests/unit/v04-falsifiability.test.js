/**
 * 可证伪性（方案 §7 / 改进方案 §10.4）。
 *
 * ### 这一份测的是"插件的自我报告能不能被推翻"
 *
 * v0.3 最深的毛病不是某一层写错了，而是**它没法被证伪**：
 *
 * - `station_status` 报「偏离 0 条」，而那个 0 分不清"确实没有"与"从来没写过"；
 * - `上次扫描：18:57:17` 一直是那个值，看起来像"刚扫过"；
 * - 守卫报「拒绝 0 次」，可能是"没有违规"，也可能是"守卫根本没跑"。
 *
 * 用户没有任何独立手段分辨这些。所以 v0.4 的每一条"零结论"都必须带上
 * **它被观测过的证据**（I10）。这一份测试就是检验那个证据是真的。
 *
 * 三个必查点：
 *
 * 1. **守卫自证**：调用过工具 ⇒ `已评估 N 次` 且 N > 0；从没调用 ⇒ 明说"没挂上"。
 * 2. **台账自证**：`meta` 表的计数器跨重开累计，且能分辨"上次是否正常关闭"。
 * 3. **偏离分级**：`notice` 不该和 `error` 混成一个数字。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attemptCall, callDispatch, callStatus, makeAgent, registerFakeTool, startStation } from '../host-fixture.js';

// ─────────────────────────────────────────────────────────────────────────────
// T77：守卫自证
// ─────────────────────────────────────────────────────────────────────────────

test('V28 从未调用过工具时，状态明说"守卫没跑过"而不是"拒绝 0 次"', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /已评估 0 次/, '必须给出被评估的次数');
    assert.match(
      text,
      /守卫从未被调用过|尚未发生/,
      '评估 0 次时必须**明说**这可能意味着守卫没挂上。'
      + '只说"拒绝 0 次"会让用户以为一切正常——那正是 v0.3 的撒谎方式。',
    );
  } finally {
    await host.stop();
  }
});

test('V29 调用过工具后，评估次数真的涨了（自证不是装饰）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    registerFakeTool(host, 'read');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    // 三次调用：两次非候选名（read 与一次自定义），一次候选名（subagent）。
    await attemptCall(host, 'read', root);
    await attemptCall(host, 'subagent', root);
    await attemptCall(host, 'read', root);

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /已评估 3 次/, '三次调用必须被计数——否则"已评估"是编的');
    assert.match(text, /其中 1 次命中候选名/, '非候选名不该进入现算（§2.3 的预筛）');
    assert.match(text, /首次评估：\d{4}-\d{2}-\d{2}/, '首次评估时间必须是可核对的绝对时刻');
    assert.doesNotMatch(text, /守卫从未被调用过/, '评估过之后不许再说"从未运行"');
  } finally {
    await host.stop();
  }
});

test('V30 拒绝次数按错误码分组（不是只给一个总数）', async () => {
  const host = await startStation();
  try {
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    // 子会话里两种不同的拒绝：`subagent`（目录内原生入口）与 `subagent_v2`（目录外像派生）。
    // 它们落在**不同**的错误码上，正好检验"按码分组"。
    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');
    registerFakeTool(host, 'subagent_v2');

    await attemptCall(host, 'subagent', child);
    await attemptCall(host, 'subagent_v2', child);

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /拒绝 2 次/, '两次拒绝必须都被记下');
    assert.match(
      text,
      /STATION_[A-Z_]+×\d+/,
      '必须按错误码分组。只给总数的话，用户不知道"被拒的是哪一类"。',
    );
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T78：台账自证（meta 表）
// ─────────────────────────────────────────────────────────────────────────────

test('V31 台账 meta 表真的写进去了，且计数随写入增长', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });

    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const opened = host.storage.opened.find((o) => o.spec.name === 'station_dispatch_ledger');
    assert.ok(opened !== undefined, '前提：台账域必须被打开');
    const meta = opened.stores.get('meta');
    assert.ok(meta !== undefined, 'v0.4 必须有 meta 表（台账自身的证据，§7.2）');

    const counters = meta.get('counters');
    assert.ok(counters !== undefined, 'meta 表里必须有一行 counters');
    assert.equal(counters.schemaVersion, 2, '要写明台账格式版本');
    // v0.4 修：`pluginVersion` 此前恒为空串——字段在、schema 要求它、能渲染，
    // 但内容永远是空。空串看起来像"未记录"，实际上"从来没记"。
    // 这条断言就是防它退回去：真机台账里读到过 `"pluginVersion": ""`。
    assert.match(
      String(counters.pluginVersion),
      /^\d+\.\d+\.\d+/,
      `台账必须写明是哪个版本写的（真机踩到过空串）。实际：${JSON.stringify(counters.pluginVersion)}`,
    );
    assert.ok(counters.counters.opened >= 1, '打开次数必须 ≥ 1');
    assert.ok(counters.counters.receiptWrites >= 1, '写过回执，计数必须跟着涨');
    assert.ok(counters.counters.childWrites >= 1, '写过子会话登记，计数必须跟着涨');
    assert.ok(typeof counters.firstOpenedAt === 'number', '首次打开时刻必须有');
  } finally {
    await host.stop();
  }
});

test('V32 缺 `lastClosedAt` 或它早于 `lastOpenedAt` ⇒ 如实说"上次未正常关闭"', async () => {
  const host = await startStation(
    {}, // 配置：用默认（root-1 受管）
    {
      // 种一条"上次没正常关闭"的 meta：`lastOpenedAt` 比 `lastClosedAt` 新。
      seed: {
        meta: [{
          schemaVersion: 2,
          pluginVersion: '0.3.0',
          firstOpenedAt: Date.now() - 86_400_000,
          lastOpenedAt: Date.now() - 3_600_000,
          lastClosedAt: Date.now() - 7_200_000, // 比 lastOpenedAt 早 ⇒ 上次打开后没走 close
          counters: {
            opened: 5, receiptWrites: 9, childWrites: 4, deviationWrites: 0,
            childRecoveries: 0, settles: 2, reconciliations: 1,
          },
        }],
      },
    },
  );
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /上次未正常关闭/, '崩溃痕迹必须被说出来——那是排查"数据为什么不对"的第一线索');
    assert.match(text, /已打开 6 次/, '打开次数必须累加（5 → 6），否则"累计"是假的');
    assert.match(text, /回执 9/, '历史计数必须保留（种子里的 9）');
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T79：偏离分级
// ─────────────────────────────────────────────────────────────────────────────

test('V33 `notice` 与 `error` 在状态里必须分开表述', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');

    // 上游给空路由 ⇒ 这是"尚未初始化"，应记 notice 而不是 error。
    await childCtx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({}),
    );

    const text = await callStatus(host, {}, { agent: root });
    assert.match(
      text,
      /notice（正常初始化/,
      '空路由必须被标为 notice。把它算成"宿主换了模型"会让偏离计数污染成噪音（§7）。',
    );
    assert.doesNotMatch(text, /error（宿主换了模型/, '空路由不是冲突');
  } finally {
    await host.stop();
  }
});

test('V34 真正的换模型必须记成 error（不许为了"好看"把冲突也说成 notice）', async () => {
  const host = await startStation();
  try {
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: root });

    const childCtx = host.ctx.extend();
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');

    await childCtx.waterfall(
      'agent/request',
      { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
      async () => Object.freeze({ provider: 'rogue', model: 'unauthorized' }),
    );

    const text = await callStatus(host, {}, { agent: root });
    assert.match(text, /error（宿主换了模型/, '真换模型必须当成冲突报出来');
    assert.match(text, /rogue\/unauthorized/, '必须写出被换成了什么——用户要据此判断是不是有人在绕过');
  } finally {
    await host.stop();
  }
});
