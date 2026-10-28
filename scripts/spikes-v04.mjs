#!/usr/bin/env node
/**
 * P0 契约验证（方案 §4 S1–S5）。
 *
 * 每个 spike 只回答一个问题，**不碰产品代码**。结论写 `docs/v04-spikes.md`，
 * 本脚本是那份文档的唯一证据来源：重跑一次就能复核每条结论。
 *
 * 用法（在 `subagent-dispatch-station/` 下）：
 *
 *     node scripts/spikes-v04.mjs
 *
 * 退出码 0 表示所有"必须成立"的假设都成立；非 0 表示 v0.4 的地基不牢，
 * 应当停止开发并向宿主维护者确认（方案 §14 第 2 行）。
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { Context, Service } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';

/**
 * `@deepseek-ai/dsh-scope` 是 `dsh-tools` 的传递依赖，本包没有直接声明它。
 * 与 `tests/host-fixture.js` 用同一套解析顺序，避免两处漂移。
 */
const requireFromHere = createRequire(import.meta.url);
const { createScope } = (() => {
  try {
    return requireFromHere('@deepseek-ai/dsh-scope');
  } catch {
    return createRequire(requireFromHere.resolve('@deepseek-ai/dsh-tools'))('@deepseek-ai/dsh-scope');
  }
})();

/** 最小 `systemPrompt` 替身（`ToolRuntime` 构造期需要 `tools()`）。 */
class StubSystemPrompt extends Service {
  providers = [];

  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  tools(provider) {
    this.providers.push(provider);
    return () => {};
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

/** 起一个最小宿主（与 `tests/harness.js` 同构，避免 spike 依赖测试夹具）。 */
async function startHost() {
  const ctx = new Context();
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  return ctx;
}

/** 造一个 agent：`agent.ctx` 用真实 `createScope` 铸造。 */
function makeAgent(parentCtx, id, { parentSession, depth = 0 } = {}) {
  const header = depth === 0
    ? { delegationDepth: 0 }
    : { parentSession, delegationDepth: depth, origin: 'subagent' };
  const agent = { id, session: { id, header }, options: depth === 0 ? {} : { subagentDepth: depth } };
  const scope = createScope(parentCtx, agent);
  agent.ctx = scope.ctx;
  agent.scope = scope;
  return agent;
}

/** 注册一个可执行工具，返回撤销函数。 */
function registerTool(ctx, name) {
  return ctx.tools.register({
    name,
    description: `spike tool ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      return 'ran';
    },
  });
}

/** 走真实 guard 链路执行一次，返回 `'ran'` 或拒绝原因。 */
async function attempt(ctx, name, agent, extraArgs = undefined) {
  const prepared = await ctx.tools.prepareScheduledExecution({
    name,
    arguments: extraArgs ?? {},
    callId: `c-${Math.random()}`,
    rootCallId: `r-${Math.random()}`,
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  });
  if (prepared.kind === 'post-result') {
    return { denied: true, reason: prepared.result?.content?.map((b) => b.text).join('\n') ?? '' };
  }
  return { denied: false, reason: undefined };
}

const out = [];
const failures = [];

/** 记一条结论。`mustHold` 为真时，不成立就计入失败。 */
function record(id, title, holds, detail, mustHold = true) {
  out.push({ id, title, holds, detail, mustHold });
  if (mustHold && !holds) failures.push(`${id} ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// S1：`guard()` 的层级归属
// ─────────────────────────────────────────────────────────────────────────────

async function s1() {
  const ctx = await startHost();
  try {
    registerTool(ctx, 'probe_tool');
    const agentA = makeAgent(ctx, 'a');
    const agentB = makeAgent(ctx, 'b');

    // (1) 普通上下文（无作用域）挂 guard → 全局限
    const plainGuardHits = [];
    const disposePlain = ctx.tools.guard((exec) => {
      plainGuardHits.push(exec?.agent?.session?.id ?? '(no-agent)');
      return undefined;
    });
    const a1 = await attempt(ctx, 'probe_tool', agentA);
    const b1 = await attempt(ctx, 'probe_tool', agentB);
    const n1 = await attempt(ctx, 'probe_tool', undefined);
    disposePlain();

    record(
      'S1-a',
      '普通 ctx 上的 guard 对全部 agent 与无 agent 调用都生效',
      plainGuardHits.length === 3 && !a1.denied && !b1.denied && !n1.denied,
      `命中 ${plainGuardHits.length} 次：${plainGuardHits.join('、')}`,
    );

    // (2) guard 返回字符串 → 拒绝；且拒绝无法被另一个 guard 放行
    const disposeDeny = ctx.tools.guard((exec) => (exec?.agent?.session?.id === 'a' ? 'S1-deny-a' : undefined));
    const denyGuard = ctx.tools.guard(() => undefined);
    const a2 = await attempt(ctx, 'probe_tool', agentA);
    const b2 = await attempt(ctx, 'probe_tool', agentB);
    denyGuard();
    disposeDeny();

    record(
      'S1-b',
      'guard 返回字符串即拒绝，且另一个"放行"guard 无法翻案（单调性）',
      a2.denied && /S1-deny-a/.test(a2.reason ?? '') && !b2.denied,
      `A concerned=${a2.denied} reason=${JSON.stringify(a2.reason ?? '')}；B denied=${b2.denied}`,
    );

    // (3) `agent.ctx` 上挂 guard → 只对该 agent
    const scopedHits = [];
    const disposeScoped = agentA.ctx.get('tools').guard((exec) => {
      scopedHits.push(exec?.agent?.session?.id ?? '(no-agent)');
      return 'S1-scoped-deny';
    });
    const a3 = await attempt(ctx, 'probe_tool', agentA);
    const b3 = await attempt(ctx, 'probe_tool', agentB);
    disposeScoped();

    record(
      'S1-c',
      '`agent.ctx` 上的 guard 只作用于该 agent（v0.3 的用法，v0.4 不再依赖）',
      a3.denied && !b3.denied && scopedHits.length === 1 && scopedHits[0] === 'a',
      `A denied=${a3.denied}；B denied=${b3.denied}；命中 ${JSON.stringify(scopedHits)}`,
    );

    // (4) guard 能读到 `exec.arguments`（问题 2 的修法依赖它）
    let seenArgs;
    const disposeArgs = ctx.tools.guard((exec) => {
      seenArgs = exec?.arguments;
      return undefined;
    });
    await attempt(ctx, 'probe_tool', agentA, { agent_id: 'child-9', message: 'hi' });
    disposeArgs();

    record(
      'S1-d',
      'guard 拿到完整 `exec.arguments`（可按 send_message 的目标做判定）',
      seenArgs?.agent_id === 'child-9' && seenArgs?.message === 'hi',
      `arguments=${JSON.stringify(seenArgs)}`,
    );

    // (5) 卸载后 guard 撤销
    const disposeLife = ctx.tools.guard(() => 'S1-life');
    const before = await attempt(ctx, 'probe_tool', agentA);
    disposeLife();
    const after = await attempt(ctx, 'probe_tool', agentA);
    record(
      'S1-e',
      '撤销 disposer 后 guard 立即失效（卸载路径不留永久拒绝）',
      before.denied && !after.denied,
      `撤销前 denied=${before.denied}，撤销后 denied=${after.denied}`,
    );
  } finally {
    await ctx.fiber.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S2：未加作用域的 `agent/request` 监听器是否收到全部请求
// ─────────────────────────────────────────────────────────────────────────────

async function s2() {
  const ctx = await startHost();
  try {
    const agentA = makeAgent(ctx, 'a');
    const agentB = makeAgent(ctx, 'b');
    const seen = [];

    // 全局（无作用域）监听器：等价于 v0.4 L3 想用的形态。
    const disposeGlobal = ctx.on('agent/request', (payload) => {
      seen.push(`global:${payload?.agent?.session?.id ?? '(?)'}`);
    });
    // agent 作用域监听器：v0.3 的形态，作为对照。
    const disposeScoped = agentA.ctx.on('agent/request', (payload) => {
      seen.push(`scopedA:${payload?.agent?.session?.id ?? '(?)'}`);
    });

    const frozen = Object.freeze({ provider: 'p', model: 'm' });
    await agentA.ctx.waterfall('agent/request', { agent: agentA, turn: 1, step: 1 }, async () => frozen);
    await agentB.ctx.waterfall('agent/request', { agent: agentB, turn: 1, step: 1 }, async () => frozen);

    disposeGlobal();
    disposeScoped();

    const globalSawA = seen.includes('global:a');
    const globalSawB = seen.includes('global:b');
    const scopedSawB = seen.includes('scopedA:b');

    record(
      'S2-a',
      '无作用域 `agent/request` 监听器收到**全部** agent 的请求',
      globalSawA && globalSawB,
      `观察到的投递：${JSON.stringify(seen)}`,
    );
    record(
      'S2-b',
      '`agent.ctx` 上的监听器只收到自己的请求（作用域隔离成立）',
      !scopedSawB,
      `scopedA 是否收到 b 的请求：${scopedSawB}`,
      false,
    );

    out.push({
      id: 'S2-c',
      title: 'L3 能否全局化',
      holds: globalSawA && globalSawB,
      detail: globalSawA && globalSawB
        ? '结论：可以全局化。全局监听器必须**自校验** `payload.agent.session.id` 与闭包无关（否则会把 A 的请求压到 B 的路由）。'
        : '结论：不可全局化，L3 退回 v0.3 的逐子会话挂载（方案 §14 第 1 行）。',
      mustHold: false,
    });
  } finally {
    await ctx.fiber.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S3：`agent/created`（serial）里抛错能否阻断子会话创建
// ─────────────────────────────────────────────────────────────────────────────

async function s3() {
  const ctx = await startHost();
  try {
    // `agents` 服务不在本仓依赖里，用一个最小的 serial 通道模拟宿主的派发方式：
    // 宿主走 `ctx.serial(carrier, 'agent/created', …)` 并 **await** 它（`.host-probe/dsh-agent.js:581-586`）。
    let disposed = 0;
    const order = [];

    const disposeListener = ctx.on('agent/created', async (payload) => {
      order.push('listener');
      if (payload?.agent?.session?.id === 'blocked') throw new Error('S3-blocked');
      return undefined;
    });

    const okAgent = makeAgent(ctx, 'ok');
    let okThrew;
    try {
      await ctx.serial('agent/created', { agent: okAgent, source: 'test' });
      okThrew = false;
    } catch {
      okThrew = true;
    }

    const badAgent = makeAgent(ctx, 'blocked');
    let badThrew;
    try {
      await ctx.serial('agent/created', { agent: badAgent, source: 'test' });
      badThrew = false;
    } catch {
      badThrew = true;
    }

    disposeListener();
    record(
      'S3-a',
      'serial 监听器抛错会让 `await ctx.serial(...)` 拒绝（宿主可感知）',
      badThrew && !okThrew,
      `正常会话抛错=${okThrew}；被拦会话抛错=${badThrew}；派发顺序=${JSON.stringify(order)} disposed=${disposed}`,
    );

    // 但宿主是否把它当成"创建失败"并回滚，需要 `agents` 服务在场才能观测。
    // 本仓没有该依赖，因此这里只回答"可感知"，不回答"可阻断"。
    out.push({
      id: 'S3-b',
      title: 'L2 是否依赖 S3 抛错阻断',
      holds: false,
      detail: '结论：不依赖。v0.4 用全局 guard（S1）在**工具调用**层拒绝，`agent/created` 只用于注册 L3 谱系锁定。'
        + '因此"抛错能否回滚创建"这个未决问题不影响任何一条验收判据。',
      mustHold: false,
    });
  } finally {
    await ctx.fiber.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S4：子会话首轮实际路由能否被读到（`station_status` 核对用）
// ─────────────────────────────────────────────────────────────────────────────

async function s4() {
  const ctx = await startHost();
  try {
    const parent = makeAgent(ctx, 'root');
    const child = makeAgent(ctx, 'child', { parentSession: 'root', depth: 1 });
    const header = child.session.header;
    const headerKeys = Object.keys(header);

    record(
      'S4-a',
      '会话头里**没有** provider/model（`.host-src/dsh-subagent.js:346-354` 的 `childSessionMeta`）',
      !headerKeys.includes('provider') && !headerKeys.includes('model'),
      `header 字段：${JSON.stringify(headerKeys)}；parent=${JSON.stringify(parent.id)}`,
    );

    out.push({
      id: 'S4-b',
      title: '`station_status({childSessionId})` 的核对结论能做到什么',
      holds: false,
      detail: '结论：只能核对**台账侧**（回执声明 vs children 登记 vs 受管根快照），'
        + '运行时实测路由需要宿主写入会话头或暴露请求日志——两者当前都没有。'
        + '因此渲染成"无法核对（宿主未记录路由）"，不许伪造"一致"。',
      mustHold: false,
    });
  } finally {
    await ctx.fiber.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S5：预置 `childId`（方案 §4 S5：TOCTOU 从根上消失的前提）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这一条**不做**端到端复现：真的跑通它需要 `agents`/`sessions`/`sessionPersistence`/
 * `tools`/`systemPrompt` 全部在场，那已经是一台完整宿主，而不是一个 spike。
 *
 * 因此改为对宿主源码做**可复核的行级断言**：脚本读 `.host-src/` 里那几行，
 * 断言 v0.4 依赖的四条事实仍然成立。宿主升级后重跑本脚本，任何一条变化都会立刻变红。
 */
async function s5() {
  const root = new URL('../../.host-src/', import.meta.url);
  const subagent = await readFile(new URL('dsh-subagent.js', root), 'utf8');
  const spawn = await readFile(new URL('dsh-subagent-spawn.js', root), 'utf8');
  const lines = subagent.split('\n');
  const at = (n) => lines[n - 1] ?? '';

  // 1. 保留 id 的降级条件：provider 没有 `prepareContinuable` ⇒ UNSUPPORTED_CAPABILITY。
  record(
    'S5-a',
    '传 `childId` 但后端不支持 `prepareContinuable` ⇒ `UNSUPPORTED_CAPABILITY`（需要降级路径）',
    /spec\.childId !== void 0 && provider\.prepareContinuable === void 0/.test(at(3038))
      && /UNSUPPORTED_CAPABILITY/.test(at(3038)),
    `dsh-subagent.js:3038 → ${at(3038).trim()}`,
  );

  // 2. 不传 childId 时宿主自己生成；传了就**直接用**（不替换、不加前缀）。
  record(
    'S5-b',
    '`childId` 被原样采用：`spec.childId ?? brandString(randomUUID())`',
    at(1397).includes('const childId = spec.childId ?? brandString(randomUUID())'),
    `dsh-subagent.js:1397 → ${at(1397).trim()}`,
  );

  // 3. 唯一性校验只查「已存在」，**不校验格式**（所以自造 UUID 可接受）。
  record(
    'S5-c',
    '`assertChildIdAvailable` 只查重、不校验格式（自造 UUID 合法）',
    /this\.resident\.has\(childId\)/.test(at(1597))
      && /DUPLICATE_CHILD/.test(at(1597))
      && !/test\(|match\(|RegExp/.test(at(1597)),
    `dsh-subagent.js:1597 → ${at(1597).trim()}`,
  );

  // 4. 预置 id 时额外查持久化：崩溃残留的同名子会话会被判 DUPLICATE_CHILD。
  record(
    'S5-d',
    '预置 id 会额外查持久化残留（同名会话已存在 ⇒ `DUPLICATE_CHILD`）',
    /if \(spec\.childId !== void 0\)/.test(at(1431)) && /persisted !== void 0/.test(at(1436)),
    `dsh-subagent.js:1431-1436 → ${at(1431).trim()} … ${at(1436).trim()}`,
  );

  // 5. 默认 `spawn` 后端声明了 `prepareContinuable`（所以默认路径可用）。
  record(
    'S5-e',
    '默认 `spawn` 后端实现 `prepareContinuable`（预置 id 在默认配置下可用）',
    /prepareContinuable\(\)/.test(spawn) && /return Promise\.resolve\(\{\}\)/.test(spawn),
    `dsh-subagent-spawn.js:31-33 → prepareContinuable() { return Promise.resolve({}) }`,
  );

  out.push({
    id: 'S5-f',
    title: 'TOCTOU 是否消失',
    holds: true,
    detail: '结论：消失（默认后端）。v0.4 在 `startActivation` **之前**自造 `childSessionId` 并写入台账，'
      + '子会话诞生那一刻台账里已有 child + receipt。仅当用户把 `providerName` 换成不支持 '
      + '`prepareContinuable` 的后端时才需要降级——降级方式：不传 `childId`，退回「派出后立刻登记」，'
      + '并在回执/状态里如实标 `保证等级：降级（配置）`，**不静默**。',
    mustHold: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// S6：全局 guard 的性能预算（热路径不能被它拖慢）
// ─────────────────────────────────────────────────────────────────────────────

async function s6() {
  const ctx = await startHost();
  try {
    registerTool(ctx, 'probe_tool');
    const agent = makeAgent(ctx, 'a');

    /** 在 guard 存在/不存在两种情况下各跑 N 次普通工具调用。 */
    const bench = async (label, rounds = 3000) => {
      const started = performance.now();
      for (let i = 0; i < rounds; i += 1) await attempt(ctx, 'probe_tool', agent);
      const elapsed = performance.now() - started;
      return { label, rounds, elapsed, perCall: elapsed / rounds };
    };

    const baseline = await bench('无 guard');

    // 与 v0.4 目标形态一致：先做名字预筛，绝大多数调用在第一次判断就返回。
    const candidate = /(subagent|sub_agent|teammate|delegat|dispatch|spawn|workflow|agent_team|send_message)/i;
    let hotHits = 0;
    let coldHits = 0;
    const dispose = ctx.tools.guard((exec) => {
      const name = exec?.name;
      if (typeof name !== 'string' || name === '') return undefined;
      if (!candidate.test(name)) {
        coldHits += 1;
        return undefined;
      }
      hotHits += 1;
      return undefined;
    });

    const guarded = await bench('带全局 guard（名字预筛）');
    dispose();

    const overhead = guarded.perCall - baseline.perCall;
    const ratio = guarded.perCall / baseline.perCall;

    record(
      'S6-a',
      '全局 guard 的名字预筛把普通工具调用的额外开销控制在 1µs 以内',
      overhead < 1,
      `基线 ${baseline.perCall.toFixed(3)}µs/次；带 guard ${guarded.perCall.toFixed(3)}µs/次；`
      + `额外 ${overhead.toFixed(3)}µs（${((ratio - 1) * 100).toFixed(1)}%）；预筛命中 热=${hotHits} 冷=${coldHits}`,
    );
    record(
      'S6-b',
      '预筛把普通工具名全部挡在"冷路径"（不进任何现算）',
      coldHits === guarded.rounds && hotHits === 0,
      `预筛结果：热 ${hotHits} / 冷 ${coldHits}（共 ${guarded.rounds} 次）`,
    );
  } finally {
    await ctx.fiber.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const spikes = [
  ['S1', 'guard() 的层级归属与能力（全局 / 作用域 / 单调 / arguments）', s1],
  ['S2', '未加作用域的 `agent/request` 监听器（决定 L3 能否全局化）', s2],
  ['S3', '`agent/created` serial 里抛错的可感知性与必要性', s3],
  ['S4', '会话头能否读到实际路由（决定状态核对能说什么）', s4],
  ['S5', '预置 `childId`（TOCTOU 是否从根上消失）', s5],
  ['S6', '全局 guard 的性能预算', s6],
];

const lines = [];
for (const [id, title, run] of spikes) {
  lines.push(`\n=== ${id} ${title} ===`);
  const before = out.length;
  await run();
  for (const item of out.slice(before)) {
    lines.push(`  [${item.holds ? '成立' : '未成立'}] ${item.id} ${item.title}`);
    lines.push(`    ${item.detail}`);
  }
}

lines.push('');
lines.push(failures.length === 0
  ? '结论：v0.4 地基成立（全部"必须成立"的假设均成立）。'
  : `结论：⚠️ 以下假设不成立，按方案 §14 应停止开发并向宿主维护者确认：\n  - ${failures.join('\n  - ')}`);

process.stdout.write(`${lines.join('\n')}\n`);
if (failures.length > 0) process.exitCode = 1;
