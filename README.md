# 子智能体派出所（dsh-subagent-station）

为 DeepSeek Harness 的子智能体派出增加**岗位级模型策略**：主智能体决定派什么任务，用户决定允许怎样派出，插件负责执行规则。

> v0.4 目标：把"治理"从**挂载时点的一次性决定**改成**每次调用的现算**。
> v0.3 留下了一个致命时点：guard 在某个会话第一次成功派出之后才挂上，
> 所以"刚装好、还没派过"这个状态下原生入口完全自由。
> 详见 [`docs/known-limits.md`](docs/known-limits.md)、[`docs/errors.md`](docs/errors.md)、
> [`docs/escape-hatches.md`](docs/escape-hatches.md) 与
> [`TEST-PLAN-v0.4.md`](TEST-PLAN-v0.4.md)。

## 版本变更

### v0.4（当前）

**架构变更（这是本版的主体）**

v0.3 把两层防线（入口守卫、请求锁定）都**逐会话挂载**：某个会话被判定受管时，
才在它的 ctx 上挂 guard。于是治理是否生效取决于"挂载那一刻发生过什么"。

v0.4 改成**插件加载时挂一次，每次调用现算**：

| 层 | v0.3 | v0.4 |
| --- | --- | --- |
| L2 入口守卫 | 逐会话挂 `tools.guard` | **加载时挂一次**（全局层），每次调用读当前配置判定 |
| L3 请求锁定 | 逐子会话挂 `agent/request` | **加载时挂一次**，每次请求从 `payload.agent` 现读身份 |
| L4 回执收尾 | 逐受管根挂 `subagent/end` | 不变（`subagent/end` 只在根的 ctx 上收得到） |

**行为变更（会被人感觉到的）**

1. **配置写入后的下一个调用立刻生效，零窗口。** 不再需要"先成功派一次"来激活治理。
   *观感差异*：把会话 id 加进 `managedSessionIds` 后，立刻调原生 `subagent` 就会被拦
   ——v0.3 在这个位置是放行的。

2. **`send_message` 在受管根上不再被拦。** 它不创建 agent（目录里
   `createsAgent: false`），与岗位模型策略无关。v0.3 把"deny-in-child"与
   "deny-managed"合流，于是排出去的子会话没法追加上下文。
   现在它按目标校验：台账内允许，跨根（`TARGET_FOREIGN`）与无法解析
   （`TARGET_UNKNOWN`）拒绝。

3. **派出前先登记子会话**（预置 `childId`）。`startActivation` 被调用时台账里
   已经有这条孩子——TOCTOU 窗口消失。后端不支持预置 id 时退回旧路径，
   并在回执里标 `保证等级：降级（配置）`。

4. **错误码按"唯一触发情形"归位。** 新增 `ROUTE_NOT_EFFECTIVE`、
   `TARGET_UNKNOWN`、`TARGET_FOREIGN`、`UNMANAGED_CHILD`、`LINEAGE_MISMATCH`、
   `LINEAGE_UNKNOWN`、`POLICY_UNREADABLE`、`INTERNAL`；**删除 `UNKNOWN_CHILD`**
   （与 `UNMANAGED_CHILD` 是同一事实的两个名字）。完整表见
   [`docs/errors.md`](docs/errors.md)。

5. **`station_status` 可以说"我不知道"。** 诊断工具自己失败时不再抛错，
   而是输出 `决定：无法判定（STATION_…）` + 说明 + 修复建议。
   dry-run 遇已禁用岗位也不再报错，而是 `决定：拒绝（STATION_ROLE_DISABLED…）`。

6. **状态新增自证与保证等级。** `已评估 N 次`、`首次评估 <时刻>`、
   `拒绝 N 次（按码分组）`、`台账已打开 N 次 / 上次是否正常关闭`、
   `表：receipts ✓ / … / deviations ✗`。这些数字**只有真的跑过才会有**——
   回答"你怎么证明自己在工作"。

7. **回执区分三种快照漂移**：`与当前一致` / `N 条新增未生效（列表）` /
   `配置已收窄（列表）`。不再把一个哈希和一个代数放在一起比较。

**修复（可核对，见 [`TEST-REPORT.md`](TEST-REPORT.md) 的红→绿对照）**

| 编号 | 问题 | 后果 |
| --- | --- | --- |
| G1 | 派出时没下发 `agentOptions` | 首轮用的是父会话模型 |
| G2 | 只治理新会话；谱系只看一层 | 装了像没装；`maxDepth: 2` 的孙级被判未受管 |
| G3 | guard 的 `isChild` 冻结在闭包；身份变化不重挂 | 恢复后变成子会话的 agent 仍按根处理，能派孙级 |
| G4 | `observed` 从不写入；回执没有终态 | 无法区分「压回过」与「从没成功过」 |
| G5 | 空快照不自愈；没有重建入口 | 首次派出时路由表为空 ⇒ 该根**永远**派不出 |
| G6 | 目录外入口默认放行；诊断只看全局 | 改名的派生入口既不拦也不报；scoped 注册看不见 |

**错误码表缩了 3 个**：`STATION_POLICY_DEVIATION`、`STATION_ROLE_NOT_CONFIGURED`、
`STATION_STORAGE_UNAVAILABLE` 从未被抛出，已删除。现在每个码都有 `throw` 点，
由 `tests/unit/error-codes.test.js` 守着。

### v0.2

把「派出时校验一次」升级为「每一轮模型请求都被锁定」，并让回执、快照、偏离跨重启可查。

## 它解决什么

使用子智能体时，用户希望控制每次派出**实际使用的模型**，而不是仅靠提示词要求主智能体自觉遵守：

- 不同类型的任务使用不同模型，不随手继承主智能体路由；
- 用户限制供应商与模型的**精确组合**，避免意外费用或数据流向变化；
- 遗漏参数、选择其他派出入口都不能绕开规则；
- 每次派出都有可核对的回执：申请了什么、采用了什么、为什么。

## 两种岗位模式

| 模式 | 行为 |
| --- | --- |
| **固定（fixed）** | 只使用岗位指定的路由。不提供覆盖时用默认值；显式选择同一路由可接受；选择**不同**路由直接报错，绝不静默改回默认值。 |
| **白名单（allowlist）** | 可在岗位允许集合内选择。未选择时用岗位默认值。 |

**有效授权集合** = 岗位允许集合 ∩ 插件全局允许集合 ∩ 受管会话快照 ∩ **官方「子智能体模型选择」策略**。

关键规则：

- 未指定路由时**一律使用岗位默认值**，从不隐式继承父会话模型。
- 授权按完整 `provider/model` 组合判定；**同名模型来自未授权供应商同样会被拒绝**（不按模型名匹配）。
- 思考强度按**路由**分别校验；切换路由不会携带另一个模型专属的强度。
- 禁用岗位只禁止新派出，不会中断已在运行的任务。
- 任何非法请求都在**调用原生启动之前**被拒绝——不会先创建子智能体再补救。
- 与官方策略没有交集时报 `STATION_OFFICIAL_POLICY_CONFLICT`，**不代为扩大官方白名单**。

## 两条实际防线

| 层 | 机制 | 拦什么 |
| --- | --- | --- |
| **入口治理** | `tools.guard()`（**v0.4：插件加载时挂一次，全局层**） | 受管根：原生派出入口（`subagent` / `subagent_fork` / `workflow` / `spawn_teammate`）被拒；受管子会话：连 `dispatch_agent` 一起拒（孙级禁令）；`send_message` 按目标校验 |
| **请求锁定** | `agent/request` 监听器（**v0.4：全局挂载，每次请求现读身份**，每轮都跑） | 把子会话的 `provider`/`model` 压回台账批准值；偏离留痕（分 `error` / `notice`） |

`interrupt_agent` 与 `dispatch_roles` 永不拦截——防绕过不能牺牲停止与发现能力。

**判定时机是这一版的核心**：两层都在插件加载时挂一次，**每次调用/请求现算**。
不存在"这个会话被判定受管之后才装上"的时点，因此也不存在"刚装好、还没派过"
那个自由窗口。

> **v0.1 方案里的 L1（`maxDepth: 0` 做运行时深度封顶）已删除**：实测证明它做不到。
> 详见 [`docs/known-limits.md`](docs/known-limits.md) 第二节。
>
> **v0.4 起 L1 改由 L3 承担**：`agent/created` 里抛错拦不住创建（S3），所以不做
> 创建门。真正拦住"绕过入口创建"的是第一轮请求——以
> `STATION_UNMANAGED_CHILD` 拒绝。代价是那个会话已经存在（占资源、出现在列表里），
> 但它**用不了任何模型**。详见 `docs/known-limits.md` §3.14。

## 模型面对的工具

### `dispatch_roles`

返回当前会话可用岗位、用途、模式与可选择的路由标识。岗位详情按需读取，不塞进系统提示词。
只读：不派出、不写回执。支持传 `roleId` 只看一个岗位（更省 token）。

### `dispatch_agent`

| 参数 | 说明 |
| --- | --- |
| `roleId` | 岗位标识（必填） |
| `description` | 简短任务标题（必填），作为子会话标签 |
| `prompt` | 自包含的任务说明（必填） |
| `routeId` | 可选；白名单岗位用来选择，固定岗位只接受其默认路由 |
| `reasoningEffort` | 可选；必须被所选路由支持 |

返回**回执文本**：回执 ID、子会话 ID、岗位与模式、最终路由及其依据、思考强度、策略修订号、
官方策略状态、覆盖诊断、当前状态。**不返回执行 Promise，不等待最终答案**；完成通知由 DSH 原生机制负责。

回执状态如实：派出后写「已受理，等待首个模型请求确认」——请求级锁定要等首轮请求才被证实，
**不会**提前写「已锁定」。宿主没返回 `childId` 时标「待核对」，不猜造 id。

### `station_status`

**v0.3 新增**。回答「现在到底在强制什么」，不需要读源码：

```text
派出所状态
- 安装：已加载（entry dsh-subagent-station）
- 本会话：root-1（受管｜根会话｜谱系 full）
- 受管根：1 个（root-1）
- 存活会话：3 个，其中受管 2 个；未受管 1 个：free-1
- 谱系解析：full
- 策略：2 条路由 / 2 个岗位（0 个禁用、0 个冲突）
- 覆盖诊断的目录外策略：block-delegation-like
- 快照代数：0
- 官方模型策略：未启用
- 台账：正常（回执 1 / 子会话 1 / 偏离 0）
- 覆盖（全局）：unrecognized（可见 3 个工具；目录外且像派生入口 0；目录外其它 1）
- 最近偏离：无
- 上次扫描：2026/10/24 22:13:26
```

未受管会话调用它时，会拿到**自己的会话 id** 与两种纳入方式（`managedSessionIds`
或 `manageAllNewRoots`）——这是「装了但没生效」时唯一能自助排障的地方。

传 `roleId` 可 dry-run 一个岗位：能不能派、会选哪条路由、求交后还剩几条。

> **排障第一步**：如果 `dispatch_roles` 都不在工具列表里，先确认 profile 的
> `dsh.profile.bundles` 里有 `dsh-subagent-station`。
> `package.json` 里有 `dependencies` 条目 ≠ 已加载。
> v0.2 就是在这一点上产生过「以为装了其实没装」的误判。

## 配置

在 DSH 的 **插件 → dsh-subagent-station → 配置** 中填写。段名即 Loader 条目 id：

```yaml
- id: dsh-subagent-station
  name: dsh-subagent-station
  config:
    managedSessionIds: []      # 显式启用的受管根会话；为空时 requireManagedSession 会拦住所有会话
    requireManagedSession: true
    forbidNestedDispatch: true      # 禁止受管子智能体再派出下一层
    blockNativeDelegation: true     # 禁止受管根会话直调原生派出入口
    strictCoverage: false           # true：发现目录外派生工具就拒绝派出
    blockedToolNames: []            # 补充要拦的私有派生入口名
    providerName: spawn             # 子智能体后端名
    receiptLimit: 50
    unknownEntryPolicy: block-delegation-like   # v0.3：目录外入口默认怎么处理
    snapshotEpoch: 0                            # v0.3：改动它 ⇒ 按当前集合重建所有快照
    manageAllNewRoots: false                    # v0.3：true ⇒ 新的根会话自动受管
    allowedRoutes:
      - routeId: cheap-fast
        provider: your-provider
        model: your-cheap-model
        efforts: [low, medium]
        defaultEffort: low
      - routeId: strong
        provider: your-provider
        model: your-strong-model
        efforts: [high]
        defaultEffort: high
    roles:
      - roleId: scout
        label: 侦察员
        description: 只做信息收集与初筛，不做修改
        enabled: true
        mode: allowlist
        defaultRouteId: cheap-fast
        allowedRouteIds: [cheap-fast]
      - roleId: reviewer
        label: 审查员
        description: 审查代码与方案，给出结论
        enabled: true
        mode: fixed
        defaultRouteId: strong
```

**不预置任何真实付费模型**：上面的 `your-provider` / `your-model` 是占位符，必须由用户替换。未完成配置前不允许派出。

### 启用步骤

1. 在 `allowedRoutes` 里填至少一条真实可用的 `provider`/`model`。
2. 在 `roles` 里配至少一个岗位，指向上面某条路由。
3. 把要接管的**根会话 ID** 填进 `managedSessionIds`，或把 `manageAllNewRoots`
   设为 `true`（新的根会话自动受管）。
   **不知道自己的会话 id？** 直接问模型「调用 `station_status`」——未受管时它会
   把 id 与两种纳入方式一起告诉你。
4. 首次派出时插件会为该根会话**冻结策略快照**：之后放宽配置不会隐式生效，
   收紧配置会立即生效。
5. 要让「放宽」生效有两个出口（v0.3）：
   - 快照是**空集**时自动自愈（空集不是「授权为零」，而是「没授权过」）；
   - 把 `snapshotEpoch` 加 1 —— 这是唯一会按当前集合重建所有快照的入口。

## 安装

```sh
dsh plugin --profile desktop add <本目录路径>
```

安装需要用户批准。请根据安装返回的 `application`、warnings 与 nextStep 判断是否生效，而不是只看命令退出码。

## 数据落盘

回执、受管根快照、子会话登记、路由偏离写入 `storageDomain` 的 `station_dispatch_ledger` 域
（`per-record` 布局，`json` 后端，落在 `dshHomePath('storages')` 下）。

**台账写不进就不派出**：这是刻意的——「派了但没记」比「没派」更难收拾。

## 兼容性

针对 **DSH 0.2.1-rc.2** 开发与核实（Node 24）。宿主 peer 声明为 `>=0.2.0-rc.1 <0.3.0-0`。

**只支持带 `startActivation` 的宿主**（0.2.1 线）。0.2.0 的 `start(name, request)` 降级路径已删除：
那条路径不支持预留 `childId`、也没有 `delivery`，走它会得到与 v0.2 状态机不一致的行为。

依赖 `zod`（域 schema 需要 `ZodType`，不能靠传递可用）。

## 不作出的保证

本节与 [`docs/known-limits.md`](docs/known-limits.md) 必须一致；冲突时以该文档为准。

插件不防御用户主动通过终端调用外部 API，不监管第三方插件内部的私有执行路径，
不证明供应商内部真实路由，也不在被禁用或卸载后继续施加限制。**中断是取消信号，不等于已停止。**

更具体地说，本插件**不**保证：

1. **子会话里绝对无法用别的模型**——只保证插件把配置压回台账值。上游适配器的二次改写、
   绕过 `agent/request` 的调用路径、适配器忽略字段，都不在覆盖内。
2. **覆盖是完备的**——目录是随包快照会过期；一个叫 `orchestrate_pipeline` 的派生工具
   会出现在 `unrecognized` 清单里（看得见），但在默认策略下不会被拦（名字不像）。
   取舍与逃生阀见 `docs/known-limits.md` §3.2.1；工具层可见 ≠ 服务层可调用。
3. **跨进程并发安全**——`json` 后端没有跨进程锁。
4. **重启后自动恢复现场**——未完结回执标 `unverified`，**不自动重派**。
5. **孙级禁令是运行时安全边界**——它是 `tools.guard()` 的工具层拒绝，
   第三方插件直调 `subagents.startActivation` 拦不住。
6. **有可视面板**——v0.1 的空卡片已删除。诊断由 `dispatch_roles`、
   `station_status` 与 `ctx.get('subagentStation').snapshot()` 提供。
7. **插件热装后一定看得见既有会话**（v0.3 新增的边界）——v0.3 的启动扫描依赖
   `agents.list()`。**v0.4 起这一条不再关键**：两层防线都是全局挂载的，
   看不见既有会话也照样拦。`agents.list()` 现在只用于 L4（`subagent/end` 的
   逐根终态监听）与"未受管会话"的诊断清单。

8. **运行时路由无法核对**（v0.4 新增的边界）——子会话的会话头里**没有**
   provider/model 字段。所以插件只能核对"我们决定用什么"，不能核对
   "实际用了什么"。状态里对运行时的表述是 `无法核对（宿主未在会话头记录实际路由）`，
   **永远不会**写成 `一致`。

另外，以下情况会**拒绝而不是降级放行**（用户会看到报错，这是设计取舍）：
受管谱系内的子会话不在台账里（`STATION_UNMANAGED_CHILD`）、
台账不可用（`STATION_LEDGER_UNAVAILABLE`）、
后端不支持 `agentOptions` 或未注册（`STATION_BACKEND_INCAPABLE`）、
严格模式下的目录外入口（`STATION_COVERAGE_INCOMPLETE`）、
谱系与台账不一致或算不出来（`STATION_LINEAGE_MISMATCH` / `STATION_LINEAGE_UNKNOWN`）、
跨根投递（`STATION_TARGET_FOREIGN`）。

完整错误码归位表见 [`docs/errors.md`](docs/errors.md)；
被拦住之后还能走哪条路见 [`docs/escape-hatches.md`](docs/escape-hatches.md)。

一个「出问题时悄悄放行」的策略插件，比没有插件更危险——它给出的是虚假的安全感。

## 开发

```
subagent-dispatch-station/
  lib/host/      宿主策略层：Config、派出工具、全局入口守卫、全局请求锁定、台账、覆盖诊断
  lib/shared/    纯策略内核（无 UI、无运行时依赖，可独立测试）：
                 policy.js（码表与路由求交）、refusal.js（拒绝文案）、
                 coverage.js（目录三态）、assurance.js（保证等级）
  docs/          契约证据、已知限制、错误码归位表、逃生路径、v0.4 spike 报告
  scripts/       报告生成（report.mjs）、红方证据（make-red-proof.mjs）、v0.4 spike（spikes-v04.mjs）
  proof/         红方证据存档（red-v02.txt 由脚本生成；red-v04.md 手写并附复现命令）
  tests/unit/    单元、集成与验收测试（**187 项**，node --test）
  locale/        中英文元数据
```

```sh
node --test --test-isolation=none "tests/unit/*.test.js"
node scripts/spikes-v04.mjs       # P0 的 S1–S6 宿主契约复核
node scripts/make-red-proof.mjs   # 生成 proof/red-v02.txt（红方证据）
node scripts/report.mjs           # 生成 TEST-REPORT.md
```

**测试编号约定**：方案 §9.4 定义的 **T59–T84** 在 `tests/unit/v04-plan-cases.test.js`，
编号与方案逐条一致；本版补充用例用 **V** 系列，分散在各主题文件。
理由见 [`TEST-PLAN-v0.4.md`](TEST-PLAN-v0.4.md) 第一节——若把补充用例也编成 T59、T60……，
"方案要求的 T60 是哪个"就再也查不清了。

`--test-isolation=none` 不是性能选择：默认隔离下 Node 需要子进程用管道捕获 stdio，
而在受限沙箱里这会 `spawn EPERM`。关掉隔离后测试在当前进程内运行。

**为什么有两个脚本**：v0.2 的 `TEST-REPORT.md` 是手写的，数字无法核验；而 v0.2 的
97 项全绿时主派出路径其实是坏的。v0.3 因此要求报告**可由第三方用一条命令重现**，
且每条修复都要有一条**在退回 v0.2 形态后会变红**的测试。`make-red-proof.mjs` 会
逐条退回并检查「应当变红」的清单是否真的变红——若某项仍然绿，它以非零退出并点名，
这就是「假绿」检查。

测试分五类：

- `policy` / `dispatch` / `starter`：纯决策（不含 I/O）。
- `register` / `legacy-registration`：用**真实** `ToolRuntime` 证明 `defineTool` 的必要性
  （含 v0.1 两种静默错误的对照）。
- `request-lock` / `request-lock-e2e` / `ledger`：请求锁定与台账，含「不串路由」回归。
- `acceptance` / `governor`：方案第 11 节 T 编号判据的自动化部分。
- `v03` / `error-codes`：v0.3 矩阵 T42–T58 与错误码表审计。

契约与源码依据见 [`docs/contract-evidence.md`](docs/contract-evidence.md)（每条带行号）。

## License

MIT
