# 测试计划 v0.4

> 基线：v0.3 的 118 条测试全绿。v0.4 结束时 **187 条**全绿。
>
> 运行：`cd subagent-dispatch-station; node --test --test-isolation=none "tests/unit/*.test.js"`
>
> （`--test-isolation=none` 不是风格选择：沙箱禁止管道 stdio，进程隔离模式会失败。）

## 一、编号约定

| 前缀 | 含义 | 位置 |
| --- | --- | --- |
| **T01–T58** | v0.2 / v0.3 的既有用例 | 各主题文件 |
| **T59–T84** | **方案 §9.4 定义**的 v0.4 用例，编号与方案逐条一致 | `v04-plan-cases.test.js` |
| **V1–V40** | 本版补充用例（时序矩阵、fail-closed 矩阵、自证、归位等） | 各主题文件 |
| **T85+** | 未使用 | — |

为什么把补充用例另起 `V` 系列：方案给了一份 26 条的编号清单，那些编号**有确定含义**。
若我把自己加的用例也编成 T59、T60……，那么"方案要求的 T60 是哪个"就再也查不清了。
`V` 系列保证"方案那一格永远对得上"，同时补充用例不必挤进同一个序号空间。

## 二、这一版测试的重点变了

v0.3 的测试几乎都是"功能对不对"。v0.4 的问题清单里有五条是**结构性**的：

| 问题 | 性质 | 单测能测吗 |
| --- | --- | --- |
| 1. 治理晚到（挂载时点判定） | 时序 | **能**，但需要专门的时序矩阵 |
| 2. `send_message` 在受管根被拦 | 判定合流 | 能 |
| 3. 逃生路径断裂 | 判定合流 | 能 |
| 6. 状态不可证伪 | 渲染与数据 | 能，但要分开测 |
| 8. 零结论无证据 | 渲染 | 能 |

问题 1 是新难点：它不是"某函数返回错了"，而是**"某个时点的行为"**。
`TEST-RESULT-v0.3.md` §六 已经指出，v0.3 的夹具在 `apply()` 之前就把配置配好了，
所以那个时点根本不在测试范围内。

### 因此新增两类测试

1. **时序矩阵**（`v04-timing.test.js`）：把"配置何时写入 × 会话何时创建"作为
   被测对象，而不是背景条件。
2. **fail-closed 矩阵**（`v04-assurance.test.js`）：把"缺什么"逐条列出，
   断言每种缺失都以**正确的码**拒绝。

## 三、方案 §9.4 的 T59–T84

全部在 `tests/unit/v04-plan-cases.test.js`，逐条对应方案原文。

| 编号 | 方案要求 | 断言要点 |
| --- | --- | --- |
| T59 | 空配置加载 → 写配置 → **不派出**直接调原生 `subagent` | 被拒。**发布判据第 1 条**；台账里 0 条回执是前提 |
| T60 | `subagent_fork` / `workflow` / `spawn_teammate` | 全部被拒（只拦 `subagent` 等于换个名就绕过） |
| T61 | 未受管会话调原生 `subagent` | 放行（不误伤） |
| T62 | 全局守卫对 `run_code` 内 `tools.subagent(...)` | 生效（C7，无 PTC 绕过）；顺带断言 `run_code` 是宿主保留名 |
| T63 | 回执：快照与当前一致 | 写「快照状态：与当前一致」，无噪音行 |
| T64 | 回执：当前新增一条路由 | 「N 条新增未生效」+ 列表，**不**比代数与哈希 |
| T65 | 回执：覆盖为 `unrecognized` | 说「目录**读到了**」，**不得**出现"目录不可读" |
| T66 | `station_status` 内部抛错（注入） | 工具**不**报错，输出含 `决定：无法判定（STATION_…）` |
| T67 | dry-run 遇已禁用岗位 | `决定：拒绝（STATION_ROLE_DISABLED…）` + 说明 + 修复 |
| T68 | 原生 `subagent` 漏网 → 其子会话发请求 | 拒绝 `STATION_UNMANAGED_CHILD` |
| T69 | 受管根 `send_message` 给台账内子会话 | 允许（`createsAgent: false`，与岗位策略无关） |
| T70 | 受管根 `send_message` 给陌生 id | 拒绝 `STATION_TARGET_UNKNOWN` |
| T71 | 子会话在 `putChild` 完成前发请求 | 不误拒：`startActivation` 被调用时台账里**已经**有它 |
| T72 | 台账 `children` 的 root 与现算谱系不符 | 拒绝 `STATION_LINEAGE_MISMATCH` |
| T73 | 台账不可打开 | 派出拒绝 + `保证等级：不可派出` |
| T74 | 零偏离时 `deviations` 表存在 | 表在、0 条、`deviationWrites` 计数为 0 |
| T75 | 手工删 `deviations` 表后重启 | 状态显示 `deviations ✗` 并说明"偏离 0 此时是假的" |
| T76 | 回执停 `observed`，重启后子会话已不存在 | 对账标 `settled`（不是 `unverified`），note 写明原因 |
| T77 | `routeId` 完全不存在 | `STATION_ROUTE_UNKNOWN`，修复指向"加路由" |
| T78 | `routeId` 存在但不在岗位白名单 | `STATION_ROUTE_NOT_ALLOWED`，修复指向岗位白名单 |
| T79 | `routeId` 被岗位允许但被上层收窄 | `STATION_ROUTE_NOT_EFFECTIVE`，修复指向上层 |
| T80 | `blockNativeDelegation: false` 时派出的回执 | 降级警告可见 |
| T81 | `subagent/start` 观察到未登记子会话 | 写 `escapes` 记录，状态可见「漏网 N 个」 |
| T82 | 卸载插件后原生 `subagent` 恢复可用 | 放行 |
| T83 | 根会话调工具且 `sessions` 服务缺失 | **不**受影响（根不需要查谱系） |
| T84 | 子会话请求且 `sessions` 缺失 | 拒绝 `STATION_LINEAGE_UNKNOWN` |

### T79 的一个坑（值得记下）

最初我把 T79 写成"岗位白名单里有 `ghost`，但全局 `allowedRoutes` 里没有"。
那样确实会被拒，但码是 `STATION_CONFIG_CONFLICT`——因为**启动校验**先发现
"岗位声明了一条不存在的路由"。那是配置错误，不是收窄。

要测"收窄"，路由必须**存在**（在全局集合里）、岗位也允许，然后被**官方层**排除。
改对之后才拿到 `ROUTE_NOT_EFFECTIVE`。

> 教训：三个 `ROUTE_*` 码的区分点在于"哪一层把它排除了"，所以夹具必须精确
> 控制"哪一层有它、哪一层没有它"。笼统地"造一个无效配置"只会撞上启动校验。

### T84 的一个坑

最初我把 T84 写成"单层子会话 + 摘掉 `sessions`"。那样 **不** 会拒绝，原因是两条：

1. 单层时"走到 `parentSession` 就停"恰好等于台账记的根，
   算不出来的部分**不影响结论**（`request-lock.js` 的 `sameAsRecorded`），
   拒绝它反而是误伤。
2. 更关键：`classifyAgent` 先判管辖区。若中间层的 id 不在 `managedSessionIds` 里，
   L3 按"不归我管"直接放行——那是**正确**的越权防护，不是漏拦。

所以 T84 的夹具必须：(a) 让中间层也在受管名单里，(b) 造一个走不到头的谱系。

## 四、本版补充用例（V 系列）

### 时序与卸载（`v04-timing.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V1 | 锚点 A3×B1：空配置加载 + 会话早已存在 + 之后写入名单 ⇒ 下一个调用立刻被拦 |
| V2 | 3×2 时序矩阵六格，**每格都先调用一次再改配置** |
| V3 | 反面：配置**从未**写入时六格全放行（插件不擅自接管） |
| V4 | 从受管名单移除后立刻放行（不缓存"曾经受管"） |
| V5 | 卸载后 guard 与锁定都撤销，台账保留（I7 双向） |

### 错误码归位（`error-codes.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V8 | `ROUTE_UNKNOWN` / `ROUTE_NOT_ALLOWED` / `ROUTE_NOT_EFFECTIVE` 各抛各的码 |
| V9 | 三条 `ROUTE_*` 的修复建议互不相同（否则拆分没有意义） |

### 拒绝文案（`v04-refusal-text.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V10 | 拒绝文案提到的每个工具名都真实注册（复制粘贴可用） |
| V11 | `dispatch_agent` / `dispatch_roles` / `station_status` 确实注册着 |
| V12 | 不创建 agent 的入口被拒时，文案不许说"绕过岗位模型策略" |
| V13 | 目录里每个入口的 `createsAgent` 都是显式布尔值 |
| V14 | `describeRefusal` 对每个错误码都给 code + message + hint + fix |
| V15 | `refusalLine` 是单行且带码（C6：宿主会丢掉 code 字段） |
| V16 | 非 `StationError` 也能被归一化（`STATION_INTERNAL`） |
| V17 | 覆盖状态由 `state` 决定，四种 state 互不相同 |
| V18 | 不许用"数组为空"代替 `state` 判断 |
| V19 | 子会话再派 `dispatch_agent` 的文案不说"改用 dispatch_agent" |

### 保证等级（`v04-assurance.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V20 | 全部事实成立 ⇒ 完整档，无降级原因 |
| V21 | 四档都可达，中文名互不相同 |
| V22 | `unavailable` 优先于一切，但原因要列全 |
| V23 | 「能改」与「改不了」严格分开 |
| V24 | 环境档优先于配置档 |
| V25 | 渲染出的每条原因都带层名，修复行只在有时出现 |
| V26 | 摘要必须说清"哪条不成立"，不是只给等级名 |
| V27 | fail-closed 矩阵：六种缺失情形各以正确的码结束 |

### 可证伪性（`v04-falsifiability.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V28 | 从未调用过工具时明说"守卫没跑过" |
| V29 | 调用后评估次数真的涨了 |
| V30 | 拒绝次数按错误码分组 |
| V31 | 台账 `meta` 表真的写进去，计数随写入增长 |
| V32 | `lastClosedAt` 早于 `lastOpenedAt` ⇒ 说"上次未正常关闭" |
| V33 | 空路由记 `notice`，不与 `error` 混 |
| V34 | 真换模型必须记 `error`，且写出被换成了什么 |

### 请求锁（`request-lock.test.js`）

| 编号 | 断言要点 |
| --- | --- |
| V35 | **一个**监听器服务**两个**子会话，不串路由（全局挂载的核心风险） |
| V36 | 根会话的请求不被改写 |
| V37 | 未受管谱系里的子会话完全不受影响（插件不越权） |
| V38 | 首次压回升 `observed`，且只写一次 |
| V39 | 谱系不可解析 ⇒ `LINEAGE_UNKNOWN` |
| V40 | 台账根与现算谱系不一致 ⇒ `LINEAGE_MISMATCH` |

## 五、改写的旧测试

| 测试 | 原断言 | 新断言 | 为什么必须改 |
| --- | --- | --- | --- |
| `ledger.test.js` 域名与版本 | version 1，四张表 | version 2，`compatibleVersions: [1]`，六张表 | 新增 `meta` 与 `escapes`；不声明兼容 v1 会让升级时读不到旧数据 |
| `request-lock.test.js` 全部 | `attachRequestLock({ agentCtx, agent })` | `mountRequestLock({ ctx, readLedger, … })` | 不只 API 变了：v0.3 用闭包捕获身份，v0.4 每次现读 |
| `request-lock-e2e.test.js` 未登记子会话 | `STATION_UNKNOWN_CHILD` | `STATION_UNMANAGED_CHILD` | 码归位：两者是同一事实的两个名字，删了前者 |
| `error-codes.test.js` 非 StationError | `code === ''` | `code === STATION_INTERNAL` | 空串会渲染成 `决定：无法判定（：…）`——一个没有码的括号 |
| `policy.test.js` T04 | `ROUTE_NOT_ALLOWED` | `ROUTE_NOT_EFFECTIVE` | 三码拆分：岗位允许但被上层收窄是第三种情形 |

## 六、夹具的三处修正（都是"替身比真机更理想"的同一类错误）

### 6.1 `attemptCall` 不传 `arguments`

v0.3 的替身在 `prepareScheduledExecution` 里把 `arguments` 固定成 `{}`。
于是任何"看参数再决定"的守卫（v0.4 的 `send_message` 目标校验）变成
"永远读不到参数"——那是最容易漏的一类假绿。

**已修**：`arguments` 真的传下去。

### 6.2 后端从不声明 `prepareContinuable`

真实 `spawn` 后端**声明**了它（`.host-src/dsh-subagent.js:3038` 只在缺失时拒绝
预置 `childId`）。v0.3 的替身漏了这项，于是"预置 childId 生效"这条路径
**从来没在单测里跑到过**。

**已修**：替身有 `supportsReservedChildId` 开关。

**默认 `false`**，理由不是"真实后端不支持"，而是**关注点分离**：
绝大多数测试关心"派出去之后怎么样"，它们用 `behaviour: () => ({ childId: 'child-1' })`
指定子会话 id。若默认 `true`，那个 `childId` 会被忽略（真实宿主也忽略），
于是二十多个与预置 id 无关的测试会因为"取不到 `child-1`"变红——
那种红是噪音，不是信号。关心预置 id 的用例（T71、T84）显式打开它。

### 6.3 宿主"原样采用预置 id"这件事没有模拟

真实宿主：`spec.childId ?? brandString(randomUUID())`（`:1397`），即传了就照用。
替身原本一律返回 `behaviour` 给的 id，于是"预置 id 有没有生效"无从测起。

**已修**：替身在 `startActivation` 里若收到 `spec.childId`，返回值就用它（S5 的证据）。

### 6.4 `makeAgent` 不登记父会话

真实宿主里父会话当然在 `sessions` 里（先有父才有子）。替身原本只登记子会话，
于是 `resolveRootSessionId` 往上走一步就断，谱系被标 `limited`——
L3 会以 `LINEAGE_UNKNOWN` 拒绝，而那是**替身造成的**假失败。

**已修**：`makeAgent({ depth > 0 })` 自动补登父会话。

## 七、三档红证

见 `proof/red-v04.md`。摘要：

| 档 | 破坏方式 | 变红 |
| --- | --- | --- |
| 红-1 | 全局守卫挂上但永远放行 | **22 条**，跨 6 个测试文件 |
| 红-2 | 把"每次现算"换成"首次算完就缓存"（v0.3 的原始行为） | **3 条**：V1 / V2 / V4 |
| 红-3 | 移除状态里的自证与表健康渲染（计数仍在算） | **5 条**：V28 / V29 / V30 / V32 / T75 |

红-2 有一个必须记住的细节：第一版 V2 在"挂载时点快照"下**也是绿的**，
因为它只在配置写入后才第一次调用工具。改成"用 → 改配置 → 再用"之后才变红。
一个只在最终状态上断言的矩阵，测不出过程中有没有窗口。

## 八、刻意不测的东西

| 不测 | 为什么 |
| --- | --- |
| 真实模型的响应 | 需要网络与适配器，且与本插件的承诺无关（我们只管"发出去的是什么"） |
| 真实 `storageDomain` 的迁移行为 | 替身不实现；已列入 `known-limits.md` §4.1 的已知盲区 |
| UI 渲染 | 本版没有 UI |
| 性能绝对值 | 只测 S6 的逻辑性质（候选名预筛不访问服务），不测毫秒数 |

## 九、执行记录

```
$ node --test --test-isolation=none "tests/unit/*.test.js"
ℹ tests 187
ℹ pass  187
ℹ fail  0
```

契约测试另跑：`node tests/contract/c1-define-tool.mjs`（需要宿主包）。
