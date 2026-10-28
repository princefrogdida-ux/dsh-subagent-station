/**
 * 入口守卫（方案 §2.2 / §2.4，L2）：**每次工具调用现算**，不在挂载时刻定稿。
 *
 * ### v0.3 为什么错（问题 1 / R1 根因）
 *
 * v0.3 的 guard 是**逐 agent** 挂在 `agent.ctx` 上的，而挂载前提是 `classifyAgent`
 * 在**挂载时刻**返回 `managed`：
 *
 * ```js
 * const { managed, isChild } = classifyAgent(policy, agent, { sessions });   // 此刻
 * if (!managed) return disposers;                                            // ← 时点判定
 * const disposeGuard = governor.attachTo(agent.ctx, agent, { isChild });     // 错过就没有
 * ```
 *
 * 三个调用点（`agent/created`、启动扫描、`dispatch` 尾部）全是时点。于是真实用户
 * 19:16 才写进 `managedSessionIds`，而扫描在 18:57 就结束了——**配置晚到 19 分钟，
 * 治理就晚 19 分钟生效**，而 `station_status` 因为「查询时现算」会一路显示"受管"。
 * 那不是诊断不准，是**插件在撒谎，而它的诊断也在撒谎**。
 *
 * ### v0.4 的修法
 *
 * 宿主明写（`.host-src/dsh-tools.js:3007-3016`，C1）：
 *
 * > A plain-context guard applies globally; one registered through `agent.ctx`
 * > applies only to that agent. … no guard can force-allow a call another guard denied.
 *
 * 所以：**一个普通上下文的 guard，挂在插件根 `ctx` 上，只挂一次**（`index.js`）。
 * 它的存在与任何会话无关，因此不存在"还没挂上"的状态（I2）。每次调用只做一件事：
 * 现读配置、现算身份、现判策略。
 *
 * ### 允许缓存的是输入，不是结论（方案 §2.2）
 *
 * - ✅ 策略视图（按输入对象身份失效）——这是"输入"，不是"这个 agent 受管"；
 * - ✅ 候选名 `Set`（按目录 + 用户补充名失效）；
 * - ❌ 「这个 agent 受管，所以给它挂过了」——v0.3 的错误就在这里。
 *
 * ### 性能预算（方案 §2.3，S6 实测）
 *
 * 非候选名必须 < 2µs 且**零服务访问**：所以第一件事是 `candidateSet.has(name)`，
 * 未命中立刻返回，不读配置、不算谱系。实测额外开销 0.002µs/次。
 */
import { ERROR_CODES, StationError } from '../shared/policy.js';
import { describeRefusal } from '../shared/refusal.js';
import { candidateNames, decideToolPolicy, looksLikeDelegationTool } from './coverage.js';

/**
 * 一个 agent 的委派深度：`max(session.header.delegationDepth, options.subagentDepth)`。
 *
 * 已核实（`.host-src/dsh-subagent.js:111-115`）：运行时字段可以**加深**但不能降低持久值，
 * 否则冷恢复回来的子智能体被当成顶层会话继续派出。
 *
 * @param {object} agent
 * @returns {number}
 */
export function delegationDepthOf(agent) {
  const persisted = Number(agent?.session?.header?.delegationDepth);
  const runtime = Number(agent?.options?.subagentDepth);
  const depth = Math.max(Number.isFinite(persisted) ? persisted : 0, Number.isFinite(runtime) ? runtime : 0);
  return depth >= 0 ? depth : 0;
}

/**
 * 沿谱系向上解析出**真正的受管根**会话 id（方案 4.3）。
 *
 * v0.2 只看一层（`header.parentSession ?? ownId`），但 `parentSession` 是**直接**父会话
 * （`.host-src/dsh-subagent.js:352` 的 `childSessionMeta`），不是根：
 * `maxDepth: 2` 时孙级的 `parentSession` 是中间子会话的 id，通常不在 `managedSessionIds` 里，
 * 于是孙级被判成「未受管」——这正是 v0.2 的 P2-A。
 *
 * 三条要点：
 * 1. **走不到头时退回「最后一个能确认的 id」**，而不是退回自己。这比退回自己更安全：
 *    不会把孙级误判成顶层会话。
 * 2. `sessions` 是可选参数。取不到时行为与 v0.2 一致（只走一层），并在诊断里标 `lineage: 'limited'`。
 *    **不要因为拿不到 `sessions` 就拒绝派出**——那是把诊断能力下降变成功能失效。
 * 3. `seen` 用于防环：伪造/损坏的谱系不能让这里死循环。
 *
 * 算法照抄宿主内部的 `liveLineage()`（`.host-src/dsh-subagent.js:1738-1746`）。
 *
 * @param {object} agent
 * @param {object} [options]
 * @param {{get?: (id: string) => object|undefined}} [options.sessions] `ctx.sessions`（可选）
 * @returns {{rootSessionId: string, lineage: 'full'|'limited', hops: number}}
 */
export function resolveRootSessionId(agent, { sessions } = {}) {
  const own = agent?.session?.id;
  const ownId = typeof own === 'string' ? own : '';
  const first = agent?.session?.header?.parentSession;
  if (typeof first !== 'string' || first === '') {
    // 没有父：它自己就是根。
    return { rootSessionId: ownId, lineage: 'full', hops: 0 };
  }

  const canWalk = typeof sessions?.get === 'function';
  let current = first;
  let hops = 1;
  let last = first;
  const seen = new Set([ownId]);
  while (typeof current === 'string' && current !== '' && !seen.has(current)) {
    seen.add(current);
    last = current;
    if (!canWalk) break;
    let parent;
    try {
      parent = sessions.get(current);
    } catch {
      // 读会话记录失败：按「只到这一层」处理，并把谱系标为 limited。
      return { rootSessionId: last, lineage: 'limited', hops };
    }
    if (parent === undefined) {
      // 父已不在 `sessions` 里（被清掉了）：到这里为止能确认的就是 `last`。
      return { rootSessionId: last, lineage: 'limited', hops };
    }
    const next = parent?.session?.header?.parentSession ?? parent?.header?.parentSession;
    if (typeof next !== 'string' || next === '') {
      // `current` 没有更上层的父 → 它就是根。
      return { rootSessionId: current, lineage: 'full', hops };
    }
    current = next;
    hops += 1;
  }

  // 走不到头（父已不在 `sessions` 里）或遇到环：退回最后一个能确认的 id。
  return { rootSessionId: last, lineage: 'limited', hops };
}

/**
 * 这个 agent 是否落在受管范围内（方案 5.2：根与子都算）。
 *
 * **v0.3 的关键改动（P2-A）**：用 `resolveRootSessionId` 的谱系结果判受管，
 * 而不是只比直接父。否则 `maxDepth: 2` 的孙级永远是「未受管」。
 *
 * 判定规则：
 * - 谱系根在受管名单里 → 受管；
 * - 或者自己就在名单里（防御：名单里写了子会话 id 的配置错误，也按受管处理）；
 * - `manageAllNewRoots: true` 时，任何**根**会话（无父）都自动受管。
 *
 * > **v0.4 的纪律**：本函数的结果**不许**被用来决定"挂不挂 guard"——
 * > guard 是全局的、与身份无关。它只用来（a）每次调用判定，（b）诊断。
 *
 * @param {object} policy
 * @param {object} agent
 * @param {object} [options]
 * @param {{get?: Function}} [options.sessions] 用于谱系解析（可选）
 * @returns {{managed: boolean, isChild: boolean, rootSessionId: string, lineage: 'full'|'limited', managedReason: string}}
 */
export function classifyAgent(policy, agent, options = {}) {
  const isChild = delegationDepthOf(agent) >= 1;
  const ownId = agent?.session?.id ?? '';
  const resolved = resolveRootSessionId(agent, options);
  const rootSessionId = resolved.rootSessionId;
  const managedIds = policy?.managedSessionIds ?? [];

  const byRoot = rootSessionId !== '' && managedIds.includes(rootSessionId);
  const bySelf = ownId !== '' && managedIds.includes(ownId);
  const byAllRoots = policy?.manageAllNewRoots === true && !isChild && resolved.hops === 0;

  const managed = byRoot || bySelf || byAllRoots;
  const managedReason = byRoot
    ? 'root-listed'
    : bySelf
      ? 'session-listed'
      : byAllRoots
        ? 'manage-all-new-roots'
        : 'not-listed';

  return {
    managed,
    isChild,
    rootSessionId: managed ? rootSessionId : (isChild ? rootSessionId : ownId),
    lineage: resolved.lineage,
    managedReason,
  };
}

/**
 * 创建入口守卫。
 *
 * **不再有 `attachTo` / `isAttached` / `listAttached`。** 那不是 API 演进，
 * 而是这个文件存在的理由变了：v0.3 的对象是"给谁挂上"，v0.4 的对象是"这次调用怎么判"。
 * 保留 `attachTo` 会让下一个人很自然地又把它接回 `agent/created`，问题 1 就回来了。
 *
 * @param {object} args
 * @param {() => object} args.readPolicy 读取实时策略（每次调用都读，不许缓存结论）
 * @param {() => object|undefined} args.readCatalog 读取已加载的目录
 * @param {() => {get?: Function}|undefined} [args.readSessions] `sessions` 服务
 * @param {() => object|undefined} [args.readLedger] 台账句柄（目标解析与谱系核对用）
 * @param {ReturnType<import('./stats.js').createStats>} [args.stats] 判定计数器
 * @returns {{decideForCall: Function, candidateSetSize: Function, snapshot: Function}}
 */
export function createEntryGovernor({ readPolicy, readCatalog, readSessions, readLedger, stats }) {
  /**
   * 候选名 `Set` 的缓存（方案 §2.3：热路径不跑正则）。
   *
   * 失效条件：目录对象变化、或用户补充名集合变化。两者都是低频事件。
   * 用引用相等判断就够了——`readCatalog()` 返回的是同一个已加载对象。
   */
  let candidateCache = { catalog: undefined, extra: undefined, set: new Set() };

  /**
   * 取候选名集合。
   * @param {object|undefined} catalog
   * @param {ReadonlyArray<string>} extra
   * @returns {Set<string>}
   */
  const candidates = (catalog, extra) => {
    if (candidateCache.catalog === catalog && candidateCache.extra === extra) return candidateCache.set;
    const set = candidateNames({ catalog, extraBlockedNames: extra });
    candidateCache = { catalog, extra, set };
    return set;
  };

  /**
   * 解析条件允许入口的**目标**（方案 §5.3）。
   *
   * 只在 `rootVerdict` / `childVerdict` 是 `allow-if-*` 时调用——也就是只对
   * `send_message` 这一条生效。普通入口不会付这个代价。
   *
   * 判定表（方案 §5.3）：
   *
   * | 情形 | 结果 |
   * | --- | --- |
   * | 参数缺失 / 非字符串 | 拒绝（`TARGET_UNKNOWN`）——宿主 schema 该拦而没拦，fail-closed |
   * | 目标是本根子树内已登记的子会话 | 允许 |
   * | 目标在台账里属于**别的根** | 拒绝（`TARGET_FOREIGN`） |
   * | 子会话 → 它的直接父 | 允许（宿主文档明写的正常形态） |
   * | 其它（不存在 / 未登记） | 拒绝（`TARGET_UNKNOWN`） |
   *
   * @param {object} args
   * @returns {{known: boolean, code?: string, reason?: string}}
   */
  const resolveTarget = ({ exec, isChild, ownId, rootSessionId }) => {
    const targetId = exec?.arguments?.agent_id;
    if (typeof targetId !== 'string' || targetId === '') {
      return {
        known: false,
        code: ERROR_CODES.TARGET_UNKNOWN,
        reason: `派出所[${ERROR_CODES.TARGET_UNKNOWN}]：这个入口需要指定目标 agent（参数 \`agent_id\`），`
          + '但调用里没有可用的字符串 id。无法确认它的路由，因此拒绝——这属于宿主参数校验该拦而没拦的情况。'
          + '（修复：给出被投递 agent 的 `agent_id`；可用 `station_status` 核对台账里有哪些子会话。）',
      };
    }

    const ledger = readLedger?.();
    if (ledger === undefined) {
      return {
        known: false,
        code: ERROR_CODES.POLICY_UNREADABLE,
        reason: `派出所[${ERROR_CODES.POLICY_UNREADABLE}]：派出台账尚未就绪，无法确认目标「${targetId}」的归属。`
          + '无法判定的调用一律拒绝（fail-closed）。请稍后重试，或用 `station_status` 确认台账状态。',
      };
    }

    let assignment;
    try {
      assignment = ledger.getChild(targetId);
    } catch (error) {
      return {
        known: false,
        code: ERROR_CODES.POLICY_UNREADABLE,
        reason: `派出所[${ERROR_CODES.POLICY_UNREADABLE}]：读取台账失败，无法确认目标「${targetId}」的归属。`
          + `原因：${String(error?.message ?? error)}。无法判定的调用一律拒绝。`,
      };
    }

    if (assignment !== undefined) {
      // 台账里有它：只要属于本根就允许；属于别的根是跨根注入。
      const owner = assignment.rootSessionId;
      if (typeof owner === 'string' && owner !== '' && owner !== rootSessionId) {
        return {
          known: false,
          code: ERROR_CODES.TARGET_FOREIGN,
          reason: `派出所[${ERROR_CODES.TARGET_FOREIGN}]：目标「${targetId}」属于另一个受管根（${owner}），`
            + `不是本会话（${rootSessionId}）派出的。跨根投递等于绕过那个根的授权，因此拒绝。`
            + '（修复：回到该子会话所属的根会话里发消息。）',
        };
      }
      return { known: true };
    }

    // 台账里没有。子会话发给**直接父**是宿主文档明写的正常逃生路径（§5.3）。
    if (isChild) {
      const directParent = exec?.agent?.session?.header?.parentSession;
      if (typeof directParent === 'string' && directParent === targetId) return { known: true };
    }

    // 其余情况：这个 id 插件解释不了。可能是一次躲过入口的漏网派出，必须显性失败。
    return {
      known: false,
      code: ERROR_CODES.TARGET_UNKNOWN,
      reason: `派出所[${ERROR_CODES.TARGET_UNKNOWN}]：目标「${targetId}」不在本受管会话的台账里`
        + `（本会话 ${ownId}，根 ${rootSessionId}）。插件无法确认它的模型路由，因此拒绝。`
        + '（修复：先用 `station_status` 核对子会话 id；若确为漏网派出，请改用 `dispatch_agent`。）',
    };
  };

  /**
   * 判定一次工具调用。
   *
   * @param {object} exec 宿主给出的冻结执行上下文（含 `name` / `agent` / `arguments`）
   * @returns {string|undefined} 拒绝文案；`undefined` 表示放行
   */
  function decideForCall(exec) {
    const name = exec?.name;
    if (typeof name !== 'string' || name === '') return undefined;

    // ── 热路径第一步：名字预筛（零服务访问）────────────────────────────────
    //
    // 读策略、读目录、算谱系都在这一行之后。绝大多数工具调用（read/bash/edit…）
    // 到这里就返回了，所以全局守卫的实际开销可以忽略（S6：+0.002µs/次）。
    let policy;
    let catalog;
    try {
      policy = readPolicy();
      catalog = readCatalog();
    } catch (error) {
      // 读配置失败：fail-closed（I8）。只对候选名生效——普通工具不该被配置读失败连累，
      // 但那样会需要先知道候选名，而候选名来自目录……所以这里用"保守的兜底正则"。
      const reason = `派出所[${ERROR_CODES.POLICY_UNREADABLE}]：读取配置或入口目录失败，无法判定这次调用`
        + `（${name}）。无法判定的调用一律拒绝（fail-closed）。原因：${String(error?.message ?? error)}`;
      stats?.record({ candidate: true, deniedCode: ERROR_CODES.POLICY_UNREADABLE });
      return reason;
    }

    const candidate = candidates(catalog, policy.blockedToolNames);
    // 两道门：目录/补充名（精确），或词形（保守正则）。
    //
    // 只查 Set 会漏掉「目录外、名字像派生入口」的工具（v0.3 的 T54 正是这条）。
    // 但正则**不能**放在最前面无条件跑——方案 §2.3 的预算是"非候选名不跑正则"。
    // 折中：Set 未命中时跑一次词形正则；正则命中即视为候选（进入慢路径），
    // 未命中立刻放行。实测这条组合的额外开销仍是 0.002µs 量级（S6）。
    if (!candidate.has(name) && !looksLikeDelegationTool(name)) {
      stats?.record({ candidate: false });
      return undefined;
    }

    // ── 候选名：进入现算 ────────────────────────────────────────────────────
    const agent = exec?.agent;
    const isChild = delegationDepthOf(agent) >= 1;
    const ownId = typeof agent?.session?.id === 'string' ? agent.session.id : '';

    // 无 agent 的调用（宿主内部、PTC 根层）：没有身份就没有受管判定。
    // 但目录里 `createsAgent: true` 的入口在**任何**位置都不该由无身份调用触发——
    // 那是"绕过所有会话治理"的最短路径。这一条在 v0.3 完全缺失。
    if (agent === undefined || agent === null || ownId === '') {
      const entry = catalog?.entries.get(name);
      if (entry?.createsAgent === true) {
        stats?.record({ candidate: true, deniedCode: ERROR_CODES.POLICY_UNREADABLE });
        return `派出所[${ERROR_CODES.POLICY_UNREADABLE}]：「${name}」能创建子智能体，但这次调用没有可识别的会话身份，`
          + '插件无法判断它属于哪个根、该用哪个岗位模型，因此拒绝。'
          + '（修复：从会话内调用；无身份的创建请求无法受岗位模型策略约束。）';
      }
      stats?.record({ candidate: false });
      return undefined;
    }

    const { managed, rootSessionId, lineage } = classifyAgent(policy, agent, { sessions: readSessions?.() });
    if (!managed) {
      // 未受管会话：不干预（这是受管模式的字面含义）。
      stats?.record({ candidate: true });
      return undefined;
    }

    // 条件允许入口需要解析目标（只对 `allow-if-*` 生效）。
    const entry = catalog?.entries.get(name);
    const needsTarget = entry !== undefined
      && (entry.rootVerdict === 'allow-if-target-known' || entry.childVerdict === 'allow-if-parent-or-known');
    let targetKnown;
    let targetRefusal;
    if (needsTarget) {
      const resolved = resolveTarget({ exec, isChild, ownId, rootSessionId });
      targetKnown = resolved.known;
      targetRefusal = resolved.reason;
    }

    const decision = decideToolPolicy({
      toolName: name,
      isChild,
      catalog,
      extraBlockedNames: policy.blockedToolNames,
      forbidNestedDispatch: policy.forbidNestedDispatch,
      blockNativeDelegation: policy.blockNativeDelegation,
      unknownEntryPolicy: policy.unknownEntryPolicy,
      ...(needsTarget ? { targetKnown } : {}),
    });

    if (!decision.deny) {
      stats?.record({ candidate: true });
      return undefined;
    }

    // 目标解析失败时，`resolveTarget` 的文案比通用文案精确得多，直接用它的。
    const text = targetRefusal ?? refusalFor({
      name, decision, isChild, policy, ownId, rootSessionId, lineage,
    });
    // 计数用的码必须与文案里写的码**一致**（否则状态栏的分组会和用户看到的对不上）。
    //
    // 优先级：目标解析（`resolveTarget` 的码最精确）> 判定分支的码。
    stats?.record({
      candidate: true,
      deniedCode: decision.targetGated
        ? (targetRefusal === undefined ? ERROR_CODES.TARGET_UNKNOWN : codeOf(targetRefusal))
        : codeOf(text) ?? errorCodeOfDecision(decision, policy),
    });
    return text;
  }

  return {
    decideForCall,
    /** 候选名集合大小（诊断用：证明预筛真的建起来了）。 */
    candidateSetSize: () => candidateCache.set.size,
    /** 当前策略快照（只读诊断，不参与判定）。 */
    snapshot: () => stats?.snapshot(),
  };
}

/**
 * 从拒绝文案里取回错误码（文案格式由 `refusal.js` 固定：`派出所[CODE]：`）。
 * @param {string} text
 * @returns {string|undefined}
 */
function codeOf(text) {
  const match = /^派出所\[([A-Z0-9_]+)\]/.exec(String(text));
  return match?.[1];
}

/**
 * 一次拒绝对应的错误码（用于计数与诊断分组）。
 *
 * 这里的映射必须与 `refusalFor()` 的文案分支一一对应，否则计数器会和文案打架。
 *
 * @param {object} decision
 * @param {object} policy
 * @returns {string}
 */
function errorCodeOfDecision(decision, policy) {
  switch (decision.reason) {
    case 'child-nested':
      return ERROR_CODES.NESTED_DISPATCH_FORBIDDEN;
    case 'root-target-unknown':
    case 'child-target-unknown':
      return ERROR_CODES.TARGET_UNKNOWN;
    case 'root-native':
      // 用户关掉了 `blockNativeDelegation` 就不会走到这里；走到这里说明是开关拦的。
      return policy.blockNativeDelegation === true
        ? ERROR_CODES.NOT_MANAGED_SESSION
        : ERROR_CODES.POLICY_UNREADABLE;
    case 'unknown-deny-all':
    case 'unknown-delegation-like':
      return ERROR_CODES.COVERAGE_INCOMPLETE;
    default:
      return ERROR_CODES.POLICY_UNREADABLE;
  }
}

/**
 * 生成拒绝文案（方案 §5.4 的文案分级）。
 *
 * **硬规则**（方案 §5.4）：文案里出现的每个工具名、每条替代路径，都必须在本插件里
 * **真实存在且当前可用**。`tests/unit/v04-refusal-text.test.js` 会核对
 * `dispatch_agent` / `dispatch_roles` / `station_status` 三个名字确实已注册。
 *
 * 按 `createsAgent` 分级，而不是按类别——v0.3 的根文案说「岗位模型策略只在
 * `dispatch_agent` 上生效」，对 `send_message` 是**错的**（它根本不涉及路由）。
 *
 * @param {object} args
 * @returns {string}
 */
function refusalFor({ name, decision, isChild, policy, ownId, rootSessionId, lineage }) {
  const entry = decision.entry;
  const code = errorCodeOfDecision(decision, policy);

  // (1) 受管子会话再派：保持 v0.3 的文案（已合格）。
  if (isChild) {
    if (name === 'dispatch_agent') {
      return `派出所：受管子智能体不允许再派下一层子智能体。请把需要委派的工作带回主会话处理。`
        + `（码：${code}）`;
    }
    return `派出所：受管子智能体不允许通过「${name}」创建或继续子智能体（入口类别：${entry?.category ?? 'unknown'}）。`
      + '请把需要委派的工作带回主会话处理。'
      + `（码：${code}）`;
  }

  // (2) 目录外、名字像派生入口：保持 v0.3 的文案（已合格）。
  if (entry === undefined) {
    return `派出所：「${name}」看起来是创建/继续子智能体的入口，但它不在本插件的入口目录里，`
      + '因此无法确认它会不会绕过岗位模型策略，这一调用已被拒绝。'
      + '请让用户把该名字加入 `blockedToolNames`（确认要拦）或升级插件目录（确认是已知入口）。'
      + `（码：${code}）`;
  }

  // (3) 会创建 agent 的入口被拒：说"这绕过了岗位模型策略"。
  if (entry.createsAgent === true) {
    return `派出所：「${name}」会创建子智能体，从而绕过岗位模型策略，已被拒绝。`
      + '请改用 `dispatch_agent` 按岗位派出——它会记录回执、锁定模型，并保证每轮请求都被压回台账路由。'
      + '（如确需原生入口，请让用户关闭 `blockNativeDelegation`。）'
      + `（码：${code}）`;
  }

  // (4) 不创建 agent 的入口被拒：不能说"绕过模型策略"（v0.3 的错）。
  //
  // 走到这里只能是目标相关问题，或者用户在 `unknownEntryPolicy` / `blockedToolNames` 上的选择。
  const describeRefusalText = describeRefusal(new StationError(code, `「${name}」的目标「${
    String(decision.entry?.name ?? '')}」无法确认`), { includeFix: false });
  return `派出所：「${name}」本身不创建子智能体、不改变路由，这次拒绝与模型策略无关；`
    + `原因是插件无法解释这次调用的目标或当前策略（会话 ${ownId}，根 ${rootSessionId}，谱系 ${lineage}）。`
    + `${describeRefusalText.text.split('\n')[1] ?? ''}`
    + `（码：${code}）`;
}
