# v0.3 交付状态

- 方案：`子智能体派出所-v0.3改进方案.md`
- 测试报告：[`TEST-REPORT.md`](TEST-REPORT.md)（**脚本生成**，含红→绿对照）
- 契约证据：[`docs/contract-evidence.md`](docs/contract-evidence.md)（C8-a…C8-g 为 v0.3 新增）
- 已知限制：[`docs/known-limits.md`](docs/known-limits.md)

## 一句话结论

六个目标（G1–G6）全部落地，v0.3 矩阵（T42–T58）全部转绿，**118 项测试全过**。
关键的是：**每条修复都有一条「退回 v0.2 形态后确实变红」的测试**，
红方证据存档在 [`proof/red-v02.txt`](proof/red-v02.txt)，由 `node scripts/make-red-proof.mjs` 重现。

## 本轮实际执行过的验证

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 全量单元测试 | `node --test --test-isolation=none "tests/unit/*.test.js"` | 118 通过 / 0 失败 |
| v0.3 矩阵 | `node --test --test-isolation=none "tests/unit/v03.test.js"` | 17 通过 / 0 失败 |
| 红方证据（12 组退回） | `node scripts/make-red-proof.mjs` | 12 组全部「应当变红 = 实际变红」 |
| 报告生成 | `node scripts/report.mjs` | 生成 `TEST-REPORT.md` |
| guard 作用域实测 | 仓内探针（已删除，结论存档在 C8-b） | `scopeOf(agent.ctx)===agent`；A 被拒、B 放行、无 agent 放行 |
| `tools.schemas(scope)` 实测 | 同上 | `schemas(agentA)` 多出 scoped 注册，全局与 `agentB` 看不到 |
| `stopReason` 取值集合 | 读宿主源码 | `completed \| aborted \| error \| max-tokens \| refusal` |

## 六个目标的落地位置

| 目标 | 方案 | 实现 | 测试 | 红方 |
| --- | --- | --- | --- | --- |
| G1 遣返参数 | §3 | `index.js` `dispatch` 的 `request.agentOptions` | T42/T43/T44 | G1 组 |
| G2 治理覆盖 | §4 | `governAgent()` + 启动扫描 + `resolveRootSessionId` | T45/T46/T47/T57 | G2-a / G2-b 组 |
| G3 身份现算 | §5 | `entry-governor.js` 身份指纹 + guard 内现算 | T48 | G3 组 |
| G4 台账闭合 | §6 | `markObserved` / `closeReceipt` / `settleStatusFor` / 对账扩展 | T49/T50/T51 | G4-a / G4-b 组 |
| G5 快照自愈 | §7 | `ensureSnapshot` 的空集自愈 + `snapshotEpoch` | T52/T53 | G5-a / G5-b 组 |
| G6 覆盖不撒谎 | §8 | 四态 `computeCoverage` + `unknownEntryPolicy` + scoped 诊断 + `station_status` | T54/T55/T56/T58 | G6-a…G6-d 组 |

## 本轮发现并修正的真实缺陷

### 1. 派出时从来没下发 `agentOptions`（G1）

v0.2 把路由写进了回执文本，却**没有**放进 `request`。于是子会话继承父会话模型，
直到请求锁在首轮把它压回来。整份「岗位模型策略」在首轮是空的。

修正：`request.agentOptions = { provider, model, ...(effort 有值才带) }`。
`reasoningEffort` 按需携带的依据是宿主 `:328` 的删除逻辑（见 C8-a）——
路由变了却带旧强度会被「显式给了」绕过。

### 2. 加载插件前已存在的会话完全不受管（G2）

v0.2 只挂 `agent/created`。用户装好插件后什么都没发生，而这正是 §1.3 那次
「以为装了其实没装」误判的土壤。

修正：`apply()` 里扫描 `agents.list()`，台账就绪后再补扫一次（第一次只能挂 guard，
第二次能挂请求锁定）。`governAgent()` 幂等，与 `agents.register()` 的
`startup` 事件重叠是安全的。

### 3. 孙级被判成「未受管」（G2）

v0.2 拿 `header.parentSession` 当根（只走一层）。`maxDepth: 2` 时孙级的父是中间子会话，
不在 `managedSessionIds` 里 ⇒ 判成未受管。

修正：`resolveRootSessionId` 沿 `sessions.get` 逐层向上（照抄宿主 `liveLineage`，`:1735`），
走不到头时退回最后一个能确认的 id，并用 `seen` 防环。

### 4. guard 的 `isChild` 冻结在闭包里（G3）

`attachTo` 把 `isChild` 冻进闭包，且同 id 直接复用旧 disposer。resume/clear 之后
`session.header` 被整体替换，而 `agent/created` 已经发过——这个会话就永远按根处理，
能派孙级。

修正：两处都要改（`attachTo` 存身份指纹并在变化时重挂；guard 内每次调用现算）。
**只改一处不够**——红方证据里这两条必须同时退回才是 v0.2 的真实形态，
这一点由 `make-red-proof.mjs` 的假绿检查逼出来了。

### 5. 回执永远停在 `started`（G4）

`observed` 状态在枚举里存在，但**从来没有被写入过**；`subagent/end` 也没有监听者。
于是「压回过」与「从没成功过」在台账里长得一样。

修正：请求锁在**首次**成功压回时写 `observed`（只写一次，不让存储变热路径）；
受管根上挂 `subagent/end` → `closeReceipt`，按 `stopReason` 落到终态；
终态不可覆盖；重启对账把 `observed` 且子会话已消失的记录判为 `settled`。

### 6. 空快照让受管根永久派不出（G5）

`stationRoutes: []` 被当成「已授权为空」。之后 `isNarrowing` 恒为 false（空集不含
任何「不在 live 里」的 key）⇒ 快照永不更新 ⇒ 该根此后每次派出都报冲突，
且用户没有任何办法让它生效。

修正：空集不构成「已授权集合」，按当前集合自愈（`snapshotVersion + 1`，
note 记原因）；另加 `snapshotEpoch` 作为唯一的显式重建入口。

### 7. 覆盖诊断在「自己认识的世界」里自说自话（G6）

三处失真：目录外一律放行、只读全局视图、只读一次目录。

修正：四态（新增 `unrecognized`）、`unknownEntryPolicy` 三档、scoped `schemas(agent)`
双视图、`tools/change` 失效目录缓存、新增 `station_status` 工具。

### 8. 三个错误码是空承诺

`STATION_POLICY_DEVIATION`、`STATION_ROLE_NOT_CONFIGURED`、`STATION_STORAGE_UNAVAILABLE`
在 `lib/` 与 `tests/` 里都是 **0 引用**（grep 核实）。已删除；
`tests/unit/error-codes.test.js` 会扫描 `lib/**/*.js`，以后任何「声明了但从不抛出」的码
都会让测试变红。

## 对照方案验收矩阵（T42–T58）

| 编号 | 判据 | 状态 |
| --- | --- | --- |
| T42 | 派出的 `startActivation` 里 `request.agentOptions` 等于回执声明的路由 | ✅ |
| T43 | 首轮请求之前，子会话创建参数已是岗位值（不经请求锁） | ✅ |
| T44 | 后端不声明 `agentOptions` 时仍然拒绝（预检没有退化成空操作） | ✅（v0.2 即为绿，作用为回归守卫） |
| T45 | 插件加载前已存在的受管根：加载后立即受 guard 约束 | ✅ |
| T46 | 插件加载前已存在的受管子会话：下一轮请求即被压回台账值 | ✅ |
| T47 | `maxDepth: 2` 的孙级：判定受管且根 id 正确 | ✅ |
| T48 | 同一 agent 身份变更后重挂：`isChild` 刷新，孙级派出被拒 | ✅ |
| T49 | 首次成功压回后回执从 `started` 变为 `observed`，且只变一次 | ✅ |
| T50 | 子会话正常结束：回执 `settled`，note 含 `stopReason` | ✅ |
| T51 | 子会话被中断：回执 `interrupted`，终态不再被改写 | ✅ |
| T52 | 空快照后补齐路由：下一次派出成功（不改 epoch） | ✅ |
| T53 | `snapshotEpoch` 加 1：按新集合重算，`snapshotVersion + 1`，在跑子会话不受影响 | ✅ |
| T54 | 受管子会话遇目录外但名字像派生的入口 → 拒绝 | ✅ |
| T55 | 目录外的普通工具（`read`/`bash`）不被误拦，且进 `unrecognized` 清单 | ✅ |
| T56 | scoped 注册的入口出现在该 agent 的覆盖诊断里，且不影响全局视图 | ✅ |
| T57 | 卸载后启动扫描挂上的治理同样解除，台账保留 | ✅ |
| T58 | 未受管会话调 `station_status`：给出本会话 id、原因与两种纳入方式 | ✅ |

## 与方案不一致、已按实测修正的地方

| 方案原文 | 实测结论 | 处理 |
| --- | --- | --- |
| §5.1 设想过 L1「运行时深度封顶」 | `request.maxDepth` 做不到（C3） | v0.2 已删，v0.3 维持 |
| §7.2 只提到「空快照自愈」 | 还需要一个**显式**重建入口，否则放宽永远无路可走 | 加 `snapshotEpoch`（§7.3） |
| §8.6 建议给目录加 mtime 缓存 | `tools/change` 失效更直接，且不必 stat | 按事件失效实现 |
| §14 阶段 3 要求「删除 `POLICY_DEVIATION`」 | 审计发现另外两个码也是 0 引用 | 三个一起删，并加守卫测试 |

## 尚未做、也没有假装做的事

1. **真实宿主里的端到端派出未验证。** 本轮所有结论来自单元测试（使用真实
   `createScope` / `ToolRuntime` / `storageDomain` 形状的替身）与宿主源码阅读。
   真实 LLM 派出的验证需要网络与适配器，不在本轮范围内。
2. **没有可视面板。** 诊断由 `dispatch_roles`、`station_status`、
   `subagentStation.snapshot()` 三处提供，都是文本/结构化数据。
3. **`unknownEntryPolicy` 默认放行「改名的派生入口」。** 这是刻意的取舍
   （误伤代价不对称），逃生阀见 `docs/known-limits.md` §3.2.1。
4. **不保证热装时一定看得见既有会话。** 启动扫描依赖 `agents.list()`；
   取不到时只治理新会话并告警（`docs/known-limits.md` 不作出的保证第 7 条）。
5. **官方双层约束不改。** 只补解释与排查顺序（§3.8）。

## 交付物清单

```
subagent-dispatch-station/
  lib/host/
    index.js              插件入口：工具注册、派出、治理、快照、诊断
    entry-governor.js     入口治理：identity fingerprint + 现算 isChild + 谱系解析
    request-lock.js       每轮请求压回 + 首次 observed
    ledger.js             回执状态机、终态映射、重启对账
    coverage.js           四态覆盖诊断 + unknownEntryPolicy 判定
    config.js             Config v0.3（14 个字段）
    delegation-catalog.json  入口目录（v0.3 新增 station_status 条目）
  lib/shared/policy.js    纯策略内核（错误码、路由求交、思考强度）
  docs/contract-evidence.md  C1–C7 + v0.3 的 C8-a…C8-g（每条带行号）
  docs/known-limits.md       8 条承诺、12 类不作出的保证、未验证清单
  scripts/report.mjs         生成 TEST-REPORT.md（抓 TAP 摘要）
  scripts/make-red-proof.mjs 生成 proof/red-v02.txt（逐条退回 + 假绿检查）
  proof/red-v02.txt          红方证据存档（12 组，由脚本生成）
  tests/host-fixture.js      替身（真实 createScope / scope-aware schemas / agentOptions 记录）
  tests/unit/v03.test.js      v0.3 矩阵 T42–T58
  tests/unit/error-codes.test.js  错误码表审计
  TEST-REPORT.md             脚本生成，勿手改
  README.md / STATUS.md      面向用户与维护者
```

## 历史：v0.2 交付状态

v0.2 的核心是把「派出时校验一次」升级为「每一轮模型请求都被锁定」。
它当时报告的 5 个真实缺陷（`register()` 不校验 `parameters`、台账表名 camelCase、
请求锁闭包串路由、回执写两次的竞态、`inject` 未声明）均已修复并保留回归测试。

但 v0.2 的「97 项全绿」有一个盲区：**它没有一个测试检查 `request.agentOptions`**。
v0.3 的阶段顺序（先写红测试、再修、再逐条退回验证）就是为了不再出现这种情况。
