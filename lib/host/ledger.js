/**
 * 派出台账（方案 6.2 / G5）：把回执、受管根快照、子会话登记、偏离记录落到 storageDomain。
 *
 * 为什么要有这一层：v0.1 全部在内存里，重启后「这个子会话为什么被允许、用的哪个模型」
 * 就查不到了。方案 6.3 要求「授权决策必须同时进入工具结果（模型看得见），台账是跨重启的
 * 解释缓存」——所以台账**不是**真相来源，会话记录才是；台账读不出时标 `unverified`，
 * 绝不静默当作「没有记录」。
 *
 * 三个域设计要点：
 * - 每个域都要有 `version`；升级时递增并列入 `compatibleVersions` 才能读旧数据。
 * - `layout: 'per-record'`：一条回执一个文档，避免单文件全量重写。
 * - 写入失败**必须**让调用方拒绝派出（方案 6.2「台账写入失败 → 拒绝该次派出」）。
 *
 * 依赖 `zod` 是直接依赖（域的 `valueSchema` 要求 `ZodType`），不能靠传递可用（方案 6.2 末段）。
 */
import { createRequire } from 'node:module';

import z from 'zod';

import { ERROR_CODES, StationError } from '../shared/policy.js';

/**
 * 读本插件自己的版本号（v0.4 修：此前 `pluginVersion` 从来没人赋值，恒为空串）。
 *
 * 用 `createRequire` 而不是 `import ... with { type: 'json' }`：后者在
 * ESM 里需要 import attributes，而宿主加载插件时的形态我们无法控制。
 * 读失败就返回 `undefined`（调用方保留旧值），**不抛**——版本号写不进去
 * 不该让台账打不开。
 *
 * @returns {string|undefined}
 */
function readOwnVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json');
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 台账域与元数据域的规范版本。升级记录格式时递增并把旧版本加进 compatibleVersions。
 *
 * ### v2 改了什么（方案 §7）
 *
 * | 改动 | 为什么 |
 * | --- | --- |
 * | 新增 `meta` 表 | v0.3 的台账只能回答"派过什么"，回答不了"这套保证自己跑了多少次"。出问题时用户只能在黑箱外猜（问题 6）。 |
 * | 偏离新增 `kind` | v0.3 把"宿主给了别的模型（要压回）"和"宿主还没定路由，我们补上初值"记成同一行。后者数量大、无害，混在一起让"偏离 N 次"失去意义。 |
 *
 * 兼容性：v1 记录缺少 `kind`，`DeviationSchema` 把它声明为 `.optional()`，
 * 读旧记录得到 `undefined`——渲染时按 `error` 处理（保守：宁可多报冲突）。
 */
export const LEDGER_VERSION = 2;

/** v0.3 用过的版本（读旧数据时要用）。 */
export const LEDGER_COMPATIBLE_VERSIONS = Object.freeze([1]);

/** 回执状态机（方案 9.3 第 3 条、v0.3 §6.2）。 */
export const RECEIPT_STATUS = Object.freeze({
  INTENT: 'intent',
  STARTED: 'started',
  OBSERVED: 'observed',
  SETTLED: 'settled',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  UNVERIFIED: 'unverified',
});

/**
 * 终态集合：进终态后**任何**事件都不得改写（方案 §6.2「终态不可覆盖」）。
 *
 * `unverified` 也在这里：它是重启对账给出的结论，不是中间态。把它当作「还能再升一次」
 * 会让一次崩溃后的诚实结论被后来的事件覆盖掉。
 */
export const TERMINAL_STATUSES = Object.freeze([
  RECEIPT_STATUS.SETTLED,
  RECEIPT_STATUS.FAILED,
  RECEIPT_STATUS.INTERRUPTED,
  RECEIPT_STATUS.UNVERIFIED,
]);

/** 该状态是否终态。 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * `subagent/end` 的 `stopReason` → 回执终态（方案 §6.2 的迁移表）。
 *
 * 取值集合已核实（`SubagentStopReasonMap`）：
 * `completed | aborted | error | max-tokens | refusal`。
 *
 * 判定依据是宿主的 `epochStopReason()` 注释（`.host-src/dsh-subagent.js:208-223`）：
 * 「子会话自己的日志才是权威——停止成功不代表模型是正常结束的」。
 * 因此只有 `completed` / `refusal` / `max-tokens` 算 `settled`（运行确实走完了），
 * `aborted` 算 `interrupted`（人主动中断），`error` 算 `failed`。
 *
 * @param {string|undefined} stopReason
 * @returns {{status: string, note: string}}
 */
export function settleStatusFor(stopReason) {
  switch (stopReason) {
    case 'completed':
      return { status: RECEIPT_STATUS.SETTLED, note: '子会话正常结束（stopReason: completed）' };
    case 'refusal':
      return { status: RECEIPT_STATUS.SETTLED, note: '子会话结束于模型拒绝（stopReason: refusal）' };
    case 'max-tokens':
      return { status: RECEIPT_STATUS.SETTLED, note: '子会话因达到 token 上限而结束（stopReason: max-tokens）' };
    case 'aborted':
      return { status: RECEIPT_STATUS.INTERRUPTED, note: '子会话被中断（stopReason: aborted）' };
    case 'error':
      return { status: RECEIPT_STATUS.FAILED, note: '子会话因错误结束（stopReason: error）' };
    default:
      // 未知 stopReason：如实标 unverified，不猜成「完成」。
      return {
        status: RECEIPT_STATUS.UNVERIFIED,
        note: `子会话已结束，但停止原因不在已知集合内（stopReason: ${String(stopReason)}），无法确认结果`,
      };
  }
}

const RouteSchema = z.object({
  routeId: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});

const ReceiptSchema = z.object({
  receiptId: z.string(),
  status: z.enum(['intent', 'started', 'observed', 'settled', 'failed', 'interrupted', 'unverified']),
  roleId: z.string(),
  roleLabel: z.string(),
  mode: z.string(),
  rootSessionId: z.string(),
  parentSessionId: z.string(),
  childSessionId: z.string(),
  route: RouteSchema,
  routeReason: z.string(),
  effortReason: z.string(),
  policyRevision: z.number(),
  snapshotVersion: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 失败或诊断说明；成功时为空字符串。 */
  note: z.string(),
});

const ManagedRootSchema = z.object({
  rootSessionId: z.string(),
  snapshotVersion: z.number(),
  policyRevision: z.number(),
  createdAt: z.number(),
  /** 冻结时的三层摘要：插件全局、岗位版本、官方策略。 */
  stationRoutes: z.array(RouteSchema),
  officialRoutes: z.array(z.object({ provider: z.string(), model: z.string() })),
  officialStatus: z.string(),
  /**
   * 冻结时的 `snapshotEpoch`（方案 §7.3，v0.3 新增）。
   *
   * 可选：旧记录读作 `undefined`，与默认 `snapshotEpoch: 0` 一起比较时按 0 处理
   * ⇒ 不会因为升级而触发一次意外重建（方案 §11.2）。
   */
  epoch: z.number().optional(),
  /** 上次重建/收紧的原因，供诊断解释「这条快照为什么是这个集合」。 */
  note: z.string().optional(),
});

const ChildSchema = z.object({
  childSessionId: z.string(),
  rootSessionId: z.string(),
  roleId: z.string(),
  receiptId: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  createdAt: z.number(),
});

const DeviationSchema = z.object({
  childSessionId: z.string(),
  receiptId: z.string(),
  turn: z.number(),
  attemptedProvider: z.string(),
  attemptedModel: z.string(),
  forcedProvider: z.string(),
  forcedModel: z.string(),
  /**
   * 偏离性质（v0.4 新增，方案 §7）。
   *
   * - `error`：宿主给了**别的**路由，我们压回了台账值。这是真正需要用户知道的。
   * - `notice`：宿主给的是空/半空路由（首轮尚未定型），我们补上初值。这是正常初始化。
   *
   * `.optional()`：v0.3 的旧记录没有这个字段，读出来是 `undefined`。
   * 渲染时按 `error` 处理（保守：宁可多报冲突，也不要把一次真的换模型说成"正常"）。
   */
  kind: z.enum(['error', 'notice']).optional(),
  at: z.number(),
});

/**
 * 漏网子会话（v0.4 新增，方案 §9.4 T81）。
 *
 * 与 `DeviationSchema` 的区别是本质的：
 *
 * - 偏离 = 「模型被换了，我压回去了」→ 我们**管到了**；
 * - 漏网 = 「这个子会话是我们没派过的」→ 我们**没管到**。
 *
 * 两者混在一张表里，"偏离 N 条"这个数字会同时包含成功与失败，
 * 而用户拿它判断的恰恰是"到底管不管得住"。
 */
const EscapeSchema = z.object({
  childSessionId: z.string(),
  /** 观察到它属于哪个受管根（`subagent/start` 的派发作用域）。 */
  rootSessionId: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  observedAt: z.number(),
});

/**
 * 台账自身的运行计数（v0.4 新增，方案 §7.2「可证伪」）。
 *
 * 为什么台账要记**自己**：一份"证明自己被用过"的台账必须是可证伪的。
 * 如果台账里只有业务记录，用户无法分辨"插件没工作"与"插件工作了但没有派出发生"——
 * 这两种情况的运维动作完全相反。
 *
 * 这张表只有一个键 `counters`，值就是这个文档。
 */
const MetaSchema = z.object({
  /** 台账格式版本（写入方声明）。 */
  schemaVersion: z.number(),
  /** 生成这个台账的插件版本。 */
  pluginVersion: z.string(),
  /** 台账第一次被打开的墙钟时间。 */
  firstOpenedAt: z.number(),
  /** 最近一次打开（每次插件加载都会刷新）。 */
  lastOpenedAt: z.number(),
  /**
   * 生命周期累计计数。**只增不减**，且不因 `close()` 归零——
   * 它的用途是"跨重启累计"，归零就等于抹掉证据。
   */
  counters: z.object({
    /** 台账被打开的次数（≈ 插件加载次数）。 */
    opened: z.number(),
    /** 写入过的回执总数（含重复覆盖，所以 ≥ `receipts` 表行数）。 */
    receiptWrites: z.number(),
    /** 写过的子会话登记数。 */
    childWrites: z.number(),
    /** 记录过的偏离数。 */
    deviationWrites: z.number(),
    /** 因派出失败而回收的预置子会话登记数（v0.4 的预置 id 失败路径）。 */
    childRecoveries: z.number(),
    /** 起终态收尾（`subagent/end` → 终态）的次数。 */
    settles: z.number(),
    /** 启动对账把回执标成 `unverified` 的次数。 */
    reconciliations: z.number(),
    /**
     * 漏网子会话记录数（v0.4，T81）。正常使用下恒为 0——
     * 它一旦非零，就说明有人绕过入口派过东西。
     *
     * `.optional()`：v0.4.0 之前写过的台账没有这个字段。
     */
    escapeWrites: z.number().optional(),
  }),
  /** 上一次正常关闭的时间；缺这个字段就说明上次是异常退出。 */
  lastClosedAt: z.number().optional(),
});

/**
 * 台账域：回执、受管根快照、子会话登记、偏离。
 *
 * **表名必须是 snake_case**：`json` 后端用 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
 * 校验域名与**每个表名**（`@deepseek-ai/dsh-storage` 的 `validateDescriptor`，
 * `.host-src/dsh-storage-json.js` 的 `validateDescriptor` 调用它）。
 * 写成 `managedRoots` 会让整个域打不开——实测错误：
 * `invalid table name 'managedRoots' in unit 'station_dispatch_ledger'`。
 * 这个错误只有在真实宿主里才会暴露（单元测试的替身不做这项校验），所以这里写死命名规则
 * 并在 `tests/unit/ledger.test.js` 里对域名与表名做正则断言。
 */
export const LEDGER_DOMAIN = Object.freeze({
  name: 'station_dispatch_ledger',
  version: LEDGER_VERSION,
  layout: 'per-record',
  compatibleVersions: LEDGER_COMPATIBLE_VERSIONS,
  tables: {
    receipts: { valueSchema: ReceiptSchema },
    managed_roots: { valueSchema: ManagedRootSchema },
    children: { valueSchema: ChildSchema },
    deviations: { valueSchema: DeviationSchema },
    // v0.4：台账自身证据（方案 §7.2）。单键表，只放一行 `counters`。
    meta: { valueSchema: MetaSchema },
    // v0.4：漏网子会话（方案 §9.4 T81）。与 deviations 分开，理由见 EscapeSchema。
    escapes: { valueSchema: EscapeSchema },
  },
});

/** `meta` 表里那唯一一行的键。 */
const META_KEY = 'counters';

/**
 * 全部表名（顺序固定，供健康探测与渲染使用）。
 *
 * 单独列出来当常量，是因为 `Object.keys(LEDGER_DOMAIN.tables)` 的顺序虽然
 * 在 JS 里是确定的，但"渲染顺序"这件事不该依赖对象字面量的书写顺序——
 * 那太容易被一次无关的重排改掉，而 `station_status` 的 `✓/✗` 序列是给人看的。
 */
const TABLE_NAMES = Object.freeze(['receipts', 'managed_roots', 'children', 'deviations', 'meta', 'escapes']);

/** 全零计数（首次打开时的初值）。 */
function zeroCounters() {
  return {
    opened: 0,
    receiptWrites: 0,
    childWrites: 0,
    deviationWrites: 0,
    childRecoveries: 0,
    settles: 0,
    reconciliations: 0,
    // v0.4：漏网子会话记录数（T81）。正常使用下恒为 0——
    // 它一旦非零，就说明有人绕过入口派过东西。
    escapeWrites: 0,
  };
}

/**
 * 打开台账并返回一层薄封装。
 *
 * 返回的句柄在 `close()` 之后不可再用；`close()` 由插件 effect 负责（方案 6.2 末段）。
 *
 * @param {object} storageDomain `ctx.storageDomain`
 * @returns {Promise<object>} 台账句柄
 * @throws {StationError} `STATION_LEDGER_UNAVAILABLE` 当域打不开
 */
export async function openLedger(storageDomain) {
  let domain;
  try {
    domain = await storageDomain.open(LEDGER_DOMAIN);
  } catch (error) {
    throw new StationError(
      ERROR_CODES.LEDGER_UNAVAILABLE,
      `派出台账打不开，插件拒绝在没有台账的情况下派出（否则会出现「派了但没记」）。原因：${String(error?.message ?? error)}`,
      { cause: String(error?.message ?? error) },
    );
  }

  const receipts = domain.table('receipts');
  const managedRoots = domain.table('managed_roots');
  const children = domain.table('children');
  const deviations = domain.table('deviations');
  const meta = domain.table('meta');
  const escapes = domain.table('escapes');

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new StationError(ERROR_CODES.LEDGER_UNAVAILABLE, '派出台账已关闭。');
  };

  // ── 台账自身的证据（v0.4，方案 §7.2）──────────────────────────────────────
  //
  // 打开时就地累计并写回。三条纪律：
  // 1. **只增不减**：计数器归零等于抹掉证据。
  // 2. **写入失败不阻断打开**：台账能读比台账能统计重要得多。失败时内存里仍然累加，
  //    本次会话内的数字是对的，只是不跨重启。
  // 3. `lastOpenedAt` 每次都刷新，`lastClosedAt` 由 `close()` 写。缺 `lastClosedAt`
  //    而 `lastOpenedAt` 更新，就是"上次异常退出"的直接证据。
  let metaState = (() => {
    try {
      return meta.get(META_KEY);
    } catch {
      return undefined;
    }
  })();

  const counters = { ...zeroCounters(), ...(metaState?.counters ?? {}), opened: (metaState?.counters?.opened ?? 0) + 1 };
  metaState = {
    schemaVersion: LEDGER_VERSION,
    // 以前这里是 `metaState?.pluginVersion`——一个从没有人赋过值的字段，于是
    // 台账里的版本号**永远是空串**。那不是"没填"，那是**假证据**：
    // `station_status` 会把"台账由 v0.3 写的还是 v0.4 写的"这种关键判断
    // 建立在一个空字符串上，而空串看起来像"未记录"，实际是"从来没记"。
    //
    // 现在直接读本插件自己的 `package.json`。它是**唯一**知道"我是哪个版本"的地方，
    // 而且 `openLedger` 没有别的合适合法来源（它只拿到 storageDomain）。
    pluginVersion: readOwnVersion()
      ?? (typeof metaState?.pluginVersion === 'string' ? metaState.pluginVersion : ''),
    firstOpenedAt: typeof metaState?.firstOpenedAt === 'number' ? metaState.firstOpenedAt : Date.now(),
    lastOpenedAt: Date.now(),
    counters,
    ...(typeof metaState?.lastClosedAt === 'number' ? { lastClosedAt: metaState.lastClosedAt } : {}),
  };
  try {
    await meta.put(META_KEY, metaState);
  } catch {
    // 见上：统计写不进去不该让台账打不开。
  }

  /**
   * 累加一个计数器并写回。
   *
   * @param {keyof ReturnType<typeof zeroCounters>} key
   */
  const bump = async (key) => {
    counters[key] = (counters[key] ?? 0) + 1;
    try {
      await meta.put(META_KEY, { ...metaState, counters: { ...counters } });
    } catch {
      // 统计是"锦上添花"，业务写入已经成功了，不该因为它回滚。
    }
  };

  /** 台账写入失败一律转成 StationError，让调用方拒绝派出而不是吞掉。 */
  const write = async (label, operation) => {
    assertOpen();
    try {
      return await operation();
    } catch (error) {
      throw new StationError(
        ERROR_CODES.LEDGER_UNAVAILABLE,
        `台账写入失败（${label}），本次派出已拒绝，避免出现「派了但没记」。原因：${String(error?.message ?? error)}`,
        { operation: label, cause: String(error?.message ?? error) },
      );
    }
  };

  return {
    /** 读一条回执；读不到返回 undefined。 */
    getReceipt(receiptId) {
      assertOpen();
      return receipts.get(receiptId);
    },
    /** 列出全部回执，按创建时间倒序。 */
    listReceipts() {
      assertOpen();
      return [...receipts.entries()]
        .map(([, value]) => value)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    /** 写入一条回执（整条替换）。 */
    async putReceipt(receipt) {
      await write('receipts.put', () => receipts.put(receipt.receiptId, receipt));
      await bump('receiptWrites');
      return receipt;
    },
    /**
     * 台账自身的证据（v0.4，方案 §7.2）。
     *
     * @returns {{schemaVersion: number, pluginVersion: string, firstOpenedAt: number,
     *   lastOpenedAt: number, lastClosedAt?: number, counters: object}|undefined}
     */
    getMeta() {
      assertOpen();
      return meta.get(META_KEY);
    },
    /**
     * 当前进程内的计数快照（不读盘：它就是刚才 `bump` 累加的那个对象）。
     * @returns {object}
     */
    readCounters() {
      assertOpen();
      return { ...counters };
    },
    /** 取受管根快照；读不到返回 undefined（调用方据此判定「首次启用」）。 */
    getManagedRoot(rootSessionId) {
      assertOpen();
      return managedRoots.get(rootSessionId);
    },
    /** 冻结一个受管根的策略快照。只在首次启用时调用（方案 4.3）。 */
    async putManagedRoot(root) {
      await write('managedRoots.put', () => managedRoots.put(root.rootSessionId, root));
      return root;
    },
    /**
     * 在已有快照上做**收紧**（方案 4.3「收紧永不延迟生效」）。
     * 只保留新旧交集，绝不扩大。
     */
    async tightenManagedRoot(rootSessionId, { stationRoutes, policyRevision }) {
      assertOpen();
      const current = managedRoots.get(rootSessionId);
      if (current === undefined) return undefined;
      const keep = new Set(stationRoutes.map((r) => `${r.provider}/${r.model}`));
      const next = {
        ...current,
        stationRoutes: current.stationRoutes.filter((r) => keep.has(`${r.provider}/${r.model}`)),
        policyRevision,
      };
      await write('managedRoots.tighten', () => managedRoots.put(rootSessionId, next));
      return next;
    },
    /** 登记一个受控子会话（请求级锁定据此判断「这是我们的孩子」）。 */
    getChild(childSessionId) {
      assertOpen();
      return children.get(childSessionId);
    },
    /** 全部子会话登记。 */
    listChildren() {
      assertOpen();
      return [...children.entries()].map(([, value]) => value);
    },
    async putChild(child) {
      await write('children.put', () => children.put(child.childSessionId, child));
      await bump('childWrites');
      return child;
    },
    /**
     * 撤销一条子会话登记（v0.4 新增，预置 `childId` 的失败路径专用）。
     *
     * 场景：我们**先**登记了预置 id、**再**调 `startActivation`，而后者失败。
     * 此时那个孩子从未存在，登记必须回收——否则它会变成一条永久悬空的
     * 「漏网子会话」，让启动对账与状态报告都指向一个不存在的会话。
     *
     * 只在"确实没创建出来"时调用。创建成功后再删登记等于抹掉审计痕迹。
     *
     * @param {string} childSessionId
     * @returns {Promise<boolean>} 是否真的删掉了
     */
    async removeChild(childSessionId) {
      assertOpen();
      if (children.get(childSessionId) === undefined) return false;
      await write('children.remove', () => children.delete(childSessionId));
      await bump('childRecoveries');
      return true;
    },
    /** 记录一次路由偏离。键用 `childSessionId#turn`，同一轮不会重复堆积。 */
    async recordDeviation(deviation) {
      const key = `${deviation.childSessionId}#${deviation.turn}`;
      await write('deviations.put', () => deviations.put(key, deviation));
      await bump('deviationWrites');
      return key;
    },
    /** 列出某个子会话的偏离记录。 */
    listDeviations(childSessionId) {
      assertOpen();
      return [...deviations.entries()]
        .filter(([, value]) => value.childSessionId === childSessionId)
        .map(([, value]) => value)
        .sort((a, b) => a.turn - b.turn);
    },
    /** 全部偏离（诊断用）。 */
    listAllDeviations() {
      assertOpen();
      return [...deviations.entries()].map(([, value]) => value);
    },
    /**
     * 记录一个**漏网**的子会话（v0.4，方案 §9.4 T81）。
     *
     * 什么叫漏网：宿主告诉我们"有个子会话起来了"（`subagent/start`），
     * 但台账里没有它的登记——也就是说它**不是**通过 `dispatch_agent` 派的。
     *
     * 为什么非要单独一张表而不是复用 `deviations`：两者说的是完全不同的两件事。
     * 偏离是"模型被换了，我压回去了"（我们管到了）；漏网是"有人绕过入口派的，
     * 我们**没管到**"。混在一张表里，"偏离 N 条"这个数字会同时包含成功与失败，
     * 而用户拿它判断的恰恰是"管不管得住"。
     *
     * 这个方法**不抛**：它的用途就是"报告坏消息"，自己坏了就报不了。
     *
     * @param {{childSessionId: string, rootSessionId?: string, provider?: string, model?: string, observedAt?: number}} escape
     * @returns {Promise<boolean>} 是否真的新增了一条（重复观察同一 id 不重复记）
     */
    async recordEscape(escape) {
      assertOpen();
      const id = escape?.childSessionId;
      if (typeof id !== 'string' || id === '') return false;
      // 同一子会话只记一次：`subagent/start` 在某些后端会重复发。
      if (escapes.get(id) !== undefined) return false;
      try {
        await write('escapes.put', () => escapes.put(id, {
          childSessionId: id,
          rootSessionId: escape.rootSessionId ?? '',
          ...(escape.provider === undefined ? {} : { provider: escape.provider }),
          ...(escape.model === undefined ? {} : { model: escape.model }),
          observedAt: escape.observedAt ?? Date.now(),
        }));
        await bump('escapeWrites');
        return true;
      } catch {
        return false;
      }
    },
    /** 全部漏网记录（诊断用）。读不出来就退化成空数组。 */
    listEscapes() {
      assertOpen();
      try {
        return [...escapes.entries()].map(([, value]) => value);
      } catch {
        return [];
      }
    },
    /**
     * 把回执升到 `observed`（方案 §6.3，v0.3）。
     *
     * 「至少有一轮请求被正确压回」是 `observed` 的全部含义。它由请求锁在**首次**
     * 成功压回时调用（`request-lock.js`），每一轮都写会让存储成为热路径。
     *
     * 迁移规则（§6.2）：
     * - 只在当前状态是 `intent` / `started` 时写入；
     * - 终态不可覆盖（已 `settled` / `interrupted` / `failed` / `unverified` → 直接返回，不写）。
     *
     * @param {string} childSessionId
     * @returns {Promise<boolean>} 是否真的写入了
     * @throws {StationError} 写入失败（由调用方决定吞还是报）
     */
    async markObserved(childSessionId) {
      assertOpen();
      const child = children.get(childSessionId);
      if (child === undefined) return false;
      const current = receipts.get(child.receiptId);
      if (current === undefined) return false;
      if (current.status !== RECEIPT_STATUS.INTENT && current.status !== RECEIPT_STATUS.STARTED) return false;
      const next = {
        ...current,
        status: RECEIPT_STATUS.OBSERVED,
        updatedAt: Date.now(),
      };
      await write('receipts.markObserved', () => receipts.put(next.receiptId, next));
      return true;
    },
    /**
     * 按 `subagent/end` 的 `stopReason` 收尾（方案 §6.4，v0.3）。
     *
     * @param {{id?: string, stopReason?: string}} info `SubagentRunEndInfo`
     * @returns {Promise<{closed: boolean, status: string|undefined}>}
     */
    async closeReceipt(info) {
      assertOpen();
      const childSessionId = info?.id;
      if (typeof childSessionId !== 'string' || childSessionId === '') return { closed: false, status: undefined };
      const child = children.get(childSessionId);
      // 查不到说明不是我们的孩子（第三方插件派的、或台账被清过）：直接返回，不改任何东西。
      if (child === undefined) return { closed: false, status: undefined };
      const current = receipts.get(child.receiptId);
      if (current === undefined) return { closed: false, status: undefined };
      // 终态不可覆盖。
      if (isTerminalStatus(current.status)) return { closed: false, status: current.status };

      const { status, note } = settleStatusFor(info?.stopReason);
      const next = {
        ...current,
        status,
        note,
        updatedAt: Date.now(),
      };
      await write('receipts.close', () => receipts.put(next.receiptId, next));
      await bump('settles');
      return { closed: true, status };
    },
    /**
     * 逐张表探测"它还在不在、读不读得出来"（v0.4，方案 §7.2 / T75）。
     *
     * 为什么要这个方法：上面每个 `listXxx()` 都被调用方包了 try，表坏了就退化成
     * 空数组。于是「表被删了」与「表里 0 条」在状态里长得一样，而用户看到
     * 「偏离 0」会以为一切正常。
     *
     * 这个方法**不抛**：它的用途就是"报告坏消息"，自己坏了就报不了。
     *
     * @returns {Array<{name: string, ok: boolean, size?: number, error?: string}>}
     */
    readTableHealth() {
      return TABLE_NAMES.map((name) => {
        try {
          const table = domain.table(name);
          // 真读一次。**`size` 是 getter，不是方法**——`dsh-storage-domain.js:253`
          // 是 `get size() { this.host.assertReadable(); return this.records.size; }`。
          // 所以这里必须用属性访问；写成 `table.size()` 会当场 TypeError。
          //
          // 这个细节是必要的：`domain.table(name)` 本身**不**校验可读性
          // （它只从构造时建好的 Map 里取），真正会在域关闭/损坏时抛错的是
          // `assertReadable()`，而它藏在 `size` / `keys()` / `entries()` 里。
          // 不碰其中一个，这个方法就只能永远返回"全部健康"——那就成了假证据。
          const size = table.size;
          return { name, ok: true, size: typeof size === 'number' ? size : undefined };
        } catch (error) {
          return { name, ok: false, error: String(error?.message ?? error) };
        }
      });
    },
    /**
     * 重启后的对账（方案 9.3 第 4 条、T35 + v0.3 §6.5）。
     *
     * 迁移规则：
     * - `intent` / `started` 且子会话不存在 → `unverified`（v0.2 行为不变）；
     * - `observed` 且子会话不存在 → `settled`，note 说明「停止原因未记录」。
     *
     * 后者是 v0.3 的扩展：`observed` 意味着「至少有一轮请求被正确压回」，
     * 这已足以判定「这次派出曾经正常运行过」。把它标 `unverified` 是过度悲观，
     * 会稀释 `unverified` 的信噪比。
     *
     * @param {(childSessionId: string) => boolean} sessionExists 该子会话当前是否仍存在
     * @returns {Promise<Array<object>>} 被改写的回执
     */
    async reconcileStaleReceipts(sessionExists) {
      assertOpen();
      const changed = [];
      for (const receipt of receipts.entries()) {
        const value = receipt[1];
        const isPending = value.status === RECEIPT_STATUS.INTENT || value.status === RECEIPT_STATUS.STARTED;
        const isObserved = value.status === RECEIPT_STATUS.OBSERVED;
        if (!isPending && !isObserved) continue;
        const childKnown = value.childSessionId !== '' && children.get(value.childSessionId) !== undefined;
        const alive = childKnown && sessionExists(value.childSessionId);
        if (alive) continue;

        const next = isObserved
          ? {
            ...value,
            status: RECEIPT_STATUS.SETTLED,
            note: '重启后确认子会话已结束（停止原因未记录）',
            updatedAt: Date.now(),
          }
          : {
            ...value,
            status: RECEIPT_STATUS.UNVERIFIED,
            note: '重启后未能确认该次派出的结果（子会话不存在或已结束）。插件不会自动重派，请人工核对会话记录。',
            updatedAt: Date.now(),
          };
        await write('receipts.reconcile', () => receipts.put(value.receiptId, next));
        changed.push(next);
      }
      if (changed.length > 0) await bump('reconciliations');
      return changed;
    },
    /**
     * 关闭台账。幂等。
     *
     * 关闭前写 `lastClosedAt`：它是区分「正常卸载」与「进程崩了」的唯一直接证据。
     * 下次打开时如果 `lastOpenedAt` 比 `lastClosedAt` 新，就说明上次没走这条路。
     */
    async close() {
      if (closed) return;
      try {
        await meta.put(META_KEY, { ...metaState, counters: { ...counters }, lastClosedAt: Date.now() });
      } catch {
        // 关闭路径上的失败不该抛（effect disposer 会把它变成噪音）。
      }
      closed = true;
      await domain.close();
    },
  };
}
