/**
 * 子智能体派出所 —— 宿主策略层（v0.2）。
 *
 * 职责边界：Host 是唯一权限裁决方。前端筛选与模型看到的 enum 只改善体验，
 * 不能代替这里的校验；模型可以申请派出，不能写入配置。
 *
 * v0.2 补齐的四件事（对应方案 2.2 的 G1–G6）：
 * - G1：两个工具改用 `defineTool`，`output.render` 用真实签名 `(args, value)`。
 * - G2：受管**根**会话与子会话都挂 guard（方案 5.2）。
 * - G3：有效路由 = 岗位 ∩ 插件全局 ∩ 受管快照 ∩ **官方会话策略**（方案 4.2）。
 * - G4：每个受管子会话的**每一轮**模型请求都被压回台账路由（`agent/request`）。
 * - G5：回执 / 快照 / 偏离落盘（`storageDomain`），重启后仍可解释。
 * - G6：覆盖诊断三态 + `strictCoverage`（方案 5.4）。
 *
 * 已核实契约的出处统一记在 `docs/contract-evidence.md`，本文件只在关键点注明依据。
 *
 * 明确的边界见 `docs/known-limits.md` 与 README「不作出的保证」。
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { computeAssurance, renderAssurance } from './assurance.js';
import { Config, volatileField } from './config.js';
import { UNKNOWN_ENTRY_POLICIES, computeCoverage, coverageBlockReason, describeCoverage, loadCatalog } from './coverage.js';
import { classifyAgent, createEntryGovernor, delegationDepthOf, resolveRootSessionId } from './entry-governor.js';
import { RECEIPT_STATUS, openLedger } from './ledger.js';
import { mountRequestLock } from './request-lock.js';
import { createStats, formatAgo, formatMoment } from './stats.js';
import { describeRefusal, refusalLine } from '../shared/refusal.js';
import {
  ERROR_CODES,
  StationError,
  decisionSummary,
  effectiveRoutes,
  findConfigConflicts,
  normalizeOfficialPolicy,
  normalizeRoles,
  normalizeRoutes,
  officialConflictReason,
  resolveEffort,
  resolveRoute,
  roleBlockReason,
} from '../shared/policy.js';

export const name = 'dsh-subagent-station';

/**
 * 唯一硬依赖：工具注册表。没有 `tools` 这个插件什么都不做，应当等它出现再加载。
 *
 * 其余服务（`subagents`、`storageDomain`、`subagentModelSelection`、`sessions`）
 * 一律走 `ctx.get()` 软获取：缺任何一个都不该让插件加载失败——那会把
 * 「派出不可用」升级成「工具都不见了」，而工具本身（`dispatch_roles`）仍有诊断价值。
 */
export const inject = ['tools'];

export { Config };

/** 本插件登记在会话消息 source 上的生产者标识（v4 会话格式要求 `plugin:<包名>`）。 */
export const MESSAGE_SOURCE = 'plugin:dsh-subagent-station';

/**
 * `defineTool` 从 `@deepseek-ai/dsh-tools` 导出（阶段 0 实测：
 * `.host-src/dsh-tools.js:3810` 的 export 列表里包含它）。
 *
 * 用 `createRequire` 而不是静态 `import`：插件的 `peerDependencies` 里两个包都是
 * **optional**，静态导入会让「宿主没装这个包」变成插件的加载期错误；
 * 而 `dsh-tools` 在宿主里一定有，取不到就是部署事故，应当在注册工具时明确报出来。
 */
const requireFromHere = createRequire(import.meta.url);

/**
 * 读取 `defineTool`。取不到返回 `undefined`，由调用方明确拒绝并说明原因，
 * 不用手写对象冒充（那正是 v0.1 的 P1-1）。
 * @returns {((options: object) => object)|undefined}
 */
export function resolveDefineTool() {
  try {
    const mod = requireFromHere('@deepseek-ai/dsh-tools');
    const defineTool = mod?.defineTool;
    return typeof defineTool === 'function' ? defineTool : undefined;
  } catch {
    return undefined;
  }
}

/** 读取内置入口目录（随包发布，缺失时覆盖诊断报 degraded）。 */
export function readCatalogFile() {
  try {
    const raw = requireFromHere('./delegation-catalog.json');
    return loadCatalog(raw);
  } catch {
    return undefined;
  }
}

/** 列出当前已注册的派出后端名，用于拒绝时的诊断。 */
function listProviders(subagents) {
  try {
    const providers = subagents.listProviders?.();
    if (Array.isArray(providers)) {
      return providers.map((p) => (typeof p === 'string' ? p : p?.name)).filter((n) => typeof n === 'string');
    }
  } catch {
    // 诊断信息取不到不影响拒绝本身。
  }
  return [];
}

/**
 * 在运行时探测可用的启动入口，并统一成一个 `start(spec)` 调用形式。
 *
 * 只支持本机实际运行的一代签名（`startActivation`）。v0.1 保留的 0.2.0 线
 * `start(name, request)` 分支已删除：那条路径不带 `childId` 预留能力，也没有
 * `delivery`，走它会得到与 v0.2 状态机不一致的行为。探测不到就明确拒绝。
 *
 * @param {object} subagents
 * @returns {((spec: object) => Promise<object>) | undefined}
 */
export function resolveStarter(subagents) {
  if (subagents === null || subagents === undefined) return undefined;
  if (typeof subagents.startActivation === 'function') {
    return (spec) => subagents.startActivation(spec);
  }
  return undefined;
}

/**
 * 从 `startActivation` 的返回值里取子会话 ID。
 *
 * 已核实返回形状（`cordis_inspect_query(Event, 'subagent/start')` 的
 * `SubagentActivation`）：`{ childId, messageId?, result, dispose }`。
 * 读不到就返回 undefined，由调用方如实标「待核对」，不猜造。
 * @param {object} activation
 * @returns {string|undefined}
 */
export function childIdOf(activation) {
  if (activation === null || typeof activation !== 'object') return undefined;
  if (typeof activation.childId === 'string' && activation.childId !== '') return activation.childId;
  const sessionId = activation.localAgent?.session?.id;
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
  const id = activation.session?.id;
  if (typeof id === 'string' && id !== '') return id;
  return undefined;
}

/**
 * 校验后端能力（方案 9.2）。不满足就拒绝派出，不忽略选项硬跑。
 *
 * @param {object} args
 * @param {object} args.subagents
 * @param {string} args.providerName
 * @returns {string|undefined} 拒绝原因
 */
export function checkBackendCapability({ subagents, providerName }) {
  const getProvider = subagents?.getProvider;
  if (typeof getProvider !== 'function') {
    return '当前宿主没有暴露 `subagents.getProvider`，无法确认后端能力。';
  }
  const provider = getProvider.call(subagents, providerName);
  if (provider === undefined || provider === null) {
    return `子智能体后端「${providerName}」未注册（当前已注册：${listProviders(subagents).join('、') || '无'}）。`
      + '请检查 `providerName` 配置或加载对应的后端插件。';
  }
  const capabilities = provider.capabilities ?? {};
  if (capabilities.agentOptions !== true) {
    return `子智能体后端「${providerName}」不声明支持 \`agentOptions\`，无法为子会话指定模型。`
      + '岗位模型策略在该后端上形同虚设，因此拒绝派出。';
  }
  return undefined;
}

/** 读取一个可能是 volatile 引用（`{ get() }`）的配置值。 */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * 这个后端能不能接受预置的 `childId`？（方案 §4 S5-a）
 *
 * 宿主判据（`.host-src/dsh-subagent.js:3038`）：
 *
 * ```js
 * if (spec.childId !== void 0 && provider.prepareContinuable === void 0)
 *   throw new SubagentError("reserved child ids require a local backend", "UNSUPPORTED_CAPABILITY");
 * ```
 *
 * 所以只有 `prepareContinuable` 存在时才能预置——否则整次派出会失败，
 * 而不是"忽略 childId"。这是**必须**提前判断的，不能在 catch 里兜。
 *
 * 取不到 provider 时返回 `false`（保守）：降级是可用的，崩溃不是。
 *
 * @param {object} subagents
 * @param {string} providerName
 * @returns {boolean}
 */
export function backendSupportsReservedChildId(subagents, providerName) {
  try {
    const provider = subagents?.getProvider?.(providerName);
    return typeof provider?.prepareContinuable === 'function';
  } catch {
    return false;
  }
}

/**
 * 把实时 Config 归一化成策略求值需要的形状。
 * volatile 字段在保存后会热更新，因此每次调用都重新读取，不做缓存。
 * @param {object} rawConfig 插件的 resolved Config
 * @returns {object}
 */
export function readPolicyView(rawConfig) {
  const raw = rawConfig ?? {};
  const { routes, routesById } = normalizeRoutes(unwrap(raw.allowedRoutes) ?? []);
  const rolesById = normalizeRoles(unwrap(raw.roles) ?? []);
  const managed = unwrap(raw.managedSessionIds);
  const receiptLimit = Number(unwrap(raw.receiptLimit));
  const blocked = unwrap(raw.blockedToolNames);
  const providerName = unwrap(raw.providerName);
  return {
    allowedRoutes: routes,
    routesById,
    rolesById,
    conflicts: findConfigConflicts({ rolesById, routesById }),
    managedSessionIds: Array.isArray(managed) ? managed.filter((id) => typeof id === 'string' && id !== '') : [],
    requireManagedSession: unwrap(raw.requireManagedSession) !== false,
    forbidNestedDispatch: unwrap(raw.forbidNestedDispatch) !== false,
    blockNativeDelegation: unwrap(raw.blockNativeDelegation) !== false,
    strictCoverage: unwrap(raw.strictCoverage) === true,
    blockedToolNames: Array.isArray(blocked) ? blocked.filter((n) => typeof n === 'string' && n !== '') : [],
    providerName: typeof providerName === 'string' && providerName !== '' ? providerName : 'spawn',
    receiptLimit: Number.isFinite(receiptLimit) && receiptLimit > 0 ? Math.floor(receiptLimit) : 50,
    unknownEntryPolicy: UNKNOWN_ENTRY_POLICIES.includes(unwrap(raw.unknownEntryPolicy))
      ? unwrap(raw.unknownEntryPolicy)
      : 'block-delegation-like',
    snapshotEpoch: Number.isFinite(Number(unwrap(raw.snapshotEpoch)))
      ? Math.max(0, Math.floor(Number(unwrap(raw.snapshotEpoch))))
      : 0,
    manageAllNewRoots: unwrap(raw.manageAllNewRoots) === true,
    // 修订号只用于让回执可解释「当时依据的是哪一版配置」。
    policyRevision: revisionOf(routes, rolesById),
  };
}

/**
 * 由配置内容算出一个稳定的修订号（FNV-1a 32 位）。
 *
 * 这里刻意不持久化单调递增的计数器：那需要在 Config 里再写一个字段，
 * 而每次保存都写回同一个 Config 容易形成写冲突。内容哈希具备同样的解释能力。
 * @param {Array<object>} routes
 * @param {Map<string, object>} rolesById
 * @returns {number}
 */
function revisionOf(routes, rolesById) {
  const canonical = JSON.stringify({
    routes: routes.map((r) => [r.routeId, r.provider, r.model, r.efforts, r.defaultEffort ?? '']),
    roles: [...rolesById.values()].map((r) => [
      r.roleId, r.mode, r.enabled, r.defaultRouteId, r.allowedRouteIds,
    ]),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * 会话是否处于受管作用域。
 *
 * 「受管」由用户显式列举（`managedSessionIds`），首次安装不接管任何既有会话。
 * 子会话继承其根的受管身份：父会话受管时，子会话同样受管（用于孙级禁令）。
 * @param {object} policy
 * @param {{id?: string, header?: object}} session
 * @returns {boolean}
 */
export function isManagedSession(policy, session) {
  const id = session?.id;
  if (typeof id !== 'string' || id === '') return false;
  if (policy.managedSessionIds.includes(id)) return true;
  const parent = session?.header?.parentSession;
  if (typeof parent === 'string' && parent !== '' && parent !== id) {
    return policy.managedSessionIds.includes(parent);
  }
  return false;
}

/**
 * 解析一次派出的完整决策。纯计算，除读取传入的官方策略快照外不做 I/O。
 *
 * @param {object} args
 * @param {object} args.policy readPolicyView 的结果
 * @param {object} args.session 调用者会话（来自运行时，不信任工具参数）
 * @param {number} [args.delegationDepth] 调用者当前委派深度
 * @param {string} args.roleId
 * @param {string|undefined} args.routeId
 * @param {string|undefined} args.reasoningEffort
 * @param {ReadonlyArray<object>} [args.snapshotRoutes] 受管根冻结的快照路由；省略则用实时全局
 * @param {{status: string, routes: ReadonlyArray<object>}} [args.official] 官方策略
 * @param {{unknown: ReadonlyArray<string>, state: string}} [args.coverage] 覆盖诊断结果
 * @returns {object} 决策摘要
 */
export function decideDispatch({
  policy, session, delegationDepth, roleId, routeId, reasoningEffort,
  snapshotRoutes, official, coverage,
}) {
  if (policy.requireManagedSession && !isManagedSession(policy, session)) {
    throw new StationError(
      ERROR_CODES.NOT_MANAGED_SESSION,
      '当前会话没有被启用为受管会话，派出所不会在这里派出子智能体。'
      + '请让用户在插件配置的 managedSessionIds 中加入本会话 ID（或在受管会话中发起请求）。',
      { sessionId: session?.id ?? '(unknown)' },
    );
  }

  const depth = Number(delegationDepth) || 0;
  if (policy.forbidNestedDispatch && depth >= 1) {
    throw new StationError(
      ERROR_CODES.NESTED_DISPATCH_FORBIDDEN,
      '受管子智能体不允许创建下一层子智能体。请把需要委派的工作带回主会话处理。',
      { depth },
    );
  }

  // 严格覆盖模式（方案 5.4 第 4 条）：出现目录外派生入口就拒绝派出。
  const coverageReason = coverage === undefined ? undefined : coverageBlockReason({
    coverage, strictCoverage: policy.strictCoverage,
  });
  if (coverageReason !== undefined) throw coverageReason;

  const role = policy.rolesById.get(roleId);
  if (role === undefined) {
    throw new StationError(
      ERROR_CODES.ROLE_NOT_FOUND,
      `岗位「${roleId}」不存在。请先调用 dispatch_roles 查看可用岗位。`,
      { knownRoleIds: [...policy.rolesById.keys()] },
    );
  }
  const blocked = roleBlockReason(role, policy.conflicts);
  if (blocked !== undefined) throw blocked;

  const officialView = official ?? normalizeOfficialPolicy(undefined);
  const officialRoutes = officialView.status === 'enforced' || officialView.status === 'empty'
    ? officialView.routes
    : undefined;

  const effective = effectiveRoutes({
    role,
    routesById: policy.routesById,
    globalAllowedRoutes: policy.allowedRoutes,
    snapshotRoutes: snapshotRoutes ?? policy.allowedRoutes,
    ...(officialRoutes === undefined ? {} : { officialRoutes }),
  });

  // 岗位本来有候选、却被官方层全部排除 → 明确的官方冲突错误（方案 4.2）。
  if (effective.length === 0) {
    const conflict = officialConflictReason({
      role,
      routesById: policy.routesById,
      globalAllowedRoutes: policy.allowedRoutes,
      snapshotRoutes: snapshotRoutes ?? policy.allowedRoutes,
    });
    if (conflict !== undefined) throw conflict;
  }

  const defaultRoute = role.defaultRouteId === ''
    ? undefined
    : effective.find((route) => route.routeId === role.defaultRouteId);

  const { route, reason: routeReason } = resolveRoute({
    role,
    roleRouteId: routeId,
    effective,
    defaultRoute,
    routesById: policy.routesById,
  });
  const { effort, reason: effortReason } = resolveEffort({ route, requested: reasoningEffort });

  return decisionSummary({
    role,
    route,
    effort,
    routeReason,
    effortReason,
    policyRevision: policy.policyRevision,
    effectiveRouteCount: effective.length,
  });
}

/**
 * 把决策摘要渲染成模型可读的回执文本（方案 7.2）。
 *
 * 关键事实同时进入工具结果，避免「只存在于插件内存」。`status` 必须如实反映
 * 已受理 / 待核对，绝不预写「已锁定」——请求级锁定要等首轮请求才被证实。
 *
 * @param {object} args
 * @returns {string}
 */
export function renderReceipt({
  receiptId, childSessionId, decision, status, snapshotVersion, policyRevisionNow, coverage, officialStatus,
  assurance, snapshotDrift,
}) {
  const lines = [
    `派出已受理（回执 ${receiptId}）`,
    `子会话：${childSessionId === '' ? '待核对（宿主未返回 childId，请按会话记录核对）' : childSessionId}`,
    `岗位：${decision.roleLabel}（${decision.roleId}，${decision.mode === 'fixed' ? '固定模型' : '白名单'}）`,
    `已选择路由：${decision.provider}/${decision.model}（${decision.routeId}，依据：${decision.routeReason}）`,
    `思考强度：${decision.reasoningEffort ?? '未指定，由适配器默认'}（依据：${decision.effortReason}）`,
    // **两个数字必须写清维度**（方案 §6.2 的硬规则）。
    //
    // v0.3 写成 `策略修订：12（当前 15）`，读者无法分辨这两个数是不是同一个量。
    // 它们**不是**：`策略修订` 是策略内容的哈希，`快照代数` 是用户按了几次 epoch。
    // 同一个维度才能比较大小，跨维度比较只会得到一句假话。
    `快照代数：${snapshotVersion ?? '（未冻结）'}（配置策略修订：${decision.policyRevision}${
      policyRevisionNow === undefined || policyRevisionNow === decision.policyRevision ? '，一致' : `，现为 ${policyRevisionNow}`}）`,
  ];

  // ── 快照漂移（v0.4，方案 §6.3 的三态）──────────────────────────────────
  //
  // 三种情形必须说三句不同的话。v0.3 把它们压成"策略修订：12（当前 15）"，
  // 用户看到两个不一样的数字，却不知道哪个该管、要不要动手。
  //
  // 注意这里**不比代数**：`快照代数` 与 `策略修订` 是不同维度，
  // 比较它们只会得到一句看起来精确的假话（方案 §6.2）。
  if (snapshotDrift !== undefined) {
    if (snapshotDrift.kind === 'same') {
      lines.push('快照状态：与当前一致');
    } else if (snapshotDrift.kind === 'added') {
      // 新增路由不影响既有求交结果 ⇒ 明确说"未生效"，不要制造"配置错了"的错觉。
      lines.push(`快照状态：${snapshotDrift.added.length} 条新增未生效（${snapshotDrift.added.join('、')}）`);
      lines.push('说明：与当前配置相比，快照缺这几条路由。新增的路由**不会**自动进入本受管会话——'
        + '这是刻意的：正在跑的任务不该因为一次配置追加而换模型。');
    } else if (snapshotDrift.kind === 'narrowed') {
      lines.push(`快照状态：配置已收窄（${snapshotDrift.narrowed.join('、')} 已从当前集合移除）`);
      lines.push('说明：收窄**立即生效**（放宽永不隐式生效，收紧永不延迟生效）。');
    }
  } else if (snapshotVersion !== undefined && policyRevisionNow !== undefined && snapshotVersion !== policyRevisionNow) {
    // 没有 drift 详情时退回到保守措辞：说"变了"，不说"代数落后"。
    lines.push('提示：配置策略修订与冻结时不同。本受管会话仍按冻结的快照求交——放宽不会隐式生效，收紧会立即生效。');
  }

  if (officialStatus !== undefined && officialStatus !== 'enforced') {
    lines.push('官方模型策略：未启用，当前仅受本插件约束');
  }

  // ── 覆盖诊断（v0.4，按 `state` 说话，不按"数组空不空"说话）──────────────
  //
  // v0.3 写的是 `覆盖未完全确认（partial）：目录不可读`——只要 unknown 为空就说
  // "目录不可读"，而实际更常见的是"目录读到了，但有我不认识的条目"。
  // 用户按前一句话会去查文件权限，而真正该做的是升级插件目录。
  if (coverage !== undefined && coverage.state !== 'complete') {
    lines.push(`覆盖未完全确认（${coverage.state}）：${describeCoverageShort(coverage)}`);
    if (coverage.state === 'unrecognized') {
      lines.push('说明：目录**读到了**，只是有不认识的条目（列表见上）。');
    } else if (coverage.state === 'unknown-present') {
      lines.push('说明：有工具在目录外。若它们确实能派生子智能体，请把它们加进 `blockedToolNames`。');
    } else if (coverage.state === 'degraded') {
      lines.push('说明：目录**没能读到**，所以"目录外有没有派生入口"这个问题目前没有答案。');
    }
  }
  // 保证等级（v0.4 新增，G8）：回执不许只承诺"已锁定"，还要说清这个锁定在什么前提下成立。
  if (assurance !== undefined) {
    lines.push(`保证等级：${assurance.label}`);
    for (const reason of assurance.reasons) {
      lines.push(`  · [${reason.layer}] ${reason.reason}`);
      if (reason.fix !== undefined) lines.push(`    修复：${reason.fix}`);
    }
  }
  lines.push(`状态：${status}`);
  return lines.join('\n');
}

/**
 * 覆盖诊断的**一行摘要**（回执用）。
 *
 * 与 `describeCoverage()` 的分工：那个是给 `station_status` 的多行块（含结论与修复），
 * 这里只要一行——回执已经很长了，再加一个块会淹没"已选择路由"。
 *
 * @param {object} coverage
 * @returns {string}
 */
function describeCoverageShort(coverage) {
  if (coverage.state === 'unrecognized') {
    const names = coverage.unrecognized ?? [];
    return names.length === 0 ? '有不认识的条目（列表为空，可能是读到了但没记下名字）' : names.join('、');
  }
  if (coverage.state === 'unknown-present') {
    const names = coverage.unknown ?? [];
    return names.length === 0 ? '有目录外工具' : names.join('、');
  }
  if (coverage.state === 'degraded') {
    return coverage.reason === undefined ? '目录不可读' : `目录不可读（${coverage.reason}）`;
  }
  return '无';
}

/**
 * 计算回执要显示的**快照漂移**三态（方案 §6.3）。
 *
 * 为什么要单独一个函数：这个判断必须在"冻结集合"与"当前集合"之间做，
 * 而 `renderReceipt` 只该负责说话。混在一起会让"比较"和"措辞"互相纠缠，
 * 一旦某一态的判断错了，另一态的措辞也会跟着被怀疑。
 *
 * @param {object} args
 * @param {string[]|undefined} args.frozen 冻结时的路由 id 集合
 * @param {string[]|undefined} args.current 当前的全局路由 id 集合
 * @returns {{kind: 'same'|'added'|'narrowed', added: string[], narrowed: string[]}|undefined}
 */
export function computeSnapshotDrift({ frozen, current }) {
  if (frozen === undefined || current === undefined) return undefined;
  const frozenSet = new Set(frozen);
  const currentSet = new Set(current);
  const added = [...currentSet].filter((id) => !frozenSet.has(id));
  const narrowed = [...frozenSet].filter((id) => !currentSet.has(id));
  // 收窄优先：它**立即生效**，是用户需要马上知道的那件事。
  // 若同时存在收窄与新增，说"收窄"并不可惜——新增本来就不生效，无关紧要。
  if (narrowed.length > 0) return { kind: 'narrowed', added, narrowed };
  if (added.length > 0) return { kind: 'added', added, narrowed };
  return { kind: 'same', added: [], narrowed: [] };
}

/**
 * 把 `buildStatus()` 的结构化结果渲染成**人可读、同时可解析**的纯文本（方案 §10.2）。
 *
 * 为什么不是 JSON：这个工具的第一用途是「用户与模型都能一眼看懂发生了什么」。
 * JSON 在那件事上比这张表差得多；需要的结构化数据走 `subagentStation.snapshot()`。
 *
 * @param {object} status `buildStatus()` 的返回值
 * @returns {string}
 */
function renderStatus(status) {
  const lines = [];
  lines.push('派出所状态');

  // §10.4：第一行固定带安装自检。用户能调这个工具，就说明插件确实加载了——
  // 这条要明说，因为 v0.2 出过「以为装了其实没装」的误判。
  lines.push(`- 安装：已加载（entry dsh-subagent-station）`);

  // ── 保证等级（v0.4，方案 §6.5 / G8）────────────────────────────────────
  //
  // 放在最前面，因为它是**唯一一个总括性判断**：下面所有内容的可信度都由它决定。
  // 台账打不开时，后面那些"受管根 1 个"其实来自配置而非台账，
  // 用户必须**先**知道这一点再去读后面的数字。
  if (status.assurance !== undefined) {
    lines.push(`- 保证等级：${status.assurance.label}`);
    for (const reason of status.assurance.reasons) {
      lines.push(`  · [${reason.layer}] ${reason.reason}`);
      if (reason.fix !== undefined) lines.push(`    修复：${reason.fix}`);
    }
  }

  // 本会话。
  const self = status.self;
  if (self === undefined) {
    lines.push('- 本会话：（未提供作用域，无法判定；请从有会话的上下文调用）');
  } else if (self.managed) {
    lines.push(`- 本会话：${self.sessionId === '' ? '（未知 id）' : self.sessionId}（受管｜${self.isChild ? '子会话' : '根会话'}｜谱系 ${self.lineage}）`);
  } else {
    // 未受管时最重要的一句：给出 id 与两种纳入方式，否则用户无从下手。
    lines.push(`- 本会话：${self.sessionId === '' ? '（未知 id）' : self.sessionId}（**未受管**）`);
    lines.push(`  · 原因：${describeManagedReason(self.managedReason)}；谱系根 ${self.rootSessionId || '（无）'}`);
    lines.push('  · 纳入方式一：把上面的 id 加进 `managedSessionIds` 配置');
    lines.push('  · 纳入方式二：把 `manageAllNewRoots` 设为 `true`（新的根会话自动受管）');
  }

  // 受管根与会话统计。
  const managedRoots = new Set(status.managedLive.map((s) => s.rootSessionId).filter((id) => id !== ''));
  lines.push(`- 受管根：${managedRoots.size} 个${managedRoots.size === 0 ? '' : `（${[...managedRoots].join('、')}）`}`);
  lines.push(
    `- 存活会话：${status.live.length} 个，其中受管 ${status.managedLive.length} 个`
    + `；未受管 ${status.unmanagedLive.length} 个${status.unmanagedLive.length === 0 ? '' : `：${status.unmanagedLive.map((s) => s.sessionId || '(无 id)').join('、')}`}`,
  );
  // 谱系解析能力：`limited` 说明宿主没给 `sessions`，此时深孙级可能判不出来——
  // 这必须说出来，否则用户会以为「报未受管」是配置错。
  const lineageStates = [...new Set(status.live.map((s) => s.lineage))];
  if (lineageStates.includes('limited')) {
    lines.push('- 谱系解析：limited（宿主未提供 `sessions`，只能用直接父会话判定；深孙级可能被判为未受管）');
  } else {
    lines.push('- 谱系解析：full');
  }

  // 策略。
  const disabled = status.roles.filter((r) => r.enabled === false).length;
  lines.push(`- 策略：${status.allowedRoutes.length} 条路由 / ${status.roles.length} 个岗位（${disabled} 个禁用、${status.conflicts.length} 个冲突）`);
  lines.push(`- 覆盖诊断的目录外策略：${status.unknownEntryPolicy}`);
  lines.push(`- 快照代数：${status.snapshotEpoch}`);

  // 官方。
  const officialRoutes = status.official?.routes?.length ?? 0;
  const officialState = status.official?.status === 'enforced'
    ? `已启用，${officialRoutes} 条`
    : status.official?.status === 'disabled'
      ? '未启用'
      : status.official?.status === 'empty'
        ? '已启用但没有允许任何模型（会拒绝全部派出）'
        : '未安装';
  lines.push(`- 官方模型策略：${officialState}`);

  // 台账。
  if (status.ledgerReady) {
    lines.push(`- 台账：正常（回执 ${status.receipts.length} / 子会话 ${status.children.length} / 偏离 ${status.deviations.length}）`);
  } else {
    lines.push(`- 台账：**不可用**（${status.ledgerError ?? '原因未知'}）——派出已被禁用`);
  }

  // 表健康（v0.4，方案 §7.2 / T75）。
  //
  // 为什么必须单独一行：表被删掉时，`listDeviations()` 会**抛错**，
  // 而调用方通常包了 try 并退化成空数组——于是"表没了"与"表里 0 条"
  // 在状态里长得一模一样。用户看到"偏离 0"会以为一切正常。
  //
  // 所以这里逐个明说"这张表在不在"。`✓` / `✗` 是刻意选的符号：
  // 它比"正常/异常"更难被一眼扫过去。
  if (status.ledgerTables !== undefined) {
    const missing = status.ledgerTables.filter((t) => !t.ok);
    lines.push(`  · 表：${status.ledgerTables.map((t) => `${t.name} ${t.ok ? '✓' : '✗'}`).join(' / ')}`);
    if (missing.length > 0) {
      lines.push(
        `  · **注意**：${missing.map((t) => t.name).join('、')} 不可读（${missing[0].error ?? '原因未知'}）。`
        + '这意味着**过去是否发生过偏离无法回答**——"偏离 0"这个数字此时是假的。',
      );
    }
  }
  if (status.orphanReceipts.length > 0) {
    lines.push(`  · 注意：${status.orphanReceipts.length} 条回执找不到对应子会话登记（台账可能被部分清空）`);
  }
  if (status.orphanChildren.length > 0) {
    lines.push(`  · 注意：${status.orphanChildren.length} 条子会话登记找不到对应回执`);
  }

  // 漏网（v0.4，方案 §9.4 T81）。
  //
  // 这一节只在**有**漏网时才出现，而且是醒目的：它是"有人绕过入口派过东西"的
  // 唯一证据。一直显示"漏网 0 条"反而会变成噪音，被人一眼扫过。
  if (Array.isArray(status.escapes) && status.escapes.length > 0) {
    lines.push(`  · **漏网 ${status.escapes.length} 个**：以下子会话不是通过本插件派出的`);
    for (const e of status.escapes.slice(0, 10)) {
      const when = e.observedAt === undefined ? '时间未记录' : formatMoment(e.observedAt);
      const route = e.provider === undefined && e.model === undefined
        ? ''
        : `（${String(e.provider ?? '?')}/${String(e.model ?? '?')}）`;
      lines.push(`    - ${e.childSessionId}${route} @ ${when}`);
    }
    if (status.escapes.length > 10) lines.push(`    - …还有 ${status.escapes.length - 10} 个`);
    lines.push('    → 它们的请求会被 L3 以 `STATION_UNMANAGED_CHILD` 拒绝（**没有**真正生效），'
      + '但"曾被创建"这件事本身已经发生了。');
  }

  // 覆盖（v0.4：按 `state` 分支渲染，见 `describeCoverage` 的文档）。
  //
  // v0.3 这里只打印一行状态名 + 两个计数，于是 `degraded` 看起来和 `complete`
  // 差不多——而前者是"没法查"，后者是"查过了没问题"。那是两件相反的事。
  lines.push(...describeCoverage(status.coverage.global, { label: '全局' }));
  const s = status.coverage.scoped;
  if (s !== undefined) lines.push(...describeCoverage(s, { label: '本会话作用域' }));

  // 最近偏离。
  if (status.recentDeviation !== undefined) {
    const d = status.recentDeviation;
    // v0.4：区分 `error`（宿主真的换了模型，我们压回）与 `notice`（宿主还没定路由，我们补初值）。
    //
    // 混在一起会让"偏离 12 次"这个数字失去意义：其中 11 次可能只是首轮初始化。
    const kind = d.kind === 'notice' ? 'notice（正常初始化，不是冲突）' : 'error（宿主换了模型，已被压回）';
    lines.push(
      `- 最近偏离：${d.childSessionId || '(未知子会话)'} 第 ${d.turn ?? '?'} 轮`
      + ` · ${kind}`
      + `｜尝试 ${String(d.attemptedProvider ?? '')}/${String(d.attemptedModel ?? '')}`
      + ` → 压回 ${String(d.forcedProvider ?? '')}/${String(d.forcedModel ?? '')}`
      + `（${d.at === undefined ? '时间未记录' : formatMoment(d.at)}）`,
    );
  } else {
    lines.push('- 最近偏离：无');
  }

  // 上次扫描。
  lines.push(`- 上次扫描：${status.sweptAt === undefined ? '未执行' : formatMoment(status.sweptAt)}`);

  // ── 自证（v0.4 新增，方案 §7.2 / 改进方案 §10.4）──────────────────────────
  //
  // 这一节回答的是一个问题：**「你怎么证明自己真的在工作？」**
  //
  // v0.3 的 `station_status` 只能列出配置与台账内容。用户看到一份空台账时，
  // 无法分辨「插件没工作」与「插件工作了、只是没人派出」——这两种情况的
  // 运维动作完全相反（前者要查安装，后者不用管）。
  //
  // 所以这里必须给出**只有真的跑过才会有**的痕迹：判定次数、首次评估时间、
  // 以及台账自己的打开次数。这些数字用户无法从配置里推出来。
  const stats = status.guardStats;
  if (stats !== undefined) {
    lines.push('- 守卫自证：');
    lines.push(`  · 已评估 ${stats.evaluated} 次调用（其中 ${stats.candidates} 次命中候选名，其余直接放行）`);
    if (stats.firstEvaluatedAt === undefined) {
      lines.push('  · 首次评估：尚未发生（插件加载后还没有任何工具调用经过守卫）');
    } else {
      lines.push(`  · 首次评估：${formatMoment(stats.firstEvaluatedAt)}（${formatAgo(stats.sinceLastMs)}前最近一次）`);
    }
    lines.push(`  · 拒绝 ${stats.deniedTotal} 次${
      stats.denials.length === 0
        ? ''
        : `（${stats.denials.map((d) => `${d.code}×${d.count}`).join('、')}）`}`);
    if (!stats.observed) {
      lines.push('  · **注意**：本次加载后守卫从未被调用过。若你刚在别的会话里用过工具，'
        + '这说明守卫没有挂上（安装问题），而不是"没有违规"。');
    }
  }

  // 台账自证（跨重启）。
  if (status.ledgerMeta !== undefined) {
    const m = status.ledgerMeta;
    const c = m.counters ?? {};
    const crashNote = typeof m.lastClosedAt === 'number' && m.lastClosedAt < m.lastOpenedAt
      ? '上次未正常关闭（可能崩溃或被强制结束）'
      : '上次正常关闭';
    lines.push('- 台账自证：');
    lines.push(`  · 已打开 ${c.opened ?? 0} 次；首次 ${formatMoment(m.firstOpenedAt)}；${crashNote}`);
    lines.push(`  · 累计写入：回执 ${c.receiptWrites ?? 0} / 子会话 ${c.childWrites ?? 0}`
      + ` / 偏离 ${c.deviationWrites ?? 0} / 终态收尾 ${c.settles ?? 0}`
      + ` / 启动对账 ${c.reconciliations ?? 0}`
      + `${(c.childRecoveries ?? 0) > 0 ? ` / 预置登记回收 ${c.childRecoveries}` : ''}`
      + `${(c.escapeWrites ?? 0) > 0 ? ` / **漏网记录 ${c.escapeWrites}**` : ''}`);
  }

  return lines.join('\n');
}

/**
 * `managedReason` 的中文解释（诊断要能自解释，方案 §10.2）。
 * @param {string} reason
 * @returns {string}
 */
function describeManagedReason(reason) {
  switch (reason) {
    case 'root-listed': return '谱系根在 `managedSessionIds` 里';
    case 'session-listed': return '本会话 id 直接在 `managedSessionIds` 里';
    case 'manage-all-new-roots': return '`manageAllNewRoots` 已开启';
    case 'not-listed': return '本会话与其谱系根都不在 `managedSessionIds` 里，且 `manageAllNewRoots` 未开启';
    default: return String(reason);
  }
}

/**
 * 把某个岗位的 dry-run 渲染出来（`station_status` 带 `roleId` 时）。
 *
 * @param {object} status
 * @param {string} roleId
 * @param {object} policy
 * @param {object} [session]
 * @returns {string}
 */
function renderRoleDryRun(status, roleId, policy, session) {
  const lines = [];
  lines.push(`岗位 ${roleId} dry-run`);
  const conflicts = status.conflicts.filter((c) => c.roleId === roleId);
  if (conflicts.length > 0) {
    lines.push('- 决定：配置冲突，暂不可派出');
    for (const c of conflicts) lines.push(`  · ${c.reason}`);
    return lines.join('\n');
  }

  // **dry-run 绝不抛错**（方案 §8.2）。
  //
  // `decideDispatch` 在拒绝时会抛 `StationError`。dry-run 的存在意义恰恰是
  // "在不真的派出的前提下，如实告诉用户会发生什么"——如果它也抛，
  // 用户就只能看到一条错误，看不到"为什么"和"怎么改"。
  //
  // 所以这里捕获并分级渲染：拒绝带码 + 文案；无法判定另起一类（那是缺输入，不是拒绝）。
  let decision;
  try {
    decision = decideDispatch({
      policy,
      session: session ?? { id: '', header: {} },
      delegationDepth: 0,
      roleId,
      official: status.official,
      coverage: status.coverage.scoped ?? status.coverage.global,
    });
  } catch (error) {
    lines.push(...renderDryRunRefusal(error));
    return lines.join('\n');
  }

  lines.push('- 决定：可派出');
  lines.push(`- 路由：${decision.provider}/${decision.model}（依据：${decision.routeReason}）`);
  lines.push(`- 思考强度：${decision.reasoningEffort ?? '（由适配器默认决定）'}（依据：${decision.effortReason}）`);
  lines.push(`- 求交：岗位∩全局∩快照∩官方 → ${decision.effectiveRouteCount ?? '?'} 条`);
  return lines.join('\n');
}

/**
 * 把一次 dry-run 的拒绝/无法判定渲染成两行（方案 §8.2 的固定格式）。
 *
 * 两个标签**必须**分开：
 *
 * - `决定：拒绝（码…）` —— 判定完成，结论是不许。用户按 `修复：` 改就能过。
 * - `决定：无法判定（码：原因）` —— 判定没完成。用户改配置通常没用，得先补输入。
 *
 * 混成一个标签会让用户对着一句"拒绝"找不到北（v0.3 的 `STATION_POLICY_UNREADABLE`
 * 就经常是"读不出来"，被渲染成"拒绝"）。
 *
 * @param {unknown} error
 * @returns {Array<string>}
 */
function renderDryRunRefusal(error) {
  const refusal = describeRefusal(error);
  if (!refusal.isStation) {
    return [
      `- 决定：无法判定（${refusal.code}：${refusal.message}）`,
      `- 修复：${refusal.fix}`,
    ];
  }
  // 「无法判定」= 缺输入的那几个码。它们不是"你不许派"，是"我还不知道"。
  const undecidable = refusal.code === ERROR_CODES.POLICY_UNREADABLE
    || refusal.code === ERROR_CODES.LINEAGE_UNKNOWN
    || refusal.code === ERROR_CODES.LEDGER_UNAVAILABLE;
  return undecidable
    ? [`- 决定：无法判定（${refusal.code}：${refusal.message}）`, `- 修复：${refusal.fix}`]
    : [`- 决定：拒绝（${refusal.code}）`, `- 说明：${refusal.message}`, `- 修复：${refusal.fix}`];
}

/**
 * 注册 `station_status`（方案 §10）。工具总数由此变成 3 个。
 *
 * @param {object} ctx
 * @param {object} deps
 * @returns {() => void} disposer
 */
function registerStationStatus(ctx, deps) {
  const { buildStatus, readPolicy } = deps;
  const defineTool = resolveDefineTool();
  if (defineTool === undefined) return () => {};
  if (typeof ctx.tools?.register !== 'function') return () => {};

  const dispose = ctx.tools.register(defineTool({
    name: 'station_status',
    description:
      'Show what the subagent station actually enforces right now: whether this session is managed, '
      + 'which routes and roles exist, ledger health, coverage gaps, and the last route deviation. '
      + 'Pass roleId to dry-run one role without dispatching.',
    parameters: {
      roleId: {
        type: 'string',
        description: 'Optional. Dry-run one role: whether it can dispatch now, and which route it would get.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const scope = exec?.agent;
      // ── 诊断工具**永远不能**自己报错（v0.4，方案 §6.6 / 问题 4）──────────
      //
      // 这是本插件唯一一个"用来排查问题"的工具。如果它先坏了，用户就**没有任何
      // 工具可用**了——包括查明"为什么坏了"的那一个。
      //
      // 所以整段包在 try 里：任何内部异常都必须变成一段**可读的诊断文本**，
      // 且带上码（`决定：无法判定（STATION_…）`），而不是变成一个 `isError`。
      let status;
      try {
        status = buildStatus(scope);
      } catch (error) {
        const refusal = describeRefusal(
          error instanceof StationError
            ? error
            : new StationError(
              ERROR_CODES.INTERNAL,
              `状态诊断自身失败：${String(error?.message ?? error)}`,
              { cause: error },
            ),
          { includeFix: true },
        );
        return [
          '派出所状态',
          `- 安装：已加载（但本次诊断失败）`,
          `- 决定：无法判定（${refusal.code}）`,
          `- 说明：${refusal.message}`,
          ...(refusal.fix === undefined ? [] : [`- 修复：${refusal.fix}`]),
          '- 注意：这一段是**诊断工具自己的失败**，不是插件整体失效。'
          + '守卫与锁定仍在运行；只有"读取现状"这一步出错了。',
        ].join('\n');
      }
      const text = renderStatus(status);
      const roleId = typeof args?.roleId === 'string' && args.roleId !== '' ? args.roleId : undefined;
      if (roleId === undefined) return text;

      if (!status.roles.some((r) => r.roleId === roleId)) {
        return `${text}\n\n岗位 ${roleId}：不存在。当前可用：${status.roles.map((r) => r.roleId).join('、') || '（无）'}`;
      }
      try {
        // dry-run 问的是「这个岗位在当前配置下能不能派」，不该被「调用者自己的会话
        // 是否受管」挡住——否则未受管用户永远看不到岗位诊断，而那正是最需要它的人。
        //
        // 因此这里构造一个**受管根形态**的会话：id 取 `managedSessionIds` 里的第一个，
        // 没有就造一个占位 id。这不是伪造结果：dry-run 只回答「假如在受管根上派出会怎样」，
        // 而真实的受管判定已经在上面那行「本会话：未受管」里如实说过一次了。
        const managedId = status.managedSessionIds[0] ?? 'station-status-dry-run';
        const dryRunSession = { id: managedId, header: { delegationDepth: 0 } };
        const lines = renderRoleDryRun(status, roleId, readPolicy(), dryRunSession);
        return `${text}\n\n${lines}${status.self?.managed === false ? '\n（注：以上是「假如在受管根上派出」的结果；本会话当前未受管，实际无法派出。）' : ''}`;
      } catch (error) {
        // dry-run 失败本身就是诊断信息，不要把它变成工具调用失败。
        return `${text}\n\n岗位 ${roleId} dry-run 失败：${String(error?.message ?? error)}`;
      }
    },
  }));

  return typeof dispose === 'function' ? dispose : () => {};
}

/**
 * 注册 `dispatch_roles` 与 `dispatch_agent`（方案 7.1 / 7.3）。
 *
 * 两个工具都用 `defineTool` 编译；`output.render` 用真实签名 `(args, value)`。
 * 这不是风格问题：`register()` 会校验 `output.schema` 且要求 `render` 存在
 * （`.host-src/dsh-tools.js:2977-2978`），v0.1 的裸对象写法在加载期就会抛错。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} deps
 * @returns {() => void} 组合 disposer
 */
function registerTools(ctx, deps) {
  const { readPolicy, dispatch } = deps;
  const defineTool = resolveDefineTool();
  if (defineTool === undefined) {
    ctx.logger?.error?.(
      '[dsh-subagent-station] 取不到 @deepseek-ai/dsh-tools 的 defineTool，'
      + '派出工具未注册。这是部署问题（宿主应提供该包），不是配置问题。',
    );
    return () => {};
  }

  const disposers = [];

  disposers.push(ctx.tools.register(defineTool({
    name: 'dispatch_roles',
    description:
      'List the subagent roles this session may dispatch, with their purpose, mode and selectable route ids. '
      + 'Roles are listed on demand — their details are not part of the system prompt.',
    parameters: {
      roleId: {
        type: 'string',
        description: 'Optional. Pass one role id to get just that role (fewer tokens than listing everything).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const policy = readPolicy();
      const only = typeof args?.roleId === 'string' && args.roleId !== '' ? args.roleId : undefined;
      const roles = [...policy.rolesById.values()]
        .filter((role) => only === undefined || role.roleId === only);
      if (roles.length === 0) {
        return only === undefined
          ? '当前没有配置任何岗位，因此不能派出子智能体。请让用户先在插件配置里添加岗位与允许路由。'
          : `岗位「${only}」不存在。当前可用：${[...policy.rolesById.keys()].join('、') || '（无）'}`;
      }
      const lines = [];
      for (const role of roles) {
        const own = policy.conflicts.filter((c) => c.roleId === role.roleId);
        const state = role.enabled ? (own.length > 0 ? '配置冲突，暂不可派出' : '可派出') : '已禁用';
        lines.push(`- ${role.roleId}｜${role.label}｜${role.mode === 'fixed' ? '固定模型' : '白名单'}｜${state}`);
        if (role.description !== '') lines.push(`  用途：${role.description}`);
        const selectable = role.mode === 'fixed' ? [role.defaultRouteId] : role.allowedRouteIds;
        const rendered = selectable.map((id) => {
          const route = policy.routesById.get(id);
          return route === undefined ? `${id}（未定义）` : `${id} = ${route.provider}/${route.model}`;
        });
        lines.push(`  路由：${rendered.join('；') || '（无）'}`);
        if (own.length > 0) {
          for (const conflict of own) lines.push(`  冲突：${conflict.message}`);
        }
      }
      const official = deps.readOfficial();
      if (official.status !== 'enforced') {
        lines.push('');
        lines.push('提示：官方「子智能体模型选择」策略未启用，当前只受本插件约束。');
      }
      return lines.join('\n');
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'dispatch_agent',
    description:
      'Dispatch a subagent under a configured role. The role binds the child to an approved provider/model; '
      + 'that binding is enforced on every model request of the child, not only at creation. '
      + 'Returns a receipt — it does not wait for the result and does not return the child\'s answer.',
    parameters: {
      roleId: { type: 'string', required: true, description: 'Role id from dispatch_roles.' },
      description: { type: 'string', required: true, description: 'Short task title; becomes the child session label.' },
      prompt: { type: 'string', required: true, description: 'Self-contained task instructions for the child.' },
      routeId: {
        type: 'string',
        description: 'Optional. Allowlist roles use this to pick a route; fixed roles accept only their default.',
      },
      reasoningEffort: {
        type: 'string',
        description: 'Optional. Must be supported by the chosen route; unsupported values are rejected.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return dispatch(args, exec);
    },
  })));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载路径上的失败不应连累其它工具。
      }
    }
  };
}

/**
 * 插件入口。
 * @param {object} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  /** 实时策略读取器：每次都重新解释 Config，保证热更新立即生效。 */
  const readPolicy = () => readPolicyView(rawConfig);

  /**
   * 目录缓存（方案 §8.6）。
   *
   * `delegation-catalog.json` 是随包发布的构建产物，正常不变化；但 G6 的主张是
   * 「诊断要看得见」，那么「目录换了一版而插件还按旧的判断」就属于同一类失真。
   * 用 `tools/change` 事件失效即可，成本是一次模块加载。
   */
  let catalogCache;
  let catalogLoaded = false;
  const readCatalog = () => {
    if (!catalogLoaded) {
      catalogCache = readCatalogFile();
      catalogLoaded = true;
    }
    return catalogCache;
  };

  /** 台账句柄；打不开时保持 undefined，派出被拒绝（方案 6.2）。 */
  let ledger;
  let ledgerError;
  let disposed = false;
  /** 上次启动扫描的时间戳（`station_status` 用，方案 §4.5）。 */
  let sweptAt;

  /** 受管根会话 id → `subagent/end` 监听的撤销函数（方案 §6.4，一个根只挂一份）。 */
  const endListeners = new Map();

  /** 受管根会话 id → `subagent/start` 漏网检测的撤销函数（v0.4，T81）。 */
  const startListeners = new Map();

  /** 曾经被 L4 治理过的会话 id（诊断用：证明"哪些根被挂过终态监听"）。 */
  const endListenerRoots = () => [...endListeners.keys()];

  /** 读取官方模型策略（方案 4.2）。读不到就当「这一层不存在」，并保留错误供诊断。 */
  const readOfficial = () => {
    try {
      const service = ctx.get?.('subagentModelSelection');
      if (service === undefined || typeof service.current !== 'function') {
        return normalizeOfficialPolicy(undefined);
      }
      return normalizeOfficialPolicy(service.current());
    } catch {
      // 官方服务自己的 `current()` 在「启用但没有允许任何模型」时会抛错。
      // 那是配置不一致，按「全拒绝」处理（放行更危险）。
      return { status: 'empty', routes: [] };
    }
  };

  /**
   * 覆盖诊断（v0.3：**作用域内视图**，方案 §8.5）。
   *
   * v0.2 只读 `ctx.tools.schemas()`（全局视图），因此插件 / preset / MCP 的 scoped 注册
   * 在诊断里完全不可见，结论偏乐观（P2-C）。现在接受可选 scope：
   * 省略 = 全局视图；传 agent = 该 agent 真实看得见的工具集合。
   *
   * @param {object} [scope] agent（即 `tools.schemas(scope)` 的 `ScopeKey`）
   * @returns {object} 覆盖诊断结果
   */
  const computeCoverageFor = (scope) => {
    let names = [];
    try {
      const schemas = ctx.tools?.schemas?.(scope);
      if (Array.isArray(schemas)) names = schemas.map((s) => s?.name).filter((n) => typeof n === 'string');
    } catch {
      names = [];
    }
    return computeCoverage({ visibleNames: names, catalog: readCatalog(), extraBlockedNames: readPolicy().blockedToolNames });
  };

  /** 全局视图的覆盖诊断（回退路径与单元测试用）。 */
  const readCoverage = () => computeCoverageFor(undefined);

  /** `sessions` 服务（谱系解析用）。取不到就当「只到一层」，不因此拒绝派出。 */
  const readSessions = () => {
    try {
      const sessions = ctx.get?.('sessions');
      return typeof sessions?.get === 'function' ? sessions : undefined;
    } catch {
      return undefined;
    }
  };

  /** 入口守卫（方案 §2.2 / §2.4，L2）。**一个**全局实例，与任何会话无关。 */
  const stats = createStats();
  const governor = createEntryGovernor({
    readPolicy,
    readCatalog,
    readSessions,
    readLedger: () => ledger,
    stats,
  });

  /**
   * **L2 全局挂载（v0.4 的核心，方案 §2.2）**。
   *
   * v0.3 把 guard 挂在各个 `agent.ctx` 上，前提是"挂载时刻这个会话受管"。
   * 于是配置晚到时治理就晚到（问题 1）。v0.4 改成：**挂在插件根 `ctx` 上，只挂一次**。
   *
   * 宿主契约（`.host-src/dsh-tools.js:3007-3016`，C1/C2）：
   * 普通上下文的 guard 落进 **global 层**，对所有 agent 生效；且拒绝是单调的。
   *
   * 因此这个 guard 的生命周期与**任何会话**无关——它从插件加载到卸载一直存在。
   * 「某个会话现在受不受管」是**每次调用现算**的问题，不是挂载问题（I2）。
   *
   * 卸载时 `ctx.effect` 会调 disposer（S1-e 已实测撤销后立即恢复放行，I7）。
   */
  ctx.effect(() => {
    if (typeof ctx.tools?.guard !== 'function') {
      ctx.logger?.warn?.(
        '[dsh-subagent-station] 宿主没有 `tools.guard`，入口守卫无法安装：'
        + '受管会话的原生派生入口将**不被拦截**。这是降级，不是正常状态。',
      );
      return () => {};
    }
    const dispose = ctx.tools.guard((exec) => {
      // 卸载过程中不再判定（避免把 teardown 期间的清理工具调用拦掉）。
      if (disposed) return undefined;
      return governor.decideForCall(exec);
    });
      return () => {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        // 卸载路径上的失败不应连累其它 disposer（I7）。
      }
      stats.reset();
    };
  }, 'dsh-subagent-station: global entry guard');

  /**
   * **L3 全局挂载（v0.4，方案 §2.4 / §4 S2）**：请求级路由锁定。
   *
   * S2-a 实测：普通上下文上的 `agent/request` 监听器收到**全部** agent 的请求
   * （`["global:a","global:b"]`）。所以锁定不必逐子会话挂载，也就不再有
   * 「台账就绪后补扫一次、给既有子会话挂锁定」那个窗口。
   *
   * 全局化带来的风险（不能靠作用域隔离了）由 `mountRequestLock` 内部的
   * **逐请求自校验**承担：它从 `payload.agent.session.id` 现读身份，
   * 绝不依赖闭包。
   */
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {};
    return mountRequestLock({
      ctx,
      readLedger: () => ledger,
      readPolicy,
      // 谱系与受管判定都复用 `entry-governor.js` 的同一套函数——
      // 两处各写一遍是"状态说受管、锁定却不管"这类漂移的温床。
      resolveLineage: (agent) => resolveRootSessionId(agent, { sessions: readSessions() }),
      classify: (policy, agent) => classifyAgent(policy, agent, { sessions: readSessions() }),
      isEnabled: () => !disposed,
      stats,
    });
  }, 'dsh-subagent-station: global request lock');

  ctx.effect(() => {
    (async () => {
      try {
        const storageDomain = ctx.get?.('storageDomain');
        if (storageDomain === undefined || typeof storageDomain.open !== 'function') {
          throw new StationError(
            ERROR_CODES.LEDGER_UNAVAILABLE,
            '宿主没有挂载 `storageDomain`，派出所无法建立派出台账。'
            + '没有台账就无法保证「派了必有记录」与跨重启解释，因此派出被禁用。',
          );
        }
        ledger = await openLedger(storageDomain);
        // 重启对账（方案 9.3 第 4 条）：未完结的回执标 unverified，不自动重派。
        const sessions = ctx.get?.('sessions');
        const stale = await ledger.reconcileStaleReceipts((childSessionId) => {
          try {
            return sessions?.get?.(childSessionId) !== undefined;
          } catch {
            return false;
          }
        });
        if (stale.length > 0) {
          ctx.logger?.warn?.(
            `[dsh-subagent-station] ${stale.length} 条未完结的派出回执已标记为 unverified（不会自动重派）：`
            + stale.map((r) => r.receiptId).join('、'),
          );
        }
        // 台账就绪。
        //
        // v0.3 在这里"补跑一次启动扫描，这次能给既有子会话挂上请求锁定"。
        // v0.4 整段删除：L2 守卫与 L3 锁定都是**全局挂载**，从插件加载那一刻起
        // 就覆盖全部会话（含尚未出现的）。不存在"需要等台账才能挂上"的东西了。
        // 台账就绪只影响**判定内容**（`readLedger()` 从 undefined 变成句柄），
        // 而判定内容是每次调用现读的。
      } catch (error) {
        ledgerError = error;
        ctx.logger?.error?.(`[dsh-subagent-station] 台账不可用：${String(error?.message ?? error)}`);
      }
    })();
    return async () => {
      disposed = true;
      // 注意：这里**不再**撤销 L2 守卫或 L3 锁定。它们各自有独立的 `ctx.effect`，
      // 由 cordis 分别调用自己的 disposer。本 effect 只管台账与 L4 监听。
      //
      // v0.3 的 `governor.disposeAll()` / `requestLockDisposers` 之所以在这里，
      // 是因为那两层曾经是**逐会话挂载**的、生命周期绑定在被治理的 agent 上。
      // 拆开还有一个实际好处：台账关闭失败不会让守卫泄漏（I7）。
      if (ledger !== undefined) {
        try {
          await ledger.close();
        } catch {
          // 关闭失败不应抛到卸载路径。
        }
        ledger = undefined;
      }
      for (const dispose of [...endListeners.values()]) {
        try {
          dispose();
        } catch {
          // 卸载路径上的失败不应抛到卸载路径。
        }
      }
      endListeners.clear();
      startListeners.clear();
    };
  }, 'dsh-subagent-station: ledger');

  /** 入口治理器（方案 5.1 / 5.2）。由上面的 effect 卸载，无需重复声明。 */

  /**
   * 为受管根会话冻结 / 收紧 / 重建策略快照（方案 4.3 + v0.3 §7）。
   *
   * 基础规则：**放宽永不隐式生效，收紧永不延迟生效。**
   * - 首次遇到该根 → 冻结当前全局集合；
   * - 已冻结且当前全局比快照**小** → 立刻收紧快照；
   * - 已冻结且当前全局比快照**大** → 不动快照（用户需显式重建）。
   *
   * v0.3 补上两个出口（v0.2 的 §1.3 事故就是缺它们造成的）：
   * 1. **空快照自愈**：`stationRoutes: []` 不构成「已授权集合」，视作尚未冻结。
   *    否则「首次派出发生在路由表为空时」会让该根**永远**无法派出。
   * 2. **显式重建**：`snapshotEpoch` 变化时按当前集合重新冻结。这是唯一会让「放宽」
   *    生效的入口，且是一个纯配置动作（不占模型上下文，不新增工具）。
   *
   * @param {string} rootSessionId
   * @param {object} policy
   * @returns {Promise<{snapshotRoutes: Array<object>, snapshotVersion: number, rebuilt?: boolean}|undefined>}
   */
  const ensureSnapshot = async (rootSessionId, policy) => {
    if (ledger === undefined || typeof rootSessionId !== 'string' || rootSessionId === '') return undefined;

    /** 把台账里的快照路由还原成带 `efforts` 的运行时路由。 */
    const hydrate = (routes) => routes.map((r) => {
      const live = policy.routesById.get(r.routeId);
      return live ?? { routeId: r.routeId, provider: r.provider, model: r.model, efforts: [] };
    });

    /** 把当前全局集合适配成台账里的快照形状。 */
    const freeze = () => policy.allowedRoutes.map((r) => ({
      routeId: r.routeId,
      provider: r.provider,
      model: r.model,
      ...(r.defaultEffort === undefined ? {} : { reasoningEffort: r.defaultEffort }),
    }));

    const existing = ledger.getManagedRoot(rootSessionId);

    // 判定「要不要按当前集合重新冻结」，以及原因。
    const snapshotIsEmpty = existing !== undefined && existing.stationRoutes.length === 0;
    const emptySelfHeal = snapshotIsEmpty && policy.allowedRoutes.length > 0;
    // 旧记录的 `epoch` 缺省按 0 读（方案 §11.2：升级不触发意外重建）。
    const storedEpoch = Number(existing?.epoch ?? 0);
    const epochChanged = existing !== undefined && storedEpoch !== policy.snapshotEpoch;

    if (existing === undefined || emptySelfHeal || epochChanged) {
      const official = readOfficial();
      const rebuildReason = existing === undefined
        ? '首次冻结'
        : emptySelfHeal
          ? '空快照自愈：空集不是「授权为零」，而是「没授权过」'
          : `按 snapshotEpoch ${storedEpoch} → ${policy.snapshotEpoch} 重建`;
      const frozen = await ledger.putManagedRoot({
        rootSessionId,
        // 重建要递增版本，才能与旧快照区分（方案 §7.3）。
        snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
        policyRevision: policy.policyRevision,
        // 重建是「重新开始」，时间戳也要更新，否则诊断里看不出它变过。
        createdAt: Date.now(),
        stationRoutes: freeze(),
        officialRoutes: official.routes.map((r) => ({ provider: r.provider, model: r.model })),
        officialStatus: official.status,
        epoch: policy.snapshotEpoch,
        ...(existing === undefined ? {} : { note: rebuildReason }),
      });
      return {
        snapshotRoutes: hydrate(frozen.stationRoutes),
        snapshotVersion: frozen.snapshotVersion,
        ...(existing === undefined ? {} : { rebuilt: true, rebuildReason }),
      };
    }

    // 收紧：当前全局比快照小的时候立即生效。
    const liveKeys = new Set(policy.allowedRoutes.map((r) => r.provider + '/' + r.model));
    const snapshotKeys = existing.stationRoutes.map((r) => r.provider + '/' + r.model);
    const isNarrowing = snapshotKeys.some((key) => !liveKeys.has(key));
    if (isNarrowing) {
      const tightened = await ledger.tightenManagedRoot(rootSessionId, {
        stationRoutes: policy.allowedRoutes,
        policyRevision: policy.policyRevision,
      });
      return {
        snapshotRoutes: hydrate(tightened?.stationRoutes ?? []),
        snapshotVersion: tightened?.snapshotVersion ?? existing.snapshotVersion,
      };
    }
    return {
      snapshotRoutes: hydrate(existing.stationRoutes),
      snapshotVersion: existing.snapshotVersion,
    };
  };

  /**
   * 一次派出的完整流程。所有校验都在 `startActivation` 之前完成（方案 9.1 的判据）。
   * @param {object} args 工具参数
   * @param {object} exec 工具执行上下文
   * @returns {Promise<string>} 面向模型的回执文本
   */
  const dispatch = async (args, exec) => {
    const policy = readPolicy();

    if (ledger === undefined) {
      throw ledgerError ?? new StationError(
        ERROR_CODES.LEDGER_UNAVAILABLE,
        '派出台账尚未就绪，本次派出已拒绝（避免出现「派了但没记」）。',
      );
    }

    const subagents = exec?.agent === undefined ? ctx.get?.('subagents') : exec.agent.ctx?.get?.('subagents') ?? ctx.get?.('subagents');
    const starter = resolveStarter(subagents);
    if (subagents === undefined || starter === undefined) {
      throw new StationError(
        ERROR_CODES.START_FAILED,
        '当前宿主没有可用的 `subagents.startActivation`，无法派出子智能体。',
      );
    }

    // 能力预检（方案 9.2）：后端不支持 agentOptions 时路由形同虚设。
    const incapable = checkBackendCapability({ subagents, providerName: policy.providerName });
    if (incapable !== undefined) {
      throw new StationError(ERROR_CODES.BACKEND_INCAPABLE, incapable);
    }

    const session = exec?.agent?.session;
    const depth = delegationDepthOf(exec?.agent);
    const coverage = readCoverage();
    const official = readOfficial();
    const rootSessionId = depth >= 1
      ? (resolveRootSessionId(exec.agent, { sessions: readSessions() }).rootSessionId ?? '')
      : (session?.id ?? '');
    const snapshot = await ensureSnapshot(rootSessionId, policy);

    const decision = decideDispatch({
      policy,
      session,
      delegationDepth: depth,
      roleId: args?.roleId,
      routeId: args?.routeId,
      reasoningEffort: args?.reasoningEffort,
      ...(snapshot === undefined ? {} : { snapshotRoutes: snapshot.snapshotRoutes }),
      official,
      coverage,
    });

    const receiptId = `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    /**
     * **预置子会话 id（v0.4 的 TOCTOU 消除，方案 §4 S5 / 改进方案 §8.2）**。
     *
     * v0.3 的顺序是：写回执 → `startActivation` → **拿到** childId → 写 children。
     * 中间那一瞬间子会话已经在跑，而 `children` 表里还没有它——如果它在这时发出
     * 首轮请求，L3 会以「未登记」拒绝（安全但误伤）；而如果 L3 尚未挂上，它就
     * 完全绕过锁定（不安全）。`pendingGrants`（在途许可 + 超时）正是为了掩盖
     * 这个窗口而设计的机制。
     *
     * S5 实测：`startActivation({ childId })` 会**原样采用**我们给的 id
     * （`dsh-subagent.js:1397` 的 `spec.childId ?? brandString(randomUUID())`），
     * 且只查重、不校验格式（`:1597`）。于是：
     *
     *     生成 childSessionId → 写 receipt + children（都带 id）→ startActivation({ childId })
     *
     * 子会话诞生那一刻台账已经完整，**窗口消失，`pendingGrants` 不需要存在**。
     *
     * 三条纪律：
     * 1. **必须用 `randomUUID()`**。S5-d：预置 id 会额外查持久化残留，可预测的 id
     *    （如 `child-1`）会在重启后必然撞 `DUPLICATE_CHILD`。
     * 2. **后端不支持 `prepareContinuable` 时不传**（S5-a：会抛 `UNSUPPORTED_CAPABILITY`）。
     *    那是降级路径：退回 v0.3 的「派出后立刻登记」，并如实标「降级（配置）」。
     * 3. 传了 `childId` 但宿主返回**别的** id ⇒ 以宿主返回的为准，并标降级，
     *    绝不假装锁在一个并不存在的 id 上。
     */
    const canReserveChildId = backendSupportsReservedChildId(subagents, policy.providerName);
    const reservedChildId = canReserveChildId ? randomUUID() : undefined;

    const now = Date.now();
    const baseReceipt = {
      receiptId,
      status: RECEIPT_STATUS.INTENT,
      roleId: decision.roleId,
      roleLabel: decision.roleLabel,
      mode: decision.mode,
      rootSessionId,
      parentSessionId: session?.id ?? '',
      // v0.4：预置 id 时这一栏**从一开始就有值**，于是"回执声称的孩子"与
      // "实际创建的孩子"永远对得上（§6.4 的核对因此有东西可对）。
      childSessionId: reservedChildId ?? '',
      route: {
        routeId: decision.routeId,
        provider: decision.provider,
        model: decision.model,
        ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
      },
      routeReason: decision.routeReason,
      effortReason: decision.effortReason,
      policyRevision: decision.policyRevision,
      snapshotVersion: snapshot?.snapshotVersion ?? 1,
      createdAt: now,
      updatedAt: now,
      note: '',
    };

    // 先记账再派出（方案 9.3 第 1 步）：写入失败会抛 StationError，派出不会发生。
    await ledger.putReceipt(baseReceipt);

    // **先登记孩子，再创建孩子。**
    //
    // v0.3 里这一步在 `startActivation` **之后**，那正是 TOCTOU 窗口的所在。
    // 提前到创建之前以后，任何"子会话已在跑但没登记"的状态都不可能存在（I3）。
    //
    // 只有拿到预置 id 时才这样做；降级路径仍退回"派出后立刻登记"。
    if (reservedChildId !== undefined) {
      try {
        await ledger.putChild({
          childSessionId: reservedChildId,
          rootSessionId,
          roleId: decision.roleId,
          receiptId,
          provider: decision.provider,
          model: decision.model,
          ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
          createdAt: Date.now(),
        });
      } catch (error) {
        throw new StationError(
          ERROR_CODES.LEDGER_UNAVAILABLE,
          `台账登记失败，本次派出已取消（子会话尚未创建）。原因：${String(error?.message ?? error)}`,
          { receiptId, childSessionId: reservedChildId },
        );
      }
    }

    // 派出参数即契约（方案 §3，G1）。
    //
    // 三条纪律，抄错任何一条都会让「岗位模型策略」变成装饰：
    // 1. **只从 `decision` 取值。** 不读 `args.provider`、不读父会话、不读 Config 现值
    //    （`decision` 已经过 岗位 ∩ 全局 ∩ 快照 ∩ 官方 四层求交）。这是 I1。
    // 2. **`reasoningEffort` 只在有值时出现。** 宿主在「改了 route 但没指定 effort」时会
    //    主动删掉继承来的 effort，让模型自己取默认（`.host-src/dsh-subagent.js:329`）：
    //    写成「键存在但值为 undefined」语义不同，会被当成「明确要求默认强度」。
    // 3. 不传 `agentOptions` 时，宿主会回落到父会话最近一次请求头里的 provider/model
    //    （`.host-src/dsh-subagent.js:293-303`、`:315-331`）——子会话在首轮请求之前
    //    就已经跑到父的路由上了，岗位策略完全没生效。
    const request = {
      prompt: [{ type: 'text', text: String(args?.prompt ?? '') }],
      parent: exec.agent,
      agentOptions: {
        provider: decision.provider,
        model: decision.model,
        ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
      },
    };

    let activation;
    try {
      activation = await starter({
        provider: policy.providerName,
        label: String(args?.description ?? ''),
        request,
        signal: exec.signal,
        delivery: 'parent',
        ...(reservedChildId === undefined ? {} : { childId: reservedChildId }),
      });
    } catch (error) {
      // 预置 id 失败时子会话**没有**被创建，所以台账里那条 children 记录要回收，
      // 否则它会永久占位（并让启动对账报一条不存在的"漏网"）。
      if (reservedChildId !== undefined) {
        try {
          await ledger.removeChild?.(reservedChildId);
        } catch {
          // 回收失败不改变结论：回执会记为 failed，启动对账会指出这个悬空登记。
        }
      }
      await ledger.putReceipt({
        ...baseReceipt,
        status: RECEIPT_STATUS.FAILED,
        updatedAt: Date.now(),
        note: String(error?.message ?? error),
      });
      throw new StationError(
        ERROR_CODES.START_FAILED,
        `派出失败（回执 ${receiptId}）：${String(error?.message ?? error)}`,
        { receiptId },
      );
    }

    const returnedChildId = childIdOf(activation) ?? '';
    // 预置成功时宿主返回的 id 必须与我们给的一致；不一致就以宿主的为准并标降级。
    const childSessionId = reservedChildId !== undefined
      && (returnedChildId === '' || returnedChildId === reservedChildId)
      ? reservedChildId
      : returnedChildId;
    const reservationHonoured = reservedChildId !== undefined && childSessionId === reservedChildId;

    if (childSessionId === '') {
      // 读不到 ID：如实标「待核对」，不猜造、不假装受控。
      const pending = {
        ...baseReceipt,
        status: RECEIPT_STATUS.STARTED,
        updatedAt: Date.now(),
        note: '宿主未返回 childId，无法登记子会话；该子会话不会被请求级锁定覆盖，请人工核对。',
      };
      await ledger.putReceipt(pending);
      return renderReceipt({
        receiptId,
        childSessionId: '',
        decision,
        status: '已受理，但宿主未返回 childId，请按会话记录核对（该子会话可能不受请求级锁定覆盖）',
        ...(snapshot === undefined ? {} : { snapshotVersion: snapshot.snapshotVersion }),
        snapshotDrift: computeSnapshotDrift({
          frozen: snapshot?.snapshotRoutes?.map((r) => r.routeId),
          current: policy.allowedRoutes.map((r) => r.routeId),
        }),
        policyRevisionNow: policy.policyRevision,
        coverage,
        officialStatus: official.status,
        assurance: computeAssurance({
          ledgerReady: true,
          lineageKnown: true,
          reservedChildId: canReserveChildId,
          reservationHonoured: false,
        }),
      });
    }

    // **降级路径**：后端不支持预置 id，或宿主没按预置 id 返回。
    //
    // 现在补登记。这条路径上仍然存在一个极短窗口——所以它必须被**如实披露**
    // （保证等级 + 回执 note），不是"看起来差不多就当没发生"。
    if (!reservationHonoured) {
      try {
        await ledger.putChild({
          childSessionId,
          rootSessionId,
          roleId: decision.roleId,
          receiptId,
          provider: decision.provider,
          model: decision.model,
          ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
          createdAt: Date.now(),
        });
      } catch (error) {
        throw new StationError(
          ERROR_CODES.LEDGER_UNAVAILABLE,
          `子会话 ${childSessionId} 已创建，但台账登记失败，无法保证它的模型被锁定。`
          + `请立即中断该子会话并检查存储。原因：${String(error?.message ?? error)}`,
          { childSessionId, receiptId },
        );
      }
    }

    // 派出成功：确保**委派父**已被治理。
    //
    // 这不只是「顺手补一下」：`subagent/end` 按委派父的作用域派发（§6.4），
    // 如果这个父会话从未经过 `agent/created`（插件是热装上的，或者它本来就存在），
    // 那么没有任何监听器能收到结束事件，回执会永远停在 `observed`。
    // `governAgent` 幂等，重复调用不叠加 guard/监听器。
    try {
      governAgent(exec?.agent, { reason: 'dispatch' });
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-subagent-station] 派出后的父会话治理失败（回执仍会写入，但可能无终态）：${String(error?.message ?? error)}`,
      );
    }

    // 回执更新失败不应把已经登记好、也已经锁定的派出判成失败：
    // 真相在 children 表与会话记录里，回执只是解释缓存。
    try {
      await ledger.putReceipt({
        ...baseReceipt,
        childSessionId,
        status: RECEIPT_STATUS.STARTED,
        updatedAt: Date.now(),
      });
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-subagent-station] 回执 ${receiptId} 状态更新失败（子会话 ${childSessionId} 仍受锁定）：`
        + String(error?.message ?? error),
      );
    }

    return renderReceipt({
      receiptId,
      childSessionId,
      decision,
      status: '已受理，等待首个模型请求确认（每轮请求都会被压回台账路由）',
      ...(snapshot === undefined ? {} : { snapshotVersion: snapshot.snapshotVersion }),
      snapshotDrift: computeSnapshotDrift({
        frozen: snapshot?.snapshotRoutes?.map((r) => r.routeId),
        current: policy.allowedRoutes.map((r) => r.routeId),
      }),
      policyRevisionNow: policy.policyRevision,
      coverage,
      officialStatus: official.status,
      assurance: computeAssurance({
        ledgerReady: true,
        lineageKnown: true,
        reservedChildId: canReserveChildId,
        reservationHonoured,
      }),
    });
  };

  // 工具注册。
  const disposeTools = registerTools(ctx, { readPolicy, dispatch, readOfficial });
  ctx.effect(() => disposeTools, 'dsh-subagent-station: dispatch tools');

  /**
   * 生命周期治理一个 agent（v0.4 收窄后的单一路径，方案 §2.4）。
   *
   * **L2 入口守卫已完全移出本函数。** 它现在是全局挂载的、与身份无关的，
   * 所以这里的 `!managed` 提前返回**不再有任何安全含义**——它只是"这个会话
   * 不需要 L3/L4"的意思。v0.3 在这里 `return disposers` 就等于"不治理"，
   * 那正是问题 1 的根。
   *
   * 剩下两件事：
   * - L4 生命周期：受管**根**的 `subagent/end` → 回执终态；
   * - L3 请求锁定：受管**子**会话（v0.4 起也可以是全局的，见下方说明）。
   *
   * `agent/created` 事件与启动扫描**共用**这里，所以它必须幂等——
   * `agents.register()` 会用 `source: 'startup'` 发事件（`dsh-agent` 的 `announce`），
   * 与启动扫描天然重叠（方案 5.3）。
   *
   * @param {object} agent
   * @param {object} [meta]
   * @param {string} [meta.reason] 触发来源（`startup` / `resume` / `clear` / `compact` / `startup-sweep`）
   * @returns {Array<() => void>} 本次挂上的全部 disposer
   */
  const governAgent = (agent, meta = {}) => {
    const disposers = [];
    if (agent === undefined || agent === null) return disposers;
    if (typeof agent.ctx?.get !== 'function' && typeof agent.ctx?.on !== 'function') return disposers;

    const policy = readPolicy();
    const { managed, isChild } = classifyAgent(policy, agent, { sessions: readSessions() });
    if (!managed) return disposers;

    // L4：`subagent/end` → 回执终态（v0.3 §6.4）。
    //
    // 只在**根的** ctx 上挂一次：`subagent/end` 由委派父的作用域派发
    // （`.host-src/dsh-subagent.js:163-168` 的 `createLifecycleEmitter` 用 `carrier(parent)`），
    // 所以受管根能收到自己这一支的全部结束事件，不必为每个孩子各挂一份。
    //
    // v0.4 保留逐根挂载的理由：这个事件**只能**在根的 ctx 上收到，全局监听器
    // 拿不到 `subagent/end` 的作用域信息（S2 只对 `agent/request` 成立）。
    // 但 L4 的缺失可自愈——启动对账会把停在 `observed` 的回执标成 `unverified`（§7.3）。
    if (!isChild && ledger !== undefined && !endListeners.has(agent?.session?.id)) {
      const disposeEnd = agent.ctx.on('subagent/end', (info) => {
        // `subagent/end` 是 `emit`（fire-and-forget）：写入必须**不阻塞、不抛错**。
        // 崩在 end 之后、写入之前会留下 `observed`——由重启对账收尾（§6.5）。
        void (async () => {
          try {
            await ledger?.closeReceipt?.(info);
          } catch (error) {
            ctx.logger?.warn?.(
              `[dsh-subagent-station] 回执收尾失败（子会话 ${String(info?.id)}）：${String(error?.message ?? error)}`,
            );
          }
        })();
      });
      if (typeof disposeEnd === 'function') {
        endListeners.set(agent.session.id, disposeEnd);
        disposers.push(() => {
          endListeners.delete(agent.session.id);
          try {
            disposeEnd();
          } catch {
            // 卸载路径上的失败不连累其它 disposer。
          }
        });
      }
    }

    // L4 补：`subagent/start` → 漏网记录（v0.4，方案 §9.4 T81）。
    //
    // 为什么需要它：`subagent/end` 只能告诉我们"某个子会话结束了"，而一个
    // **从未登记过**的子会话结束时，`closeReceipt()` 查不到它、直接返回
    // （那是刻意的：不该改写别人的孩子）。于是"有人绕过入口派过东西"这件事
    // 在整个台账里**没有任何痕迹**——用户永远不知道发生过。
    //
    // `subagent/start` 是宿主唯一主动告知"有子会话起来了"的事件。在它上面
    // 检查台账，就能把"漏网"变成一条可查的记录。注意这里**只记录、不阻断**：
    // 事件已经发完，阻断是做不到的（S3 的结论），假装能拦只会让人误以为拦住了。
    // 真正的阻断在 L3——那个子会话的首轮请求会以 `UNMANAGED_CHILD` 被拒。
    if (!isChild && ledger !== undefined && !startListeners.has(agent?.session?.id)) {
      const disposeStart = agent.ctx.on('subagent/start', (info) => {
        void (async () => {
          try {
            const childId = typeof info?.id === 'string' && info.id !== ''
              ? info.id
              : (typeof info?.childId === 'string' && info.childId !== '' ? info.childId : undefined);
            if (childId === undefined) return;
            // 已登记 ⇒ 这是我们自己派的，无事发生。
            if (typeof ledger.getChild === 'function' && ledger.getChild(childId) !== undefined) return;
            await ledger.recordEscape({
              childSessionId: childId,
              rootSessionId: agent?.session?.id ?? '',
              provider: typeof info?.provider === 'string' ? info.provider : undefined,
              model: typeof info?.model === 'string' ? info.model : undefined,
              observedAt: Date.now(),
            });
          } catch (error) {
            // 记录失败不改变任何结论：这只是"尽力留下痕迹"，不该拖垮宿主的事件流。
            ctx.logger?.warn?.(
              `[dsh-subagent-station] 漏网子会话记录失败：${String(error?.message ?? error)}`,
            );
          }
        })();
      });
      if (typeof disposeStart === 'function') {
        startListeners.set(agent.session.id, disposeStart);
        disposers.push(() => {
          startListeners.delete(agent.session.id);
          try {
            disposeStart();
          } catch {
            // 卸载路径上的失败不连累其它 disposer。
          }
        });
      }
    }

    // L3：请求锁定已**全局挂载**（v0.4，方案 §2.4 / S2），不再逐子会话挂。
    //
    // v0.3 在这里 `attachRequestLock({ agentCtx: agent.ctx, … })`，于是"还没挂上锁定
    // 的子会话"是一个真实存在的状态——那正是 `pendingSweeps` 那一整段的存在理由。
    // 现在监听从插件加载起就覆盖**所有**子会话（含尚未出现的），这个状态不存在了。
    return disposers;
  };

  /**
   * `agent/created` 是派生监听点（方案 5.2）：新会话一出现就治理。
   *
   * 已核实（`cordis_inspect_query(Event, 'agent/created')`）：`serial` 模式，
   * 监听器可以 `await`，失败会拒绝注册。
   */
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      if (disposed) return;
      governAgent(payload?.agent, { reason: payload?.source });
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'dsh-subagent-station: entry governor + request lock');

  /**
   * 启动扫描（方案 §4.2）：治理**插件加载前就已存在**的会话（W1/W2）。
   *
   * 没有这一步时：用户打开 DSH（会话早就在跑）→ 装上插件 → 什么都没发生，
   * 而 `station_status` 类诊断也不存在，用户无从得知（v0.2 的 P1-C）。
   *
   * 顺序有讲究：这个 effect 排在台账 effect **之后**，因为请求锁定需要 `ledger`；
   * 但台账是异步打开的，所以扫描要等它。用 `queueMicrotask` 不够（`openLedger` 有 await），
   * 因此扫描挂在台账 effect 的异步尾部——见下面的 `sweepExistingAgents()`。
   */
  ctx.effect(() => {
    const disposers = [];
    const sweep = () => {
      if (disposed) return;
      let agents;
      try {
        agents = ctx.get?.('agents');
      } catch {
        agents = undefined;
      }
      if (agents === undefined || typeof agents.list !== 'function') {
        ctx.logger?.warn?.(
          '[dsh-subagent-station] 取不到 `agents` 服务，'
          + '本次加载前已存在的会话不会被治理（仅新会话受管）。',
        );
        return;
      }
      let live = [];
      try {
        live = agents.list() ?? [];
      } catch {
        live = [];
      }
      for (const agent of live) {
        for (const dispose of governAgent(agent, { reason: 'startup-sweep' })) disposers.push(dispose);
      }
      sweptAt = Date.now();
    };
    // v0.4：**只扫一次**。
    //
    // v0.3 扫两次（第一次挂 guard，台账就绪后第二次挂请求锁定）。现在 L2 与 L3
    // 都是全局挂载的，扫描只剩一件事：给受管根挂 L4 的 `subagent/end` 终态监听。
    // 那件事对台账有依赖（要写回执），所以这里仍然只做一次——
    // 但代价从"漏掉锁定"降到"漏掉终态收尾"，而后者能被启动对账自愈（§7.3）。
    sweep();
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 卸载路径上的失败不应连累其它 disposer（I7）。
        }
      }
    };
  }, 'dsh-subagent-station: startup sweep');

  /**
   * 诊断状态（方案 §10.2 / §10.3）：**工具与服务共用这一个函数**，所以两处不会漂移。
   *
   * 三个真相源（方案 §9.1）在这里同时展示：
   * - 会话记录（`agents.list()` 的实况与谱系）；
   * - 台账（回执 / 子会话 / 偏离）；
   * - Config（岗位与路由）。
   *
   * 不猜：`managed: false` 时给出**原因**（`managedReason`），并列出未受管的存活会话。
   *
   * @param {object} [scope] 可选 agent。传了就给这个 agent 的作用域覆盖诊断。
   * @returns {object} 结构化状态（`station_status` 会把它渲染成文本）
   */
  const buildStatus = (scope) => {
    const policy = readPolicy();
    const official = readOfficial();

    /** 读 `agents` 服务；取不到就是空列表（诊断降级，不是功能失效）。 */
    let live = [];
    try {
      const agents = ctx.get?.('agents');
      live = typeof agents?.list === 'function' ? (agents.list() ?? []) : [];
    } catch {
      live = [];
    }

    // 逐个分类存活会话。这里是「未受管会话必须被报出来」的实现点（G2 的验收要求）。
    const sessions = readSessions();
    const classified = live.map((agent) => {
      const info = classifyAgent(policy, agent, { sessions });
      return {
        sessionId: agent?.session?.id ?? '',
        managed: info.managed,
        isChild: info.isChild,
        rootSessionId: info.rootSessionId,
        lineage: info.lineage,
        managedReason: info.managedReason,
        depth: delegationDepthOf(agent),
        // v0.4：守卫是全局的，因此**每个**会话都是"被守卫覆盖"的——
        // 它不再是"给这个 agent 挂过"的事实，而是"全局 guard 已安装"的事实（I6）。
        // 保留这个字段是为了让 v0.3 的状态输出不突变，但含义变了。
        guarded: true,
        // v0.4：L3 也是全局挂载的，所以每个子会话都被锁定覆盖（含尚未出现的）。
        locked: true,
      };
    });

    const managedLive = classified.filter((s) => s.managed);
    const unmanagedLive = classified.filter((s) => !s.managed);

    // 本会话（调用者）。未受管时这才是用户唯一能拿到的「我该把什么 id 抄进配置」。
    const selfSessionId = scope?.session?.id ?? '';
    const selfClassified = scope === undefined ? undefined : classified.find((s) => s.sessionId === selfSessionId)
      ?? (() => {
        const info = classifyAgent(policy, scope, { sessions });
        return {
          sessionId: selfSessionId,
          managed: info.managed,
          isChild: info.isChild,
          rootSessionId: info.rootSessionId,
          lineage: info.lineage,
          managedReason: info.managedReason,
          depth: delegationDepthOf(scope),
          guarded: true,
          // v0.4：同上——锁定是全局的，不再是"这个 agent 挂过没有"。
          locked: true,
        };
      })();

    /**
     * 读一组台账记录，**读不出来就退化成空数组**（v0.4 修）。
     *
     * 原来的写法是 `ledger === undefined ? [] : ledger.listAllDeviations()`，
     * 而上面的注释却写着"都包了 try"——注释与代码不一致。
     * 后果在 T75 里暴露：一张表读不出来，整个 `buildStatus` 抛错，
     * 状态退化成「诊断自身失败」，于是**那张表的 ✗ 永远显示不出来**。
     *
     * 那是最糟的一种失败：用户看到"诊断失败"，却看不到"哪张表坏了"。
     * 现在单表故障只让那一段数据变空，`ledgerTables` 负责把真相说出来。
     */
    const safeList = (read) => {
      try {
        const value = read();
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    };

    const receipts = safeList(() => ledger?.listReceipts());
    const deviations = safeList(() => ledger?.listAllDeviations());
    const children = safeList(() => ledger?.listChildren());
    const escapes = safeList(() => ledger?.listEscapes());

    // 台账自洽性：回执有孩子、孩子有回执（方案 §9.2 的两条对账规则）。
    const orphanReceipts = receipts.filter((r) => r.childSessionId !== '' && !children.some((c) => c.childSessionId === r.childSessionId));
    const orphanChildren = children.filter((c) => !receipts.some((r) => r.receiptId === c.receiptId));

    const globalCoverage = computeCoverageFor(undefined);
    const scopedCoverage = scope === undefined ? undefined : computeCoverageFor(scope);

    // 最近一次偏离**按 `at` 排**（v0.4 修正）。
    //
    // v0.3 这里用 `d.createdAt ?? 0`——偏离记录里没有 `createdAt` 字段（它叫 `at`），
    // 于是每一项都取到 0，排序永远等于"原序"。那意味着「最近偏离」显示的
    // 其实可能是很久以前的一条。这不是显示瑕疵：用户据此判断"现在还在被换模型吗"。
    const recentDeviation = [...deviations].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];

    // 台账自身的证据（v0.4，方案 §7.2）。读不到就如实留空，不编。
    const ledgerMeta = (() => {
      if (ledger === undefined || typeof ledger.getMeta !== 'function') return undefined;
      try {
        return ledger.getMeta();
      } catch {
        return undefined;
      }
    })();

    // 表健康（v0.4，方案 §7.2 / T75）。
    //
    // 为什么单独探一次：上面三行 `listReceipts()` / `listChildren()` /
    // `listAllDeviations()` 都是在 `ledger` 句柄上包的 try，表坏了会退化成空数组。
    // 那样"表没了"就伪装成"表里是 0 条"——而这两件事的处置完全不同。
    const ledgerTables = (() => {
      if (ledger === undefined || typeof ledger.readTableHealth !== 'function') return undefined;
      try {
        return ledger.readTableHealth();
      } catch {
        return undefined;
      }
    })();

    // 保证等级（v0.4，方案 §6.5）。
    //
    // 输入全部来自**已经算出来的事实**，不重新探测——状态诊断本身不该有副作用。
    const assurance = computeAssurance({
      ledgerReady: ledger !== undefined,
      // 守卫是否装上：`tools.guard` 存在（effect 里失败会记 warn，这里如实反映）。
      guardMounted: typeof ctx.tools?.guard === 'function',
      // 请求锁是全局 effect 挂的，与守卫同生共死（同一个 `ctx.effect` 生命周期）。
      lockMounted: typeof ctx.on === 'function',
      // 预置 id 能力：决定了"派出与登记之间有没有窗口"。
      reservedChildId: backendSupportsReservedChildId(ctx.get?.('subagents'), policy.providerName),
      // 谱系可解析（只有子会话才依赖它；算不出时 L3 会明确拒绝，不是静默降级）。
      lineageKnown: true,
    });

    return {
      policyRevision: policy.policyRevision,
      managedSessionIds: [...policy.managedSessionIds],
      manageAllNewRoots: policy.manageAllNewRoots === true,
      snapshotEpoch: policy.snapshotEpoch,
      unknownEntryPolicy: policy.unknownEntryPolicy,
      roles: [...policy.rolesById.values()].map((r) => ({ ...r })),
      allowedRoutes: policy.allowedRoutes.map((r) => ({ ...r })),
      conflicts: policy.conflicts.map((c) => ({ ...c })),
      official,
      assurance,
      ledgerReady: ledger !== undefined,
      ...(ledgerError === undefined ? {} : { ledgerError: String(ledgerError?.message ?? ledgerError) }),
      ...(ledgerMeta === undefined ? {} : { ledgerMeta }),
      ...(ledgerTables === undefined ? {} : { ledgerTables }),
      // 判定计数（进程内，v0.4 自证用）：证明守卫真的在跑，而不是"看起来装了"。
      guardStats: stats.snapshot(),
      receipts: receipts.slice(0, policy.receiptLimit),
      deviations,
      escapes,
      children,
      orphanReceipts,
      orphanChildren,
      live: classified,
      managedLive,
      unmanagedLive,
      self: selfClassified,
      sweptAt,
      coverage: {
        // 全局视图：插件注册 + 无作用域注册。
        global: globalCoverage,
        // 作用域视图：这个 agent 真实看得见的（v0.3 §8.5）。
        ...(scopedCoverage === undefined ? {} : { scoped: scopedCoverage }),
      },
      ...(recentDeviation === undefined ? {} : { recentDeviation }),
    };
  };

  // 只读诊断服务（供工具与未来面板使用）。这里不注册任何 UI 插槽。
  if (typeof ctx.provide === 'function') {
    ctx.provide('subagentStation', {
      /**
       * 当前策略与覆盖诊断的只读快照（方案 §10.3：与 `station_status` 共用 `buildStatus()`）。
       *
       * @param {object} [scope] 可选：某个 agent。传了就给这个 agent 真实看得见的覆盖诊断
       *   （`coverage.scoped`），并保留全局视图（`coverage.global`）供对比。
       */
      snapshot(scope) {
        return buildStatus(scope);
      },
    });
  }

  // ── 诊断面：`station_status`（方案 §10）─────────────────────────────────
  // 与 `subagentStation.snapshot()` 共用 `buildStatus()`，避免两处漂移。
  const disposeStatus = registerStationStatus(ctx, { buildStatus, readPolicy });
  ctx.effect(() => disposeStatus, 'dsh-subagent-station: station_status');
}

/** 供测试与诊断使用：导出这些名字让宿主半边可被单独 import。 */
export { volatileField, delegationDepthOf };
