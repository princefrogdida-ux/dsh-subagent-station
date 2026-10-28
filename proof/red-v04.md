# v0.4 红证（三档）

> 目的：证明**这些测试真的在测实现**，而不是在测"测试自己"。
>
> 做法：每次只破坏一处实现，保持其余代码是 v0.4 形态，跑全套，记录哪些测试变红。
> 三次实验之后代码已全部还原（末附验收）。
>
> 复现命令：`node --test --test-isolation=none "tests/unit/*.test.js"`
>
> 编号说明：方案 §9.4 定义的 **T59–T84** 在 `tests/unit/v04-plan-cases.test.js` 里，
> 编号与方案一致。我自己补的用例用 **V** 系列（`V1` = 方案里那个"回归锚点 T59"
> 的时序矩阵版本），分散在各主题文件里。这样"方案要求的那条"永远查得到。

## 基线

```
ℹ tests 187
ℹ pass  187
ℹ fail  0
```

---

## 红-1：移除全局守卫的实现（守卫挂上但永远放行）

**改动**（`lib/host/index.js`）：

```js
const dispose = ctx.tools.guard((exec) => {
  if (disposed) return undefined;
  return undefined;            // ← 原本是 governor.decideForCall(exec)
});
```

这样 `tools.guard` 仍然被调用、"安装：已加载"的自检仍然通过、`station_status`
仍然显示一切正常——**只是它不再拦任何东西**。这正是 v0.3 那类"看起来装了"的失败形态。

**结果：22 红 / 165 绿**

变红的测试（跨 6 个文件）：

| 文件 | 测试 | 它守的是什么 |
| --- | --- | --- |
| `register.test.js` | 受管根原生入口被拒 | 基本拦截能力 |
| `register.test.js` | 受管子会话连 `dispatch_agent` 一起拦 | 孙级禁令 |
| `register.test.js` | `blockedToolNames` 私有入口被拦 | 用户补充名单 |
| `register.test.js` | 卸载后 guard 撤销 | I7 单向 |
| `v03.test.js` | T45 加载前已存在的受管根立即受约束 | 冷启动 |
| `v03.test.js` | T48 身份变更后 `isChild` 刷新 | 身份现读 |
| `v03.test.js` | T54 目录外像派生入口在子会话被拦 | 词形判据 |
| `v03.test.js` | T57 卸载后治理解除 | I7 |
| `v04-timing.test.js` | V1 锚点 A3×B1 | **核心：配置晚到** |
| `v04-timing.test.js` | V2 3×2 时序矩阵 | 零窗口 |
| `v04-timing.test.js` | V4 撤销受管后立刻放行 | 反方向 |
| `v04-timing.test.js` | V5 卸载双向 | I7 双向 |
| `v04-plan-cases.test.js` | **T59** 从未派出过也要拦 | **发布判据第 1 条** |
| `v04-plan-cases.test.js` | **T60** 三个替代入口全拒 | 目录覆盖 |
| `v04-plan-cases.test.js` | T62 `run_code` 无 PTC 绕过 | 全局层 |
| `v04-plan-cases.test.js` | T70 `send_message` 陌生目标被拒 | 目标校验 |
| `v04-plan-cases.test.js` | T82 卸载后恢复 | 卸载干净 |
| `v04-plan-cases.test.js` | T83 摘掉 `sessions` 不误伤根 | 不越权 |
| `v04-falsifiability.test.js` | V29 / V30 判定计数 | 自证 |
| `v04-refusal-text.test.js` | V10 工具名可执行 | 文案 |
| `v04-refusal-text.test.js` | V19 不说"改用 dispatch_agent" | 非循环提示 |

**读法**：一条实现改动同时打红**六份测试文件**，其中包含 4 条 v0.3 遗留测试。
这说明新测试不是自我循环——它们和旧断言指向同一件事。

---

## 红-2：把「每次调用现算」换成「首次算完就缓存」

**改动**（`lib/host/entry-governor.js`）：

```js
const __red2Cache = new Map();          // createEntryGovernor 里
// …
let cls = __red2Cache.get(ownId);       // decideForCall 里
if (cls === undefined) {
  cls = classifyAgent(policy, agent, { sessions: readSessions?.() });
  __red2Cache.set(ownId, cls);
}
const { managed, rootSessionId, lineage } = cls;
```

**这就是 v0.3 的行为**：guard 挂载那一刻判定"这个 agent 受管吗"，之后不再重算。
其余一切（全局挂载、文案、计数、台账）都保持 v0.4 形态。

**结果：3 红 / 184 绿**

| 测试 | 为什么它必须红 |
| --- | --- |
| `v04-timing.test.js` **V1** | 配置写入后的**下一个**调用就必须被拦——这就是"零窗口" |
| `v04-timing.test.js` **V2** | `时序格 A=late B=before-load 必须被拦。六格里任何一格放行，都说明有一个时点让治理漏掉了。` |
| `v04-timing.test.js` **V4** | 撤销受管后必须立刻放行（缓存了"曾经受管"） |

**这一档最初的实现是有缺陷的，值得记下来。**

第一版 V2（当时叫 T59b）只在配置写入**之后**才第一次调用工具。那种写法下，
"挂载时点判定"也能通过——因为它第一次调用时读到的已经是新配置。六格全绿，
而 V1 红了。

差别只在于 V1 在写入配置**之前**先调了一次工具。于是 V2 被改成真正的用户动作序列：
**用 → 改配置 → 再用**。改完之后 V2 才变红。

> 教训：**一个只在"最终状态"上断言的矩阵，测不出过程中有没有窗口。**
> 矩阵的每一格都必须包含"改之前"的那一次观测。

**注意 3 条都集中在 `v04-timing.test.js`**：`v04-plan-cases.test.js` 的 T59 在红-2 下
**是绿的**——因为它在配置写入后只调用一次工具，恰好落在"缓存已经读到新配置"的位置。
这不是缺陷：T59 测的是"从未派出过也能拦"（v0.3 的挂载时机问题），V1/V2 测的是
"配置变了之后立刻重算"（v0.3 的快照问题）。**两个问题，两组用例。**
红证的价值在于它红在哪，而不是它红了几个。

---

## 红-3：移除渲染层的自证与表健康

**改动**（`lib/host/index.js`）：三处渲染分支改成永不进入。

```js
const stats = undefined;                              // ← 原本是 status.guardStats
if (false && status.ledgerMeta !== undefined) { … }    // 台账自证
if (false && status.ledgerTables !== undefined) { … } // 表健康
```

计数**仍然在算**（`stats.record()` 照常调用、`meta` 表照常写、`readTableHealth()`
照常探），只是不再显示。这测的是"渲染层是否真的接上了数据"。

**结果：5 红 / 182 绿**

| 测试 | 失败信息 |
| --- | --- |
| `v04-falsifiability.test.js` **V28** | 评估 0 次时必须**明说**这可能意味着守卫没挂上 |
| `v04-falsifiability.test.js` **V29** | 三次调用必须被计数——否则"已评估"是编的 |
| `v04-falsifiability.test.js` **V30** | 必须按错误码分组。只给总数，用户不知道"被拒的是哪一类" |
| `v04-falsifiability.test.js` **V32** | 崩溃痕迹必须被说出来 |
| `v04-plan-cases.test.js` **T75** | 表缺失必须在状态里可见 |

**读法**：V31（`meta` 表真有数据）和 T74（零偏离时计数器为 0）在红-3 下**仍然是绿的**
——因为它们直接读存储，不经过渲染。这正好说明两件事被分开测了：
**数据层**（V31/T74）与**显示层**（V28/V29/V30/V32/T75）。
如果渲染是唯一被测的东西，数据层坏了就没人管；反之亦然。

---

## 三档的分工（为什么不能只做一档）

| 档 | 能抓住的错 | 抓不住的错 |
| --- | --- | --- |
| 红-1 | 实现被删/被短路 | 实现在、但判定时机错了 |
| 红-2 | 判定时机错了（缓存、挂载时快照） | 判定对了、但结果没显示给用户 |
| 红-3 | 结果没显示 / 显示了假数字 | 判定与显示都对了、但拦不住 |

三档各覆盖一层，合起来才覆盖"从决定到用户看见"的整条链路。

---

## 还原后的验收

```
ℹ tests 187
ℹ pass  187
ℹ fail  0
```

三次实验期间的改动已全部还原，逐个核对过三处还原点：

1. `index.js` 的 `ctx.tools.guard` 回调恢复为 `return governor.decideForCall(exec);`
2. `entry-governor.js` 的 `__red2Cache` 两处（声明与使用）都已删除，
   `decideForCall` 恢复为每次调用 `classifyAgent(...)`
3. `index.js` 的三个渲染分支恢复为 `status.guardStats` / `status.ledgerMeta` / `status.ledgerTables`

（本仓不是 git 仓库，所以以"末次全绿 + 逐点核对"为准。）
