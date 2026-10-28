/**
 * 保证等级（G8）与 **fail-closed 矩阵**（方案 §2.6 / 改进方案 §9.4、§11.2）。
 *
 * ### 这一份测的是"插件在不确定时怎么选"
 *
 * 一份安全承诺最该被测的不是它在顺境里的行为，而是**它在缺东西时怎么选**。
 * v0.3 的 bug 几乎都是同一个形状：某个输入读不出来时，代码选了"放行"。
 *
 * 所以这里做两件事：
 *
 * 1. **真值表**：`computeAssurance` 的每一档都能被明确的布尔事实触发，
 *    且每一档都说得清"是哪一条不成立"。
 * 2. **fail-closed 矩阵**：把每一种"缺东西"的情形列出来，逐条断言结论是拒绝，
 *    而不是放行。每一条都同时验证"拒绝"与"拒绝的理由是对的"——只断言"抛错了"
 *    会让"因为错误的原因而抛"也算通过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ERROR_CODES } from '../../lib/shared/policy.js';
import { ASSURANCE_LABELS, ASSURANCE_LEVELS, computeAssurance, renderAssurance } from '../../lib/host/assurance.js';

// ─────────────────────────────────────────────────────────────────────────────
// T75：保证等级的真值表
// ─────────────────────────────────────────────────────────────────────────────

/** 一切成立时的基线事实。 */
const FULL_FACTS = Object.freeze({
  guardMounted: true,
  lockMounted: true,
  ledgerReady: true,
  lineageKnown: true,
  reservedChildId: true,
  reservationHonoured: true,
  catalogReadable: true,
  snapshotFrozen: true,
});

test('V20 全部事实成立 → 完整（且没有任何降级原因）', () => {
  const assurance = computeAssurance(FULL_FACTS);
  assert.equal(assurance.level, 'full');
  assert.equal(assurance.label, '完整');
  assert.equal(assurance.complete, true);
  assert.deepEqual(assurance.reasons, [], '完整时不该有任何"原因"——那会让完整档失去意义');
});

test('V21 每一档都能被触达，且四档的中文名互不相同', () => {
  // 逐档构造一组事实，断言它能落到该档。
  const cases = [
    { level: 'unavailable', facts: { guardMounted: false } },
    { level: 'degraded-env', facts: { lockMounted: false } },
    { level: 'degraded-config', facts: { reservedChildId: false } },
    { level: 'full', facts: {} },
  ];

  for (const testCase of cases) {
    const assurance = computeAssurance({ ...FULL_FACTS, ...testCase.facts });
    assert.equal(
      assurance.level,
      testCase.level,
      `事实 ${JSON.stringify(testCase.facts)} 应落到 ${testCase.level}，实际 ${assurance.level}`
      + `（原因：${assurance.reasons.map((r) => r.reason).join('；') || '（无）'}）`,
    );
  }

  // 四档名字必须互不相同——否则用户分不清"能改"与"改不了"。
  assert.equal(new Set(Object.values(ASSURANCE_LABELS)).size, ASSURANCE_LEVELS.length);
});

test('V22 `unavailable` 优先于一切：守卫或台账缺失时不降级为"降级"', () => {
  // 守卫缺失 + 一堆配置问题 ⇒ 仍然是 unavailable（最严重的那个决定等级）。
  const assurance = computeAssurance({
    ...FULL_FACTS,
    guardMounted: false,
    lockMounted: false,
    reservedChildId: false,
  });
  assert.equal(assurance.level, 'unavailable');
  assert.ok(
    assurance.reasons.some((r) => r.layer === 'guard'),
    '原因里必须能指出是守卫缺失——等级本身只是一个标签，原因才是可行动的信息',
  );
  assert.ok(
    assurance.reasons.some((r) => r.layer === 'lock'),
    '同时也要把其它不成立层列全，不能因为定了级就少报',
  );
});

test('V23 「能改」与「改不了」严格分开（fixable 决定配置档 vs 环境档）', () => {
  const configOnly = computeAssurance({ ...FULL_FACTS, reservedChildId: false });
  assert.equal(configOnly.level, 'degraded-config');
  assert.ok(configOnly.reasons.every((r) => r.fix !== undefined), '配置档的每条原因都必须给出修复方式');

  const envOnly = computeAssurance({ ...FULL_FACTS, lineageKnown: false });
  assert.equal(envOnly.level, 'degraded-env');
  assert.ok(
    envOnly.reasons.every((r) => r.fix === undefined),
    '环境档的原因**不许**给出修复方式——那是骗人（用户改不了）',
  );
});

test('V24 环境档优先于配置档（改不了的比能改的更值得先说）', () => {
  // 同时有配置问题与环境问题 ⇒ 报环境档，但两条原因都在。
  const assurance = computeAssurance({
    ...FULL_FACTS,
    reservedChildId: false, // 能改
    lineageKnown: false, // 改不了
  });
  assert.equal(assurance.level, 'degraded-env', '用户会照"配置"去改，改完发现还有一条改不了的');
  assert.equal(assurance.reasons.length, 2, '两条原因都要列，不能因为定了级就少报');
});

test('V25 渲染出的每一行都带层名，且修复行只在有时出现', () => {
  const assurance = computeAssurance({ ...FULL_FACTS, reservedChildId: false, lineageKnown: false });
  const lines = renderAssurance(assurance);
  assert.match(lines[0], /保证等级：降级（环境）/);

  const reasonLines = lines.filter((line) => line.startsWith('  · ['));
  assert.equal(reasonLines.length, 2);
  for (const line of reasonLines) {
    assert.match(line, /\[[a-z]+\]/, '每条原因必须标出是哪一层不成立');
  }
  const fixLines = lines.filter((line) => line.includes('修复：'));
  assert.equal(fixLines.length, 1, '只有"能改"的那条该有修复行');
});

test('V26 摘要必须说清"哪条不成立"，不是只给一个等级名', () => {
  const degraded = computeAssurance({ ...FULL_FACTS, reservedChildId: false });
  assert.match(degraded.summary, /降级（配置）/);
  assert.ok(
    degraded.summary.length > '本套保证：降级（配置）'.length + 5,
    '摘要里必须带上具体原因。只给等级名等于让用户自己去翻回执。'
  );

  const full = computeAssurance(FULL_FACTS);
  assert.match(full.summary, /完整/);
});

// ─────────────────────────────────────────────────────────────────────────────
// T76：fail-closed 矩阵（缺东西 ⇒ 拒绝，不是放行）
// ─────────────────────────────────────────────────────────────────────────────

test('V27 fail-closed 矩阵：每一种"缺东西"都以正确的码拒绝', async () => {
  const { mountRequestLock } = await import('../../lib/host/request-lock.js');

  /**
   * 每一行 = 一种缺失情形。
   *
   * `expect` 是**必须**出现的码。矩阵要求每行都拒绝——`expect: undefined` 的行
   * 存在，但必须是真的"不归我管"（不是"读不出来"）。
   */
  const rows = [
    {
      name: '台账未就绪',
      expect: ERROR_CODES.LEDGER_UNAVAILABLE,
      make: () => ({ readLedger: () => undefined, classify: () => managed(), resolveLineage: () => full() }),
    },
    {
      name: '台账读取抛错',
      expect: ERROR_CODES.POLICY_UNREADABLE,
      make: () => ({
        readLedger: () => ({ getChild() { throw new Error('storage gone'); } }),
        classify: () => managed(),
        resolveLineage: () => full(),
      }),
    },
    {
      name: '受管子会话未登记',
      expect: ERROR_CODES.UNMANAGED_CHILD,
      make: () => ({ readLedger: () => emptyLedger(), classify: () => managed(), resolveLineage: () => full() }),
    },
    {
      name: '谱系不可解析',
      expect: ERROR_CODES.LINEAGE_UNKNOWN,
      make: () => ({
        readLedger: () => ledgerWith('root-1'),
        classify: () => managed(),
        resolveLineage: () => ({ rootSessionId: '', lineage: 'limited', hops: 0 }),
      }),
    },
    {
      name: '谱系与台账不一致',
      expect: ERROR_CODES.LINEAGE_MISMATCH,
      make: () => ({
        readLedger: () => ledgerWith('root-1'),
        classify: () => managed(),
        resolveLineage: () => ({ rootSessionId: 'root-2', lineage: 'full', hops: 1 }),
      }),
    },
    {
      name: '未受管谱系（不归我管）',
      expect: undefined, // ← 这一类**必须**放行，见下方断言
      make: () => ({
        readLedger: () => emptyLedger(),
        classify: () => ({ managed: false, isChild: true, rootSessionId: 'free-root' }),
        resolveLineage: () => full(),
      }),
    },
  ];

  const results = [];
  for (const row of rows) {
    const handlers = [];
    const ctx = { on: (_event, handler) => { handlers.push(handler); return () => {}; } };
    mountRequestLock({
      ctx,
      readPolicy: () => ({ managedSessionIds: ['root-1'] }),
      isEnabled: () => true,
      ...row.make(),
    });
    assert.equal(handlers.length, 1, `${row.name}：监听器必须挂上（没挂 = 假绿）`);

    const child = { session: { id: 'child-1', header: { parentSession: 'root-1', delegationDepth: 1 } }, options: {} };
    let code;
    try {
      await handlers[0](
        { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
        async () => Object.freeze({ provider: 'p', model: 'm' }),
      );
      code = undefined;
    } catch (error) {
      code = error?.code;
    }
    results.push({ name: row.name, expect: row.expect, actual: code });

    assert.equal(
      code,
      row.expect,
      `${row.name}：期望 ${row.expect ?? '放行'}，实际 ${code ?? '放行'}。`
      + `\n全部结果：${JSON.stringify(results, null, 2)}`,
    );
  }

  // 反向守一条：矩阵里必须有"真的拒绝"的行，否则整个矩阵可能是"什么都不拒绝"的假绿。
  assert.ok(results.filter((r) => r.actual !== undefined).length >= 5, '至少五类缺失必须以错误结束');
  // 也必须有恰好一行放行，证明"未受管不归我管"与"读不出来"是分开的两件事。
  assert.equal(results.filter((r) => r.actual === undefined).length, 1);
});

/** 受管判定替身：受管子会话。 */
function managed() {
  return { managed: true, isChild: true, rootSessionId: 'root-1' };
}

/** 谱系替身：完整、指向 root-1。 */
function full() {
  return { rootSessionId: 'root-1', lineage: 'full', hops: 1 };
}

/** 空台账替身。 */
function emptyLedger() {
  return { getChild: () => undefined };
}

/** 只有一条登记的台账替身。 */
function ledgerWith(rootSessionId) {
  return {
    getChild: () => ({
      childSessionId: 'child-1', receiptId: 'r1', rootSessionId, provider: 'vendorA', model: 'm',
    }),
  };
}
