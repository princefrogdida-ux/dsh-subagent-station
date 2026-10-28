#!/usr/bin/env node
/**
 * 生成红方证据（方案 §13.1 第 1 条）。
 *
 * 做法：**每条 P1 修复单独退回、单独跑一遍测试**，把输出写进 `proof/red-v02.txt`。
 *
 * 为什么不是「一次性全退回」：那样只能证明「这一堆东西里有问题」，不能证明
 * 「这条测试测的就是这处修复」。方案要求的是后者——每条修复都要有**能归因到它**的红。
 *
 * 为什么用「退回到临时副本」而不是 `git stash`：本工作区没有 git 仓库，
 * 红→绿必须靠存档输出而不是提交历史来证明。
 *
 * 每条退回都带一个 `expect` 清单：跑完若清单里的测试**没有**变红，脚本以非零退出，
 * 因为那意味着该测试并没有真的守住那处修复（假绿）。
 *
 * 用法（在 `subagent-dispatch-station/` 下，需要能写 `proof/`）：
 *
 *     node scripts/make-red-proof.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROOF_DIR = join(ROOT, 'proof');
const PROOF = join(PROOF_DIR, 'red-v02.txt');

/**
 * 退回清单：每条 = 一处 P1 修复 + 它应当弄红的测试。
 *
 * `from` 必须能在当前源码里**逐字**找到，否则脚本中止——宁可拒绝生成，
 * 也不产出一份看起来像证据的假输出。
 */
const REVERTS = [
  {
    id: 'G1',
    title: '派出时下发 agentOptions',
    file: 'lib/host/index.js',
    expect: ['T42', 'T43'],
    note: 'v0.2 的形态：只把路由写进回执文本，`startActivation` 的 request 里没有 agentOptions。',
    from: `      agentOptions: {
        provider: decision.provider,
        model: decision.model,
        ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
      },
`,
    to: '',
  },
  {
    id: 'G2-a',
    title: '启动扫描治理加载前已存在的会话',
    file: 'lib/host/index.js',
    expect: ['T45', 'T46', 'T57'],
    note: 'v0.2 的形态：只治理 `agent/created` 的新会话，插件加载前已存在的会话完全不受管。',
    from: `      for (const agent of live) {
        for (const dispose of governAgent(agent, { reason: 'startup-sweep' })) disposers.push(dispose);
      }`,
    to: `      for (const agent of live) {
        // v0.2：不扫描既有会话。
      }`,
  },
  {
    id: 'G2-b',
    title: '沿谱系向上解析真正的受管根',
    file: 'lib/host/entry-governor.js',
    expect: ['T47'],
    note: 'v0.2 的形态：直接拿 `header.parentSession` 当根（只走一层），maxDepth 2 的孙级被判成未受管。',
    from: '  const resolved = resolveRootSessionId(agent, options);',
    to: "  const resolved = { rootSessionId: agent?.session?.header?.parentSession ?? ownId, lineage: 'full', hops: 0 };",
  },
  {
    // G3 的两处修复互为掩护：只退回「现算」、保留「重挂」时，重挂会用新身份重算闭包值，
    // 于是 T48 仍然绿；只退回「重挂」、保留「现算」时，现算会救回来。
    // 因此这一条必须**同时**退回两者，才是 v0.2 的真实形态（两者 v0.2 都没有）。
    // 这不是为了凑红：它如实说明「单靠其中任一修复都不足以保证身份正确」。
    id: 'G3',
    title: 'guard 内现算 isChild + 身份变化时重挂',
    file: 'lib/host/entry-governor.js',
    expect: ['T48'],
    note: 'v0.2 的形态：`isChild` 冻结在闭包里，且同 id 直接复用旧 disposer（两处都不做）。',
    from: `    const existing = attached.get(id);
    if (existing !== undefined) {
      if (existing.isChild === isChild) return existing.dispose;
      // 身份变了：先撤销，再重挂（P1-B）。
      existing.dispose();
    }`,
    to: `    const existing = attached.get(id);
    if (existing !== undefined) return existing.dispose;`,
  },
  {
    id: 'G3-guard',
    title: '（接上条）guard 内不再现算 isChild',
    file: 'lib/host/entry-governor.js',
    expect: [],
    note: '与 G3 一起生效：把现算也退回闭包冻结值。',
    from: '      const liveIsChild = delegationDepthOf(agent) >= 1;',
    to: '      const liveIsChild = isChild; // v0.2：冻结在闭包里',
  },
  {
    id: 'G4-a',
    title: '首次压回后把回执升到 observed',
    file: 'lib/host/request-lock.js',
    expect: ['T49'],
    note: 'v0.2 的形态：不写 observed，回执永远停在 started。',
    from: `    if (!observed) {
      observed = true;
      try {
        await ledger.markObserved?.(childSessionId);
      } catch {
        // 故意吞掉：见上。
      }
    }`,
    to: '    // v0.2：不写 observed。',
  },
  {
    id: 'G4-b',
    title: '`subagent/end` 收尾回执终态',
    file: 'lib/host/ledger.js',
    expect: ['T50', 'T51'],
    note: 'v0.2 的形态：`closeReceipt` 什么都不做，回执永远没有终态。',
    from: '      if (isTerminalStatus(current.status)) return { closed: false, status: current.status };',
    to: '      return { closed: false, status: current.status }; // v0.2：不写终态',
  },
  {
    id: 'G5-a',
    title: '空快照自愈',
    file: 'lib/host/index.js',
    expect: ['T52'],
    note: 'v0.2 的形态：`stationRoutes: []` 被当成「已授权为空」，此后永不更新。',
    from: '    const emptySelfHeal = snapshotIsEmpty && policy.allowedRoutes.length > 0;',
    to: '    const emptySelfHeal = false; // v0.2：空集不视为「没授权过」',
  },
  {
    id: 'G5-b',
    title: '`snapshotEpoch` 显式重建',
    file: 'lib/host/index.js',
    expect: ['T53'],
    note: 'v0.2 的形态：没有重建入口，放宽永远不生效。',
    from: '    const epochChanged = existing !== undefined && storedEpoch !== policy.snapshotEpoch;',
    to: '    const epochChanged = false; // v0.2：没有 epoch 重建',
  },
  {
    id: 'G6-a',
    title: '目录外「像派生入口」的默认拦截',
    file: 'lib/host/coverage.js',
    expect: ['T54'],
    note: 'v0.2 的形态：目录外入口一律 `deny: false`，改名的派生入口既不拦也不报。',
    from: '  if (entry === undefined && !isExtra) {',
    to: "  if (entry === undefined && !isExtra) {\n    return { deny: false, entry: undefined, reason: 'unknown-allowed' }; // v0.2：目录外一律放行",
  },
  {
    id: 'G6-b',
    title: '覆盖诊断的第四态 `unrecognized`',
    file: 'lib/host/coverage.js',
    expect: ['T55'],
    note: 'v0.2 的形态：只把正则命中的报为未知，其余目录外工具假装不存在。',
    from: `    } else {
      // v0.3：不像派生入口的目录外工具也**必须看得见**，否则「覆盖诊断」只会在
      // 自己认识的世界里自说自话（T55 的 \`read\`/\`bash\`）。
      unrecognized.push(name);
    }`,
    to: '    }',
  },
  {
    id: 'G6-c',
    title: '按作用域读取可见工具名',
    file: 'lib/host/index.js',
    expect: ['T56'],
    note: 'v0.2 的形态：`ctx.tools.schemas()` 不带 scope，scoped 注册在诊断里不可见。',
    from: '      const schemas = ctx.tools?.schemas?.(scope);',
    to: '      const schemas = ctx.tools?.schemas?.(); // v0.2：只看全局视图',
  },
  {
    id: 'G6-d',
    title: '`station_status` 诊断工具',
    file: 'lib/host/index.js',
    expect: ['T58'],
    note: 'v0.2 的形态：没有这个工具，用户没有任何能问的地方。',
    from: `  const disposeStatus = registerStationStatus(ctx, { buildStatus, readPolicy });
  ctx.effect(() => disposeStatus, 'dsh-subagent-station: station_status');`,
    to: '  // v0.2：没有 station_status。',
  },
  {
    id: 'G6-e',
    title: '未受管用户的岗位 dry-run 与「假如受管」标注',
    file: 'lib/host/index.js',
    expect: ['T58'],
    note: '退回成「直接用调用者会话做 dry-run」：未受管用户会拿到一句「当前会话没有被启用为受管会话」，'
      + '于是最需要诊断的人反而看不到岗位诊断。',
    from: `        const managedId = status.managedSessionIds[0] ?? 'station-status-dry-run';
        const dryRunSession = { id: managedId, header: { delegationDepth: 0 } };
        const lines = renderRoleDryRun(status, roleId, readPolicy(), dryRunSession);
        return \`\${text}\\n\\n\${lines}\${status.self?.managed === false ? '\\n（注：以上是「假如在受管根上派出」的结果；本会话当前未受管，实际无法派出。）' : ''}\`;`,
    to: '        return `${text}\\n\\n${renderRoleDryRun(status, roleId, readPolicy(), scope?.session)}`;',
  },
];

/** 建一个只含源码的临时副本，`node_modules` 用 junction 指回真实目录。 */
function makeWorkspace() {
  const sandbox = mkdtempSync(join(tmpdir(), 'station-red-'));
  const work = join(sandbox, 'pkg');
  mkdirSync(work, { recursive: true });
  for (const entry of readdirSync(ROOT)) {
    // 为什么不整体复制：`.pnpm` 里全是符号链接，Windows 沙箱下 `cpSync` 会 `symlink EPERM`；
    // 而且测试必须 import 与产品**同一份**真实宿主包（替身能力 ≥ 被测字段，§13.1 第 2 条）。
    if (entry === 'node_modules' || entry === 'proof' || entry === '.red-green') continue;
    cpSync(join(ROOT, entry), join(work, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');
  return { sandbox, work };
}

/** 在副本里逐字替换一处，改不到就抛错（拒绝产出假证据）。 */
function applyRevert(work, revert) {
  const path = join(work, revert.file);
  const before = readFileSync(path, 'utf8');
  if (!before.includes(revert.from)) {
    throw new Error(
      `退回 ${revert.id} 失败：在 ${revert.file} 里找不到要替换的片段。`
      + '红方证据不可信，已中止。请同步更新 scripts/make-red-proof.mjs 里的 from 字符串。',
    );
  }
  const after = before.replace(revert.from, revert.to);
  if (after === before) throw new Error(`退回 ${revert.id} 失败：${revert.file} 未发生变化。`);
  writeFileSync(path, after, 'utf8');
}

/** 跑一遍 v0.3 矩阵，返回逐条结果。 */
function runMatrix(work) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-isolation=none', 'tests/unit/v03.test.js'],
    { cwd: work, encoding: 'utf8', timeout: 300_000 },
  );
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const results = new Map();
  for (const line of text.split(/\r?\n/)) {
    const ok = line.match(/^\s*✔\s+(T\d+)\s/);
    if (ok !== null) results.set(ok[1], true);
    const bad = line.match(/^\s*✖\s+(T\d+)\s/);
    if (bad !== null) results.set(bad[1], false);
  }
  return { text, results, code: result.status ?? -1 };
}

const out = [];
const failures = [];

out.push('# 红方证据：逐条 P1 修复在「退回 v0.2 形态」后的测试结果');
out.push('#');
out.push('# 由 scripts/make-red-proof.mjs 生成。生成方式：每条修复单独退回到临时副本，');
out.push('# 单独跑一遍同一份 tests/unit/v03.test.js。这样每条红都能归因到具体一处修复。');
out.push('# 少数条目（标了「接上条」）必须与前一条同时退回，因为两处修复互为掩护——');
out.push('# 只退回其中一处时另一处会救回来，那样得到的「绿」不能证明任何事。');
out.push('#');
out.push(`# 生成时间：${new Date().toISOString()}`);
out.push(`# Node：${process.version}`);
out.push('');

/**
 * 把 REVERTS 分组成「一次退回」（同一组的条目同时生效、只跑一遍）。
 * 分组规则：`expect` 为空的条目从属于它前面那条。
 */
const groups = [];
for (const revert of REVERTS) {
  if (revert.expect.length === 0 && groups.length > 0) {
    groups[groups.length - 1].push(revert);
  } else {
    groups.push([revert]);
  }
}

for (const group of groups) {
  const primary = group[0];
  const expected = group.flatMap((r) => r.expect);
  const { sandbox, work } = makeWorkspace();
  try {
    for (const revert of group) applyRevert(work, revert);
    const run = runMatrix(work);

    const red = [];
    const green = [];
    for (const id of expected) {
      if (run.results.get(id) === false) red.push(id);
      else if (run.results.get(id) === true) green.push(id);
    }

    out.push(`${'='.repeat(78)}`);
    out.push(`# ${group.map((r) => r.id).join(' + ')}  ${primary.title}`);
    for (const revert of group) {
      out.push(`# 文件：${revert.file}`);
      out.push(`# 退回：${revert.note}`);
    }
    out.push(`# 应当变红：${expected.join('、')}`);
    out.push(`# 实际变红：${red.join('、') || '（无）'}`);
    if (green.length > 0) out.push(`# ⚠️ 仍然通过：${green.join('、')}  ← 该测试没有守住这处修复`);
    out.push(`# 退出码：${run.code}`);
    out.push(`${'='.repeat(78)}`);
    out.push(run.text.trimEnd());
    out.push('');

    if (green.length > 0) {
      failures.push(`${group.map((r) => r.id).join('+')}：${green.join('、')} 在退回后仍然通过（假绿）`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

mkdirSync(PROOF_DIR, { recursive: true });
writeFileSync(PROOF, `${out.join('\n')}\n`, 'utf8');

process.stdout.write(`已写入 ${PROOF}\n共 ${groups.length} 组退回（${REVERTS.length} 条改动）。\n`);
if (failures.length > 0) {
  process.stdout.write(`\n⚠️ 以下修复缺少能归因的红：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('每条修复都有能归因的红。\n');
}
