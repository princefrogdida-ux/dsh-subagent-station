/**
 * 拒绝文案的分级与**可执行性**（方案 §5.4 / §8.2 / 改进方案 §10）。
 *
 * ### 这一份测的是"文案有没有在骗人"
 *
 * v0.3 的根文案说：
 *
 * > 岗位模型策略只在 `dispatch_agent` 上生效
 *
 * 这句话对 `send_message` 是**错的**——它根本不涉及路由（`createsAgent: false`）。
 * 对用户的影响不是措辞难看，而是他照着提示去改一个跟问题无关的东西。
 *
 * 所以这里用一张**能力表**逐条核对：每一种拒绝形态渲染出来的文案，
 * 必须满足该形态的语义约束。
 *
 * ### 硬规则（方案 §5.4）
 *
 * 文案里出现的每个工具名都必须在插件里**真实注册**。`dispatch_roles` 写错成
 * `dispatch_role`，用户复制粘贴会得到一个"未知工具"——比不给提示更糟。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ERROR_CODES } from '../../lib/shared/policy.js';
import { REFUSAL_HINTS, describeRefusal, refusalLine } from '../../lib/shared/refusal.js';
import { computeCoverage, decideToolPolicy, loadCatalog } from '../../lib/host/coverage.js';
import { readCatalogFile } from '../../lib/host/index.js';
import { makeAgent, registerFakeTool, startStation } from '../host-fixture.js';

/**
 * 真实加载的目录（**不用替身**：目录 schema 与 `createsAgent` 字段本身就是被测对象）。
 *
 * `readCatalogFile()` 从磁盘读 `delegation-catalog.json` 并 `loadCatalog()` 它——
 * 走真路径，"schema v2 生效"这件事才真的被验证。
 */
function realCatalog() {
  return readCatalogFile();
}

/**
 * 直接调 governor 的拒绝路径（不走宿主 guard，便于读文案）。
 * @returns {Promise<string|undefined>}
 */
async function governorRefusal(host, name, agent, args = {}) {
  return host.guardRefusal({ name, agent, arguments: args });
}

// ─────────────────────────────────────────────────────────────────────────────
// T70：文案里出现的工具名必须真实存在
// ─────────────────────────────────────────────────────────────────────────────

test('V10 拒绝文案提到的每个工具名都真实注册（复制粘贴可用）', async () => {
  const host = await startStation();
  try {
    registerFakeTool(host, 'subagent');
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const refusal = await governorRefusal(host, 'subagent', root);
    assert.equal(typeof refusal, 'string', '前提：原生入口在受管根上必须被拒');

    // 把文案里出现的所有 `xxx` 形式的名字抓出来。
    const mentioned = [...refusal.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
    assert.ok(mentioned.length > 0, '拒绝文案必须给出一条可执行的替代路径（不能只说"不行"）');

    const known = new Set(['subagent', 'dispatch_agent', 'dispatch_roles', 'station_status']);
    const unknown = mentioned.filter((n) => !known.has(n));
    assert.deepEqual(
      unknown,
      [],
      `文案里提到了不存在的名字：${unknown.join('、')}。`
      + '硬规则：文案里的每个工具名都必须能直接调用（§5.4）。',
    );

    // 最关键的那一个：必须指向真实存在的 `dispatch_agent`。
    assert.ok(
      mentioned.includes('dispatch_agent'),
      '「会创建 agent 的入口」被拒时必须告诉用户改用 `dispatch_agent`，否则用户不知道该走哪条路',
    );
  } finally {
    await host.stop();
  }
});

test('V11 `dispatch_agent` / `dispatch_roles` / `station_status` 三个工具确实注册着', async () => {
  const host = await startStation();
  try {
    for (const name of ['dispatch_agent', 'dispatch_roles', 'station_status']) {
      assert.notEqual(host.tools.get(name), undefined, `${name} 必须已注册——文案里点名了它`);
    }
  } finally {
    await host.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T71：按 `createsAgent` 分级，而不是按类别
// ─────────────────────────────────────────────────────────────────────────────

test('V12 不创建 agent 的入口被拒时，文案不许说"绕过岗位模型策略"', () => {
  const catalog = realCatalog();
  const entry = catalog.entries.get('send_message');
  assert.ok(entry !== undefined, '目录里必须有 send_message');
  assert.equal(entry.createsAgent, false, '前提：send_message 不创建 agent');

  // `send_message` 的 `childVerdict` 是 `allow-if-parent-or-known`，子会话里
  // 遇到未知目标会被拒——那是一种真实的拒绝形态。
  const decision = decideToolPolicy({
    toolName: 'send_message',
    isChild: true,
    catalog,
    extraBlockedNames: [],
    forbidNestedDispatch: true,
    blockNativeDelegation: true,
    unknownEntryPolicy: 'deny-all',
    targetKnown: false,
  });
  assert.equal(decision.deny, true, '前提：未知目标必须被拒');
  assert.equal(decision.targetGated, true, '这个拒绝是由目标引发的（不是"绕过路由"）');
});

test('V13 目录里每个入口的 createsAgent 都是显式布尔值（不留 undefined）', () => {
  const catalog = realCatalog();
  for (const [name, entry] of catalog.entries) {
    assert.equal(
      typeof entry.createsAgent,
      'boolean',
      `入口 ${name} 的 createsAgent 必须是显式布尔值。`
      + 'undefined 会让"按 createsAgent 分级"的文案静默退化成"按类别"——那正是 v0.3 的错。',
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T72：describeRefusal 的三段结构
// ─────────────────────────────────────────────────────────────────────────────

test('V14 describeRefusal 对每个错误码都给出 code + message + hint + fix', () => {
  for (const [key, code] of Object.entries(ERROR_CODES)) {
    const refusal = describeRefusal(Object.assign(new Error('原始消息'), { code, isStationError: true }));
    assert.equal(refusal.code, code, `${key}：码必须原样保留`);
    assert.equal(typeof refusal.hint, 'string', `${key}：必须有 hint`);
    assert.ok(refusal.hint.length >= 6, `${key}：hint 不能是空壳（"出错了"这类不算）`);
    assert.equal(typeof refusal.fix, 'string', `${key}：必须有 fix（用户要知道怎么办）`);
    assert.ok(refusal.fix.length >= 6, `${key}：fix 不能是空壳`);
    assert.ok(refusal.hint !== refusal.fix, `${key}：hint 与 fix 说的不是同一件事，不该相同`);
  }
});

test('V15 refusalLine 是单行（guard 返回值不能带换行）', () => {
  for (const code of Object.values(ERROR_CODES)) {
    const line = refusalLine(Object.assign(new Error('x'), { code, isStationError: true }));
    assert.equal(typeof line, 'string');
    assert.doesNotMatch(line, /\n/, `${code}：guard 返回单行，带换行会被截断成看不懂的半句`);
    assert.ok(line.includes(code), `${code}：单行里必须带码（宿主会丢掉 code 字段，见 C6）`);
  }
});

test('V16 非 StationError 也能被归一化（不许把内部错误直接倒给用户）', () => {
  const refusal = describeRefusal(new TypeError('boom'));
  assert.equal(refusal.isStation, false);
  assert.equal(typeof refusal.code, 'string');
  assert.ok(refusal.code.length > 0);
  assert.match(refusal.message, /boom/, '原始消息要保留，否则用户什么线索都没有');
  assert.equal(typeof refusal.fix, 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// T73：覆盖诊断按 state 分级（不是按数组空不空）
// ─────────────────────────────────────────────────────────────────────────────

test('V17 覆盖状态由 state 决定，四种 state 各自可区分', () => {
  const catalog = realCatalog();
  assert.ok(catalog !== undefined, '目录必须能真的读出来（读不出来这个测试本身就是假绿）');
  const allNames = [...catalog.entries.keys()];

  // ① complete：目录里认得的名字全在。
  const complete = computeCoverage({ catalog, visibleNames: allNames });
  assert.equal(complete.state, 'complete');
  assert.deepEqual(complete.unknown, []);
  assert.deepEqual(complete.unrecognized, []);

  // ② unknown-present：目录外、**名字像派生入口** ⇒ 这是最危险的一类（可能绕过岗位策略）。
  const unknownPresent = computeCoverage({ catalog, visibleNames: [...allNames, 'subagent_v2'] });
  assert.equal(unknownPresent.state, 'unknown-present', '名字像派生的目录外工具必须单独成档');
  assert.deepEqual(unknownPresent.unknown, ['subagent_v2']);

  // ③ unrecognized：目录外、名字不像派生 ⇒ 看得见，但不当成威胁。
  const unrecognized = computeCoverage({ catalog, visibleNames: [...allNames, 'read', 'bash'] });
  assert.equal(unrecognized.state, 'unrecognized');
  assert.deepEqual(unrecognized.unknown, [], '普通工具不该被误报成"可疑派生入口"');
  assert.deepEqual(unrecognized.unrecognized, ['read', 'bash'], '但必须看得见，否则覆盖诊断在自己认识的世界里自说自话');

  // ④ degraded：目录读不出来。
  const degraded = computeCoverage({ catalog: undefined, visibleNames: [] });
  assert.equal(degraded.state, 'degraded', '目录读不出来必须落到 degraded，不是"未知为空所以完整"');

  // 四种 state 必须互不相同——否则上面的分档等于没做。
  const states = new Set([complete.state, unknownPresent.state, unrecognized.state, degraded.state]);
  assert.equal(states.size, 4, `四种 state 必须互不相同，实际：${[...states].join('、')}`);
});

test('V18 覆盖状态不许用"数组为空"代替 state 判断（反面）', () => {
  const unreadable = computeCoverage({ catalog: undefined, visibleNames: [] });
  // 这一条是关键：如果实现只看 `unknown.length === 0` 就判完整，degraded 就会被说成 complete。
  assert.equal(unreadable.unknown.length, 0, '前提：degraded 时确实没有"未知名字"可列');
  assert.notEqual(
    unreadable.state,
    'complete',
    '「没有未知名字」不等于「覆盖完整」。目录都没读到，怎么可能知道?（§2.5 的硬规则）',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T74：受管子会话 → dispatch_agent 的文案必须说"带回主会话"
// ─────────────────────────────────────────────────────────────────────────────

test('V19 受管子会话再派 dispatch_agent：文案指出替代路径，且不说"改用 dispatch_agent"', async () => {
  const host = await startStation();
  try {
    host.subagents.behaviour = () => ({ childId: 'child-1' });
    const root = host.makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0 });
    await host.announce(root, 'startup');

    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await host.announce(child, 'startup');

    const refusal = await governorRefusal(host, 'dispatch_agent', child);
    assert.equal(typeof refusal, 'string', '前提：子会话不许再派');

    // 关键反面：对子会话说"改用 dispatch_agent"是自相矛盾（它就是 dispatch_agent）。
    assert.doesNotMatch(
      refusal.split('（如确需原生入口')[0],
      /请改用 `dispatch_agent`/,
      '在 dispatch_agent 被拒的文案里让它"改用 dispatch_agent"，用户会照做然后又被拒——这是循环提示',
    );
    assert.match(refusal, /带回主会话|主会话/, '必须给出一个真实可行的替代路径');
  } finally {
    await host.stop();
  }
});
