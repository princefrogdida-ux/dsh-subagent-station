/**
 * 覆盖诊断（方案 5.4，对应 T20 / T36 / T37）。
 *
 * 插件不能在不知道存在什么工具时宣称「严格受管」。这里把「当前可见的派生类工具」
 * 与内置目录比对，产出三态结论，供派出前的严格模式判定与工具结果使用。
 *
 * 纯函数，不读运行时状态：调用方把 `ctx.tools.schemas()` 的名字数组传进来。
 */
import { ERROR_CODES, StationError } from '../shared/policy.js';

/**
 * 覆盖状态四态（方案 5.4 第 3 条 + v0.3 §8.4 新增 `unrecognized`）。
 *
 * `unknown` 与 `unrecognized` **分开存**的直接好处：`strictCoverage` 的拒绝条件继续只看
 * `unknown-present`，不会因为引入了 `read`/`bash`/`mcp__x` 这类名字就突然开始拒绝派出。
 */
export const COVERAGE_STATES = Object.freeze({
  /** 所有可见派生入口都在目录内且已处理。 */
  COMPLETE: 'complete',
  /** 出现了**像派生入口**的目录外工具；`unknown` 列出名字。 */
  UNKNOWN_PRESENT: 'unknown-present',
  /** 出现了**不像派生入口**的目录外工具（v0.3 新增）；只进清单，不升级状态。 */
  UNRECOGNIZED: 'unrecognized',
  /** 连目录都读不到。 */
  DEGRADED: 'degraded',
});

/**
 * 目录外入口的默认处理策略（方案 §8.3，v0.3 新增配置）。
 *
 * - `block-delegation-like`（默认）：只拦**名字像派生入口**的，且默认只作用于子会话；
 * - `allow`：全部放行（仅进诊断清单）；
 * - `deny-all`：拦全部目录外入口（最严，可能误伤普通工具）。
 *
 * 为什么默认偏向拦截：误伤代价不对称——受管根调用一个名字里带 `dispatch` 的普通工具
 * （例如 `dispatch_notification`）被拦，用户立刻会反馈；而放行一个改名的派生入口，
 * 用户永远不会发现。逃生阀见 `docs/known-limits.md`。
 */
export const UNKNOWN_ENTRY_POLICIES = Object.freeze(['block-delegation-like', 'allow', 'deny-all']);

/**
 * 目录条目在两个会话位置上的判定取值（方案 §5.1，schema v2）。
 *
 * v0.3 的 `policy: allow | deny-in-child | deny-managed` 把 `category` 与 `policy`
 * 的语义叠在一起，且**无法表达「条件允许」**——于是 `send_message` 在受管根上
 * 被 `blockNativeDelegation` 无辜拦掉（问题 2），逃生路径断裂。
 *
 * v0.4 把判定拆成两个显式字段，`category` 退化为**纯文案/分组用途，不参与判定**。
 */
export const ROOT_VERDICTS = Object.freeze(['allow', 'deny', 'allow-if-target-known']);
export const CHILD_VERDICTS = Object.freeze(['allow', 'deny', 'allow-if-parent-or-known']);

/**
 * v0.3 目录 `policy` → v0.4 双字段的映射（向后兼容：旧目录文件仍然能加载）。
 *
 * 保留它的理由不是"兼容洁癖"：插件是热升级的，用户机器上可能存在被手工改过的
 * 旧目录。让他一升级就 `degraded` 是更糟的结果。
 *
 * @param {string} policy
 * @param {string} category
 * @returns {{createsAgent: boolean, rootVerdict: string, childVerdict: string}|undefined}
 */
function legacyPolicyToVerdicts(policy, category) {
  // `createsAgent` 只能靠类别推断——这是 v0.3 schema 的固有缺陷，不是这里的偷懒。
  const createsAgent = category !== 'control' && category !== 'discovery' && category !== 'station';
  switch (policy) {
    case 'allow':
      return { createsAgent: false, rootVerdict: 'allow', childVerdict: 'allow' };
    case 'deny-managed':
      return { createsAgent, rootVerdict: 'deny', childVerdict: 'deny' };
    case 'deny-in-child':
      // v0.3 里这个值只用于 `send_message` 与 `dispatch_agent`。前者不创建 agent。
      // `dispatch_agent` 走 category === 'station' 分支，由 `createsAgent` 上面的推断处理。
      return category === 'station'
        ? { createsAgent: true, rootVerdict: 'allow', childVerdict: 'deny' }
        : { createsAgent: false, rootVerdict: 'allow-if-target-known', childVerdict: 'allow-if-parent-or-known' };
    default:
      return undefined;
  }
}

/**
 * 把目录 JSON 归一化成 `Map<name, entry>`，并丢弃结构不完整的条目。
 *
 * 读不到或格式不对 → 返回 `undefined`，由调用方标 `degraded`。
 * 「读不到」和「目录是空的」必须区分：前者是诊断失败，后者是插件打包事故。
 *
 * @param {unknown} raw
 * @returns {{catalogVersion: string, entries: Map<string, object>, schema: 2}|undefined}
 */
export function loadCatalog(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const entries = new Map();
  for (const entry of raw.entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
    const category = typeof entry.category === 'string' ? entry.category : 'unknown';

    // schema v2：显式双字段优先。
    let verdicts;
    if (ROOT_VERDICTS.includes(entry.rootVerdict) && CHILD_VERDICTS.includes(entry.childVerdict)) {
      verdicts = {
        createsAgent: entry.createsAgent === true,
        rootVerdict: entry.rootVerdict,
        childVerdict: entry.childVerdict,
      };
    } else {
      // 旧 schema：按 v0.3 的 policy 映射。映射不出来就丢弃这一条（不猜）。
      verdicts = legacyPolicyToVerdicts(entry.policy, category);
    }
    if (verdicts === undefined) continue;

    entries.set(entry.name, {
      name: entry.name,
      category,
      owner: typeof entry.owner === 'string' ? entry.owner : '',
      ...verdicts,
      evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
    });
  }
  if (entries.size === 0) return undefined;
  return {
    catalogVersion: typeof raw.catalogVersion === 'string' ? raw.catalogVersion : '',
    dshVersion: typeof raw.dshVersion === 'string' ? raw.dshVersion : '',
    entries,
    schema: 2,
  };
}

/**
 * 判定一个可见工具名是否属于「派生类入口」。
 *
 * 目录本身就定义了已知集合；但目录外的**新**派生工具必须能被认出来，否则
 * 「覆盖诊断」只能在已知世界里自说自话。
 *
 * 判据是保守的**词形**匹配：名字里出现 subagent / teammate / delegate / dispatch /
 * workflow 这类词。宁可多报（要求用户确认）也不漏报——多报只影响严格模式，
 * 漏报会让「严格受管」变成假话。
 *
 * > **注意**：本函数**只**用于「诊断」与「候选名集合的构建」。
 * > 它不再参与「拦不拦」的决策（v0.3 用它回答了两个问题）。
 * > 热路径上**禁止**调用它——用 `candidateNames()` 的预编译 Set（方案 §2.3）。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeDelegationTool(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return CANDIDATE_PATTERN.test(name);
}

/**
 * 词形判据的正则（预编译一次）。
 *
 * `send_message` 不在里面：它不创建 agent，词形上也不像派生入口。
 * 它由目录直接列为候选（见 `candidateNames`）。
 */
const CANDIDATE_PATTERN = /(subagent|sub_agent|teammate|delegat|dispatch|spawn|workflow|agent_team|send_message|interrupt_agent)/i;

/**
 * 构建**候选名集合**（方案 §2.3 的性能关键）。
 *
 * 全局 guard 在每一次工具调用上运行。热路径的预算对非候选名是 < 2µs 且**零服务访问**，
 * 所以这里预编译一个 `Set`：目录里的全部名字 + 用户补充的名字 + 词形命中的名字。
 *
 * 调用方应在「工具名集合变化」时重建这个 Set，**不要在每次调用时重建**。
 *
 * @param {object} args
 * @param {{entries: Map<string, object>}|undefined} args.catalog
 * @param {ReadonlyArray<string>} [args.extraBlockedNames]
 * @param {ReadonlyArray<string>} [args.visibleNames] 若提供，把词形命中的也收进来
 * @returns {Set<string>}
 */
export function candidateNames({ catalog, extraBlockedNames, visibleNames }) {
  const set = new Set();
  for (const name of catalog?.entries?.keys?.() ?? []) set.add(name);
  for (const name of extraBlockedNames ?? []) {
    if (typeof name === 'string' && name.length > 0) set.add(name);
  }
  for (const name of visibleNames ?? []) {
    if (looksLikeDelegationTool(name)) set.add(name);
  }
  return set;
}

/**
 * 计算覆盖状态（方案 5.4 第 3 条 + v0.3 §8.2「拆成两个问题」）。
 *
 * v0.3 的核心判断：**「guard 拦什么」与「诊断看见什么」是两个不同的问题**，
 * v0.2 用同一套判据（正则）回答了两者。
 *
 * - 诊断：对**全部**可见工具名与目录做差集，不做正则过滤 → 得到 `unrecognized`；
 * - 拦截：只在 `decideToolPolicy` 里按 `unknownEntryPolicy` 决定。
 *
 * @param {object} args
 * @param {ReadonlyArray<string>} args.visibleNames 当前作用域可见的全部工具名
 * @param {{entries: Map<string, object>}|undefined} args.catalog 归一化后的目录
 * @param {ReadonlyArray<string>} [args.extraBlockedNames] 用户补充的入口名（方案 5.5）
 * @returns {{state: string, known: Array<object>, unknown: Array<string>, unrecognized: Array<string>, catalogVersion: string, visibleCount: number}}
 */
export function computeCoverage({ visibleNames, catalog, extraBlockedNames }) {
  const names = [...(visibleNames ?? [])];
  if (catalog === undefined) {
    return {
      state: COVERAGE_STATES.DEGRADED,
      known: [],
      unknown: names.filter(looksLikeDelegationTool),
      // 目录读不到时，「有没有不像派生的目录外工具」无从判断，如实留空。
      unrecognized: [],
      catalogVersion: '',
      visibleCount: names.length,
    };
  }

  const extra = new Set((extraBlockedNames ?? []).filter((n) => typeof n === 'string' && n.length > 0));
  const known = [];
  const unknown = [];
  const unrecognized = [];

  for (const name of names) {
    const entry = catalog.entries.get(name);
    if (entry !== undefined) {
      known.push({ ...entry });
      continue;
    }
    // 用户补充的名字已在目录外登记，不算「未知」——但仍在 guard 里被拦。
    if (extra.has(name)) {
      known.push({ name, category: 'user-extension', owner: '(user)', policy: 'deny-managed' });
      continue;
    }
    if (looksLikeDelegationTool(name)) {
      unknown.push(name);
    } else {
      // v0.3：不像派生入口的目录外工具也**必须看得见**，否则「覆盖诊断」只会在
      // 自己认识的世界里自说自话（T55 的 `read`/`bash`）。
      unrecognized.push(name);
    }
  }

  const state = unknown.length > 0
    ? COVERAGE_STATES.UNKNOWN_PRESENT
    : unrecognized.length > 0
      ? COVERAGE_STATES.UNRECOGNIZED
      : COVERAGE_STATES.COMPLETE;

  return {
    state,
    known,
    unknown,
    unrecognized,
    catalogVersion: catalog.catalogVersion,
    visibleCount: names.length,
  };
}

/**
 * 严格模式下的派出前判定（方案 5.4 第 4 条）。
 *
 * 只在 `state === 'unknown-present'` 且 `strictCoverage: true` 时拒绝。
 * `degraded` 不在这里拒绝：目录读不到是**插件打包事故**，把它变成「用户什么都做不了」
 * 会让一次升级错误变成生产事故。改为在回执与诊断里明示 `degraded`。
 *
 * @param {object} args
 * @param {{state: string, unknown: ReadonlyArray<string>}} args.coverage
 * @param {boolean} args.strictCoverage
 * @returns {StationError|undefined}
 */
export function coverageBlockReason({ coverage, strictCoverage }) {
  if (!strictCoverage) return undefined;
  if (coverage.state !== COVERAGE_STATES.UNKNOWN_PRESENT) return undefined;
  return new StationError(
    ERROR_CODES.COVERAGE_INCOMPLETE,
    `严格覆盖模式已开启，但当前会话里出现了目录外的派生入口：${coverage.unknown.join('、')}。`
    + '插件不确定这些入口是否会被用来绕过岗位模型策略，因此拒绝派出。'
    + '请让用户把它们加入 `blockedToolNames`（确认要拦）或升级插件目录（确认是已知入口）。',
    { unknown: [...coverage.unknown] },
  );
}

/**
 * 一个工具名在给定会话位置上是否应被拒绝（方案 §5.1–§5.3，v0.4 三分语义）。
 *
 * ### v0.3 的错（问题 2，R2 根因）
 *
 * 目录声明了 `allow` / `deny-in-child` / `deny-managed` 三种策略，但本函数的根分支
 * 把后两种合流：
 *
 * ```js
 * // v0.3 coverage.js:325-334
 * if (effective.policy === 'allow') return { deny: false, … };
 * if (isChild) return { deny: forbidNestedDispatch, … };
 * const isStationTool = effective.category === 'station';
 * if (isStationTool) return { deny: false, … };
 * return { deny: blockNativeDelegation, … };   // ← deny-in-child 在根上落到这里
 * ```
 *
 * 于是 `send_message`（目录自述"根会话允许"）在受管根上也返回 `deny: true`。
 * 真实后果不是文案问题：**用户在受管主会话里无法给已派出的子会话追加指令**，逃生路径断了。
 *
 * ### v0.4 的判据
 *
 * 只用目录的两个字段，一个分支一行配置，**没有合流**：
 *
 * - `createsAgent`：它会不会创建新 agent？（这是"是否绕过岗位模型策略"的唯一判据）
 * - `rootVerdict` / `childVerdict`：在该位置上允不允许？
 *
 * `category` 只用于拒绝文案与诊断分组，**不参与判定**。
 *
 * @param {object} args
 * @param {string} args.toolName
 * @param {boolean} args.isChild 是否子会话（delegationDepth >= 1）
 * @param {{entries: Map<string, object>}|undefined} args.catalog
 * @param {ReadonlyArray<string>} args.extraBlockedNames 用户补充的名字（按 deny-managed 处理）
 * @param {boolean} args.forbidNestedDispatch
 * @param {boolean} args.blockNativeDelegation
 * @param {string} [args.unknownEntryPolicy] 目录外入口的默认处理（方案 §8.3）
 * @param {boolean} [args.targetKnown] 条件允许入口的目标是否已解析成功（省略 = 未解析）
 * @returns {{deny: boolean, entry: object|undefined, reason: string, targetGated?: boolean}}
 */
export function decideToolPolicy({
  toolName, isChild, catalog, extraBlockedNames, forbidNestedDispatch, blockNativeDelegation,
  unknownEntryPolicy = 'block-delegation-like', targetKnown,
}) {
  const entry = catalog?.entries.get(toolName);
  const isExtra = (extraBlockedNames ?? []).includes(toolName);

  if (entry === undefined && !isExtra) {
    // 目录外且用户没登记：v0.2 一律放行（P2-B 的失真），v0.3 起按策略决定。
    if (unknownEntryPolicy === 'deny-all') {
      return { deny: true, entry: undefined, reason: 'unknown-deny-all' };
    }
    if (unknownEntryPolicy === 'block-delegation-like' && looksLikeDelegationTool(toolName)) {
      // 名字像派生入口的未知工具：**只在子会话拦**。
      //
      // 为什么受管根不拦：受管根的原生入口已有 `blockNativeDelegation` 的既有语义，
      // 而「名字像」的判据在根上误伤面太大（`dispatch_notification` 之类）。
      // 这里刻意保留不对称——子会话是孙级的唯一闸口，宁可多拦。
      return { deny: isChild && forbidNestedDispatch, entry: undefined, reason: 'unknown-delegation-like' };
    }
    return { deny: false, entry: undefined, reason: 'unknown-allowed' };
  }

  // 用户补充的名字按「受管一律拒绝」处理（目录外，没有可用判定字段）。
  const effective = entry ?? {
    name: toolName,
    category: 'user-extension',
    createsAgent: true,
    rootVerdict: 'deny',
    childVerdict: 'deny',
  };

  // ── 子会话分支 ────────────────────────────────────────────────────────────
  if (isChild) {
    switch (effective.childVerdict) {
      case 'allow':
        return { deny: false, entry: effective, reason: 'child-allow' };
      case 'allow-if-parent-or-known':
        // 条件允许：目标必须是直接父或台账内已知的子会话。目标解析不到就拒绝（fail-closed）。
        return targetKnown === true
          ? { deny: false, entry: effective, reason: 'child-target-known' }
          : { deny: true, entry: effective, reason: 'child-target-unknown', targetGated: true };
      case 'deny':
      default:
        // 子会话再派（含 `dispatch_agent`）：由 `forbidNestedDispatch` 决定，
        // 关掉它等于用户明确接受孙级存在。
        return { deny: forbidNestedDispatch, entry: effective, reason: 'child-nested' };
    }
  }

  // ── 受管根分支 ────────────────────────────────────────────────────────────
  //
  // 这里**不再**按 `category === 'station'` 放行本插件入口——那是 v0.3 把
  // "受控路径"这个意图塞进 `category` 的结果。现在由目录直接写 `rootVerdict: 'allow'`。
  switch (effective.rootVerdict) {
    case 'allow':
      return { deny: false, entry: effective, reason: 'root-allow' };
    case 'allow-if-target-known':
      return targetKnown === true
        ? { deny: false, entry: effective, reason: 'root-target-known' }
        : { deny: true, entry: effective, reason: 'root-target-unknown', targetGated: true };
    case 'deny':
    default:
      // 受管根的原生派生入口：由 `blockNativeDelegation` 决定（默认 true）。
      //
      // 注意 `createsAgent` 在这里**不参与**分支：它决定的是拒绝文案（见 refusal.js
      // 与 index.js 的文案选择），而不是判定。判定只看 `rootVerdict`。
      // 「只有能创建 agent 的入口才需要受 blockNativeDelegation 管」这个理由，
      // 已经写进目录：不创建 agent 的入口一律 `rootVerdict: 'allow'`。
      return { deny: blockNativeDelegation, entry: effective, reason: 'root-native' };
  }
}

/**
 * 把覆盖诊断渲染成**以 `state` 为键**的多行文本（方案 §2.5 / 改进方案 §10.2）。
 *
 * ### 为什么必须按 `state` 分支，而不是按数组空不空
 *
 * v0.3 的渲染逻辑是：
 *
 * ```js
 * if (g.unknown.length > 0) lines.push(`· 像派生入口但不在目录：${...}`);
 * if (g.unrecognized.length > 0) lines.push(`· 目录外其它工具：${...}`);
 * ```
 *
 * 于是 `degraded`（目录根本没读到）渲染出来的唯一一行是
 * `- 覆盖（全局）：degraded（可见 5 个工具；… 0；… 0）`——用户读到的是
 * 「一切正常，只是状态名叫 degraded」。**"没有未知名字"被当成了"覆盖完整"**。
 *
 * 而 `degraded` 与 `complete` 的差别恰恰是：后者"我们查过了，没有漏"，前者
 * "我们连目录都没读到，不知道有没有漏"。这两句话对用户的意义完全相反。
 *
 * 所以这里每一个 state 都有**自己的话**，且任何 state 都必须输出至少一行
 * 关于"这意味着什么"的说明——不许只吐一个状态名。
 *
 * @param {object} coverage `computeCoverage()` 的返回值
 * @param {object} [options]
 * @param {string} [options.label] 作用域标签（`全局` / `本会话作用域`）
 * @returns {Array<string>} 可直接 `push` 进状态文本的行
 */
export function describeCoverage(coverage, { label = '全局' } = {}) {
  const state = coverage?.state ?? COVERAGE_STATES.DEGRADED;
  const visible = coverage?.visibleCount ?? 0;
  const head = `- 覆盖（${label}）：${state}（可见 ${visible} 个工具）`;

  switch (state) {
    case COVERAGE_STATES.COMPLETE:
      return [
        head,
        `  · 结论：目录内 ${coverage.known.length} 个入口全部认得，没有发现目录外的派生入口。`,
      ];

    case COVERAGE_STATES.UNKNOWN_PRESENT:
      return [
        head,
        `  · 结论：发现 ${coverage.unknown.length} 个**名字像派生入口**的目录外工具——`
        + '它们可能绕过岗位模型策略。',
        `  · 名单：${coverage.unknown.join('、')}`,
        '  · 修复：确认要拦就把名字加进 `blockedToolNames`；确认是已知入口就升级插件目录。'
        + '若开启了 `strictCoverage`，出现这类工具会直接拒绝派出。',
      ];

    case COVERAGE_STATES.UNRECOGNIZED:
      return [
        head,
        `  · 结论：发现 ${coverage.unrecognized.length} 个目录外工具，但它们的名字不像派生入口，`
        + '按普通工具放行。',
        `  · 名单：${coverage.unrecognized.join('、')}`,
        '  · 说明：这一类不会升级成拦截，列出它们只是为了让你知道"目录没覆盖到什么"。',
      ];

    case COVERAGE_STATES.DEGRADED:
    default:
      return [
        head,
        '  · 结论：**入口目录读不出来**，因此无法判断是否存在目录外的派生入口。',
        '  · 这意味着：上面那个"可见 N 个工具"是全部信息——不是"查过了没问题"，而是"根本没法查"。',
        '  · 影响：`strictCoverage` 此时不会拦截（没有名单可比），但目录外入口的拦截判据退化到'
        + '「名字像不像派生入口」这一层。',
        '  · 修复：确认插件包的 `lib/host/delegation-catalog.json` 存在且可读；'
        + '这是部署问题，不是配置问题。',
      ];
  }
}
