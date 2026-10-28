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
  `STATION_UNMANAGED_CHILD` 并被拒绝——这是设计如此，见 3.5。
- **v0.4 的变化**：v0.3 在这里还会额外"挂上入口 guard"，所以"查不到台账但仍受部分治理"。
  v0.4 的 guard 是**全局的**，从插件加载那一刻就覆盖所有会话——不存在"恢复后忘了挂"。
  因此这一条从"部分治理"变成了"完整治理"：恢复的子会话既不能派孙级，也不能换模型。

### 3.5 被拒绝时「看起来坏了」是刻意的

以下情况会**拒绝**而不是降级放行，用户会看到工具报错：

| 情况 | 错误码 | 为什么拒绝 |
| --- | --- | --- |
| 受管谱系内的子会话不在台账里 | `STATION_UNMANAGED_CHILD` | 无法确认它该用哪个岗位模型；放行等于「看起来受管」 |
| 台账读不出/写不进 | `STATION_LEDGER_UNAVAILABLE` | 「派了但没记」比「没派」更难收拾 |
| 后端不声明 `agentOptions` | `STATION_BACKEND_INCAPABLE` | 岗位模型策略在该后端上形同虚设 |
| 后端未注册 | `STATION_BACKEND_INCAPABLE` | 同上 |
| 严格模式下出现目录外入口 | `STATION_COVERAGE_INCOMPLETE` | 用户显式要求了强保证 |
| 谱系与台账不一致 | `STATION_LINEAGE_MISMATCH` | 谱系被改写过（resume/clear/换父）。不猜哪个根才对 |
| 谱系算不出来 | `STATION_LINEAGE_UNKNOWN` | 无法确认归属就放行 = 「看起来受管」 |
| 跨根投递 `send_message` | `STATION_TARGET_FOREIGN` | 绕过那个根的授权 |
| 判定输入读不出来 | `STATION_POLICY_UNREADABLE` | 不知道就不放行（I8，fail-closed） |

> **v0.4 删掉了 `STATION_UNKNOWN_CHILD`**：它与 `STATION_UNMANAGED_CHILD` 是同一个
> 事实的两个名字。v0.3 用它表示"子会话不在台账里"，而 v0.4 必须把这件事与
> "根本不归我管"分开——后者由 L3 的**管辖区判定**处理，直接放行，**不抛码**。
> 完整归位表见 `docs/errors.md`。

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

## 三之二、v0.4 新增的已知限制

### 3.11 全局挂载的监听器必须自己认身份（新增风险，已缓解）

v0.4 把 L2 守卫与 L3 锁定都改成**全局挂载**（S1/S2 实测：普通上下文上的
`tools.guard` 覆盖全部调用，`agent/request` 监听器收到全部 agent 的请求）。
这让"窗口"消失，但引入一个**新的**真实风险：

> 全局监听器不分来源，所以它**不能**用闭包里的 agent 判断身份。

v0.3 的 `request-lock.js` 正是按 agent 闭包挂的。改全局时如果照抄，就变成
"把 A 的请求压到 B 的路由"——那是「看起来受管、实际用了错模型」的最坏形态。

**缓解措施**（不是"注意一下"，是代码结构）：

1. `mountRequestLock` 每次请求都从 `payload.agent.session.id` **现读**身份；
2. 管辖区先判：不受管 ⇒ 原样放行，**不读台账、不拒绝**（否则插件越权接管）；
3. `tests/unit/request-lock.test.js` 的 T63 用**一个**监听器服务**两个**子会话，
   断言不串路由。这条测试在 v0.3 的 API 上根本写不出来。

### 3.12 预置 `childId` 依赖后端实现 `prepareContinuable`

v0.4 用"先生成 childId → 登记 → 再用它创建"消除 TOCTOU（S5 实测宿主会原样采用
`spec.childId`）。但宿主明写（`.host-src/dsh-subagent.js:3038`）：

```js
if (spec.childId !== void 0 && provider.prepareContinuable === void 0)
  throw new SubagentError("reserved child ids require a local backend", "UNSUPPORTED_CAPABILITY");
```

所以：

- **后端不支持时，插件不传 `childId`**，退回 v0.3 的"派出后立刻登记"；
- 该路径上仍有一个极短窗口，因此回执会标 **`保证等级：降级（配置）`**；
- 用户改配置可以修好（换支持的后端），所以它算"配置"档而不是"环境"档。

**绝不用可预测的 child id**（如 `child-1`）：S5-d 实测预置 id 会额外检查持久化残留，
可预测的 id 在重启后必然撞 `DUPLICATE_CHILD`。插件统一用 `randomUUID()`。

### 3.13 运行时路由**无法核对**

S4 实测：子会话的 `session.header` 里**没有** provider/model 字段。所以：

- `station_status` 只能核对**台账侧**（我们决定用什么）；
- 真实运行中模型到底用了哪条路由，插件**看不见**;
- 因此状态里对运行时的表述是 **`无法核对（宿主未在会话头记录实际路由）`**，
  **永远不会**写成 `一致`。

这是刻意的不作为：写"一致"等于替一个我们没看到的事实背书。

### 3.14 `agent/created` 里不许抛错（所以没有 L1 创建门）

S3 实测：在 `agent/created` 监听器里抛错**不会**阻止 agent 创建（事件已经发完了）。
所以 v0.4 **不建** L1 创建门——一个拦不住的"门"只会让人误以为拦住了。

真正拦住"绕过入口创建"的是 L3：子会话的第一轮请求会以
`STATION_UNMANAGED_CHILD` 被拒绝。代价是那个会话**已经存在**（占用资源、出现在列表里），
但它**用不了任何模型**。

### 3.15 计数器的三个已知局限

`stats.js` 的判定计数与 `meta` 表的生命周期计数都是**尽力而为**的证据：

| 局限 | 影响 | 为什么不修 |
| --- | --- | --- |
| `stats` 只在内存，热重载归零 | 重载后「已评估 0 次」不代表"从未工作" | 落盘会让每次工具调用都写存储（方案 §2.3 明确禁止把判定变热路径） |
| `meta` 写入失败被吞掉 | 计数可能少记，但不影响业务写入 | 统计写不进去时让派出失败，是本末倒置 |
| 计数器只增不减，无法回滚 | 台账被手动清空后计数会显得"对不上" | 那正是我们想让它显出来的：数字对不上就是有人动过 |

关键在于：**这些数字的用途是"发现不对劲"，不是"当作审计凭证"**。
审计凭证是台账的记录本身，不是计数。

### 3.16 `notice` 与 `error` 的边界是启发式的

偏离分级的判据（`request-lock.js` 的 `classifyDeviation`）：

| 上游给的 | 判为 | 理由 |
| --- | --- | --- |
| 空 provider **且** 空 model | `notice` | 尚未初始化（首轮还没有路由） |
| 只有一半不同 | `notice` | 宿主在做某种退化，不是"换了个模型" |
| 两者都不同 | `error` | 真的被换掉了 |

**这是启发式，不是契约。** 某些后端可能在首轮给一个具体的默认 provider/model，
那时会被判成 `error`。后果是偏离计数偏高——但它偏向"多报冲突"，
而不是"把真冲突说成正常"。

### 3.17 「漏网」只能记账，不能阻断

`subagent/start` 是我们唯一能观察到"有子会话起来了"的事件。v0.4 在它上面检查台账，
发现未登记的就把记录写进 `escapes` 表，`station_status` 会显示「漏网 N 个」。

**但那时候已经拦不住了**：

- `subagent/start` 是 `emit`（通知），不是 waterfall；
- 子会话已经创建好了，插件没有"撤销创建"的能力。

所以真正生效的阻断在 L3：那个子会话的**第一轮请求**会以
`STATION_UNMANAGED_CHILD` 被拒。它存在、占资源、出现在会话列表里，
但**用不了任何模型**。

这是取舍：一个"拦不住的创建门"比没有门更糟（S3 证明在
`agent/created` 里抛错不会阻止创建）。

### 3.18 `escapes` 表会被频繁写吗

不会。`recordEscape()` 对同一个子会话 id 只写一次（幂等），且只在
"确实有未登记子会话"时写。正常使用下这张表永远是空的——它只在有绕过时才有记录。
`station_status` 也只在非空时显示这一节，避免"漏网 0 个"变成被人一眼扫过的噪音。

---

## 四、未验证清单

以下事项**没有**在真实环境里验证过。任何依赖它们的结论都应重新核实。

| 事项 | 状态 | 影响 |
| --- | --- | --- |
| 真实宿主里 `agent/request` 的派发宽度 | **v0.4 已实测（S2）**：普通上下文收到全部 agent | 仍由插件逐请求自校验，见 3.11 |
| `storageDomain` 的 `invalidRecords: 'backup-and-skip'` | **未验证**（`json` 后端是否有 `backupRecord` 未知） | v0.2 不使用该选项；坏记录会让域打不开，从而拒绝派出 |
| `subagent` 后端的 `capabilities.toolFilter` | **未验证**（`spawn` 未声明该项） | 不依赖它 |
| 手写 `@Remote` 的可行性 | **未验证** | 面板不做 |
| 真实模型是否遵守压回后的路由 | **未验证**（需要网络与适配器），且**无法核对**（见 3.13） | 与 3.1 是同一件事 |
| 跨进程并发写同一 storages 目录 | **未验证** | 见 3.3 |
| `spawn_teammate` / `run_code` 在本 profile 是否存在 | **实测不存在**（43 个工具里没有） | 目录里保留 `spawn_teammate` 条目，存在才拦 |
| `subagent/end` 的 `info.id` 是否总等于 `childSessionId` | **源码已核**（`.host-src/dsh-subagent.js:187-206`），**真实运行未验证** | 若不等，回执会停在 `observed`，由重启对账收尾 |
| `agent/created` 的 `source` 在 resume/clear/compact 下的真实取值 | **源码已核**，**真实运行未验证** | v0.4 起不再影响治理完整性（guard 是全局的），只影响日志措辞 |
| 真实宿主中「插件热装后既有会话」的 `agents.list()` 可见性 | **单测已覆盖**（T45/T46） | v0.4 起不再关键：guard 是全局的，看不见也会拦 |
| 官方 `subagent-model-selection-settings` 与本插件求交的实际一致性 | **未验证** | 见 3.8 的排查顺序 |
| 预置 `childId` 在真实 `spawn` 后端上的行为 | **源码已核 + S5 源码级断言**，**真实运行未验证** | 若不生效，插件检测到"宿主返回别的 id"并标降级，不会静默 |

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
