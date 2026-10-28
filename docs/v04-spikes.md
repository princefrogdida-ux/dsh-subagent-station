# v0.4 阶段 0：契约验证（spike 结论）

- 核实日期：2026-10-25
- 核实对象：本机 `@deepseek-ai/dsh-*` 0.2.1-rc.2（源码见 `.host-src/`）
- 复现命令：`node scripts/spikes-v04.mjs`（退出码 0 = 全部"必须成立"的假设成立）
- 方案依据：`子智能体派出所-v0.4开发方案.md` §4 S1–S5

> 本文只记录**跑过**的结论。凡"源码已给定论"的，S1/S2 仍跑了冒烟——
> 理由不是不确信，而是留一份可复核的记录：宿主升级后重跑一次就知道语义有没有变。

## 结论速览

| spike | 问题 | 结论 | 对 v0.4 的影响 |
| --- | --- | --- | --- |
| **S1** | `guard()` 的层级归属与能力 | **全部成立** | L2 可以挂在插件根 `ctx` 上，一个 guard 覆盖全部会话 |
| **S2** | 无作用域 `agent/request` 能否收到子会话请求 | **成立** | L3 可以全局化，不必逐子挂载（v0.3 的挂载窗口消失） |
| **S3** | `agent/created` 里抛错能否阻断创建 | **可感知，但 v0.4 不依赖** | 不在 `agent/created` 里抛错；L1 创建闸不做 |
| **S4** | 子会话首轮实际路由能否读到 | **读不到** | 状态核对只能核对台账侧，运行时路由如实印"无法核对" |
| **S5** | 预置 `childId` 是否可行 | **可行（默认后端）** | TOCTOU 从根上消失，**不需要** `pendingGrants` |
| **S6** | 全局 guard 性能 | 额外开销 ≈ 0.002µs/次 | 名字预筛是必须的（见下） |

**总结论：v0.4 的地基成立，六项全部通过，按方案继续开发。**
两个"未成立"标记（`S3-b`、`S4-b`）不是失败，是**否定式结论**——它们回答的是
"要不要依赖某机制"，答案是"不要"，因此不影响任何一条验收判据。

---

## S1 — `guard()` 的层级归属与能力

方案 §3 C1–C5 已给定论；本次跑冒烟确认当前安装的行为与之**完全一致**。

| 编号 | 断言 | 观测 | 结论 |
| --- | --- | --- | --- |
| S1-a | 普通 ctx 上的 guard 对全部 agent 与无 agent 调用都生效 | 命中 3 次：`a`、`b`、`(no-agent)` | **成立** |
| S1-b | guard 返回字符串即拒绝，且另一个"放行" guard 无法翻案 | A 被拒（`Error: S1-deny-a`），B 放行 | **成立** |
| S1-c | `agent.ctx` 上的 guard 只作用于该 agent | 只命中 `a` 一次 | **成立**（v0.3 的用法，v0.4 不再依赖） |
| S1-d | guard 拿到完整 `exec.arguments` | `{"agent_id":"child-9","message":"hi"}` | **成立** |
| S1-e | 撤销 disposer 后 guard 立即失效 | 撤销前拒绝、撤销后放行 | **成立** |

**影响**：

1. **L2 改成挂在插件根 `ctx` 上**，一个 guard 覆盖所有会话（含尚未出现的会话）——这就是问题 1 的修法。挂载时刻不再是治理时刻。
2. `S1-d` 让 §5.3 的 `send_message` 目标校验可实现：不必再依赖任何辅助状态，直接读 `exec.arguments.agent_id`。
3. `S1-b` 的单调性说明 guard **不能互相覆盖**：一旦拒绝就是最终答案。因此 v0.4 只需要一个 guard，不必担心与别人的 guard 打架。
4. `S1-e` 说明卸载路径干净（I7）：`ctx.tools.guard()` 返回的 disposer 必须被卸载逻辑调用，否则拒绝会永久残留。

> **一处必须记住的细节（C6）**：guard 返回的拒绝被宿主渲染成 `Error: <reason>`，
> **`StationError.code` 不会被保留**。所以拒绝文案里必须自带错误码，否则用户看到的就是一句纯自然语言。
> v0.4 的做法：`describeRefusal()` 统一拼出 `派出所[STATION_TARGET_UNKNOWN]：…` 的形式。

---

## S2 — 无作用域 `agent/request` 监听器

| 编号 | 断言 | 观测 | 结论 |
| --- | --- | --- | --- |
| S2-a | 无作用域监听器收到**全部** agent 的请求 | `["global:a","global:b"]` | **成立** |
| S2-b | `agent.ctx` 上的监听器只收到自己的请求 | scopedA 是否收到 b：`false` | **成立**（作用域隔离存在） |

**影响**：L3 谱系锁定可以改成全局监听器，`payload.agent.session.id` 每次现算。
v0.3 的"台账就绪后补扫一次、给既有子会话挂锁定"（`index.js:848-857` 的 `pendingSweeps`）**整段可以删除**：
不存在"还没挂上锁定的子会话"这种状态了。

**但必须自校验**：全局监听器不分来源，所以它**不能**用闭包里的 `agent` 判断身份，
必须一律用 `payload.agent`。v0.3 的 `request-lock.js` 是按 agent 闭包挂的，
改全局时这一处是唯一的真实风险点——写入 `docs/known-limits.md`，并用测试 T63 钉住。

---

## S3 — `agent/created` 里抛错的可感知性

| 编号 | 断言 | 观测 | 结论 |
| --- | --- | --- | --- |
| S3-a | serial 监听器抛错会让 `await ctx.serial(...)` 拒绝 | 正常会话不抛，被拦会话抛 | **成立** |
| S3-b | v0.4 是否需要靠它阻断创建 | —— | **不需要** |

**影响**：v0.4 **不**在 `agent/created` 里抛错（v0.3 已用 try/catch 包着，保持）。

- 拒绝发生在**工具调用**层（L2 全局 guard），早于 `startActivation`，满足 I3。
- `agent/created` 在 v0.4 里只剩两件事：登记 L3 所需的谱系旁证、挂 L4 的终态监听。
- 因此"抛错能否回滚创建"这个未决问题**不影响任何一条验收判据**。

> 这一条是本方案里唯一"可以不知道"的问题。它的价值在于**明确写下不知道也没关系**，
> 免得后来的人以为漏测了。

---

## S4 — 子会话首轮实际路由能否读到

| 编号 | 断言 | 观测 | 结论 |
| --- | --- | --- | --- |
| S4-a | 会话头里**没有** `provider`/`model` | header 键集合 = `["parentSession","delegationDepth","origin"]` | **成立**（确认"读不到"） |
| S4-b | 状态核对只能说台账侧 | —— | **如实降级** |

对应源码 `.host-src/dsh-subagent.js:346-354` 的 `childSessionMeta()`：
会话头只有 `parentSession` / `delegationDepth` / `origin`（外加 `agentPreset` 时另说），
**路由被写进 `subagent/descriptor` 事件与 `activation`，不在会话头上**。

**影响**：`station_status` 的"核对"三态里，**"一致"必须标为"无法核对"**，不能假装判出来了。

具体表达（§6.4 的落地）：

```
- 核对：无法核对（宿主未在会话头记录实际路由；台账声明 vendorA/pro-model）
```

**绝不允许**写成"核对：一致"——那是把自己的声明当成证据。
台账侧能核对的只有一致性（回执声明 vs `children` 登记 vs 受管根快照），
那部分照实说，并明确标注它比对的是**台账内部**，不是运行时实况。

---

## S5 — 预置 `childId`

方案 §4 S5 把这条列为"关键"：它决定 TOCTOU 是**从根上消失**还是要靠 `pendingGrants` 兜。

端到端复现需要一台完整宿主（`agents` / `sessions` / `sessionPersistence` / `tools` / `systemPrompt` 全在场），
那已经超出"5 分钟 spike"的范围。因此本 spike 改为对 `.host-src/` 做**行级断言**：
脚本读那几行源码，断言 v0.4 依赖的五条事实仍然成立。宿主升级后重跑，任何一条变化都会立刻变红。

| 编号 | 断言 | 依据 | 结论 |
| --- | --- | --- | --- |
| S5-a | 传 `childId` 但后端无 `prepareContinuable` ⇒ `UNSUPPORTED_CAPABILITY` | `dsh-subagent.js:3038` | **成立**（需要降级路径） |
| S5-b | `childId` 被原样采用：`spec.childId ?? brandString(randomUUID())` | `dsh-subagent.js:1397` | **成立** |
| S5-c | `assertChildIdAvailable` 只查重、不校验格式 | `dsh-subagent.js:1597` | **成立**（自造 UUID 合法） |
| S5-d | 预置 id 会额外查持久化残留 ⇒ `DUPLICATE_CHILD` | `dsh-subagent.js:1431-1436` | **成立** |
| S5-e | 默认 `spawn` 后端实现 `prepareContinuable` | `dsh-subagent-spawn.js:31-33` | **成立** |

**影响（这是 v0.4 最省事的一处收益）**：

```
v0.3（有窗口）:  先记账(receipt) → startActivation → 拿到 childId → 写 children → 更新回执
                                  └─ 这一瞬间子会话已在跑，但 children 里还没有它 ─┘

v0.4（无窗口）:  childSessionId = randomUUID() → 写 receipt + children（全部带 id）
                → startActivation({ childId }) → 子会话诞生时台账已完整
```

**TOCTOU 从根上消失**，方案 §8.2 的 `pendingGrants`（延迟许可 + 超时）**不需要实现**。
这比"在途许可"干净得多：没有任何"暂时放行"的状态，fail-closed 因此没有任何例外。

**降级路径**（必须实现，不许静默）：

| 情形 | 行为 | 保证等级 |
| --- | --- | --- |
| 后端支持 `prepareContinuable` | 预置 id，先记账再派出 | **完整** |
| 后端不支持 | 不传 `childId`，退回"派出后立刻登记" | **降级（配置）**，回执与状态都明说 |

另外 `S5-d` 揭示一个真实的坑：**崩溃残留的同名会话会让预置 id 撞 `DUPLICATE_CHILD`**。
用 `randomUUID()` 时概率为零，但**绝不能用可预测的 id**（如 `child-${counter}`）——
那会在重启后必然撞车。这一点写进 `docs/known-limits.md` 并在 dispatch 里加注释。

---

## S6 — 全局 guard 的性能预算

| 编号 | 断言 | 观测 | 结论 |
| --- | --- | --- | --- |
| S6-a | 名字预筛把额外开销控制在 1µs 以内 | 基线 0.061 → 带 guard 0.062 µs/次（+0.002µs，2.9%） | **成立** |
| S6-b | 预筛把普通工具名全部挡在冷路径 | 热 0 / 冷 3000 | **成立** |

**影响**：

- 方案 §2.3 的"< 2µs，零服务访问"对非候选名是可达的，**前提是热路径上不跑正则、不查服务**。
- 实现要求（写进代码注释）：
  1. **候选名集合预编译成 `Set`**，含目录全部名字 + 正则命中的名字；工具名集合变化时重建。
  2. `Set.has(name)` 未命中 ⇒ 立即 `return undefined`，**不读配置、不读目录、不算谱系**。
  3. 命中也只做一次记忆化策略读（按 `policyRevision` 失效），不做深比较。

> 性能断言的写法：本 spike 用的是 3000 次 `prepareScheduledExecution` 的实测均值。
> 它证明的是**量级**（0.06µs vs 2µs 预算，余量 30 倍），不是精确值——
> 所以结论写"可达"，测试里不断言绝对时间（那会在慢机器上假红）。
