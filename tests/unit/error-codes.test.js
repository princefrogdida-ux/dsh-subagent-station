/**
 * 错误码**归位**审计（方案 §6.1，问题 7 / R4 根因）。
 *
 * ### v0.3 的判据为什么不够
 *
 * v0.3 只核对「每个码至少有一处 `throw`」。问题 7 恰恰是**码存在、也抛了，
 * 但抛在不该抛的地方**：`resolveRoute` 对「不在白名单」和「不在有效集合」
 * 都抛 `ROUTE_NOT_ALLOWED`，于是用户拿到一个码要自己猜是该抄对 id、
 * 改岗位配置、还是查全局那三层。
 *
 * ### v0.4 的判据
 *
 * 每个码有一列「唯一触发情形」和「反例」，测试核对**归位**：
 *
 * 1. `RELOCATION` 表覆盖 `ERROR_CODES` 的每一个码（漏一个就红）；
 * 2. 每个码在 `lib/` 里确实有触发点（旧的弱判据保留，它仍然是必要条件）；
 * 3. 三个新增/拆出的码有**行为级**反例测试——不是文档说了算，是跑出来算数；
 * 4. `REFUSAL_HINTS` 覆盖每一个码（"新增错误码"与"新增可诊断文案"不许脱节）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ERROR_CODES,
  StationError,
  effectiveRoutes,
  normalizeRoles,
  normalizeRoutes,
  resolveRoute,
} from '../../lib/shared/policy.js';
import { REFUSAL_HINTS, describeRefusal, refusalLine } from '../../lib/shared/refusal.js';

/** 递归收集 `lib/` 下的全部 `.js` 文件。 */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

/**
 * 归位表（方案 §6.1 的运行时副本）。
 *
 * 每行的 `case` 是「唯一触发情形」，`counter` 是「反例：不许在这里抛」。
 * 这张表是**可执行的文档**：`ERROR_CODES` 出现新码而这里没跟上，测试立刻红。
 */
const RELOCATION = Object.freeze({
  ROLE_NOT_FOUND: {
    case: '请求的岗位在当前配置里不存在',
    counter: '岗位存在但被禁用（那是 ROLE_DISABLED）',
  },
  ROLE_DISABLED: {
    case: '岗位存在但 enabled=false',
    counter: '岗位根本不存在',
  },
  FIXED_ROLE_OVERRIDE: {
    case: 'fixed 岗位被要求改派到别的路由',
    counter: 'allowlist 岗位选了一条未授权的路由',
  },
  ROUTE_NOT_ALLOWED: {
    case: 'routeId 存在，但不在该岗位允许集合内',
    counter: 'routeId 在任何路由表里都不存在（那是 ROUTE_UNKNOWN）',
  },
  ROUTE_UNKNOWN: {
    case: 'routeId 在任何岗位与全局路由表里都不存在',
    counter: 'id 存在但该岗位没授权它',
  },
  ROUTE_NOT_EFFECTIVE: {
    case: 'routeId 被岗位允许，但被全局/快照/官方收窄',
    counter: 'id 不存在，或岗位没授权它',
  },
  DEFAULT_ROUTE_INVALID: {
    case: '岗位的 defaultRouteId 自身配置非法',
    counter: '默认路由合法但被全局收窄（那是 EMPTY_EFFECTIVE_SET）',
  },
  EMPTY_EFFECTIVE_SET: {
    case: '四层求交后为空，连默认路由都不在集合内',
    counter: '调用者显式选的路由不在集合内（那是 ROUTE_NOT_EFFECTIVE）',
  },
  EFFORT_UNSUPPORTED: {
    case: '思考强度不是已知取值，或该路由没有声明它',
    counter: '路由问题（那是三个 ROUTE_* 之一）',
  },
  NOT_MANAGED_SESSION: {
    case: '调用者会话既不在 managedSessionIds 里也不在受管谱系内',
    counter: '受管子会话再派（那是 NESTED_DISPATCH_FORBIDDEN）',
  },
  NESTED_DISPATCH_FORBIDDEN: {
    case: '受管子会话试图创建下一层',
    counter: '未受管会话的派出尝试',
  },
  CONFIG_CONFLICT: {
    case: '配置内部自相矛盾（岗位引用了不存在的路由等）',
    counter: '运行时求交为空（那是 EMPTY_EFFECTIVE_SET）',
  },
  START_FAILED: {
    case: '宿主 startActivation 抛错',
    counter: '插件在派出**之前**就拒绝了（那不该走到这里）',
  },
  OFFICIAL_POLICY_CONFLICT: {
    case: '岗位路由与官方白名单零交集',
    counter: '与本插件全局配置零交集',
  },
  LEDGER_UNAVAILABLE: {
    case: '台账域打不开或写入失败',
    counter: '配置问题（那是 CONFIG_CONFLICT 之类）',
  },
  COVERAGE_INCOMPLETE: {
    case: '严格覆盖模式开启且存在目录外派生入口',
    counter: '目录读不到（那是 degraded，只告警不拒绝）',
  },
  BACKEND_INCAPABLE: {
    case: '子智能体后端不声明支持必要能力',
    counter: '后端存在但 startActivation 失败（那是 START_FAILED）',
  },
  TARGET_UNKNOWN: {
    case: '条件允许入口的目标 agent 无法解析',
    counter: '目标存在但属于别的受管根（那是 TARGET_FOREIGN）',
  },
  TARGET_FOREIGN: {
    case: '目标属于别的受管根',
    counter: '目标压根不存在（那是 TARGET_UNKNOWN）',
  },
  UNMANAGED_CHILD: {
    case: '受管谱系内、未登记的子会话发起请求',
    counter: '非受管谱系里的会话（那不该被 L3 关注）',
  },
  LINEAGE_MISMATCH: {
    case: '台账 rootSessionId 与现算谱系不一致',
    counter: '谱系算不出来（那是 LINEAGE_UNKNOWN）',
  },
  LINEAGE_UNKNOWN: {
    case: '谱系算不出来（父会话不可达）',
    counter: '谱系算得出来但与台账不一致',
  },
  POLICY_UNREADABLE: {
    case: '判定所依赖的输入（配置/目录/台账）读不出来',
    counter: '输入读得出来但结论是拒绝（那是具体业务码）',
  },
  INTERNAL: {
    case: '插件内部抛出未归类的异常（`describeRefusal` 的归一化出口）',
    counter: '任何有业务含义的失败——它们都有各自的码，不该退化成 INTERNAL',
  },
});

test('归位表覆盖全部错误码：新增码必须同时给出"唯一触发情形"与"反例"', () => {
  const missing = Object.keys(ERROR_CODES).filter((name) => RELOCATION[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `以下错误码没有在 RELOCATION 表里登记唯一触发情形与反例：\n${missing.join('\n')}\n`
    + '每个码只对应一种情形是 v0.4 的硬要求（方案 §6.1）——否则用户拿到码要自己猜。',
  );

  // 反向：表里不许留已被删除的码。
  const stale = Object.keys(RELOCATION).filter((name) => ERROR_CODES[name] === undefined);
  assert.deepEqual(stale, [], `RELOCATION 里的这些码在 ERROR_CODES 里已不存在：${stale.join('、')}`);

  // 每一行都要真的写了内容（空对象也算漏）。
  for (const [name, row] of Object.entries(RELOCATION)) {
    assert.equal(typeof row.case, 'string', `${name} 缺少 case 描述`);
    assert.ok(row.case.length > 5, `${name} 的 case 描述过于笼统：${row.case}`);
    assert.ok(row.counter.length > 5, `${name} 的 counter 描述过于笼统：${row.counter}`);
  }
});

test('每个错误码在 lib/ 里都至少有一个触发点（必要条件，v0.3 判据保留）', () => {
  const root = new URL('../../lib/', import.meta.url);
  const sources = jsFiles(root.pathname.replace(/^\/([A-Z]:)/, '$1')).map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));

  const unThrown = [];
  for (const [name, code] of Object.entries(ERROR_CODES)) {
    const used = sources.some(({ text }) => {
      const pattern = new RegExp(
        `(?:StationError\\(\\s*ERROR_CODES\\.${name}\\b|code:\\s*ERROR_CODES\\.${name}\\b)`,
      );
      return pattern.test(text);
    });
    if (!used) unThrown.push(`${name} (${code})`);
  }

  assert.deepEqual(unThrown, [], `以下错误码声明了但从未抛出/从未被放进拒绝结果：\n${unThrown.join('\n')}`);
});

test('每个错误码都有可诊断文案，并且同一句文案由 describeRefusal 统一产出', () => {
  const missing = Object.keys(ERROR_CODES).filter((name) => REFUSAL_HINTS[ERROR_CODES[name]] === undefined);
  assert.deepEqual(
    missing,
    [],
    `以下错误码缺少 REFUSAL_HINTS 行：${missing.join('、')}\n`
    + '拒绝文案是三个消费点（全局守卫 / dispatch catch / dry-run）的单一来源，漏一个就会漂移。',
  );

  // 同一个码，从三个消费点得到的文本必须逐字相同——这就是「单一来源」的可执行定义。
  for (const code of Object.values(ERROR_CODES)) {
    const error = new StationError(code, `关于 ${code} 的一次拒绝`);
    const a = describeRefusal(error).text;
    const b = describeRefusal(new StationError(code, `关于 ${code} 的一次拒绝`)).text;
    assert.equal(a, b, `${code} 的文案不稳定`);
    assert.ok(a.includes(code), `${code} 的文案必须包含码本身：宿主不保留 StationError.code（C6），码只能靠文案传递`);
    assert.ok(a.includes('修复：'), `${code} 的文案必须给出修复动作`);
  }
});

test('非 StationError 的抛出品也能被 describeRefusal 归一化（不崩、不假装是业务判定）', () => {
  const raw = new Error('底层炸了');
  const described = describeRefusal(raw);
  assert.equal(described.isStation, false, '它**不是**一次业务判定结果，这一点必须保留');
  // v0.4 给它一个稳定的归一化码 `STATION_INTERNAL`，而不是空串：
  // 空串会让 `决定：无法判定（：…）` 渲染出一个没有码的括号（半成品）。
  assert.equal(described.code, ERROR_CODES.INTERNAL);
  assert.equal(described.isStation, false, 'INTERNAL 不代表"判定完成"，别把它当业务码用');
  assert.match(described.text, /底层炸了/);
  assert.match(described.text, /修复：/);
  // guard 返回值必须是单行（宿主渲染成 `Error: <reason>`，多行会很吵）。
  assert.ok(!refusalLine(raw).includes('\n'));
  assert.ok(!refusalLine(new StationError(ERROR_CODES.TARGET_UNKNOWN, 'x')).includes('\n'));
});

test('v0.3 已删除的三个空承诺码确实不在了', () => {
  assert.equal('POLICY_DEVIATION' in ERROR_CODES, false, '偏离从不阻断，不该有错误码');
  assert.equal('ROLE_NOT_CONFIGURED' in ERROR_CODES, false, '被 CONFIG_CONFLICT / ROLE_NOT_FOUND 完全覆盖');
  assert.equal('STORAGE_UNAVAILABLE' in ERROR_CODES, false, '与 LEDGER_UNAVAILABLE 是同一事实的两个名字');
});

test('错误码值都是 STATION_ 前缀的稳定字符串（前端可分类）', () => {
  for (const [name, code] of Object.entries(ERROR_CODES)) {
    assert.match(code, /^STATION_[A-Z0-9_]+$/, `${name} 的取值必须是 STATION_ 前缀的大写串，实际：${code}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三个 ROUTE_* 码的行为级反例（方案 §6.1 的"为什么必须拆"）
// ─────────────────────────────────────────────────────────────────────────────

/** T60 用的路由表：三条路由，其中 `orphan` 存在但没人授权。 */
function routeTable() {
  const { routesById } = normalizeRoutes([
    { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
    { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'] },
    { routeId: 'orphan', provider: 'vendorA', model: 'orphan-model', efforts: [] },
  ]);
  return routesById;
}

test('V8 ROUTE_UNKNOWN / ROUTE_NOT_ALLOWED / ROUTE_NOT_EFFECTIVE 三种情形各抛各的码', () => {
  const routesById = routeTable();
  const role = normalizeRoles([{
    roleId: 'scout',
    mode: 'allowlist',
    defaultRouteId: 'cheap',
    allowedRouteIds: ['cheap'], // 注意：不含 orphan，也不含 strong
  }]).get('scout');

  // 有效集合里只有 cheap（模拟全局层收窄）。
  const effective = [routesById.get('cheap')];

  // (1) 抄错 id：任何表里都没有 ⇒ ROUTE_UNKNOWN
  assert.throws(
    () => resolveRoute({ role, roleRouteId: 'typo-route', effective, defaultRoute: effective[0], routesById }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_UNKNOWN,
    '路由 id 不存在必须报 ROUTE_UNKNOWN（修复动作是抄对 id）',
  );

  // (2) 存在，但岗位没授权 ⇒ ROUTE_NOT_ALLOWED
  assert.throws(
    () => resolveRoute({ role, roleRouteId: 'orphan', effective, defaultRoute: effective[0], routesById }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_NOT_ALLOWED,
    '路由存在但岗位未授权必须报 ROUTE_NOT_ALLOWED（修复动作是改岗位配置）',
  );

  // (3) 岗位授权了，但被全局/快照/官方收窄 ⇒ ROUTE_NOT_EFFECTIVE
  const permissiveRole = normalizeRoles([{
    roleId: 'scout2',
    mode: 'allowlist',
    defaultRouteId: 'cheap',
    allowedRouteIds: ['cheap', 'strong'],
  }]).get('scout2');
  assert.throws(
    () => resolveRoute({
      role: permissiveRole, roleRouteId: 'strong', effective, defaultRoute: effective[0], routesById,
    }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_NOT_EFFECTIVE,
    '岗位允许但全局收窄必须报 ROUTE_NOT_EFFECTIVE（修复动作是查全局那三层）',
  );

  // 反例（方案 §6.1 的"不许在这里抛"）：不传 `routesById` 时无法区分存在性，
  // 因此不许假装报 ROUTE_UNKNOWN——退化为 ROUTE_NOT_ALLOWED 是如实的降级。
  assert.throws(
    () => resolveRoute({ role, roleRouteId: 'typo-route', effective, defaultRoute: effective[0] }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_NOT_ALLOWED,
    '拿不到全局路由表时不许猜 ROUTE_UNKNOWN',
  );
});

test('V9 三条 ROUTE_* 拒绝的修复建议互不相同（否则拆分就没有意义）', () => {
  const fixes = ['ROUTE_UNKNOWN', 'ROUTE_NOT_ALLOWED', 'ROUTE_NOT_EFFECTIVE'].map((name) => {
    const hint = REFUSAL_HINTS[ERROR_CODES[name]];
    assert.ok(hint !== undefined, `${name} 必须有文案`);
    return hint.fix;
  });
  assert.equal(new Set(fixes).size, 3, `三种情形的修复建议必须不同，实际：${JSON.stringify(fixes)}`);
});
