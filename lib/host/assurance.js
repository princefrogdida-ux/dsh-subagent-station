/**
 * 保证等级（方案 §2.1 G8 / 改进方案 §9.4）。
 *
 * 为什么必须有它：v0.3 的回执说"已锁定"，但没说"这个锁定在什么前提下成立"。
 * 而当前提不成立时（后端不支持预置 id、谱系读不出来、台账读不出来），
 * 插件的行为会**降级**——如果不披露，用户读到的就是一句无法核对的承诺。
 *
 * 四档（改进方案 §9.4）：
 *
 * | 等级 | 含义 | 用户该做什么 |
 * | --- | --- | --- |
 * | **完整** | 每一层保证都成立 | 什么都不用做 |
 * | **降级（配置）** | 用户配置导致某层做不到 | 可以改配置修好 |
 * | **降级（环境）** | 宿主/服务导致某层做不到 | 改不了，只能知情 |
 * | **不可派出** | 关键一层缺失，派出被拒绝 | 按提示修 |
 *
 * 一条硬规则：**这个等级不许现编**。它只能由这里根据一组明确的布尔事实算出来，
 * 而且每一档都要能指出"是哪一条事实不成立"。测试用真值表覆盖全部组合。
 */

/** 四个等级（顺序 = 从最完整到最不可用）。 */
export const ASSURANCE_LEVELS = Object.freeze(['full', 'degraded-config', 'degraded-env', 'unavailable']);

/** 等级的中文名（渲染用，一处定义）。 */
export const ASSURANCE_LABELS = Object.freeze({
  full: '完整',
  'degraded-config': '降级（配置）',
  'degraded-env': '降级（环境）',
  unavailable: '不可派出',
});

/**
 * 一条"降级原因"：哪一层不成立、为什么、怎么办。
 *
 * `fixable` 决定等级是「配置」还是「环境」——这不是措辞问题：
 * 「配置」档会告诉用户"改这里就好了"，所以它只在**真的能改**时使用。
 *
 * @param {string} layer 哪一层（`guard` / `lock` / `ledger` / `lineage` / `reservation`）
 * @param {string} reason 为什么不成立
 * @param {string} [fix] 怎么修（省略 = 用户改不了）
 * @returns {{layer: string, reason: string, fix?: string, fixable: boolean}}
 */
function degradation(layer, reason, fix) {
  return fix === undefined
    ? { layer, reason, fixable: false }
    : { layer, reason, fix, fixable: true };
}

/**
 * 计算当前这一套保证的等级。
 *
 * @param {object} facts
 * @param {boolean} facts.guardMounted 全局入口守卫是否已安装（`tools.guard` 存在）
 * @param {boolean} facts.lockMounted 全局请求锁定是否已安装
 * @param {boolean} facts.ledgerReady 台账是否可用
 * @param {boolean} facts.lineageKnown 谱系是否可完整解析
 * @param {boolean} [facts.reservedChildId] 后端是否支持预置 childId（本次派出的形态）
 * @param {boolean} [facts.reservationHonoured] 这次是否真的按预置 id 创建成功
 * @param {boolean} [facts.catalogReadable] 入口目录是否可读
 * @param {boolean} [facts.snapshotFrozen] 受管根快照是否已冻结
 * @returns {{level: string, label: string, complete: boolean, reasons: Array<object>, summary: string}}
 */
export function computeAssurance(facts = {}) {
  const reasons = [];

  // ── 决定性的一层：没有守卫就等于没有入口治理 ────────────────────────────
  //
  // 这是唯一会让等级落到「不可派出」的条件之一：受管会话的原生派生入口
  // 完全不受拦，那已经不是"降级"，而是"这个插件没在工作"。
  if (facts.guardMounted === false) {
    reasons.push(degradation(
      'guard',
      '宿主没有提供 `tools.guard`，受管会话的原生派生入口不会被拦截',
      undefined, // 用户改不了：这是宿主版本问题
    ));
  }
  if (facts.ledgerReady === false) {
    reasons.push(degradation(
      'ledger',
      '派出台账不可用，「先记账再派出」与跨重启解释都做不到',
      '检查存储服务是否正常；台账打不开时插件拒绝派出（这是刻意的）',
    ));
  }

  // ── 降级（配置）：用户能改的 ─────────────────────────────────────────────
  if (facts.reservedChildId === false) {
    reasons.push(degradation(
      'reservation',
      '当前子智能体后端不支持预置子会话 id，派出与登记之间存在极短窗口',
      '改用默认 `spawn` 后端（它实现了 `prepareContinuable`），或在 `providerName` 上换一个支持的后端',
    ));
  } else if (facts.reservationHonoured === false) {
    reasons.push(degradation(
      'reservation',
      '宿主没有按预置的子会话 id 创建（返回了别的 id），登记因此发生在创建之后',
      '这是宿主行为，通常意味着后端被替换过；请核对 `providerName` 与该后端的实现',
    ));
  }
  if (facts.snapshotFrozen === false) {
    reasons.push(degradation(
      'snapshot',
      '受管根的路由快照尚未冻结，本次按当前全局集合派出',
      '正常使用一次派出或调整 `snapshotEpoch` 即可冻结',
    ));
  }

  // ── 降级（环境）：用户改不了的 ───────────────────────────────────────────
  if (facts.lockMounted === false) {
    reasons.push(degradation(
      'lock',
      '无法挂载请求级锁定（宿主缺少 `agent/request` 事件）',
      undefined,
    ));
  }
  if (facts.lineageKnown === false) {
    reasons.push(degradation(
      'lineage',
      '谱系只能解析一层（`sessions` 服务不可用），孙级的受管判定可能不完整',
      undefined,
    ));
  }
  if (facts.catalogReadable === false) {
    reasons.push(degradation(
      'catalog',
      '入口目录读不出来，覆盖诊断处于 degraded 状态',
      undefined,
    ));
  }

  // ── 定级 ─────────────────────────────────────────────────────────────────
  //
  // 顺序有讲究：`unavailable` 只在「守卫缺失或台账缺失」时出现——这两条
  // 是**承诺本身**不成立，不是"承诺打了个折"。
  const unavailable = facts.guardMounted === false || facts.ledgerReady === false;
  const env = reasons.some((r) => !r.fixable);
  const config = reasons.some((r) => r.fixable);

  const level = unavailable
    ? 'unavailable'
    : env
      ? 'degraded-env'
      : config
        ? 'degraded-config'
        : 'full';

  return {
    level,
    label: ASSURANCE_LABELS[level],
    complete: level === 'full',
    reasons,
    summary: summarize(level, reasons),
  };
}

/**
 * 一行摘要（回执与状态都用它，保证两处说同一句话）。
 * @param {string} level
 * @param {ReadonlyArray<object>} reasons
 * @returns {string}
 */
function summarize(level, reasons) {
  if (level === 'full') return '本套保证：完整（入口治理、请求锁定、台账、谱系全部成立）';
  const label = ASSURANCE_LABELS[level];
  if (reasons.length === 0) return `本套保证：${label}`;
  return `本套保证：${label} — ${reasons.map((r) => r.reason).join('；')}`;
}

/**
 * 把保证等级渲染成多行（`station_status` 用）。
 *
 * @param {ReturnType<typeof computeAssurance>} assurance
 * @returns {Array<string>}
 */
export function renderAssurance(assurance) {
  const lines = [`保证等级：${assurance.label}`];
  for (const reason of assurance.reasons) {
    lines.push(`  · [${reason.layer}] ${reason.reason}`);
    if (reason.fix !== undefined) lines.push(`    修复：${reason.fix}`);
  }
  return lines;
}
