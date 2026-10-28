/**
 * 端到端验收夹具：把插件装进一个**装配得足够真**的宿主里。
 *
 * v0.3 对夹具的三项升级（方案 13.1 第 2 条「替身的能力必须 ≥ 被测字段」），
 * 每一项都对应 v0.2 的一处假绿：
 *
 * 1. `StubSubagents.startActivation` 记录**完整 spec**（含 `request.agentOptions`）。
 *    v0.2 只断言 `provider`/`delivery`，于是 P1-A（`agentOptions` 从未下发）在
 *    97 条全绿测试下潜伏了整个版本（T42/T43）。
 * 2. `makeAgent` 用**真实的 `createScope`** 铸造 `agent.ctx`，与宿主一致
 *    （`dsh-agent-loop`：`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`）。
 *    用裸 `ctx.extend({})` 冒充会让 `tools.guard()` 落到**全局层**——实测：
 *    在旧夹具里给 `root-1` 挂的 guard 会连带拒绝 `free-1` 和不带 agent 的调用。
 *    那样的夹具分不清「按 agent 治理」和「全局一刀切」（T56）。
 * 3. `StubAgents` 提供 `list/roots/get` 并允许**预置** live agent，
 *    `StubSessions` 提供 `get(id)` 供谱系解析。没有它们就测不出启动扫描（T45/T46）
 *    与孙级判定（T47）。
 *
 * 仍然不提供的：真实模型调用（需要网络与适配器）。因此这里能证明「谁被允许派出、
 * 派出时传了什么、请求被改成什么」，但不能证明「模型真的按这个路由回包」——
 * 后者归 `docs/known-limits.md`。
 */
import { createRequire } from 'node:module';

import { Context, Service } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';

const requireFromHere = createRequire(import.meta.url);

/**
 * 取真实的 `@deepseek-ai/dsh-scope`。
 *
 * 它是 `dsh-tools` 的传递依赖（宿主里一定有），但本包没有直接声明它，
 * 所以先试直接解析，再退回「从 dsh-tools 的位置解析」。
 * 两条都失败时夹具**显式失败**，不静默降级成 `ctx.extend({})`：
 * 那会得到一个「guard 全局限」的假宿主，让 T56 这类测试变成假绿。
 *
 * @returns {{createScope: Function, scopeOf: Function}}
 */
function loadScopePrimitives() {
  try {
    // 直接可用时优先（若将来把它提为显式依赖）。
    const direct = requireFromHere('@deepseek-ai/dsh-scope');
    if (typeof direct?.createScope === 'function') return direct;
  } catch {
    // 落到下一策略。
  }
  try {
    const fromTools = createRequire(requireFromHere.resolve('@deepseek-ai/dsh-tools'));
    const mod = fromTools('@deepseek-ai/dsh-scope');
    if (typeof mod?.createScope === 'function') return mod;
  } catch {
    // 下面统一报错。
  }
  throw new Error(
    '测试夹具需要 @deepseek-ai/dsh-scope 来铸造与宿主一致的 agent 作用域，当前解析不到。'
    + '它是 @deepseek-ai/dsh-tools 的传递依赖，请先 `pnpm install`。',
  );
}

export const scopePrimitives = loadScopePrimitives();

/** 最小 `systemPrompt` 替身（`ToolRuntime` 构造期需要 `tools()`）。 */
class StubSystemPrompt extends Service {
  providers = [];

  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  tools(provider) {
    this.providers.push(provider);
    return () => {
      const index = this.providers.indexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  section() {
    return () => {};
  }

  context() {
    return () => {};
  }

  getContextOrder() {
    return 0;
  }

  getSectionOrder() {
    return 0;
  }
}

/**
 * 可编程的 `subagents` 服务。
 *
 * `startActivation` 记录**完整** spec（与真实 `SubagentStartRequest` 对齐：
 * `{ provider, label, request, signal, delivery }`），并按 `behaviour` 决定成功或失败。
 * T42/T43 直接对这些记录做断言，不经请求锁做中介。
 */
class StubSubagents extends Service {
  static inject = [];

  /** 每次 startActivation 的完整 spec。 */
  calls = [];

  /** 每次的返回值或抛错。 */
  behaviour = () => ({ childId: `child-${this.calls.length}` });

  /**
   * 是否声明 `prepareContinuable`（决定插件能否预置 `childId`）。
   *
   * **默认 `false`**，与 v0.3 的替身一致。理由不是"真实后端不支持"——真实
   * `spawn` 后端**支持**（`.host-src/dsh-subagent.js:3038` 只在它缺失时才拒绝
   * 预置 id）。理由是**测试关注点分离**：
   *
   * - 绝大多数测试（L3 锁定、回执、偏离、覆盖诊断）关心的是"派出去之后怎么样"，
   *   它们用 `behaviour: () => ({ childId: 'child-1' })` 指定子会话 id 就好；
   * - 关心"预置 id 有没有生效"的测试（T71、V41–V44）显式打开它，
   *   这样断言才针对那一件事。
   *
   * 若默认 `true`，`behaviour` 里的 `childId` 会被忽略（真实宿主也忽略），
   * 于是二十多个与预置 id 无关的测试会因为"取不到 child-1"而变红——
   * 那种红是噪音，不是信号。
   */
  supportsReservedChildId = false;

  constructor(ctx) {
    super(ctx, 'subagents');
  }

  getProvider(name) {
    if (name !== 'spawn') return undefined;
    return {
      name: 'spawn',
      capabilities: { agentOptions: true, continuable: true },
      ...(this.supportsReservedChildId
        ? { prepareContinuable: (spec) => spec }
        : {}),
    };
  }

  listProviders() {
    return ['spawn'];
  }

  async startActivation(spec) {
    this.calls.push(spec);
    const outcome = this.behaviour(spec, this.calls.length);
    if (outcome instanceof Error) throw outcome;
    // 真实宿主会**原样采用**预置的 `childId`（`.host-src/dsh-subagent.js:1397`：
    // `spec.childId ?? brandString(randomUUID())`）。替身必须照做，否则
    // "预置 id 生效了吗"这件事在单测里测不出来（S5 的源码级证据）。
    if (typeof spec?.childId === 'string' && spec.childId !== '' && outcome?.childId !== spec.childId) {
      return { ...outcome, childId: spec.childId };
    }
    return outcome;
  }
}

/** 官方模型策略服务替身。 */
class StubOfficialPolicy extends Service {
  static inject = [];

  value = { enabled: false, allowedModels: [] };

  constructor(ctx) {
    super(ctx, 'subagentModelSelection');
  }

  current() {
    if (this.value.enabled === true && (this.value.allowedModels ?? []).length === 0) {
      // 与真实服务一致：启用但没有任何允许项是配置错误，会抛错。
      throw new Error('subagent model selection is enabled but allows no models');
    }
    return this.value;
  }
}

/**
 * `agents` 服务替身：`list/roots/get` + 预置「加载前已存在」的 agent。
 *
 * 真实契约（`@deepseek-ai/dsh-agent`）：`list(): Agent[]`（注册顺序、返回新数组）、
 * `roots(): Agent[]`、`get(id): Agent|undefined`。
 */
class StubAgents extends Service {
  static inject = [];

  entries = [];

  constructor(ctx) {
    super(ctx, 'agents');
  }

  /** 预置一个 agent（模拟「插件加载前已存在」）。 */
  preset(agent) {
    this.entries.push(agent);
    return agent;
  }

  list() {
    return [...this.entries];
  }

  roots() {
    return this.entries.filter((agent) => {
      const parent = agent?.session?.header?.parentSession;
      return typeof parent !== 'string' || parent === '';
    });
  }

  get(id) {
    return this.entries.find((agent) => agent?.session?.id === id);
  }
}

/** `sessions` 服务替身：谱系解析需要 `get(id)`。 */
class StubSessions extends Service {
  static inject = [];

  entries = new Map();

  constructor(ctx) {
    super(ctx, 'sessions');
  }

  preset(session) {
    this.entries.set(session.id, session);
    return session;
  }

  get(id) {
    return this.entries.get(id);
  }
}

/**
 * 每张表的主键字段，用于把 `seed` 记录写进正确的键。
 * 与 `lib/host/ledger.js` 的写入点一致（`put(key, value)` 的第一个参数）。
 */
const KEY_FIELDS = Object.freeze({
  receipts: 'receiptId',
  managed_roots: 'rootSessionId',
  children: 'childSessionId',
  // 偏离的键是 `${childSessionId}#${turn}`，不是单个字段，seed 不支持。
  // v0.4：meta 是单键表，键固定为 `'counters'`（见 `ledger.js` 的 `META_KEY`）。
  // 它没有"主键字段"可读，所以固定填 `'counters'`。
  meta: '__constant:counters',
  // v0.4：漏网记录以子会话 id 为键。
  escapes: 'childSessionId',
});

/**
 * 真实域契约的内存实现（schema 校验用声明里的 zod）。
 *
 * `seed` 用于模拟「上一次运行留下的台账」：T46（加载前已存在的子会话必须已被登记）
 * 与 T52/T53（受管根快照已冻结）都依赖它。没有它就只能从「刚装好」的状态出发，
 * 而那恰恰不是这些缺陷发生的现场。
 */
class StubStorageDomain extends Service {
  static inject = [];

  opened = [];

  /** `{ 表名: [记录...] }`，每次 `open()` 时按主键写入。 */
  seed = {};

  /**
   * 声明存在、但"读不出来"的表名（v0.4，T75）。
   *
   * 与"表没声明"不同：未声明的表走 `domain.table(name)` 就会抛；
   * 这里模拟的是**表在、读不动**（真机上手工删掉表目录之后的状态）。
   */
  brokenTables = [];

  constructor(ctx) {
    super(ctx, 'storageDomain');
  }

  async open(spec) {
    const stores = new Map(Object.keys(spec.tables).map((name) => [name, new Map()]));
    /**
     * 哪些表"在声明里、但读不出来"（v0.4，T75）。
     *
     * 模拟真机上的形态：`domain.table(name)` 不抛（它只从构造时的 Map 里取），
     * 抛错的是 `assertReadable()`，而它藏在 `size` / `keys()` / `entries()` 里。
     * 所以替身也必须让"取句柄成功、读内容失败"，否则插件里
     * "用 `domain.table()` 探测健康"这种错误写法在替身里永远是绿的。
     */
    const brokenTables = new Set(this.brokenTables ?? []);
    // 预置记录：走真实 zod 校验，形状不对的 seed 会当场失败（而不是静默通过）。
    for (const [tableName, records] of Object.entries(this.seed)) {
      const tableSpec = spec.tables[tableName];
      if (tableSpec === undefined) throw new Error(`seed 引用了域 '${spec.name}' 未声明的表 '${tableName}'`);
      for (const record of records) {
        const keyOf = KEY_FIELDS[tableName];
        if (keyOf === undefined) throw new Error(`seed 不支持表 '${tableName}'（未登记主键字段）`);
        // `__constant:<value>`：单键表（v0.4 的 `meta`）用固定键，不从记录里取。
        const key = keyOf.startsWith('__constant:') ? keyOf.slice('__constant:'.length) : record[keyOf];
        stores.get(tableName).set(key, tableSpec.valueSchema.parse(record));
      }
    }
    const handle = {
      name: spec.name,
      table(tableName) {
        const tableSpec = spec.tables[tableName];
        if (tableSpec === undefined) throw new Error(`domain '${spec.name}' declares no table '${tableName}'`);
        const store = stores.get(tableName);
        // 键集合的来源：默认是内存里的 `store`。
        //
        // `brokenTables` 可以把某张表换成"表在、但读不出来"——用来模拟真机上
        // 手工删掉一个表目录之后的状态（T75）。真机里 `domain.table(name)`
        // 本身不抛（它只从构造时的 Map 取），抛错的是 `assertReadable()`，
        // 而它藏在 `size` / `keys()` / `entries()` 里。
        const readStore = () => {
          if (brokenTables.has(tableName)) {
            throw new Error(`模拟：表 ${tableName} 不可读（T75）`);
          }
          return store;
        };
        return {
          get: (key) => readStore().get(key),
          keys: () => [...readStore().keys()],
          entries: () => [...readStore().entries()],
          // **getter，不是方法**——真实 `dsh-storage-domain.js:253` 就是
          // `get size() { this.host.assertReadable(); return this.records.size; }`。
          // 替身原先写成 `size: () => …`（方法），于是插件里 `table.size()`
          // 在替身中能过、在真机会 TypeError。那正是 §4.1 那类假绿。
          get size() {
            return readStore().size;
          },
          async put(key, value) {
            const parsed = tableSpec.valueSchema.parse(value);
            store.set(key, parsed);
            return parsed;
          },
          async delete(key) {
            return store.delete(key);
          },
        };
      },
      async close() {
        handle.closed = true;
      },
    };
    this.opened.push({ spec, handle, stores });
    return handle;
  }
}

/**
 * 造一个 agent：形状与运行时一致，并用**真实 `createScope`** 铸造它的 ctx。
 *
 * `agentCtx` 是**父**上下文（通常是 `host.ctx` 或 `host.ctx.extend({})`）。
 * 作用域挂在该父上下文下，与宿主 `createScope(loopCtx, agent)` 同构。
 *
 * @param {object} args
 * @param {string} args.id
 * @param {string} [args.rootSessionId] 直接父会话 id
 * @param {number} [args.depth]
 * @param {object} args.agentCtx 父上下文
 * @param {boolean} [args.preset] 是否登记进 `agents`/`sessions` 服务（默认不登记）
 * @returns {object} agent
 */
export function makeAgent({ id, rootSessionId, depth = 0, agentCtx, preset = false }) {
  const header = depth === 0
    ? { delegationDepth: 0 }
    : { parentSession: rootSessionId, delegationDepth: depth, origin: 'subagent' };
  const agent = {
    id,
    session: { id, header },
    options: depth === 0 ? {} : { subagentDepth: depth },
  };
  const scope = scopePrimitives.createScope(agentCtx, agent);
  agent.ctx = scope.ctx;
  agent.scope = scope;
  if (preset) {
    agentCtx.get('agents')?.preset?.(agent);
    agentCtx.get('sessions')?.preset?.(agent.session);
    // v0.4：子会话的**父会话也必须登记**。
    //
    // 真实宿主里父会话当然在 `sessions` 里（它是先创建才有子的）。
    // 若替身只登记子会话，`resolveRootSessionId` 往上走一步就断，
    // 谱系被标成 `limited`——于是 L3 会以 `LINEAGE_UNKNOWN` 拒绝，
    // 而那是一个**替身造成的**假失败，不是插件的行为。
    if (depth > 0 && typeof rootSessionId === 'string' && rootSessionId !== '') {
      const sessions = agentCtx.get('sessions');
      if (sessions?.get?.(rootSessionId) === undefined) {
        sessions?.preset?.({ id: rootSessionId, header: { delegationDepth: 0 } });
      }
    }
  }
  return agent;
}

/**
 * 起一个完整宿主并安装插件。
 *
 * @param {object} [config] 插件配置（会被 schemastery 归一化）
 * @param {object} [options]
 * @param {Array<object>} [options.existingAgents] 插件加载**前**就存在的 agent 规格（T45/T46）
 * @param {object} [options.seed] 预置台账记录 `{ receipts: [], managed_roots: [], children: [] }`
 * @returns {Promise<object>} 夹具
 */
export async function startStation(config = {}, options = {}) {
  const ctx = new Context();
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  // `ctx.plugin` 返回 Fiber，服务实例要从 `ctx.get(name)` 取。
  await ctx.plugin(StubSubagents);
  await ctx.plugin(StubOfficialPolicy);
  await ctx.plugin(StubStorageDomain);
  await ctx.plugin(StubAgents);
  await ctx.plugin(StubSessions);
  const subagents = ctx.get('subagents');
  const official = ctx.get('subagentModelSelection');
  const storage = ctx.get('storageDomain');
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  if (options.seed !== undefined) storage.seed = options.seed;

  // 表在、读不出来（T75）：模拟真机上手工删掉一个表目录之后的状态。
  if (options.brokenTables !== undefined) storage.brokenTables = options.brokenTables;

  // 模拟"台账打不开"（T73）：必须在插件 `apply()` **之前**让域拒绝打开，
  // 否则 openLedger 已经成功了，坏的只是之后的某次写入——那是另一件事。
  if (options.breakStorage === true) {
    storage.open = async () => {
      throw new Error('模拟存储不可用（T73）');
    };
  }

  // 加载前已存在的会话：必须在插件 `apply()` 之前就登记好（T45/T46）。
  const existing = (options.existingAgents ?? []).map((spec) => makeAgent({
    ...spec,
    agentCtx: ctx,
    preset: true,
  }));

  const station = await import('../lib/host/index.js');
  const resolved = station.Config({
    managedSessionIds: ['root-1'],
    allowedRoutes: [
      { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model', efforts: ['low'] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
    ],
    roles: [
      { roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong', enabled: true },
      { roleId: 'scout', mode: 'allowlist', defaultRouteId: 'cheap', allowedRouteIds: ['cheap', 'strong'], enabled: true },
    ],
    ...config,
  });
  const fiber = await ctx.plugin(
    { name: station.name, apply: station.apply, inject: station.inject },
    resolved,
  );

  // 台账打开与启动扫描都是同步 effect 派生的异步工作，等一个宏任务让它们跑完。
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const host = {
    ctx,
    tools: ctx.tools,
    subagents,
    official,
    storage,
    agents,
    sessions,
    existing,
    fiber,
    /** 本夹具推荐用的 agent 工厂（自动登记进 agents/sessions）。 */
    makeAgent: (spec) => makeAgent({ ...spec, agentCtx: ctx, preset: true }),
    /** 诊断服务（v0.3：与 `station_status` 共用同一份 `buildStatus()`）。 */
    service: ctx.get('subagentStation'),
    /**
     * 触发 `agent/created` 并等监听器跑完。
     *
     * 真实宿主用 `serial` 派发（`agents.announce` → `ctx.serial(carrier, 'agent/created')`），
     * 所以这里必须 await。
     */
    async announce(agent, source = 'startup') {
      await ctx.parallel('agent/created', { agent, source });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
    /** 模拟宿主在子会话结束时发出 `subagent/end`（作用域按委派父）。 */
    async emitSubagentEnd(parentAgent, info) {
      parentAgent.ctx.emit('subagent/end', info);
      // 监听器是 fire-and-forget，等它把台账写完。
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
    /** 取回执（按 receiptId）；取不到返回 undefined。 */
    receipt(receiptId) {
      return [...(host.storage.opened.at(-1)?.stores.get('receipts')?.values() ?? [])]
        .find((value) => value.receiptId === receiptId);
    },
    /** 全部回执（按写入顺序）。 */
    receipts() {
      return [...(host.storage.opened.at(-1)?.stores.get('receipts')?.values() ?? [])];
    },
    /** 全部子会话登记。 */
    children() {
      return [...(host.storage.opened.at(-1)?.stores.get('children')?.values() ?? [])];
    },
    /**
     * **最近一次派出的子会话 id**。
     *
     * v0.4 起后端支持预置 id 时，插件会用 `randomUUID()` 占位——也就是说
     * `behaviour: () => ({ childId: 'child-1' })` 里的那个 `'child-1'` 会被**忽略**
     * （真实宿主也忽略，S5）。
     *
     * 所以测试不能硬编码子会话 id，必须回读真实值。这个 helper 就是为了让
     * "回读"变成一行，而不是让每个测试自己翻台账。
     *
     * @returns {string|undefined}
     */
    lastChildId() {
      return host.children().at(-1)?.childSessionId;
    },
    /** 全部偏离记录。 */
    deviations() {
      return [...(host.storage.opened.at(-1)?.stores.get('deviations')?.values() ?? [])];
    },
    /** 受管根快照记录。 */
    managedRoots() {
      return [...(host.storage.opened.at(-1)?.stores.get('managed_roots')?.values() ?? [])];
    },
    /**
     * **直接执行**一个工具，绕过 guard。
     *
     * 与 `attemptCall` 的分工：那个走真实 guard 链路（测"拦不拦"），
     * 这个直接调工具本体（测"工具自己会不会抛"）。
     *
     * 为什么两个都要：`station_status` 的核心承诺是"诊断工具自己不许坏"，
     * 而这条承诺在 guard 链路里**测不出来**——guard 的拒绝也走 `post-result`，
     * 与"工具抛了"在返回值上长得一样。
     *
     * @param {string} name
     * @param {object} [args]
     * @param {object} [agent]
     * @returns {Promise<unknown>}
     */
    async executeTool(name, args = {}, agent = undefined) {
      const tool = host.tools.get?.(name) ?? host.tools.tools?.get?.(name);
      if (tool === undefined) throw new Error(`工具 '${name}' 未注册`);
      const exec = {
        arguments: args,
        callId: `exec-${Math.random()}`,
        rootCallId: `rexec-${Math.random()}`,
        signal: new AbortController().signal,
        ...(agent === undefined ? {} : { agent }),
      };
      return tool.execute(args, exec);
    },
    /**
     * 取一次调用**如果被拒绝**时的文案（走真实 guard 链路）。
     *
     * 为什么单独一个方法：`attemptCall` 只回 `{denied, reason}`，读文案要额外解析；
     * 而文案本身在 v0.4 是被测对象（分级、工具名可执行性、单行约束）。
     *
     * @param {{name: string, agent?: object, arguments?: object}} spec
     * @returns {Promise<string|undefined>} 拒绝文案；放行时 undefined
     */
    async guardRefusal(spec) {
      const outcome = await attemptCall(host, spec.name, spec.agent, spec.arguments ?? {});
      return outcome.denied ? outcome.reason : undefined;
    },
    /**
     * 热更新一个 volatile 配置字段（模拟用户在设置里改配置）。
     *
     * 真实宿主把 volatile 字段解析成 `{ get() }` 包装，并在保存时替换该字段；
     * 这里用同样的形状替换，验证的是 `readPolicy()`「每次重新读取、不缓存」的承诺。
     *
     * @param {string} field
     * @param {unknown} value
     */
    setConfig(field, value) {
      const config = fiber?.config;
      if (config === undefined) throw new Error('取不到已解析的 Config');
      const current = config[field];
      if (current !== undefined && typeof current === 'object' && typeof current.get === 'function') {
        // 保持 volatile 包装，让插件继续用 `unwrap()` 读取。
        config[field] = { get: () => value };
        return;
      }
      config[field] = value;
    },
    stop: async () => {
      await ctx.fiber.dispose();
    },
  };
  return host;
}

/**
 * 直接调用 `dispatch_agent` 并取回它的文本结果。
 *
 * 走真实 `defineTool` 编译后的 `execute`，因此参数校验与 `render` 全在链路上。
 *
 * @param {object} host `startStation` 的结果
 * @param {object} args 工具参数
 * @param {object} exec 执行上下文（至少要有 `agent`）
 * @returns {Promise<string>} 回执文本
 */
export async function callDispatch(host, args, exec) {
  const definition = host.tools.get('dispatch_agent');
  const value = await definition.execute(args, {
    name: 'dispatch_agent',
    callId: 'call-1',
    rootCallId: 'call-1',
    signal: new AbortController().signal,
    arguments: args,
    ...exec,
  });
  // 用真实 render 把值变成模型可见的文本，验证回执确实进入工具结果。
  const blocks = definition.output.render(args, value);
  return blocks.map((block) => block.text).join('\n');
}

/**
 * 直接调用 `station_status` 并取回文本（v0.3 新增工具）。
 *
 * @param {object} host
 * @param {object} [args]
 * @param {object} [exec]
 * @returns {Promise<string>}
 */
export async function callStatus(host, args = {}, exec = {}) {
  const definition = host.tools.get('station_status');
  if (definition === undefined) throw new Error('station_status 未注册');
  const value = await definition.execute(args, {
    name: 'station_status',
    callId: 'status-1',
    rootCallId: 'status-1',
    signal: new AbortController().signal,
    arguments: args,
    ...exec,
  });
  const blocks = definition.output.render(args, value);
  return blocks.map((block) => block.text).join('\n');
}

/**
 * 用真实 guard 链路判断一次工具调用是否被拒绝。
 *
 * 必须走 `prepareScheduledExecution`：guard 在 `prepareExecution` 里调用
 * （`.host-src/dsh-tools.js:3337`），裸 `execute()` 会得到「guard 从未被调用」的假绿。
 *
 * `args` 必须真的传下去：v0.4 的 `send_message` 目标校验读 `exec.arguments.agent_id`
 * （`entry-governor.js` 的 `resolveTarget`）。v0.3 的替身这里固定 `arguments: {}`，
 * 于是任何"看参数再决定"的守卫都变成"永远读不到参数"——那是最容易漏的一类假绿。
 *
 * @param {object} host
 * @param {string} name
 * @param {object|undefined} agent
 * @param {object} [args]
 * @returns {Promise<{denied: boolean, reason: string|undefined}>}
 */
export async function attemptCall(host, name, agent, args = {}) {
  const prepared = await host.tools.prepareScheduledExecution({
    name,
    arguments: args,
    callId: `call-${Math.random()}`,
    rootCallId: `root-${Math.random()}`,
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  });
  if (prepared.kind === 'post-result') {
    const text = prepared.result?.content?.map((block) => block.text).join('\n') ?? '';
    return { denied: true, reason: text };
  }
  return { denied: false, reason: undefined };
}

/** 注册一个假的派生工具，模拟原生入口（`subagent` 等）。 */
export function registerFakeTool(host, name) {
  return host.tools.register({
    name,
    description: `假的 ${name}，用于验证入口治理`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      return 'should not run';
    },
  });
}

/**
 * 造一条「上一次运行留下的」子会话登记（用于 `seed.children`）。
 *
 * @param {object} args
 * @returns {object}
 */
export function seedChild({
  childSessionId, rootSessionId = 'root-1', roleId = 'reviewer', provider = 'vendorA',
  model = 'pro-model', reasoningEffort = 'high', receiptId = 'rcpt-seed-1',
} = {}) {
  return {
    childSessionId,
    rootSessionId,
    roleId,
    receiptId,
    provider,
    model,
    createdAt: Date.now() - 60_000,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/**
 * 造一条「上一次运行留下的」回执（用于 `seed.receipts`）。
 *
 * @param {object} args
 * @returns {object}
 */
export function seedReceipt({
  receiptId = 'rcpt-seed-1', status = 'started', rootSessionId = 'root-1', parentSessionId = 'root-1',
  childSessionId = 'child-1', roleId = 'reviewer', provider = 'vendorA', model = 'pro-model',
  reasoningEffort = 'high', snapshotVersion = 1, policyRevision = 1, note = '', createdAt = Date.now() - 60_000,
} = {}) {
  return {
    receiptId,
    status,
    roleId,
    roleLabel: roleId,
    mode: 'fixed',
    rootSessionId,
    parentSessionId,
    childSessionId,
    route: {
      routeId: 'strong',
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    routeReason: 'role-default',
    effortReason: 'route-default',
    policyRevision,
    snapshotVersion,
    createdAt,
    updatedAt: createdAt,
    note,
  };
}

/**
 * 造一条「上一次运行留下的」受管根快照（用于 `seed.managed_roots`）。
 *
 * @param {object} args
 * @returns {object}
 */
export function seedManagedRoot({
  rootSessionId = 'root-1', snapshotVersion = 1, stationRoutes = [], epoch = undefined,
  officialStatus = 'absent', officialRoutes = [],
} = {}) {
  return {
    rootSessionId,
    snapshotVersion,
    policyRevision: 1,
    createdAt: Date.now() - 60_000,
    stationRoutes,
    officialRoutes,
    officialStatus,
    ...(epoch === undefined ? {} : { epoch }),
  };
}

export { Context, Service };
