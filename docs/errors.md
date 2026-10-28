# 错误码归位表（v0.4）

> 配套代码：`lib/shared/policy.js`（码定义）、`lib/shared/refusal.js`（文案）。
> 配套测试：`tests/unit/error-codes.test.js`（归位表的完整性与触发点）。

## 为什么需要"归位"

v0.3 的 18 个错误码里有 4 个是**同一个事实的不同名字**，还有几个的"唯一触发情形"
说不清。用户拿到的后果是：看到 `STATION_STORAGE_UNAVAILABLE` 时不知道该去查存储
还是查配置；看到 `STATION_UNKNOWN_CHILD` 时分不清"这个孩子不归我管"和
"这个孩子归我管但台账里没有"。

v0.4 的判据（也是 `tests/unit/error-codes.test.js` 的断言）：

> **每一个码都必须有一个"只有它会触发"的情形，以及一个"看起来像但不是它"的反例。**

说不清的码就删掉——不是重命名，是删除。理由：一个码如果能被另一个码完整覆盖，
它存在的唯一效果就是让用户多猜一次。

## 三个消费点（同一份文案）

所有拒绝文案都从 `describeRefusal()` 出来，三个消费点共用：

| 消费点 | 位置 | 渲染要求 |
| --- | --- | --- |
| 全局入口守卫 | `entry-governor.js` → `ctx.tools.guard()` | **单行**，且自带错误码 |
| `dispatch_agent` 的 catch | `index.js` | 多行，含 `说明` 与 `修复` |
| `station_status` 的 dry-run | `index.js` → `renderDryRunRefusal()` | 多行，`决定：拒绝` / `决定：无法判定` 二选一 |

**守卫那一条为什么必须单行且自带码**：宿主把 guard 的返回值渲染成
`Error: <reason>`，并**丢弃** `StationError.code`（C6）。所以码只能写在文本里——
否则用户在界面上根本看不到码，而我们的 `station_status` 却在按码分组统计。

## 归位表

### 判定类（有结论：不许）

| 码 | 唯一触发情形 | 反例（看起来像但不是它） |
| --- | --- | --- |
| `NOT_MANAGED_SESSION` | 受管模式开启，但调用者所在谱系不在 `managedSessionIds` 里 | 名单里有但谱系算错了（那是 `LINEAGE_UNKNOWN`） |
| `ROUTE_UNKNOWN` | 指定的 `routeId` 在**任何**路由表里都不存在 | 存在但不在该岗位的白名单里（那是 `ROUTE_NOT_ALLOWED`） |
| `ROUTE_NOT_ALLOWED` | `routeId` 存在，但不在该岗位允许集合内 | 岗位允许，但被全局/快照/官方收窄（那是 `ROUTE_NOT_EFFECTIVE`） |
| `ROUTE_NOT_EFFECTIVE` | 岗位允许该路由，但被全局集合、受管根快照或官方策略收窄到零 | 路由根本不存在（那是 `ROUTE_UNKNOWN`） |
| `ROLE_NOT_FOUND` | `roleId` 不在岗位表里 | 岗位存在但被 `enabled: false` 禁用（那是 `ROLE_DISABLED`） |
| `ROLE_DISABLED` | 岗位存在且被禁用 | 岗位不存在（那是 `ROLE_NOT_FOUND`） |
| `NESTED_DISPATCH_FORBIDDEN` | 子会话（delegationDepth ≥ 1）尝试再派孙级 | 子会话给父会话发消息（那是允许的） |
| `OFFICIAL_POLICY_CONFLICT` | 岗位路由与官方白名单**零交集** | 与本插件全局配置零交集（那是 `ROUTE_NOT_EFFECTIVE`） |
| `CONFIG_CONFLICT` | 配置内部自相矛盾（如 `mode: fixed` 却没有 `defaultRouteId`） | 配置与官方策略冲突（那是 `OFFICIAL_POLICY_CONFLICT`） |
| `COVERAGE_INCOMPLETE` | 严格覆盖模式开启，且存在**名字像派生入口**的目录外工具 | 目录读不到（那是 degraded，只告警不拒绝） |
| `BACKEND_INCAPABLE` | 子智能体后端不声明支持必要能力 | 后端存在但 `startActivation` 失败（那是 `START_FAILED`） |
| `TARGET_UNKNOWN` | 条件允许入口的目标 `agent_id` 无法解析（缺失 / 不在台账 / 不是直接父） | 目标存在但属于别的受管根（那是 `TARGET_FOREIGN`） |
| `TARGET_FOREIGN` | 目标属于**别的**受管根 | 目标压根不存在（那是 `TARGET_UNKNOWN`） |
| `UNMANAGED_CHILD` | 受管谱系内、但台账里没有登记的子会话发起请求 | 非受管谱系里的会话（那**不归 L3 管**，直接放行而不是拒绝） |
| `LINEAGE_MISMATCH` | 台账的 `rootSessionId` 与现算谱系不一致 | 谱系算不出来（那是 `LINEAGE_UNKNOWN`） |

### 输入缺失类（无结论：不知道，所以拒绝）

这一类的共同点：**判定没有完成**。它们不是"你不许派"，是"我还不知道"。
渲染时标签是 `决定：无法判定`，而不是 `决定：拒绝`。

| 码 | 唯一触发情形 | 反例 |
| --- | --- | --- |
| `POLICY_UNREADABLE` | 判定所依赖的输入（配置 / 入口目录 / 台账读取）抛错 | 输入读得出来但结论是拒绝（那是具体业务码） |
| `LINEAGE_UNKNOWN` | 谱系算不出来（父会话已不可达） | 谱系算得出来但与台账不一致（那是 `LINEAGE_MISMATCH`） |
| `LEDGER_UNAVAILABLE` | 台账域打不开或写入失败 | 配置问题（那是 `CONFIG_CONFLICT`） |

### 环境类（不是判定，是事故）

| 码 | 唯一触发情形 | 反例 |
| --- | --- | --- |
| `START_FAILED` | 宿主 `startActivation` 抛错 | 插件在派出**之前**就拒绝了（那不该走到这里） |
| `INTERNAL` | 插件内部抛出未归类的异常（`describeRefusal` 的归一化出口） | 任何有业务含义的失败——它们都有各自的码 |

## v0.4 新增的码

| 码 | 为什么非加不可 |
| --- | --- |
| `ROUTE_NOT_EFFECTIVE` | v0.3 把"路由不存在"、"岗位不允许"、"被上层收窄"三种情形都报成 `ROUTE_NOT_ALLOWED`。用户的修复动作完全不同：改 `routeId`、改岗位白名单、改全局/官方——给同一个码等于让他猜。 |
| `TARGET_UNKNOWN` | v0.4 开始治理 `send_message`（它不创建 agent，但能跨根投递）。目标无法解析时必须有自己的码，否则会退化成 `POLICY_UNREADABLE`，把"目标不对"说成"读不出来"。 |
| `TARGET_FOREIGN` | 跨根投递等于绕过那个根的授权。它与"目标不存在"的区别是**攻击性的**：前者说明有人在试。 |
| `UNMANAGED_CHILD` | 受管谱系内、但台账没登记。这是"绕过入口创建"的直接证据，必须与"不归我管"分开。 |
| `LINEAGE_MISMATCH` / `LINEAGE_UNKNOWN` | 谱系被改写过（resume / clear / 换父）时，插件不许猜哪个根才对。两个码对应两种截然不同的处置：前者要人工核对，后者是环境限制。 |
| `POLICY_UNREADABLE` | fail-closed 的统一出口。`describeRefusal` 需要它来把"读不出来"与"判定为拒绝"分开渲染。 |
| `INTERNAL` | `describeRefusal` 归一化非 `StationError` 时需要一个稳定的码。空串会让 `决定：无法判定（：…）` 渲染出一个没有码的括号。 |

## v0.4 删除的码

| 码 | 为什么删 |
| --- | --- |
| `UNKNOWN_CHILD` | 与新的 `UNMANAGED_CHILD` 是同一个事实的两个名字。v0.3 用它表示"子会话不在台账里"，而 v0.4 必须把这件事与"根本不归我管"分开（后者由 L3 的管辖区判定处理，**不抛码**）。同名二义正是 v0.3 删 `STORAGE_UNAVAILABLE` 时的同一个理由。 |

## 三个已删除的"空承诺"

v0.3 起就删掉了，这里留档说明为什么：

| 码 | 为什么它是空承诺 |
| --- | --- |
| `POLICY_DEVIATION` | 偏离**从不阻断**请求（它只是记录）。给一个不会导致失败的码，等于暗示用户"这个错误可以被处理"。 |
| `ROLE_NOT_CONFIGURED` | 被 `CONFIG_CONFLICT` / `ROLE_NOT_FOUND` 完全覆盖。 |
| `STORAGE_UNAVAILABLE` | 与 `LEDGER_UNAVAILABLE` 是同一事实的两个名字。 |
