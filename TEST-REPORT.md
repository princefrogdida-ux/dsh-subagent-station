# 测试报告（v0.3）

> 本文件由 `scripts/report.mjs` 生成于 2026-10-24T14:32:57.394Z。**请勿手改**——手改的数字无法被核验。

## 环境

| 项 | 值 |
| --- | --- |
| 插件 | dsh-subagent-station 0.3.0 |
| Node | v24.14.0 |
| 平台 | win32 x64 |
| DSH_HOME | <DSH_HOME> |

## 命令

工作目录：`subagent-dispatch-station/`

```powershell
node --test --test-isolation=none "tests/unit/*.test.js"
node --test --test-isolation=none "tests/unit/v03.test.js"
node scripts/report.mjs   # 重新生成本文件
```

`--test-isolation=none` 不是性能选择：本环境的沙箱禁止子进程用管道捕获 stdio，
默认隔离会导致 `spawn EPERM`。关掉隔离后测试在当前进程内运行。

## 原始输出摘要

| 范围 | 通过 | 失败 | 合计 | 退出码 |
| --- | --- | --- | --- | --- |
| 全部单元测试 | 118 | 0 | 118 | 0 |
| v0.3 矩阵（T42–T58） | 17 | 0 | 17 | 0 |

### T42–T58 逐条结果

| 结果 | 测试 |
| --- | --- |
| ✅ 通过 | T42 派出的 startActivation 里 request.agentOptions 等于回执声明的路由 |
| ✅ 通过 | T43 首轮请求之前，子会话创建参数已是岗位值（不经请求锁） |
| ✅ 通过 | T44 后端不声明 agentOptions 时仍然拒绝（预检没有退化成空操作） |
| ✅ 通过 | T45 插件加载前已存在的受管根：加载后立即受 guard 约束 |
| ✅ 通过 | T46 插件加载前已存在的受管子会话：下一轮请求即被压回台账值 |
| ✅ 通过 | T47 maxDepth: 2 的孙级：判定受管且根 id 正确 |
| ✅ 通过 | T48 同一 agent 身份变更后重挂：isChild 刷新，孙级派出被拒 |
| ✅ 通过 | T49 首次成功压回后回执从 started 变为 observed，且只变一次 |
| ✅ 通过 | T50 子会话正常结束：回执 settled，note 含 stopReason |
| ✅ 通过 | T51 子会话被中断：回执 interrupted，终态不再被改写 |
| ✅ 通过 | T52 空快照后补齐路由：下一次派出成功（不改 epoch） |
| ✅ 通过 | T53 snapshotEpoch 加 1：按新集合重算，snapshotVersion + 1，在跑子会话不受影响 |
| ✅ 通过 | T54 受管子会话遇目录外但名字像派生的入口（subagent_v2）→ 拒绝 |
| ✅ 通过 | T55 目录外的普通工具（read/bash）不被误拦，且进 unrecognized 清单 |
| ✅ 通过 | T56 scoped 注册的入口出现在该 agent 的覆盖诊断里，且不影响全局视图 |
| ✅ 通过 | T57 卸载后启动扫描挂上的治理同样解除，台账保留 |
| ✅ 通过 | T58 未受管会话调 station_status：给出本会话 id、原因与两种纳入方式 |

## 红 → 绿对照

纪律（方案 §13.1 第 1 条）：每条 P1 修复必须附一条**在 v0.2 代码上会红**的测试，
且红与绿两次输出都要进报告。

### 红方：逐条修复单独退回后重跑同一份测试

生成脚本 `scripts/make-red-proof.mjs` 的工作方式：把源码复制到临时目录，
**每条修复单独退回**成 v0.2 形态，再对副本跑 `tests/unit/v03.test.js`。
这样每条红都能归因到具体一处修复，而不是「一大堆改动里有问题」。
若清单里的测试没有变红，脚本以非零退出并点名——即「假绿」检查。

| 修复 | 内容 | 应当变红 | 实际变红 | 结论 |
| --- | --- | --- | --- | --- |
| G1 | 派出时下发 agentOptions | T42、T43 | T42、T43 | ✅ 红方成立 |
| G2-a | 启动扫描治理加载前已存在的会话 | T45、T46、T57 | T45、T46、T57 | ✅ 红方成立 |
| G2-b | 沿谱系向上解析真正的受管根 | T47 | T47 | ✅ 红方成立 |
| G3 + G3-guard | guard 内现算 isChild + 身份变化时重挂 | T48 | T48 | ✅ 红方成立 |
| G4-a | 首次压回后把回执升到 observed | T49 | T49 | ✅ 红方成立 |
| G4-b | `subagent/end` 收尾回执终态 | T50、T51 | T50、T51 | ✅ 红方成立 |
| G5-a | 空快照自愈 | T52 | T52 | ✅ 红方成立 |
| G5-b | `snapshotEpoch` 显式重建 | T53 | T53 | ✅ 红方成立 |
| G6-a | 目录外「像派生入口」的默认拦截 | T54 | T54 | ✅ 红方成立 |
| G6-b | 覆盖诊断的第四态 `unrecognized` | T55 | T55 | ✅ 红方成立 |
| G6-c | 按作用域读取可见工具名 | T56 | T56 | ✅ 红方成立 |
| G6-d | `station_status` 诊断工具 | T58 | T58 | ✅ 红方成立 |
| G6-e | 未受管用户的岗位 dry-run 与「假如受管」标注 | T58 | T58 | ✅ 红方成立 |

### 绿方：v0.3 代码，当前

```text
tests 17
pass 17
fail 0
```

红方原文全文见 `proof/red-v02.txt`（含每组完整的 `node --test` 输出）。

## 未验证清单

本节的唯一真相源是 `docs/known-limits.md`（方案 §13.3 要求两处同源、不得两处不一致）。
下面原样内嵌该文件，任何不一致都应先改那份文件。

<details>
<summary>docs/known-limits.md（原文）</summary>

```markdown
# 已知限制与不作出的保证（v0.3）

本文是 v0.3 的交付物之一（方案第 13 节）。它列的是**插件明确不承诺的东西**，
以及**为什么**——每一条都能指到具体的事件、作用域或源码行。

v0.3 的判断标准只有一句：**凡是插件说自己做到的事，都要能指出「在哪一行、在哪个时刻，
由哪个参数或哪次写入保证」；指不出的，从自述里删掉，或者把它变成真的。**
本文就是「变成真的」与「删掉」之后剩下的东西。

阅读顺序建议：先看「一、结论：v0.3 到底保证了什么」，那 8 条是与 README 一致的最小承诺集。

---

## 一、结论：v0.3 到底保证了什么

只承诺下面 8 条，其余一律不承诺。

| # | 保证 | 由谁兑现 | 可核对方式 |
| --- | --- | --- | --- |
| G-a | 受管会话只能通过 `dispatch_agent` 按岗位派出，原生派生入口被拒绝 | `tools.guard()`（`.host-src/dsh-tools.js:3017-3032`） | `tests/unit/governor.test.js` |
| G-b | 岗位没配好、或与官方策略无交集时，派出在创建之前被拒绝 | `decideDispatch()` 纯计算 | `tests/unit/dispatch.test.js`、`tests/unit/acceptance.test.js` |
| G-c | 受管子会话的**每一轮**模型请求都被压回台账路由 | `agent/request` 监听器 | `tests/unit/request-lock-e2e.test.js` |
| G-d | 每次派出都有落盘回执；台账写不进就不派 | `storageDomain` + `openLedger()` | `tests/unit/ledger.test.js`、T33 |
| G-e | 受管子会话不能再派孙级 | `tools.guard()` + `STATION_NESTED_DISPATCH_FORBIDDEN` | `tests/unit/governor.test.js` |
| G-f | 覆盖不完整时如实报告，严格模式下拒绝派出 | `computeCoverage()` | T20 / T20b |
| **G-g** | **派出的子会话在第一轮请求之前就带着岗位路由** | `request.agentOptions`（`index.js` 的 `dispatch`） | **T42 / T43** |
| **G-h** | **加载插件前就已存在的受管会话同样被治理；未受管的存活会话会被报出来** | 启动扫描 `governAgent()` + `station_status` | **T45 / T46 / T58** |

### 三条最容易被误读的边界

1. **G-c 的「压回」发生在请求将要发出时，不是「模型被替换」。** 如果上游适配器
   在收到配置后又自行改写（例如把它自己的默认值塞回来），插件看不到也拦不住。
2. **G-e 是工具层拒绝，不是运行时深度封顶。** 见下面第二条。
3. **本插件不防「用户自己改配置」。** 用户随时可以把 `managedSessionIds` 清空、
   把岗位删掉、把我禁用。它防的是**模型在受管会话里自行绕过岗位**，不是防管理员。
4. **G-g 改变了一个 v0.2 的默认行为（v0.3 的重要变更）。** 修复前，子会话创建时
   不带 `agentOptions`，因此**继承父会话的模型**，直到首轮请求被压回。修复后，
   子会话从创建那一刻起就用岗位路由。副作用：如果某岗位的路由与父会话不同，
   子会话的**首轮**就会看到不同模型——这正是「岗位模型策略」的本意，
   但与 v0.2 的观感不同。

---

## 二、L1 已删除：`maxDepth` 做不到「禁止孙级」

方案 5.1 原本设计三层防线，其中 L1 是「派出时传 `request.maxDepth: 0`，
让子会话的委派工具在运行时层面被封顶」。**阶段 0 的 C3 证明这条不成立**，
v0.2 因此只有两层（guard + 请求锁定）。

`maxDepth` 的真实语义与三个候选机制的结论：

| 候选机制 | 能否通过 `startActivation` 设置 | 能否约束子会话的后代 |
| --- | --- | --- |
| `request.maxDepth = 0` | 能 | **不能**——`1 > 0`，直接拒绝本次派出 |
| `request.maxDepth = childDepth` | 能 | **不能**——不持久化，也不拒绝正常派出 |
| `request.toolFilter` | **不能**——类型与实现都不透传 | — |
| 改 `tool-subagent` 行的 Config | **不能**——那是别的插件条目 | — |

证据：

- 唯一的检查点是 `resolveChildDepth`，`.host-src/dsh-subagent.js:279-284`：
  `childDepth = delegationDepthOf(parent) + 1; if (childDepth > maxDepth) throw SubagentDepthError`。
- `maxDepth` **不进入描述符**：`snapshotSubagentDescriptor` 的字段集合里没有它
  （`.host-src/dsh-subagent.js:670-681`），`startLocal` 只带
  `agentProvider/agentModel/agentReasoningEffort`（`:1404-1411`）。
  所以它连「这个孩子自己记住了上限」都做不到。
- 本地后端的 `composition` 只传 `{ agentPreset }`（`.host-src/dsh-subagent.js:1452`），
  **不透传 `toolFilter`**；只有冷恢复路径才会从历史描述符恢复它（`:2180`）。

**因此不要把「孙级被拒」理解为运行时安全边界。** 它是工具层拒绝：
如果一个第三方插件绕过工具层直接调 `subagents.startActivation`，本插件拦不住。
（这一条同样适用于下面第四节的所有「新增入口」场景。）

---

## 三、不作出的保证（逐条）

### 3.1 不保证「子会话里绝对无法用别的模型」

G-c 保证的是「插件把配置压回台账值」。以下情况不在覆盖内：

- **上游适配器二次改写。** 插件返回的配置被适配器再处理，插件无从得知。
- **绕过 `agent/request` 的调用路径。** 例如某个插件直接持有适配器句柄自己发请求。
- **`next()` 抛错时。** 监听器会等待 `next()`；上游抛错则该轮直接失败，
  这时插件也无法「接管」这个请求——它只是没被发出。
- **适配器忽略 `provider`/`model` 字段。** 有些适配器可能只认自己的参数名。
  插件只负责把这两个字段写正确，不负责验证适配器是否理它。

### 3.2 不保证「覆盖是完备的」

覆盖诊断（`lib/host/coverage.js`）只能基于**当前可见的工具名**做判断，因此：

- **目录是快照，会过期。** `lib/host/delegation-catalog.json` 记录的是
  DSH `0.2.1-rc.2` 上实测到的入口（`catalogVersion` 字段写着）。宿主升级后出现的新入口
  需要更新目录，否则它们会落到「目录外」。
  v0.3 起 `tools/change` 会失效目录缓存（`index.js` 的 `readCatalog`），
  所以「文件换了一版而插件还按旧的判断」这个失真不再成立；但**文件内容本身过期**
  仍然是真问题。
- **「目录外」分两类，判据不同。** v0.3 把两个问题拆开了（方案 §8.2）：

  | 问题 | 判据 | 后果 |
  | --- | --- | --- |
  | 诊断看见什么 | 与目录做**差集**，不做词形过滤 | 出现在 `unrecognized` / `unknown` 里 |
  | guard 拦什么 | `unknownEntryPolicy` + 词形匹配 | 决定是否拒绝 |

  一个叫 `orchestrate_pipeline` 的派生工具会出现在 `unrecognized` 清单里（**看得见**），
  但在默认策略 `block-delegation-like` 下**不会被拦**（因为名字不像）。
  这是 v0.3 仍然存在的真实盲区，取舍见下面 3.2.1。

- **`degraded` 不阻止派出。** 目录读不到时只标 `degraded` 并告警。
  这是刻意的：把一次打包事故变成「用户什么都做不了」代价更高。
  需要强保证的部署应打开 `strictCoverage`——但如上所述，它仍受前两条限制。
- **工具层的可见性 ≠ 服务层的可调用性。** 一个插件即使不注册工具，
  也能通过 `ctx.get('subagents')` 直接派出。覆盖诊断看不到这种情况。

#### 3.2.1 `unknownEntryPolicy` 的三种取值与取舍（v0.3 新增）

| 取值 | 拦什么 | 适用于 | 代价 |
| --- | --- | --- | --- |
| `block-delegation-like`（默认） | 目录外**且名字像派生入口**的，只在子会话拦 | 大多数部署 | 改名的派生入口会被放行 |
| `deny-all` | **全部**目录外入口 | 强管控环境 | 任何新装的普通工具都不能用 |
| `allow` | 不拦 | 只想要诊断、不想要拦截 | 与 v0.2 行为一致（= 没有入口收口） |

**为什么默认只拦「像的」**：误伤代价不对称。受管根调用一个名字里带 `dispatch` 的
普通工具（例如 `dispatch_notification`）被拦，用户立刻会反馈；而放行一个改名的派生入口，
用户永远不会发现。所以默认偏严，但**只严在子会话**——受管根的原生入口已由
`blockNativeDelegation` 单独处理，那边的误伤面更大。

**逃生阀**（按推荐顺序）：

1. 确认那个名字**不是**派生入口 → 设 `unknownEntryPolicy: 'allow'`，或把它加进
   `blockedToolNames` 而把策略留在默认（推荐：后者更精确，因为 `blockedToolNames`
   是逐名登记的）；
2. 确认那个名字**是**新入口 → 更新 `lib/host/delegation-catalog.json`，
   这是唯一能让诊断与拦截都认识它的方式；
3. 装在一个你完全信任的 MCP/插件上、又不想逐名维护 → `deny-all`。

### 3.3 不保证「跨进程并发安全」

台账用 `json` 后端（`<DSH_HOME>\profiles\desktop\cordis.patch.yml`：
`backend: json`，`root: dshHomePath('storages')`）。因此：

- **两个 DSH 进程同时写同一份存储**时，插件没有跨进程锁。它依赖后端自己的
  「单写者」假设，插件没有额外加固。
- **单进程内**的写入是有序的：`Domain` 内部有 `chain` 串行化
  （`.host-src/dsh-storage-domain.js:198-204`），插件的写入都经过它。
- **回执不是审计日志。** 它是「解释缓存」：真相在会话记录里。
  两者冲突时以会话记录为准（优先级见下面 3.8）。

### 3.4 不保证「重启后能自动恢复现场」

- 重启时 `intent`/`started` 且子会话找不到的回执会被标成 `unverified`
  （`RECEIPT_STATUS.UNVERIFIED`），**不自动重派**。这是刻意的：
  自动重派一个可能已经在跑的任务，比留下一条待核对记录危险得多。
- v0.3 补充：`observed` 且子会话找不到 → 标 `settled`，note 写
  「重启后确认子会话已结束（停止原因未记录）」。`observed` 的含义是
  「至少有一轮请求被正确压回」，那已足以判定这次派出曾经正常运行过；
  把它标 `unverified` 会稀释该状态的信噪比。
- `unverified` 的回执不会阻止后续派出，也不会自动清理。需要人工核对。
- **冷恢复的子会话仍受锁定**，但它靠的不是 `toolFilter`/`agentOptions` 被宿主持久化
  ——**那个论证在 v0.2 的文档里是错的**。真实依据是两条：
  1. `session.header.delegationDepth` 会持久化，插件用它判断「这是子会话」；
  2. 台账的 `children` 表里有这条记录，插件据此知道它该用哪条路由。

  也就是说：**恢复能力来自本插件自己的台账**，不来自 `startAgentOptions`。
- 如果存储被清空（换 profile、删 storages 目录），冷恢复的子会话会走到
  `STATION_UNKNOWN_CHILD` 并被拒绝——这是设计如此，见 3.5。
  但此时**入口 guard 仍然会挂上**（v0.3 §4.4）：恢复后的子会话即使查不到台账，
  也依然不能再派孙级。这条区分很重要：它把「查不到模型」与「完全不受管」分开了。

### 3.5 被拒绝时「看起来坏了」是刻意的

以下情况会**拒绝**而不是降级放行，用户会看到工具报错：

| 情况 | 错误码 | 为什么拒绝 |
| --- | --- | --- |
| 子会话不在台账里 | `STATION_UNKNOWN_CHILD` | 无法确认它该用哪个岗位模型；放行等于「看起来受管」 |
| 台账读不出/写不进 | `STATION_LEDGER_UNAVAILABLE` | 「派了但没记」比「没派」更难收拾 |
| 后端不声明 `agentOptions` | `STATION_BACKEND_INCAPABLE` | 岗位模型策略在该后端上形同虚设 |
| 后端未注册 | `STATION_BACKEND_INCAPABLE` | 同上 |
| 严格模式下出现目录外入口 | `STATION_COVERAGE_INCOMPLETE` | 用户显式要求了强保证 |

**这是设计取舍，不是缺陷。** 一个「出问题时悄悄放行」的策略插件，
比没有插件更危险——它给出的是虚假的安全感。

### 3.6 `dispatch_agent` 不返回子会话的答案

它返回**回执**：路由、依据、策略修订、状态。子会话的结果通过常规的
`send_message` / 子会话回复机制回到父会话。原因：v0.2 的承诺是「路由受控」，
不是「替你等结果」；等结果会让工具超时语义与子会话生命周期纠缠。

回执状态如实：派出后写的是「已受理，等待首个模型请求确认」，
**不会**在首轮请求前写「已锁定」（T40）。

### 3.7 三个真相源的优先级（v0.3 新增）

v0.2 实际上有三个数据源在描述「这个子会话该用什么模型」，但**没有写下优先级**。
v0.3 把它写清：

| 源 | 位置 | 权威性 | 说明 |
| --- | --- | --- | --- |
| 会话记录（`session.header` + `request/header`） | 持久化日志 | **最高** | 已经发出的请求是什么样，只有它说得清 |
| 台账 `children` 表 | `station_dispatch_ledger` | 次高 | 插件自己的决定记录；子会话可能被手动改过，两者会不一致 |
| Config（岗位/路由） | 插件设置 | **最低** | 只描述「以后怎么办」，不描述「已经发生了什么」 |

这条优先级在代码里体现为两件事：

- **请求锁只读台账，不读 Config。** `request-lock.js` 每轮都重新 `getChild`，
  所以用户改配置后，**已在跑的子会话仍按台账值锁定**。这是刻意的：改配置不该
  把正在运行的任务换个模型。
- **诊断同时展示三者，有冲突时按上表解释，不猜。** `station_status` 会同时给出
  台账回执、Config 策略与存活会话实况；`subagentStation.snapshot()` 返回同一份结构。

### 3.8 双层约束的排查顺序（v0.3 新增）

本插件对 `dispatch_agent` 创建的子会话做**四层求交**：岗位 ∩ 全局允许 ∩ 快照 ∩ 官方。
而官方 `tool-subagent` 自己的 `selectForSession` 也会对子会话施加
`subagent-model-selection-settings` 的允许集合。

后果：如果岗位路由与官方允许集合不一致，**由原生 `subagent` 工具创建的子会话会失败，
而这个失败不由本插件产生、也不由本插件解释**。

**排查顺序**（按这个顺序看，不要跳）：

1. 先看 `dispatch_agent` 回执里的「官方模型策略」一行——它说的是本插件看到的官方状态；
2. 再看 `station_status` 的 dry-run（`roleId` 参数），它会给出求交后还剩几条；
3. 最后才去看官方设置页（`subagent-model-selection-settings`）。

**本插件不改官方行为**——那不是它的权力范围。它能做的只是把冲突说清楚。

### 3.9 错误码表只列「会抛出的」（v0.3 审计）

v0.2 声明了 19 个错误码，其中 3 个**从未 `throw`**：

| 已删除的码 | 为什么删 |
| --- | --- |
| `STATION_POLICY_DEVIATION` | 偏离**从不阻断**请求，只是记录。背离的可见性由 `station_status` 的「最近偏离」承担 |
| `STATION_ROLE_NOT_CONFIGURED` | 被 `STATION_CONFIG_CONFLICT` 与 `STATION_ROLE_NOT_FOUND` 完全覆盖 |
| `STATION_STORAGE_UNAVAILABLE` | 与 `STATION_LEDGER_UNAVAILABLE` 是同一事实的两个名字 |

留下的每个码都在 `lib/` 里至少有一个 `throw` 点。这不是靠人工记忆维持的：
`tests/unit/error-codes.test.js` 会扫描 `lib/**/*.js`，任何「声明了但从不抛出」的码
都会让测试变红。

### 3.10 没有可视面板

v0.2 **删除了** v0.1 的前端卡片（方案 8.2）。原因：v0.1 的卡片读
`props.station.snapshot`，而 `plugins.bundle.config` 的 ownerProps 只有
`{ view: 'summary' | 'page', form? }`（`docs/contract-evidence.md` C7），
那个 props 永远是 `undefined`——一张永远空白的卡片。

诊断改由三处提供：

- `dispatch_roles` 工具（模型可见，人也能从会话记录看到）；
- `station_status` 工具（**v0.3 新增**，方案 §10）：结构化文本，含未受管会话清单、
  台账自洽性、覆盖诊断（全局 + 本会话作用域）、最近偏离、上次扫描时间；
- `ctx.get('subagentStation').snapshot()` 只读服务（给将来的面板或脚本用）。
  它与 `station_status` **共用同一个 `buildStatus()`**，所以两处不会漂移。

**手写 `@Remote` 的用法未验证**（C7），因此仍然不做面板。
没有承诺的东西不写进 UI。

---

## 四、未验证清单

以下事项**没有**在真实环境里验证过。任何依赖它们的结论都应重新核实。

| 事项 | 状态 | 影响 |
| --- | --- | --- |
| 真实宿主里 `agent/request` 的派发宽度 | **未验证** | 本仓夹具比真实宿主更宽；插件已自校验，故不影响 G-c |
| `storageDomain` 的 `invalidRecords: 'backup-and-skip'` | **未验证**（`json` 后端是否有 `backupRecord` 未知） | v0.2 不使用该选项；坏记录会让域打不开，从而拒绝派出 |
| `subagent` 后端的 `capabilities.toolFilter` | **未验证**（`spawn` 未声明该项） | 不依赖它 |
| 手写 `@Remote` 的可行性 | **未验证** | 面板不做 |
| 真实模型是否遵守压回后的路由 | **未验证**（需要网络与适配器） | 这与 3.1 是同一件事 |
| 跨进程并发写同一 storages 目录 | **未验证** | 见 3.3 |
| `spawn_teammate` / `run_code` 在本 profile 是否存在 | **实测不存在**（43 个工具里没有） | 目录里保留 `spawn_teammate` 条目，存在才拦 |
| `subagent/end` 的 `info.id` 是否总等于 `childSessionId` | **源码已核**（`.host-src/dsh-subagent.js:187-206`），**真实运行未验证** | 若不等，回执会停在 `observed`，由重启对账收尾 |
| `agent/created` 的 `source` 在 resume/clear/compact 下的真实取值 | **源码已核**，**真实运行未验证** | 若与文档不符，恢复路径退化为「只挂 guard、不挂锁定」——仍比 v0.2 强 |
| 真实宿主中「插件热装后既有会话」的 `agents.list()` 可见性 | **单测已覆盖**（T45/T46），**真实运行未验证** | 若看不见，W1/W2 降级为「只治理新会话」（已由 `station_status` 的「上次扫描」与未受管清单兜住） |
| 官方 `subagent-model-selection-settings` 与本插件求交的实际一致性 | **未验证** | 见 3.8 的排查顺序 |

### 4.1 一个已知的测试盲区（已踩到）

本仓的单元测试替身**不实现**真实后端的全部校验。已经因此漏过一个会让插件完全不可用的错误：
台账表名写成 `managedRoots`（camelCase），真实 `json` 后端用
`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 校验每个表名，于是整个域打不开 → 所有派出被拒。
这个错误在单测里是绿的，只有在真实宿主里调用一次才暴露。

已经做的补救：

- `tests/unit/ledger.test.js` 对域名与每个表名跑同一个正则；
- 交付前在真实宿主里实调一次 `dispatch_agent`，确认能推进到「未受管会话」这一层。

**仍然存在的同类风险**：替身对 `Domain` 的其它约束（版本迁移、`invalidRecords` 行为）
同样不做校验。凡是「只有真实后端才检查」的约束，单测都保证不了。

---

## 五、与 README 的一致性

README 的「不作出的保证」一节必须与本文一致。改动任一处时同步另一处。

若两处冲突，**以本文为准**——本文每条都附了可核对的出处。
```

</details>

## 测试文件

- `tests/unit/acceptance.test.js`
- `tests/unit/dispatch.test.js`
- `tests/unit/error-codes.test.js`
- `tests/unit/governor.test.js`
- `tests/unit/ledger.test.js`
- `tests/unit/legacy-registration.test.js`
- `tests/unit/policy.test.js`
- `tests/unit/register.test.js`
- `tests/unit/request-lock-e2e.test.js`
- `tests/unit/request-lock.test.js`
- `tests/unit/starter.test.js`
- `tests/unit/v03.test.js`
