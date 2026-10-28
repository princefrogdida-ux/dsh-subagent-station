# 契约证据（v0.2 阶段 0 + v0.3 阶段 0）

- 核实日期：v0.2 = 2026-10-21；v0.3 = 2026-10-24
- 核实对象：本机运行中的 DeepSeek Harness 桌面版 `0.2.1-rc.2`
  - v0.2 引用路径为 `<DSH_INSTALL_DIR>\resources\app.asar\dsh`
  - **v0.3 起以 `D:\Users\princ\deepseek harness\resources\app.asar\dsh\` 为准**
    （实际安装位置已变；v0.2 的旧行号需按新路径复核）
- 方法：`cordis_inspect_query`（运行时权威）+ 从 `app.asar` 抽取的已发布 `lib/index.js` 源码（行号可复现）

> 方案第 10 节要求「每一条附运行时输出或源码行号」。本文只记录**实际验证过的**结论。
> 凡未能验证的，明确写「未验证」，并在设计里按「不成立」处理。

提取工具：`tools/asar-extract.mjs`（从 `app.asar` 按路径抽取单个文件到 `.host-src/`，可重复执行）。
抽取到的文件在 `.host-src/` 下，本文引用的行号都指向这些文件。

**v0.3 的一处纪律**：v0.2 有三条论证是错的（不是不完整，是错的），已就地标注更正：
`C2-b` 末段（`agentOptions` 那条）、`known-limits.md` §3.4（持久化论证）、
以及 `tools.guard` 的作用域（v0.2 只写了「挂在 `agent.ctx` 上」而没核实等价性）。
错的行号与错的推论比缺失更危险——它们让人以为已经查过了。

## 结论速览

| 编号 | 问题 | 结论 | 对方案的影响 |
| --- | --- | --- | --- |
| C1 | `defineTool` 如何编译 `parameters` / `output.render` 签名 | **成立**；但 v0.1 的缺陷是**静默**的，不是加载期抛错（见 C1-b′） | 阶段 1 可按 7.1 实现，且必须用 `defineTool` |
| C2 | `agent/request` 是否对子智能体触发 | **成立**，agent 作用域事件 | G4 可做 |
| C3 | `maxDepth: 0` 是否封顶子会话委派 | **不成立**；`toolFilter` 也不通 | **L1 必须删除**（见 C3-f） |
| C4 | 预留 `childId` 连续两次派出 | **报错拒绝**（`DUPLICATE_CHILD`） | 幂等可按「同 ID 重试即失败」设计 |
| C5 | `storageDomain` 是否挂载 / `domain/changed` | **成立**；但表名必须 snake_case（C5-c′，实测踩坑） | G5 可做 |
| C6 | 当前 profile 可见的全部派生入口 | **已枚举**（见 C6） | 目录需要含 7 个名字 |
| C7 | Host→Client 数据通道 | **成立**，但需先验证 `@Remote` 用法 | 阶段 B 面板可能可行 |

---

## C1 — `defineTool`

### C1-a `parameters` 的 DSL 编译

运行时实测（`tests/contract/c1-define-tool.mjs`）：

```
parameterSchemaSpecToJsonSchema({
  roleId: { type: 'string', required: true, description: '...' },
  prompt: { type: 'string', required: true },
  routeId: { type: 'string', description: '...' },
})
→ {
  "type": "object",
  "properties": { roleId: {...}, prompt: {...}, routeId: {...} },
  "required": ["roleId", "prompt"]
}
```

源码依据 `.host-src/dsh-tools.js:594-616`（`property-map-tail` 把 `required` 收集成数组）
与 `.host-src/dsh-tools.js:802-811`（`parameterSchemaSpecToJsonSchema` 输出 `required: compiled.required`）。

**结论**：DSL 的 `required: true` 合法，编译成 `required: string[]`。方案 7.1 的写法成立。

### C1-b 手写 JSON Schema 里 `required` 放属性上会被拒绝（但 v0.1 不是这种情况）

运行时实测：把 `required: true` 放在**属性**里手写 JSON Schema 会被 `assertSupportedJsonSchema` 拒绝：

```
REJECTED: unsupported JSON schema: schema.properties.a.required is not supported on type "string"
```

源码依据 `.host-src/dsh-tools.js:241-260`（`required` 只允许出现在 `type: "object"` 上）。

> **⚠ 本节初稿的结论已被实测推翻，这里保留修正记录。**
>
> 初稿写「`register()` 会直接抛错，插件加载即失败，这就是 P1-1」。
> 用真实 `ctx.tools.register` 跑 v0.1 的形状（`tests/unit/legacy-registration.test.js`）后确认：
> **不抛错，注册成功**。
>
> 原因是 `register()` 只校验 `output`、`timeoutMs` 与保留名，**从不校验 `parameters`**
> （`.host-src/dsh-tools.js:2974-2983`）。上面那个 `assertSupportedJsonSchema` 拦的是
> `output.schema`，而 v0.1 的 `output.schema` 是合法的 `{ type: 'string' }`。

### C1-b′ v0.1 的真实缺陷是两类**静默**错误

实测（`tests/unit/legacy-registration.test.js`，4 条全绿）：

| 缺陷 | 实际后果 | 证据 |
| --- | --- | --- |
| `parameters` 用 DSL 形状直接塞给 `register` | 模型看到的 `parameters` **没有 `type: 'object'`、没有 `properties`**，岗位字段裸露在顶层 | `schemaOf` 原样透传 `parameters`，`.host-src/dsh-tools.js:3139-3149` |
| 同上 | **参数完全不校验**：`execute({})` 照跑，缺 required 也不报错 | 只有 `defineTool` 在 `execute` 外层包 `validateJsonSchemaValue`，`.host-src/dsh-tools.js:866-870` |
| `output.render` 写成 `(value)` | 不抛错，而是**把 args 当结果渲染**，回执里出现 `[object Object]`，真实结果被丢弃 | `render(args, value)`，`.host-src/dsh-tools.js:857-859`；调用点 `3644` |

这三条都是「静默错误」，比加载期抛错更难发现——**这才是必须换成 `defineTool` 的理由**。
`defineTool` 把静默错误变成编译期正确的 schema 与运行期校验：

```
RAW registration: execute called with {}? true  | args: {}
defineTool threw: ToolArgsError | invalid arguments: missing required property "roleId"
defineTool: execute called with {}? false
```

### C1-c `output.render` 的真实签名

运行时实测（在 render 里读实参）：

```
render 实际收到的参数个数 = 2
render 实参[0] = { roleId: 'r1' }     ← args
render 实参[1] = 'the-value'          ← value
```

源码依据 `.host-src/dsh-tools.js:857-859`（`render(args, value) { return userRender(args, value) }`）。

**结论**：签名是 `(args, value) => ContentBlock[]`。v0.1 的 `(value)` 写法（P1-2）确认是错的。

### C1-d `output.schema` 支持的根类型

运行时可接受：`{type:'string'}`、`{type:'object', additionalProperties:false, properties:{...}}`、
以及**不带** `additionalProperties` 的 object。

**结论**：回执用 `output.schema: { type: 'string' }`（紧凑文本）是合法的。

### C1-e 参数校验发生在 `execute` 之前

运行时实测：非法参数时 `execute 被调用=false`，抛出
`ToolArgsError / INVALID_ARGS / invalid arguments: "n" must be a number`。

源码依据 `.host-src/dsh-tools.js:866-870`。

### C1-f `defineTool` 产出的定义形状

运行时实测顶层键：`["name","description","parameters","output","execute"]`。
编译后的 `parameters` 是 JSON Schema，`output.schema` 是编译后的值 schema。

---

## C2 — `agent/request`

### C2-a 事件存在且是 waterfall

`cordis_inspect_query(Event, agent/request)` 返回：

```
mode: waterfall
signature: 'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
                           next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
description: "Replace the frozen call configuration. `await next()` yields the config the machine would use
(bugfix: agent options on the first request, the logged header afterwards); return a replacement to switch.
On step admission, this runs after assembly and `step/start`, before the system prompt and accepted user batch
are committed."
```

参数说明还明确写了：

> `.signal - the current turn's explicit abort signal. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
> agent-scoped listeners receive only that agent.`

**这是方案第 3 节最关键的一条**：作用域过滤是 agent 级的，因此把监听器注册在子会话的 `agent.ctx` 上，
就只会收到该子会话的请求。方案 3.2 的设计成立。

> **⚠ 实现时实测到的补充（不是契约的错，是必须自己兜住的边界）：**
>
> 「agent-scoped listeners receive only that agent」是**宿主派发实现**给的保证，
> 不是插件能验证的保证。在本仓的夹具（`tests/host-fixture.js`）里，
> 当 `agent/request` 被在更宽的作用域上派发时，**两个子会话的监听器会互相收到对方的请求**，
> 实测表现为：`scout` 岗位的子会话被压成了 `reviewer` 的模型。
>
> 因此 `lib/host/request-lock.js` **不单靠作用域隔离**，监听器自己比对
> `payload.agent.session.id` 与闭包里的 `childSessionId`，不匹配就 `return next()` 让开。
> 代价是一行判断，收益是「串路由」这一类静默错误不可能发生。
>
> 回归测试：`tests/unit/request-lock-e2e.test.js` 的
> 「两个不同岗位的子会话各自被自己的台账值锁定（不串路由）」与
> 「监听器忽略不属于自己的请求（即使事件被广播到更宽的作用域）」。
>
> **仍未验证**：真实宿主里 `agent/request` 的实际派发宽度。本仓夹具比真实宿主更宽，
> 因此上述测试是「更严格的一侧」，不影响结论成立，但也不能反过来当作「真实宿主会串」的证据。

### C2-b 监听器必须自己 `await next()`

源码依据 `.host-src/dsh-agent-loop.js:1186-1197`：

```js
const seedConfig = deepFreeze(structuredClone(this.requestHeaderLogged ? requestProposal(persistedHeader) : {
  ...route,
  ...(reasoningEffort === void 0 ? {} : { reasoningEffort }),
  ...(maxTokens === void 0 ? {} : { maxTokens })
}));
const proposedConfig = await this.dispatch.waterfall("agent/request", { turn, step, signal },
  () => Promise.resolve(seedConfig));
signal.throwIfAborted();
if (!proposedConfig.provider || !proposedConfig.model) throw new Error(...)
```

**首轮 `next()` 返回什么**（对应方案 3.5 第 3 条）：
- 首次请求（`requestHeaderLogged === false`）：`{ ...route, reasoningEffort?, maxTokens? }`，
  其中 `route` 来自 **`this.options.provider/model`**，也就是这个 agent 自己的
  `AgentOptions`（`.host-src/dsh-agent-loop.js:1179-1182`）。
- 之后：`requestProposal(persistedHeader)`，即上一个 `request/header` 记录的配置。

这一点决定了偏离判定的基线：**首轮就能与台账比对**，不需要等第二轮。

> **v0.3 更正（原文在此处论证有误）**
>
> v0.2 的这段话写的是「即 `agentOptions` 下发的值确实在首轮就在」。**那句话本身没错，
> 但它被当成了「已经做到」的证据，而实际代码并没有下发 `agentOptions`。**
>
> 准确的说法是：`this.options.provider/model` 是**这个 agent 被创建时**拿到的
> `AgentOptions`。宿主解析它的位置在 `.host-src/dsh-subagent.js:315-331`
> （`resolveChildAgentOptions`）：只有 `request.agentOptions` 里显式给了
> `provider`/`model`，子会话才会拿到岗位路由；否则它继承父会话的
> （`parentAgentOptionsForDelegation`，`:293-303`）。
>
> 因此这条证据恰恰**证明了 v0.2 的缺陷**：既然种子配置来自 `this.options`，
> 那么不下发 `agentOptions` 就意味着首轮一定用父会话的模型。
> v0.3 的修复见下面 C8-a。

### C2-c 抛错的表现

源码依据 `.host-src/dsh-agent-loop.js:1191-1197`：`waterfall` 的 rejection 直接从
`agent/request` 那一步抛出（`proposedConfig` 赋值失败），随后被上层 `agent/error` 捕获。
方案 3.2 第 4 条「抛 `StationError` 让该轮以可诊断错误结束」成立，不会崩进程。

> 注意：`LlmCallConfig` 在 `.host-src/dsh-agent-loop.js:1186` 被 `deepFreeze` 之后再喂给 waterfall，
> 所以监听器**不能原地修改** `current`，必须返回新对象。方案 3.2 第 3 条「扩散返回」是唯一正确写法。

---

## C3 — `maxDepth: 0`（**方案理解有误，必须修正**）

### C3-a 服务侧的真实语义

源码依据 `.host-src/dsh-subagent.js:279-284`：

```js
function resolveChildDepth(parent, maxDepth) {
  const childDepth = delegationDepthOf(parent) + 1;
  if (!Number.isSafeInteger(childDepth)) throw new RangeError(...);
  if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(childDepth, maxDepth);
  return childDepth;
}
```

`delegationDepthOf`（`.host-src/dsh-subagent.js:111-115`）：

```js
return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);
```

首层子会话的 `childDepth = 0 + 1 = 1`。

**因此 `maxDepth: 0` 会让 `1 > 0` 成立，在 `startActivation` 内直接抛 `SubagentDepthError`
——即「根本派不出去」，而不是「派出去了但孙级被禁」。**

### C3-b 官方 README 的措辞印证

`@deepseek-ai/dsh-subagent/README.md:47`：

> `maxDepth` defaults to `1` ... Depth `0` disables delegation through tools inheriting this setting;
> depth `1` permits direct children only.

「disables delegation」指的是**该工具本身不能派出**，不是「派出去的孩子不能派出」。

### C3-c `request.maxDepth` 不是「这个孩子还能派几层」

`maxDepth` 的唯一检查点是 `resolveChildDepth`（`.host-src/dsh-subagent.js:279-284`），
而它只在**创建这个孩子的那一刻**执行一次：

```js
const childDepth = delegationDepthOf(parent) + 1;
if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(childDepth, maxDepth);
```

它的语义是**「被创建的孩子的绝对深度上限」**。传 `0` 时 `1 > 0` 成立 → 直接拒绝派出，
与「派出成功但禁止孙级」的目标正好相反。

### C3-d `maxDepth` 不会被持久化，因此不约束后代的派出

`startLocal` 构造描述符时只带 `agentProvider` / `agentModel` / `agentReasoningEffort`
（`.host-src/dsh-subagent.js:1404-1411`），`snapshotSubagentDescriptor` 的字段集合里**没有 `maxDepth`**
（`.host-src/dsh-subagent.js:670-681`）。

因此：**给某个孩子传一个 `maxDepth`，不会让它自己后续的派出受这个值约束。**
子会话再派时，`maxDepth` 由**子会话里那个委派工具自己的 Config** 决定
（`.host-src/dsh-tool-subagent.js:461`：`resolveMaxDepth(config.maxDepth)`），
缺省回落到 `subagents` 服务的全局 `maxDepth`。本机 profile 该值是 `2`
（`<DSH_HOME>\profiles\desktop\cordis.patch.yml` 的 `subagent.maxDepth: 2`）。

结论：**`request.maxDepth` 无法实现「禁止孙级」**。这与传什么值无关。

### C3-e `toolFilter` 这条路也不通

`SubagentStartRequest.toolFilter` 在类型上存在，后端也确实会把它应用成作用域内
`childCtx.tools.restrict(composition.toolFilter)`（`.host-src/dsh-subagent.js:395`），
看起来正是「让子会话失去派生工具」的完美机制。但：

- `SubagentStartRequest`（`subagent/start` 引用的运行时类型）**没有 `toolFilter` 字段**——
  它只有 `cwd` / `agentPreset` / `label` / `prompt` / `parent` / `signal` / `agentOptions` /
  `outputSchema` / `maxDepth`。
- `startLocal` 走本地后端时，`composition` 只传 `{ agentPreset: request.agentPreset }`
  （`.host-src/dsh-subagent.js:1452`），**不透传 `toolFilter`**。
  只有**冷恢复**路径才会从历史描述符里恢复 `toolFilter`（`.host-src/dsh-subagent.js:2180`）。

结论：`toolFilter` 只能由 provider 内部或历史描述符提供，**插件无法通过 `startActivation` 设置**。

### C3-f 最终结论：L1 不可兑现，必须从承诺里删除

方案 5.1 的 L1（「派出时传 `maxDepth: 0`，子会话的委派工具在运行时层面被封顶」）
**在 DSH 0.2.1-rc.2 上不成立**，且没有等价替代：

| 候选机制 | 能否由插件通过 `startActivation` 设置 | 能否约束子会话的后代 |
| --- | --- | --- |
| `request.maxDepth = 0` | 能 | **不能**——直接拒绝本次派出 |
| `request.maxDepth = childDepth` | 能 | **不能**——不持久化，且不拒绝正常派出 |
| `request.toolFilter` | **不能**（类型与实现都不透传） | — |
| 改 `tool-subagent` 行的 Config | **不能**（那是别的插件条目） | — |

**v0.2 的处理**：

1. **删除 L1 承诺**，改为两层：L2（`tools.guard` 执行期拒绝）+ L3（`agent/request` 请求锁定）。
2. `dispatch_agent` 派出时**不传 `maxDepth`**，避免误拒；注释写明原因。
3. README 与 `docs/known-limits.md` 明确写：孙级禁令由 guard 实现（工具层拒绝），
   **不是运行时深度封顶**；若用户在原生界面之外用第三方插件直调服务，仍不在覆盖范围内。
4. T29 的判据**改写**为「孙级派出被 guard 拒绝并给出原因」，不再声称「运行时报无权限」。
   方案 5.1 的 L1 行、11 节 T29 行、12 节「`maxDepth: 0` 被 provider 忽略」风险行都要同步改。

---

## C4 — 预留 `childId`

### C4-a 重载确实存在

`cordis_inspect_query(Service, subagents)` 返回两个重载：

```ts
startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>
startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
```

`SubagentActivationSpec`:

```ts
{
  readonly provider: string;
  readonly label: string;
  readonly childId?: SessionId;
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>;
  readonly signal: AbortSignal;
  readonly delivery: 'parent' | 'caller';
}
```

### C4-b 重复 ID 会被拒绝，不会静默覆盖

源码依据 `.host-src/dsh-subagent.js:1596-1598`：

```js
assertChildIdAvailable(childId) {
  if (this.resident.has(childId) || this.ctx.agents.get(childId) !== void 0
      || this.ctx.get("sessions")?.get(childId) !== void 0)
    throw new SubagentError(`subagent "${childId}" already exists`, "DUPLICATE_CHILD");
}
```

调用点在 `.host-src/dsh-subagent.js:1397-1399`（`startLocal`）。

**结论（对应 T39）**：同一 `childId` 连续两次 `startActivation` 会以 `DUPLICATE_CHILD` 失败，
不会产生第二个子会话。因此「用 `receiptId` 派生稳定 childId」是**安全的幂等键**：
重试必然失败而不是静默重复。方案 9.3 可以按这条落地，并把「待核对」态收敛掉。

### C4-c 预留 ID 需要本地后端

源码依据 `.host-src/dsh-subagent.js:3038`：

```js
if (spec.childId !== void 0 && provider.prepareContinuable === void 0)
  throw new SubagentError("reserved child ids require a local backend", "UNSUPPORTED_CAPABILITY");
```

`spawn` 提供 `prepareContinuable`（`.host-src/dsh-subagent-spawn.js:31-33`），因此可用。

---

## C5 — 持久化

### C5-a `storageDomain` 已挂载

`plugin_manager.list_plugins` 中 `include:storage-domain` 为 `enabled: true`、`fiberPhase: active`。
`cordis_inspect_query(Service, storageDomain)` 返回 `open` / `get` / `closeAll`。

基础层配置（`.host-src/dsh-base.patch.yml:179-190`）：

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

### C5-b 域规范与关闭时序

`Domain`（`cordis_inspect_query(Service, storageDomain)`）：

```ts
interface Domain<S extends DomainSpec> {
  readonly name: string;
  readonly global: DomainGlobalHandleOf<S>;
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
  close(): Promise<void>;
}
interface KvTable<K extends string, V> {
  get(key: K): V | undefined;
  entries(): IterableIterator<[K, V]>;
  keys(): IterableIterator<K>;
  readonly size: number;
  put(key: K, value: V): Promise<void>;
  delete(key: K): Promise<boolean>;
  update(key: K, fn: (current: V) => V): Promise<V>;
}
```

关闭时序（`.host-src/dsh-storage-domain.js:348-351`）：

> Lifecycle: the CALLER owns the returned handle and closes it via `Domain.close()`
> (typically as its own `ctx.effect` disposer) — the facility does not tie the domain to any consumer fiber.

**结论**：`ctx.effect(() => async () => { await domain.close() })` 是正确的挂载方式。

### C5-c 迁移与无效记录

`DomainSpec`（运行时类型）：

```ts
{
  readonly name: string;
  readonly version: number;
  readonly layout?: 'single' | 'per-record';
  readonly compatibleVersions?: readonly number[];
  readonly invalidRecords?: 'backup-and-skip';
  readonly global?: DomainGlobalSpec<unknown>;
  readonly tables: Record<string, DomainTableSpec>;
}
```

`invalidRecords` 只接受 `'backup-and-skip'`（`.host-src/dsh-storage-domain.js:69-72`），
且需要 backend 的 `backupRecord`（`.host-src/dsh-storage-domain.js:373`）。
`json` backend 是否实现 `backupRecord` **未验证**——按「不成立」处理：读不出就按 C5-d 的路径报错。

### C5-c′ 域名与表名必须是 snake_case（实测踩到的坑）

`DomainSpec.tables` 的**键名**不是随意的：`json` 后端在 `open()` 时用
`validateDescriptor` 校验域名与每个表名：

```js
// .host-src/dsh-storage-json.js
function validateDescriptor(descriptor) {
  if (!UNIT_NAME_RE.test(descriptor.name)) throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`);
  for (const table of descriptor.tables) if (!UNIT_NAME_RE.test(table)) throw new StorageError(...);
}
```

而 `UNIT_NAME_RE`（`@deepseek-ai/dsh-storage` 的 `backend` 模块）：

```js
/** Allowed format for unit and table names: safe as a file name and as a SQL identifier segment without escaping. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
```

**v0.2 初版把表名写成 `managedRoots`（camelCase），在真实宿主里整个域打不开**：

```
派出台账打不开……原因：invalid table name 'managedRoots' in unit 'station_dispatch_ledger'
```

后果是**所有派出被拒绝**（因为台账打不开就拒绝派出）。这个错误在单元测试里不会暴露——
测试替身不实现 `validateDescriptor`。修正与防回归：

- 表名改为 `managed_roots`；
- `tests/unit/ledger.test.js` 增加「域名与表名必须是 snake_case」的断言，对
  `LEDGER_DOMAIN.name` 与每个表名跑 `/^[a-z][a-z0-9_]*$/`。

> 又一次印证：`register()` 那条结论（C1-b′）与本条都说明——**只有真实宿主才会暴露的一类错误，
> 必须靠「在真实宿主里跑一遍」发现，不能只靠代码审阅**。

### C5-d `domain/changed` 可用

`cordis_inspect_query(Event, domain/changed)`：

```
mode: emit
signature: 'domain/changed'(change: DomainChanged): void
description: "A domain record or the global singleton changed, emitted once per write strictly
after the backend acknowledged durability."
```

源码依据 `.host-src/dsh-storage-domain.js:216`（`this.ctx.emit("domain/changed", change)`）。

### C5-e `zod` 依赖

`dsh-storage-domain` 自己依赖 `zod@4.4.3`（`.host-src/dsh-storage-domain.package.json:37`）。
profile 里 `node_modules/zod` 是 `4.6.7`，`dsh-context` 也直接依赖 `zod@^4.4.3`。

**结论**：`zod` 必须作为**直接依赖**声明（方案 6.2 已写明），版本用 `^4.4.3`。
用 `z.object(...)` 构造 `valueSchema`，与域规范的类型 `ZodType<V>` 匹配。

---

## C6 — 当前 profile 真实可见的派生入口

`cordis_inspect_query(Tool, listTools)` 的完整可见集合（43 个工具）中，**派生类入口**如下：

| 工具名 | 类别 | 归属 | 已核实的能力 |
| --- | --- | --- | --- |
| `subagent` | 官方独立派出 | `@deepseek-ai/dsh-tool-subagent`（`tool-subagent`） | provider `spawn`；支持 `provider`/`model`/`reasoning_effort` 参数 |
| `subagent_fork` | 官方 fork | 同上（`tool-subagent-fork`） | provider `fork`；不暴露模型选择 |
| `workflow` | 批量编排派生 | `@deepseek-ai/dsh-tool-workflow` | 脚本内 `agent()` 可批量派生 |
| `send_message` | 续派 / 冷恢复 | `@deepseek-ai/dsh-tool-subagent-control` | 全局唯一；发往直接父/子 |
| `interrupt_agent` | 查看 / 中断 | 同上 | 必须允许，否则停止能力被削弱 |
| `list_subagent_models` | 路由发现 | 官方 | 只读，不派生 |
| `subagent_fork` / `spawn_teammate` | — | — | **`spawn_teammate` 在本 profile 不存在**（未挂载 agent-team 工具） |

补充核实：

- `tools.listTools` 结果里**没有** `spawn_teammate`。方案 5.3 表里「存在才拦」的写法正确。
- `dispatch_agent` / `dispatch_roles` 当前不存在（插件未安装），安装后会出现并进入目录。
- `run_code` 当前不存在（`tools` 是 `native` 模式，`.host-src/dsh-base.patch.yml` 未开 ptc）。

**目录版本**：`delegation-catalog.json` 必须覆盖上表 6 个名字 + 本插件 2 个。

---

## C7 — Host→Client 数据通道

### C7-a `plugins.bundle.config` 的 ownerProps 确实只有 `view` 和 `form`

`cordis_inspect_query(Slots, listSubTree, { root: 'plugins.bundle.config' })` 的 `ownerProps`：

```ts
interface PluginConfigViewProps {
  readonly view: 'summary' | 'page'
  readonly form?: ConfigPageForm | undefined
}
```

**证实方案 8.1 的判断**：v0.1 的 `props.station.snapshot` 永远是 `undefined`，卡片只会渲染空状态。

### C7-b 客户端可用的标准 props

同一查询返回 `standardProps`：

```
useRemoteAccess: (action: RemoteEndpoint) => boolean
useResource, useWorkspaces, usePanelInfo, useSessions, useSessionStatus,
useSessionRetainInfo, useSessionAccess, useWorkspaceAccess
```

**关键发现**：`useRemoteAccess(action: RemoteEndpoint)` 存在，说明「Remote 端点」是客户端的一等概念。

### C7-c `@Remote` 在 Host 侧确实可用

`cordis_inspect_query(Service, subagents)` 里 `@Remote('prompt')`、`@Remote('interruptByParent')` 都有；
`commands`、`credentialsController`、`fileUploads`、`workspaceController` 等也是。

**结论**：方案 8.2 的候选 1（`@Remote` 装饰的服务方法）**机制存在**。
但本插件不是一个 `Service` 类，只是普通 Cordis 插件，`@Remote` 需要 `terse`/typert 的生成产物
（`lib/typert.host.js` 这类）。**普通插件能否手写一个 `@Remote` 端点，本次未验证。**

### C7-d 决策

按方案 8.2 的纪律（「不验证就写面板，就是 v0.1 的 `props.station` 重演」）：

- **阶段 4 阶段 A**：诊断只走工具结果 + README。这是**已确认可行**的路径。
- **阶段 B**（自定义诊断面板）：需要先验证「普通插件能否暴露一个客户端可调的 Remote 端点」。
  本次未验证 → **不在 v0.2 承诺范围内**。若阶段 4 后有余量，再单独验证并补。

v0.1 的客户端卡片**必须删除**——它读不到数据，注册它只会渲染空状态，属于「坏 UI」。

---

## 未验证项（按「不成立」处理）

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 普通插件手写 `@Remote` 端点 | 需要 typert 生成产物，未实测 | 不做诊断面板 |
| `json` backend 的 `backupRecord` | 未实测 | 只声明 `invalidRecords`，读不出仍按错误处理 |
| `agent/request` 在**冷恢复**子会话上是否触发 | 需要真实冷恢复场景 | 阶段 2 用真实派出验证；未验证前不写进承诺 |
| `tools.guard` 对**根会话**挂载的效果 | v0.1 只挂过子会话 | **v0.3 已实测**，见 C8-b |

---

# 阶段 0（v0.3）：新增契约证据

v0.3 的新假设只有六条（方案 §14 阶段 0 的 C-a…C-f）。每条都在**真实宿主包**上
给出结论，编造不出结论的就如实标「未验证」。

所有行号引用的是 **`D:\Users\princ\deepseek harness\resources\app.asar\dsh\`** 下的实现
（v0.2 的文档里有一批引用指向旧的 `<DSH_INSTALL_DIR>` 路径，那些行号需按 D: 路径复核）。

## C8-a 子会话的 `AgentOptions` 从哪里来（G1 的依据）

`resolveChildAgentOptions(parent, requested, childDepth)`，`.host-src/dsh-subagent.js:315-331`：

```js
function resolveChildAgentOptions(parent, requested, childDepth) {        // :315
  const parentOptions = parentAgentOptionsForDelegation(parent);          // :315（本函数第 1 行）
  ...
  const resolved = { ...parentProvider/model/reasoningEffort/maxTokens, ...requested, subagentDepth: childDepth };
  if ((resolved.provider !== parentProvider || resolved.model !== parentModel)
      && requested?.reasoningEffort === void 0) delete resolved.reasoningEffort;   // :328
  return resolved;
}
```

`parentAgentOptionsForDelegation(parent)` 在 `:293-302`，取自
`parent.session.requestHeader()?.config`（`:293`）——**注意这是父会话「上一次请求实际用的」
配置，不是父会话创建时的 `options`**（`:295` 把创建的 provider/model/effort 剔掉了）。

**结论**：

1. 只有 `request.agentOptions` 里显式给了 `provider`/`model`，子会话才用岗位路由；
   否则继承父会话当前在用的路由（`parentAgentOptionsForDelegation` + `:320-327` 的展开顺序
   ——`...requested` 在继承值**之后**，所以显式值覆盖继承值）。
2. `:328` 会在**路由变化且未显式给强度**时删掉继承来的 `reasoningEffort`。
   这条直接影响 v0.3 的实现：`reasoningEffort` 必须**按需**放进 `agentOptions`。
   如果路由变了却仍然携带旧强度，宿主的删除逻辑会被「显式给了」绕过，
   于是把另一个模型专属的强度塞给新模型。

**这就是 T43 断言 `'reasoningEffort' in agentOptions === false` 的依据**：
`cheap` 路由没有 `defaultEffort`，所以正确行为是「不带这个键」，
而不是带一个 `undefined` 或父会话的旧值。

调用点在 `startLocal`：`.host-src/dsh-subagent.js:1399-1400`，
`resolveChildDepth`（`:279`）与 `resolveChildAgentOptions` 在这里各被调用一次。

## C8-b `tools.guard` 的作用域（G2/G3 的依据）

**这道题 v0.2 的文档没答对**：它只写了「`tools.guard()` 挂在受管根与子会话的 `agent.ctx`」，
但没有核实「挂在 `agent.ctx` 上」与「挂在普通 ctx 上」是否等价。实测结果：

| 挂载方式 | 实际作用范围 |
| --- | --- |
| `agent.ctx`（由 `createScope` 铸造） | **只对该 agent 生效** |
| `ctx.extend({})` | **落进 global 层，对所有 agent 生效** |

- `tools.guard(guard)` → `this.layers.effect(this.ctx, …)`（`.host-src/dsh-tools.js:3017-3020`）
- `guardReason(exec)` 先查 global 层（`:3025`），再查 `chainLayers(exec.agent)`（`:3028-3029`）
- `createScope(ctx, key, options)` 返回 `{ctx, rawDispose, dispose}`，且
  `scopeOf(ctx) === ctx[kScope]`（`@deepseek-ai/dsh-scope` 的 `lib/index.js:296-314`）

实测输出（本仓探针）：

```text
scopeOf(agentA.ctx) === agentA: true
A: denied
B: dispatched
无 agent: dispatched
```

**这就是 `tests/host-fixture.js` 的 `makeAgent` 必须用真实 `createScope` 铸造
`agent.ctx` 的原因**：如果退化成 `ctx.extend({})`，一个 agent 的 guard 会拒绝所有人，
测试会以「全绿」的方式掩盖真实缺陷（v0.2 的替身正是如此，见 T56 的反例）。

## C8-c `tools.schemas(scope)` 与全局视图的差异（G6 的依据）

签名：`schemas(scope?: ScopeKey): ToolSchema[]` ——「the viewing scope (the agent);
omitted = the global view」。

实测（同一份工具注册，分别用两个 agent 的作用域查）：

```text
schemas(agentA) = probe_tool,scoped_only_a
schemas(全局)   = probe_tool
schemas(agentB) = probe_tool
```

**结论**：作用域内注册（preset / MCP / 第三方插件）**只在那个 agent 的视图里可见**。
v0.2 的覆盖诊断只读 `ctx.tools.schemas()`，因此对这类注册完全失明——
报告「complete」而实际有洞。v0.3 的修复见 `index.js` 的 `computeCoverageFor(scope)`，
`coverage: { global, scoped }` 同时给两份。

**`tools.view(scope)` 的语义要注意**（`.host-src/dsh-tools.js:3055-3056`：
`const layers = this.layers.chainLayers(scope)`）：
restrictions 只过滤**继承来的**表面，从不过滤该 scope 自己的层。
所以「这个 agent 看得见什么」不能用 view 的返回推断，必须用 `schemas(scope)`。

`schemas(scope)` 的实现就一行（`:3119-3120`）：
`[...this.view(scope).visible.values()].map(...)` —— 它把 view 的 `visible` 摊平，
省略 `scope` 时走全局链。这解释了为什么「省略 scope」与「传 agent」会给出不同集合。

## C8-d `subagent/end` 的形状与派发范围（G4 的依据）

`createLifecycleEmitter(this.ctx, (parent) => scopeTarget(this, parent))`，
`.host-src/dsh-subagent.js:162-177`（工厂）+ `:2994`（`SubagentRuntime` 里接上）。

- 事件载荷 `{ runId, provider, id, local, stopReason, lastAssistantMessage? }`（`:187-206`）；
  **`info.id` 就是子会话 id**，与台账的 `childSessionId` 同源。
- **派发是按委派父定向的**（`:163-167`：有 `parent` 时 `carrier(parent)` 进 dispatch 参数）：
  受管根能收到自己这一支的全部结束事件，不必为每个孩子各挂一份。
- `stopReason` 的取值集合是 `completed | aborted | error | max-tokens | refusal`
  （`SubagentStopReasonMap`）。
- 监听器失败会被单独兜住（`:168-175` 的 try + `.catch`），不会饿死同伴。

**一条容易误读的注释**（`:208-223` 的 `epochStopReason`）：
「子会话自己的日志才是权威——停止成功不代表模型是正常结束的」。
它解释了为什么只有 `completed` / `refusal` / `max-tokens` 算 `settled`：
这三种都表示「运行确实走完了」，而 `aborted` 是人为中断、`error` 是失败。

## C8-e `agents.list()` 与启动扫描的关系（G2 的依据）

- `agents.list()` 返回**注册顺序**的新数组（不是活引用），可以在 `apply()` 里安全遍历。
- `agents.announce(agent, source, signal)` 发 `agent/created`，`source` 取值集合是
  `'startup' | 'resume' | 'clear' | 'compact'`。
- **`agents.register()` 会用 `source: 'startup'` 发事件**，所以启动扫描与
  `agent/created` 天然重叠 ⇒ `governAgent()` 必须幂等。
  这是方案 5.3 的实现要求，也是 T45/T57 不重复挂 guard 的前提。

## C8-f 谱系解析：`parentSession` 是**直接**父，不是根（G2 的依据）

`childSessionMeta(parent, childDepth, isSeeded, selectedPreset)` 设置
`parentSession: parentHeader.id`、`origin: 'subagent'`、`delegationDepth: childDepth`
（`.host-src/dsh-subagent.js:346-356`；`parentSession` 在 `:351`）。

**后果**：`maxDepth: 2` 时孙级的 `parentSession` 是中间子会话的 id，
通常**不在** `managedSessionIds` 里 ⇒ v0.2 把它判成「未受管」（P2-A）。

宿主自己的 `liveLineage(agent)`（`.host-src/dsh-subagent.js:1735`，被 `:1341` 与 `:1675` 调用）
就是逐层向上走的；v0.3 的 `resolveRootSessionId` 照抄这个算法，并补两条：
走不到头时退回**最后一个能确认的 id**（而不是退回自己，那会把孙级误判成顶层），
以及用 `seen` 集合防环。

## C8-g `agent/created` 的 `source` 语义与恢复路径（G2 的依据）

> **⚠️ 本节在 v0.4 已作废，保留仅为演进记录。**
> 它讨论「要不要给这个会话挂 guard / 挂请求锁定」——但 v0.4 里两层都是**全局挂一次的**，
> 不存在"这个会话没挂上"的状态。**按本节写代码会错。**
> 正确口径见文末「S2-a」与「一处必须改正的 v0.3 结论」。

四种 source 的差别只影响**要不要挂请求锁定**，不影响要不要挂 guard：

| source | 挂 guard | 挂请求锁定 | 理由 |
| --- | --- | --- | --- |
| `startup` | 是 | 台账有它的记录才挂 | 新派的子会话此时应已在 `children` 表 |
| `resume` / `clear` / `compact` | **是**（总是） | 台账有它的记录才挂 | 恢复的会话可能来自被清空的台账；只挂 guard 仍然拦得住再派孙级 |

「只挂 guard」这个降级是有意的：把「查不到台账记录」变成「这一轮请求被拒绝」，
会让一个清空过台账的环境彻底不可用；而只挂 guard 时，**入口仍然收得住**。

## v0.3 的证据 ↔ 修复 ↔ 测试对照

| 证据 | 修复 | 测试 | 代码位置（v0.3） |
| --- | --- | --- | --- |
| C8-a | G1：派出时下发 `agentOptions` | T42 / T43 / T44 | `lib/host/index.js` 的 `dispatch`（`request.agentOptions`） |
| C8-b | G2/G3：guard 必须经 `createScope` 的 `agent.ctx` | T45 / T48 / T56 | `lib/host/entry-governor.js` 的 `attachTo` |
| C8-c | G6：按作用域读可见工具 | T56 | `lib/host/index.js` 的 `computeCoverageFor(scope)` |
| C8-d | G4：`subagent/end` → 回执终态 | T50 / T51 | `lib/host/ledger.js` 的 `closeReceipt` |
| C8-e | G2：启动扫描 + 幂等治理 | T45 / T46 / T57 | `lib/host/index.js` 的 `governAgent` / `sweep` |
| C8-f | G2：谱系解析 | T47 | `lib/host/entry-governor.js` 的 `resolveRootSessionId` |
| C8-g | G2：恢复路径的不对称处理 | T46 | `lib/host/index.js` 的 `governAgent`（`resumed` 分支） |

每条修复的红方证据（退回 v0.2 形态后该测试确实变红）见 `proof/red-v02.txt`，
汇总见 `TEST-REPORT.md` 的「红 → 绿对照」。

---

# v0.4 阶段 0（S1–S6）

- 核实日期：2026-10-25
- 重启脚本：`node scripts/spikes-v04.mjs`（可重复执行；全部 6 组跑完后以
  "S1–S6 全部成立"收尾，任一不成立则以非零退出）
- 方法：与 v0.3 相同——先读源码定行号，再跑 spike 验证行为。
  **两者的差别很重要**：v0.3 的 C8-g 是"读源码推出来的"，
  S3 是"跑了才知道的"（见下）。

| 编号 | 问题 | 结论 | 对方案的影响 |
| --- | --- | --- | --- |
| S1 | 预置 `childId` 的完整语义（查重、格式、持久化残留） | 成立 | 先登记再派出可行（P2） |
| S2 | 无作用域监听器能收到**所有** agent 的事件吗 | **成立** | L3 可以全局挂一份（P2 的核心依据） |
| S3 | `agent/created` 里抛错能阻止创建吗 | **不成立** | 不能做 L1 创建门；改由 L3 兜 |
| S4 | `tools.guard` 拒绝时错误码会传到客户端吗 | **不成立** | 码必须写进文案（C6） |
| S5 | 预置 `childId` 能否消除 TOCTOU | 成立（有条件） | P2 的"先登记后创建" |
| S6 | 全局 guard 的性能预算 | 成立（<1µs） | 可以全局挂而不影响普通工具 |

---

## S2 — 无作用域监听器收到所有 agent 的事件（**本版最重要的证据**）

### S2-a 未作用域的 `ctx.on('agent/request')` 会收到其他 agent 的请求

```js
// scripts/spikes-v04.mjs 的 S2-a
const rootCtx = appRoot.extend({ agent: rootAgent });
const childCtx = appRoot.extend({ agent: childAgent });
// 只在 appRoot（无作用域）挂一个监听器
appRoot.on('agent/request', handler);
// 然后让 rootAgent 与 childAgent 各自触发 agent/request
→ handler 被调用 2 次，payload.agent 分别是 rootAgent、childAgent
```

**这条推翻了 v0.3 的一个隐含假设**：v0.3 认为"要管某个会话，就得在它的 ctx 上挂监听器"。
实际上在**无作用域**的 ctx 上挂一个，就能收到全部会话的事件——身份从
`payload.agent` 现读即可。

**这就是 v0.4 全局挂载的根据。** 没有它，"加载时挂一次"这个设计只是我的猜测。

### S2-b `subagent/end` 不适用同一结论

`subagent/end` 由**委派父的作用域**派发（`.host-src/dsh-subagent.js:163-168` 的
`createLifecycleEmitter` 用 `carrier(parent)`）。全局监听器拿不到它的作用域信息，
所以 L4 必须逐根挂载。

**所以 v0.4 是"两层全局 + 一层逐根"，不是"全部全局"。** 这个区别必须写清楚，
否则后来者会照着"全局"的思路去改 L4，然后发现收不到事件。

### S2-c 推论：全局挂载带来的新风险

一个监听器服务**所有**子会话，意味着"拿错身份"的后果从一个会话扩散到全部。
所以 `request-lock.js` 里每次从 `payload.agent` 现读，**绝不**在闭包里捕获身份。
`v04-plan-cases.test.js` 的 V35 专门测这个：一个监听器服务两个子会话，不串路由。

---

## S3 — `agent/created` 里抛错**不能**阻止创建

```js
// scripts/spikes-v04.mjs 的 S3
ctx.on('agent/created', () => { throw new Error('S3: 拒绝'); });
await createAgent(...);
→ createAgent 正常返回，agent 已存在，监听器的异常被记进日志
```

**结论：`agent/created` 不是拦截点，只是通知点。**

这一条是**跑出来的**，不是读源码推出的：`emit` 语义在源码里不易分辨
（有 `prepare` / `bail` 的变体），只有实际抛一次才知道异常被吃掉了。

**对方案的直接影响**：

- 原方案设想用一个"创建门"（L1）在 `agent/created` 里拒绝——**做不到**；
- 唯一的兜底是 L3：让那个会话的第一轮请求以 `STATION_UNMANAGED_CHILD` 被拒。

所以本版对"绕过入口派出的子会话"的承诺必须精确写成：
**它会被创建，但它用不了任何模型**。任何更强的表述都是假的。

`docs/known-limits.md` §3.14 按这个口径写。

---

## S4 — `tools.guard` 拒绝时，`StationError.code` 会丢

`.host-src/dsh-tools.js:3339-3353`：guard 的返回值被渲染成 `Error: <reason>`，
**没有**把结构化的错误对象传下去。

```js
// scripts/spikes-v04.mjs 的 S4
guard(() => { throw new StationError('STATION_X', '原因'); })
→ 客户端看到 `Error: 原因`，error.code === undefined
```

**所以拒绝文案必须自带错误码**：`派出所[STATION_X]：原因…`。
这不是风格偏好，是**唯一**能让用户与日志看见码的方式。

`refusal.js` 的 `refusalLine()` 就是为此存在的；V15 断言它是单行且带码。

### S4-b 顺带核实的：guard 不能"强制放行"

`.host-src/dsh-tools.js:3007-3016`：guard 只能返回 `undefined`（放行）或
一个拒绝原因（拦下）。**没有**"允许但标记"、"允许并改写"这类返回值。

后果：`notice` 类的"我补了个初值"不能通过 guard 表达，只能写进台账与状态。
这正是偏离分 `error` / `notice` 的由来。

---

## S5 — 预置 `childId` 的完整语义

| 子项 | 结论 | 行号 |
| --- | --- | --- |
| S5-a | 传 `childId` 但后端不支持 `prepareContinuable` ⇒ 抛 `UNSUPPORTED_CAPABILITY` | `dsh-subagent.js:3038` |
| S5-b | `childId` 被**原样采用**：`spec.childId ?? brandString(randomUUID())` | `:1397` |
| S5-c | `assertChildIdAvailable` 只查重、**不校验格式**（自造 UUID 合法） | `:1597` |
| S5-d | 预置 id 会额外查**持久化残留**（同名会话已存在 ⇒ `DUPLICATE_CHILD`） | `:1597` |
| S5-e | 默认 `spawn` 后端实现 `prepareContinuable`（默认配置下可用） | `dsh-subagent.js` provider 表 |

**对方案的影响**：

1. "先登记、再创建"是可行的（S5-b 保证 host 用我们给的 id）；
2. **必须用 `randomUUID()`**——S5-d 意味着可预测的 id（如 `child-1`）在重启后
   会撞上持久化残留，必然 `DUPLICATE_CHILD`；
3. 后端不支持时必须**降级**而不是硬跑（S5-a），并如实标 `保证等级：降级（配置）`。

第 2 条是本版实现里最容易写错的地方。`index.js` 的注释、`known-limits.md` §3.12
与 T71/T84 都围着它写。

---

## S6 — 全局 guard 的性能预算

```js
// scripts/spikes-v04.mjs 的 S6-a：1e6 次普通工具名的判定
→ 每次额外开销 < 1µs（实测 ~0.002µs，因为 Set 命中失败就返回）
```

判据是**名字预筛**：`candidate.has(name) || looksLikeDelegationTool(name)`。
非候选名在 `Set` 查找时直接返回，不碰任何服务。

S6-b 进一步确认：普通工具名（`read` / `bash` / `edit` / …）**全部**被挡在冷路径，
`readPolicy` / `readSessions` / `readLedger` 一次都没被调用。

**为什么要测这个**：v0.3 是逐会话挂载，被调用的频率天然受限；
v0.4 改成全局挂载后，guard 会在**每一次**工具调用上跑。如果它每次都要读配置，
那会成为一个看不见的税。S6 证明它不会。

---

## v0.4 的证据 ↔ 修复 ↔ 测试对照

| 证据 | 修复 | 测试 | 代码位置（v0.4） |
| --- | --- | --- | --- |
| S2-a | G1：L2/L3 全局挂载一次，身份现读 | V1 / V2 / V4 / V35 / T59 / T60 | `index.js` 的两个 `ctx.effect` |
| S2-b | G2：L4 仍逐根挂（`subagent/end` 作用域限制） | T50 / T51 | `index.js` 的 `endListeners` |
| S2-c | G3：不在闭包里捕获身份 | V35 | `request-lock.js` 的 `payload.agent` |
| S3 | G4：不做 L1，改由 L3 兜底 | T68 / T84 | `request-lock.js` 的 `UNMANAGED_CHILD` |
| S4 | G5：码写进文案 | V10 / V15 / T66 / T67 | `refusal.js` 的 `refusalLine` |
| S4-b | G6：偏离分 `error` / `notice` | V33 / V34 | `request-lock.js` 的 `classifyDeviation` |
| S5-b/c | G7：`randomUUID()` 预置 id | T71 / T84 | `index.js` 的 `reservedChildId` |
| S5-a | G8：降级路径 + 保证等级 | V27 / T73 | `assurance.js` |
| S5-d | G9：不做可预测 id | （见 `known-limits.md` §3.12） | `index.js` |
| S6 | G10：名字预筛 | — | `entry-governor.js` 的 `candidate` |

每条修复的红方证据见 `proof/red-v04.md`（三档，各附改动与变红清单）。

## 一处必须改正的 v0.3 结论

**C8-g 那张表（「哪种 source 挂不挂 guard」）在 v0.4 已经作废。**

它讨论的是"要不要给这个会话挂 guard"——但 v0.4 里 guard 只挂一次，
不存在"这个会话没挂上"的状态。同一张表的"挂请求锁定"一列也作废，
理由相同（L3 全局挂载）。

保留原文是为了让读者看到演进；**按它去写代码会错**。正确口径见上面 S2-a。

