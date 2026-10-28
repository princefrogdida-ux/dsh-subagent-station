#!/usr/bin/env node
/**
 * 生成 `TEST-REPORT.md`（方案 §13.2 / §13.3）。
 *
 * 为什么必须是脚本生成：v0.2 的 `TEST-REPORT.md` 是手写的，数字无法被第三方核验；
 * 而「测试通过」这件事在 v0.2 是**不可信**的——97 项全绿时主派出路径其实是坏的。
 * v0.3 的自证标准因此提高一档：报告必须可用一条命令重现。
 *
 * 用法（在 `subagent-dispatch-station/` 下）：
 *
 *     node scripts/report.mjs
 *
 * 它会：
 * 1. 跑 `node --test --test-isolation=none "tests/unit/*.test.js"` 抓 TAP 摘要；
 * 2. 跑 v0.3 那 17 条（T42–T58）并逐条列出通过/失败；
 * 3. 读 `proof/red-v02.txt`（如果存在）作为红方证据，与当前绿方结果对照；
 * 4. 写 `TEST-REPORT.md`。
 *
 * **不**修改任何产品代码，**不**猜测数字：凡是没跑出来的，如实写「未获得」。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'TEST-REPORT.md');
const RED_PROOF = join(ROOT, 'proof', 'red-v02.txt');

/**
 * 跑一条测试命令并抓 TAP/摘要输出。
 *
 * 注意 `--test-isolation=none`：这个环境的沙箱不允许子进程用管道捕获 stdio
 * （`spawn EPERM`），关掉隔离后测试在同一个进程里跑，报告才可能被重现。
 *
 * @param {string} glob
 * @returns {{text: string, pass: number, fail: number, total: number, code: number, names: Array<{ok: boolean, name: string}>}}
 */
function runTests(glob) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-isolation=none', glob],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000 },
  );
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  const num = (label) => {
    const match = text.match(new RegExp(`^[ℹ#]\\s*${label}s?\\s+(\\d+)\\s*$`, 'm'));
    return match === null ? undefined : Number(match[1]);
  };

  // TAP 风格与 spec 风格都认。
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const ok = line.match(/^\s*✔\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (ok !== null) names.push({ ok: true, name: ok[1] });
    const bad = line.match(/^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (bad !== null) names.push({ ok: false, name: bad[1] });
  }

  return {
    text,
    pass: num('pass') ?? 0,
    fail: num('fail') ?? 0,
    total: num('test') ?? (num('pass') ?? 0) + (num('fail') ?? 0),
    code: result.status ?? -1,
    names,
  };
}

/** 环境信息。 */
function environment() {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  } catch {
    pkg = {};
  }
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    packageName: pkg.name ?? '(未读到)',
    packageVersion: pkg.version ?? '(未读到)',
    dshHome: process.env.DSH_HOME ?? '(未设置)',
  };
}

/** 把「未验证清单」从 known-limits 里取出来，保证两处同源（§13.3 末行）。 */
function knownLimits() {
  const path = join(ROOT, 'docs', 'known-limits.md');
  if (!existsSync(path)) return '(未找到 docs/known-limits.md)';
  return readFileSync(path, 'utf8');
}

/** 主流程。 */
function main() {
  const env = environment();
  const all = runTests('tests/unit/*.test.js');
  const v03 = runTests('tests/unit/v03.test.js');

  const t42to58 = v03.names.filter((n) => /^T(4[2-9]|5[0-8])\b/.test(n.name));
  const redProof = existsSync(RED_PROOF) ? readFileSync(RED_PROOF, 'utf8') : undefined;

  const lines = [];
  lines.push('# 测试报告（v0.3）');
  lines.push('');
  lines.push(`> 本文件由 \`scripts/report.mjs\` 生成于 ${new Date().toISOString()}。**请勿手改**——手改的数字无法被核验。`);
  lines.push('');

  lines.push('## 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 插件 | ${env.packageName} ${env.packageVersion} |`);
  lines.push(`| Node | ${env.node} |`);
  lines.push(`| 平台 | ${env.platform} |`);
  lines.push(`| DSH_HOME | ${env.dshHome} |`);
  lines.push('');

  lines.push('## 命令');
  lines.push('');
  lines.push('工作目录：`subagent-dispatch-station/`');
  lines.push('');
  lines.push('```powershell');
  lines.push('node --test --test-isolation=none "tests/unit/*.test.js"');
  lines.push('node --test --test-isolation=none "tests/unit/v03.test.js"');
  lines.push('node scripts/report.mjs   # 重新生成本文件');
  lines.push('```');
  lines.push('');
  lines.push('`--test-isolation=none` 不是性能选择：本环境的沙箱禁止子进程用管道捕获 stdio，');
  lines.push('默认隔离会导致 `spawn EPERM`。关掉隔离后测试在当前进程内运行。');
  lines.push('');

  lines.push('## 原始输出摘要');
  lines.push('');
  lines.push('| 范围 | 通过 | 失败 | 合计 | 退出码 |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(`| 全部单元测试 | ${all.pass} | ${all.fail} | ${all.total} | ${all.code} |`);
  lines.push(`| v0.3 矩阵（T42–T58） | ${v03.pass} | ${v03.fail} | ${v03.total} | ${v03.code} |`);
  lines.push('');

  lines.push('### T42–T58 逐条结果');
  lines.push('');
  if (t42to58.length === 0) {
    lines.push('（未获得：本轮运行没有输出 T42–T58 的结果）');
  } else {
    lines.push('| 结果 | 测试 |');
    lines.push('| --- | --- |');
    for (const item of t42to58) lines.push(`| ${item.ok ? '✅ 通过' : '❌ 失败'} | ${item.name} |`);
  }
  lines.push('');

  lines.push('## 红 → 绿对照');
  lines.push('');
  lines.push('纪律（方案 §13.1 第 1 条）：每条 P1 修复必须附一条**在 v0.2 代码上会红**的测试，');
  lines.push('且红与绿两次输出都要进报告。');
  lines.push('');
  if (redProof === undefined) {
    lines.push('> ⚠️ **未找到 `proof/red-v02.txt`**，本轮缺少红方证据。');
    lines.push('> 按 §13.1，缺红方证据的修复**不得**在报告中声称「已验证」。');
    lines.push('');
    lines.push('复现红方的方法：');
    lines.push('');
    lines.push('```powershell');
    lines.push('node scripts/make-red-proof.mjs   # 生成 proof/red-v02.txt');
    lines.push('node scripts/report.mjs');
    lines.push('```');
  } else {
    // 从红方证据里抽出每组退回的摘要行（生成脚本把结论写成 `# …` 注释行）。
    const groups = [];
    let current;
    for (const line of redProof.split(/\r?\n/)) {
      const head = line.match(/^# (G\d[\w-]*(?: \+ G\d[\w-]*)*)\s+(.+)$/);
      if (head !== null) {
        current = { id: head[1], title: head[2], expected: '', actual: '', warn: '' };
        groups.push(current);
        continue;
      }
      if (current === undefined) continue;
      const expected = line.match(/^# 应当变红：(.+)$/);
      if (expected !== null) current.expected = expected[1];
      const actual = line.match(/^# 实际变红：(.+)$/);
      if (actual !== null) current.actual = actual[1];
      const warn = line.match(/^# ⚠️ 仍然通过：(.+?)  ←/);
      if (warn !== null) current.warn = warn[1];
    }

    lines.push('### 红方：逐条修复单独退回后重跑同一份测试');
    lines.push('');
    lines.push('生成脚本 `scripts/make-red-proof.mjs` 的工作方式：把源码复制到临时目录，');
    lines.push('**每条修复单独退回**成 v0.2 形态，再对副本跑 `tests/unit/v03.test.js`。');
    lines.push('这样每条红都能归因到具体一处修复，而不是「一大堆改动里有问题」。');
    lines.push('若清单里的测试没有变红，脚本以非零退出并点名——即「假绿」检查。');
    lines.push('');
    lines.push('| 修复 | 内容 | 应当变红 | 实际变红 | 结论 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const group of groups) {
      const verdict = group.warn === ''
        ? (group.actual === group.expected && group.expected !== '' ? '✅ 红方成立' : '⚠️ 与预期不符')
        : `❌ 假绿：${group.warn}`;
      lines.push(`| ${group.id} | ${group.title} | ${group.expected} | ${group.actual || '（无）'} | ${verdict} |`);
    }
    lines.push('');
    lines.push('### 绿方：v0.3 代码，当前');
    lines.push('');
    lines.push('```text');
    lines.push(`tests ${v03.total}`);
    lines.push(`pass ${v03.pass}`);
    lines.push(`fail ${v03.fail}`);
    lines.push('```');
    lines.push('');
    lines.push('红方原文全文见 `proof/red-v02.txt`（含每组完整的 `node --test` 输出）。');
  }
  lines.push('');

  lines.push('## 未验证清单');
  lines.push('');
  lines.push('本节的唯一真相源是 `docs/known-limits.md`（方案 §13.3 要求两处同源、不得两处不一致）。');
  lines.push('下面原样内嵌该文件，任何不一致都应先改那份文件。');
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>docs/known-limits.md（原文）</summary>');
  lines.push('');
  lines.push('```markdown');
  lines.push(knownLimits().trimEnd());
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  lines.push('');

  // 测试文件清单：让第三方能一眼看出覆盖面。
  let files = [];
  try {
    files = readdirSync(join(ROOT, 'tests', 'unit')).filter((f) => f.endsWith('.test.js')).sort();
  } catch {
    files = [];
  }
  lines.push('## 测试文件');
  lines.push('');
  for (const file of files) lines.push(`- \`tests/unit/${file}\``);
  lines.push('');

  writeFileSync(OUT, lines.join('\n'), 'utf8');
  process.stdout.write(
    `已生成 ${OUT}\n全部：pass ${all.pass} / fail ${all.fail}（退出码 ${all.code}）\n`
    + `v0.3：pass ${v03.pass} / fail ${v03.fail}（退出码 ${v03.code}）\n`,
  );

  // 任一范围有失败就以非零退出，避免 CI 把红的报告当绿的。
  process.exitCode = all.fail === 0 && v03.fail === 0 ? 0 : 1;
}

main();
