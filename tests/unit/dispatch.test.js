import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ERROR_CODES,
  StationError,
  normalizeOfficialPolicy,
} from '../../lib/shared/policy.js';
import {
  decideDispatch,
  isManagedSession,
  readPolicyView,
} from '../../lib/host/index.js';
import { classifyAgent } from '../../lib/host/entry-governor.js';
import { computeCoverage, decideToolPolicy, loadCatalog } from '../../lib/host/coverage.js';

/** 一份最小可用配置：两条全局路由、一个固定岗位、一个白名单岗位。 */
function baseConfig(overrides = {}) {
  return {
    managedSessionIds: ['root-1'],
    requireManagedSession: true,
    forbidNestedDispatch: true,
    receiptLimit: 50,
    allowedRoutes: [
      { routeId: 'cheap', provider: 'vendorA', model: 'shared-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
    ],
    roles: [
      { roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong', enabled: true },
      { roleId: 'scout', mode: 'allowlist', defaultRouteId: 'cheap', allowedRouteIds: ['cheap', 'strong'], enabled: true },
    ],
    ...overrides,
  };
}

/** 受管根会话。 */
const root = { id: 'root-1', header: { delegationDepth: 0 } };

test('受管会话判定包含自己与子会话', () => {
  const policy = readPolicyView(baseConfig());
  assert.equal(isManagedSession(policy, root), true);
  assert.equal(isManagedSession(policy, { id: 'other-1', header: {} }), false);
  // 子会话通过 parentSession 继承受管身份。
  assert.equal(isManagedSession(policy, { id: 'child-9', header: { parentSession: 'root-1' } }), true);
});

test('未受管会话默认拒绝派出', () => {
  const policy = readPolicyView(baseConfig());
  assert.throws(
    () => decideDispatch({
      policy,
      session: { id: 'other-1', header: { delegationDepth: 0 } },
      delegationDepth: 0,
      roleId: 'reviewer',
    }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.NOT_MANAGED_SESSION,
  );
});

test('受管子智能体（深度 1）不能继续派出', () => {
  const policy = readPolicyView(baseConfig());
  assert.throws(
    () => decideDispatch({
      policy,
      session: { id: 'child-1', header: { parentSession: 'root-1', delegationDepth: 1 } },
      delegationDepth: 1,
      roleId: 'reviewer',
    }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.NESTED_DISPATCH_FORBIDDEN,
  );
});

test('正常派出：固定岗位使用默认路由与默认强度', () => {
  const policy = readPolicyView(baseConfig());
  const decision = decideDispatch({
    policy,
    session: root,
    delegationDepth: 0,
    roleId: 'reviewer',
  });
  assert.equal(decision.provider, 'vendorA');
  assert.equal(decision.model, 'pro-model');
  assert.equal(decision.reasoningEffort, 'high');
  assert.equal(decision.routeReason, 'role-default');
  assert.equal(decision.mode, 'fixed');
});

test('白名单岗位可显式选择，且必须落在岗位与全局交集内', () => {
  const policy = readPolicyView(baseConfig());
  const decision = decideDispatch({
    policy,
    session: root,
    delegationDepth: 0,
    roleId: 'scout',
    routeId: 'strong',
  });
  assert.equal(decision.model, 'pro-model');
  assert.equal(decision.routeReason, 'caller-selected');
});

test('全局删掉路由后，引用它的岗位被判配置冲突（比交集更早拒绝）', () => {
  const config = baseConfig();
  // 从全局移除 strong，而 scout 的白名单仍引用它。
  config.allowedRoutes = config.allowedRoutes.filter((r) => r.routeId !== 'strong');
  const policy = readPolicyView(config);
  // 这条路由已不存在，岗位配置本身就坏了：应在交集计算之前报配置冲突。
  assert.throws(
    () => decideDispatch({ policy, session: root, delegationDepth: 0, roleId: 'scout', routeId: 'strong' }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.CONFIG_CONFLICT,
  );
});

test('交集语义：路由存在但不在岗位白名单内时仍被拒', () => {
  const config = baseConfig();
  // 新增一条全局路由，但 scout 的白名单里没有它。
  config.allowedRoutes.push({ routeId: 'extra', provider: 'vendorB', model: 'extra-model', efforts: [] });
  const policy = readPolicyView(config);
  assert.throws(
    () => decideDispatch({ policy, session: root, delegationDepth: 0, roleId: 'scout', routeId: 'extra' }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_NOT_ALLOWED,
  );
});

test('禁用岗位拒绝新派出', () => {
  const config = baseConfig();
  config.roles = config.roles.map((r) => (r.roleId === 'reviewer' ? { ...r, enabled: false } : r));
  const policy = readPolicyView(config);
  assert.throws(
    () => decideDispatch({ policy, session: root, delegationDepth: 0, roleId: 'reviewer' }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROLE_DISABLED,
  );
});

test('未知岗位拒绝，并列出已知岗位', () => {
  const policy = readPolicyView(baseConfig());
  assert.throws(
    () => decideDispatch({ policy, session: root, delegationDepth: 0, roleId: 'nobody' }),
    (error) => error instanceof StationError
      && error.code === ERROR_CODES.ROLE_NOT_FOUND
      && error.details.knownRoleIds.includes('reviewer'),
  );
});

test('策略修订号随配置内容变化', () => {
  const a = readPolicyView(baseConfig()).policyRevision;
  const b = readPolicyView(baseConfig()).policyRevision;
  const config = baseConfig();
  config.allowedRoutes = config.allowedRoutes.map((r) => (
    r.routeId === 'cheap' ? { ...r, model: 'other-model' } : r
  ));
  const c = readPolicyView(config).policyRevision;
  assert.equal(a, b, '相同配置应有相同修订号');
  assert.notEqual(a, c, '配置变化应改变修订号');
});

test('受管判定区分根与子：根受管、子继承、无关会话不受管', () => {
  const policy = readPolicyView(baseConfig());

  // 受管根会话。
  assert.deepEqual(
    classifyAgent(policy, { session: { id: 'root-1', header: { delegationDepth: 0 } } }),
    {
      managed: true, isChild: false, rootSessionId: 'root-1', lineage: 'full', managedReason: 'root-listed',
    },
  );
  // 受管子会话：通过 parentSession 继承受管身份，且 isChild 为 true。
  //
  // `lineage: 'limited'` 是如实的：这里没传 `sessions`，所以只能确认「直接父是 root-1」，
  // 无法排除上面还有一层。能走到真正的根时才报 'full'（见下一条测试）。
  assert.deepEqual(
    classifyAgent(policy, { session: { id: 'c1', header: { parentSession: 'root-1', delegationDepth: 1 } } }),
    {
      managed: true, isChild: true, rootSessionId: 'root-1', lineage: 'limited', managedReason: 'root-listed',
    },
  );
  // 顶层但不在名单内：不受管。
  assert.equal(
    classifyAgent(policy, { session: { id: 'free-1', header: { delegationDepth: 0 } } }).managed,
    false,
  );
  // 深度 1 但父会话不在名单内：不受管。
  assert.equal(
    classifyAgent(policy, { session: { id: 'c2', header: { parentSession: 'free-1', delegationDepth: 1 } } }).managed,
    false,
  );
  // 运行时 subagentDepth 计入深度：即使 header 没有 delegationDepth，也判定为子会话。
  const resumed = classifyAgent(policy, {
    options: { subagentDepth: 2 },
    session: { id: 'c4', header: { parentSession: 'root-1' } },
  });
  assert.equal(resumed.isChild, true, '运行时深度必须计入');
  assert.equal(resumed.managed, true);
});

test('v0.3 谱系解析：孙级沿 sessions 走到真正的受管根，拿不到 sessions 时如实降级', () => {
  const policy = readPolicyView(baseConfig());

  // 三层谱系：root-1 → c1 → g1。`sessions` 能给出中间层的父，才能走到根。
  const sessions = {
    get(id) {
      if (id === 'c1') return { id: 'c1', header: { parentSession: 'root-1', delegationDepth: 1 } };
      if (id === 'root-1') return { id: 'root-1', header: { delegationDepth: 0 } };
      return undefined;
    },
  };
  const grandchild = { session: { id: 'g1', header: { parentSession: 'c1', delegationDepth: 2 } } };
  const full = classifyAgent(policy, grandchild, { sessions });
  assert.equal(full.managed, true, '孙级必须通过谱系向上走到受管根');
  assert.equal(full.rootSessionId, 'root-1');
  assert.equal(full.lineage, 'full');

  // 取不到 `sessions` 时只能走一层：孙级会「走不到根」，必须如实标 limited 而不是假装算到了。
  const limited = classifyAgent(policy, grandchild);
  assert.equal(limited.lineage, 'limited', '拿不到 sessions 时必须标注降级，不能假装是全谱系');
  assert.equal(limited.managed, false, '只走一层时孙级确实判不出来——这是如实的结论');

  // 「走到一半」时退回最后一个能确认的 id，而不是退回自己（那会把孙级误判成顶层）。
  const partialLineage = {
    get(id) {
      if (id === 'c1') return { id: 'c1' }; // 有记录但没有更上层父 → c1 就是根
      return undefined;
    },
  };
  const half = classifyAgent(policy, grandchild, { sessions: partialLineage });
  assert.equal(half.rootSessionId, 'c1', '走得到的地方就要用——c1 是这条链能确认的根');

  // 环状谱系不得死循环。
  const cyclic = {
    get(id) {
      if (id === 'a') return { id: 'a', header: { parentSession: 'b' } };
      if (id === 'b') return { id: 'b', header: { parentSession: 'a' } };
      return undefined;
    },
  };
  const cycleResult = classifyAgent(policy, { session: { id: 'a', header: { parentSession: 'b', delegationDepth: 1 } } }, { sessions: cyclic });
  assert.equal(typeof cycleResult.rootSessionId, 'string', '环状谱系必须收敛到一个确定答案');
});

test('入口策略：根拦原生入口但放行本插件，子会话连 dispatch_agent 一起拦', () => {
  const catalog = loadCatalog(JSON.parse(readFileSync(new URL('../../lib/host/delegation-catalog.json', import.meta.url), 'utf8')));
  assert.ok(catalog !== undefined, '随包目录必须能被解析');

  const base = {
    catalog,
    extraBlockedNames: [],
    forbidNestedDispatch: true,
    blockNativeDelegation: true,
  };

  // 受管根：原生入口被拦，本插件入口放行。
  for (const name of ['subagent', 'subagent_fork', 'workflow']) {
    assert.equal(decideToolPolicy({ ...base, toolName: name, isChild: false }).deny, true, `根会话应拦 ${name}`);
  }
  assert.equal(decideToolPolicy({ ...base, toolName: 'dispatch_agent', isChild: false }).deny, false);
  // 只读与停止类永不拦——拦截会削弱用户能力。
  assert.equal(decideToolPolicy({ ...base, toolName: 'interrupt_agent', isChild: false }).deny, false);
  assert.equal(decideToolPolicy({ ...base, toolName: 'dispatch_roles', isChild: true }).deny, false);

  // 子会话：连 dispatch_agent 一起拦（它就是孙级）。
  assert.equal(decideToolPolicy({ ...base, toolName: 'dispatch_agent', isChild: true }).deny, true);
  assert.equal(decideToolPolicy({ ...base, toolName: 'subagent', isChild: true }).deny, true);

  // 用户关掉 blockNativeDelegation 时，根会话的原生入口不再被拦——但子会话仍受 forbidNestedDispatch 约束。
  const lax = { ...base, blockNativeDelegation: false };
  assert.equal(decideToolPolicy({ ...lax, toolName: 'subagent', isChild: false }).deny, false);
  assert.equal(decideToolPolicy({ ...lax, toolName: 'dispatch_agent', isChild: true }).deny, true);
});

test('目录外的派生工具会被覆盖诊断认出来，不假装覆盖完整', () => {
  const catalog = loadCatalog(JSON.parse(readFileSync(new URL('../../lib/host/delegation-catalog.json', import.meta.url), 'utf8')));

  // 全部已知 + 目录外的**普通**工具（read/bash）→ v0.3 新态 `unrecognized`。
  //
  // v0.2 这里断言的是 'complete'，而那是「自述与实现不一致」的一处：
  // `read`/`bash` 明明不在目录里，却说覆盖完整。v0.3 把「像派生入口」与
  // 「不像派生入口」分开报（方案 §8.4），所以状态变成 `unrecognized`，
  // 但仍然**不会**触发 strictCoverage 的拒绝（那是 `unknown-present` 的职责）。
  const complete = computeCoverage({
    visibleNames: ['subagent', 'workflow', 'read', 'bash'],
    catalog,
    extraBlockedNames: [],
  });
  assert.equal(complete.state, 'unrecognized', '目录外的普通工具必须被看见，不能报 complete');
  assert.deepEqual([...complete.unrecognized].sort(), ['bash', 'read']);
  assert.deepEqual(complete.unknown, [], '普通工具不得被算作「像派生入口」');

  // 只有目录内工具 → complete。
  const pure = computeCoverage({ visibleNames: ['subagent', 'workflow'], catalog, extraBlockedNames: [] });
  assert.equal(pure.state, 'complete');

  // 出现目录外的派生工具 → unknown-present，并点名。
  const partial = computeCoverage({
    visibleNames: ['subagent', 'delegate_everything'],
    catalog,
    extraBlockedNames: [],
  });
  assert.equal(partial.state, 'unknown-present');
  assert.deepEqual(partial.unknown, ['delegate_everything']);

  // 目录读不到 → degraded，且仍然尽力列出可疑名字。
  const degraded = computeCoverage({ visibleNames: ['subagent'], catalog: undefined, extraBlockedNames: [] });
  assert.equal(degraded.state, 'degraded');
});

test('严格覆盖模式下，目录外入口会让派出被拒绝', () => {
  const strictPolicy = readPolicyView(baseConfig({ strictCoverage: true }));
  assert.throws(
    () => decideDispatch({
      policy: strictPolicy,
      session: root,
      delegationDepth: 0,
      roleId: 'reviewer',
      coverage: { state: 'unknown-present', unknown: ['mystery_delegate'] },
    }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.COVERAGE_INCOMPLETE,
  );

  // 非严格模式：只告警，不拦。
  const laxPolicy = readPolicyView(baseConfig({ strictCoverage: false }));
  const decision = decideDispatch({
    policy: laxPolicy,
    session: root,
    delegationDepth: 0,
    roleId: 'reviewer',
    coverage: { state: 'unknown-present', unknown: ['mystery_delegate'] },
  });
  assert.equal(decision.model, 'pro-model');
});

test('官方策略参与求交：启用时取交集，未启用时这一层不存在', () => {
  const policy = readPolicyView(baseConfig());

  // 官方只允许 cheap → 固定岗位 reviewer（只有 strong）应报官方冲突，而不是普通空集。
  assert.throws(
    () => decideDispatch({
      policy,
      session: root,
      delegationDepth: 0,
      roleId: 'reviewer',
      official: normalizeOfficialPolicy({ enabled: true, allowedModels: [{ provider: 'vendorA', model: 'shared-model' }] }),
    }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.OFFICIAL_POLICY_CONFLICT,
  );

  // 官方允许 strong → 正常派出。
  const ok = decideDispatch({
    policy,
    session: root,
    delegationDepth: 0,
    roleId: 'reviewer',
    official: normalizeOfficialPolicy({ enabled: true, allowedModels: [{ provider: 'vendorA', model: 'pro-model' }] }),
  });
  assert.equal(ok.model, 'pro-model');

  // 官方 enabled: false → 这一层不存在（不是全拒绝）。
  const disabled = decideDispatch({
    policy,
    session: root,
    delegationDepth: 0,
    roleId: 'reviewer',
    official: normalizeOfficialPolicy({ enabled: false, allowedModels: [] }),
  });
  assert.equal(disabled.model, 'pro-model', 'enabled:false 不得变成全拒绝');
});

test('官方策略归一化：absent / disabled / enforced / empty 四态', () => {
  assert.deepEqual(normalizeOfficialPolicy(undefined), { status: 'absent', routes: [] });
  assert.deepEqual(normalizeOfficialPolicy({ enabled: false, allowedModels: [] }), { status: 'disabled', routes: [] });
  assert.deepEqual(
    normalizeOfficialPolicy({ enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] }),
    { status: 'enforced', routes: [{ provider: 'p', model: 'm' }] },
  );
  // 启用但一个都没允许 ≠ 不限制：按全拒绝处理（放行更危险）。
  assert.deepEqual(normalizeOfficialPolicy({ enabled: true, allowedModels: [] }), { status: 'empty', routes: [] });
});
