/**
 * 拒绝文案的**单一来源**（方案 §6.2）。
 *
 * 为什么需要它：v0.3 同一个错误码在三个地方各写一遍文案——
 * 全局守卫的返回值、`dispatch` 的 catch、`station_status` 的 dry-run。
 * 三处一旦漂移，用户看到的"同一件事"就有了三种说法，而错误码存在的唯一理由
 * 就是让它们说同一句话。
 *
 * ### 与宿主的一处硬约束（C6）
 *
 * guard 返回的字符串会被宿主渲染成 `Error: <reason>`，**`StationError.code` 不会被保留**
 * （`.host-src/dsh-tools.js:3339-3353`）。所以码必须写进文案本身，否则用户看到的
 * 就是一句没有名字的自然语言。
 *
 * 因此本模块的输出一律形如：
 *
 *     派出所[STATION_TARGET_UNKNOWN]：目标「x」…
 *     修复：…
 *
 * 前半段给机器与日志（可 `grep`、可断言），后半段给人。
 */
import { ERROR_CODES, StationError } from './policy.js';

/**
 * 每个码的「一句话定位」（`hint`）+「该做什么」（`fix`）。
 *
 * 只放**码级别的通用**部分；具体到某次拒绝的编号、id、可用候选由调用方通过
 * `details` 注入，`message` 仍是 `StationError` 自带的完整说明。
 *
 * 这张表同时是**归位表**的运行时副本：`ERROR_CODES` 里每个码都必须在这里有一行，
 * `tests/unit/v04-error-codes.test.js` 会核对——漏一个就红。
 * 这样"新增错误码"和"新增可诊断文案"不会脱节。
 */
export const REFUSAL_HINTS = Object.freeze({
  [ERROR_CODES.ROLE_NOT_FOUND]: {
    hint: '请求的岗位不在当前配置里',
    fix: '先调用 `dispatch_roles` 查看可用岗位，再改用其中之一的 `roleId`。',
  },
  [ERROR_CODES.ROLE_DISABLED]: {
    hint: '该岗位已被用户禁用',
    fix: '这不是调用方能修的：请让用户在设置里重新启用该岗位。',
  },
  [ERROR_CODES.FIXED_ROLE_OVERRIDE]: {
    hint: '该岗位是固定模型，不接受路由覆盖',
    fix: '移除 `routeId` 参数后重试；要换模型请让用户改岗位配置。',
  },
  [ERROR_CODES.ROUTE_NOT_ALLOWED]: {
    hint: '路由存在，但这个岗位没有授权它',
    fix: '改派到被授权的岗位，或让用户把该路由加入该岗位的白名单。',
  },
  [ERROR_CODES.ROUTE_UNKNOWN]: {
    hint: '路由标识写错了（任何路由表里都没有）',
    fix: '让用户核对路由标识；`station_status` 会列出当前已配置的全部路由。',
  },
  [ERROR_CODES.ROUTE_NOT_EFFECTIVE]: {
    hint: '岗位授权了，但被全局/快照/官方三层收窄掉了',
    fix: '让用户检查「全局允许路由」、「快照代数（snapshotEpoch）」与官方模型白名单这三层。',
  },
  [ERROR_CODES.DEFAULT_ROUTE_INVALID]: {
    hint: '岗位的默认路由配错了',
    fix: '这是配置错误：请让用户修正该岗位的 `defaultRouteId`。',
  },
  [ERROR_CODES.EMPTY_EFFECTIVE_SET]: {
    hint: '四层求交后没有任何可用路由',
    fix: '让用户扩充全局允许路由，或为该岗位选一个交集内的默认路由。',
  },
  [ERROR_CODES.EFFORT_UNSUPPORTED]: {
    hint: '该路由不支持请求的思考强度',
    fix: '移除 `reasoningEffort`（让适配器取默认），或改用 `station_status` 列出的受支持强度。',
  },
  [ERROR_CODES.NOT_MANAGED_SESSION]: {
    hint: '当前会话不在受管范围内',
    fix: '让用户把本会话的根会话 id 加入 `managedSessionIds`，或开启 `manageAllNewRoots`。',
  },
  [ERROR_CODES.NESTED_DISPATCH_FORBIDDEN]: {
    hint: '受管子智能体不允许再派下一层',
    fix: '把需要委派的工作带回主会话处理。',
  },
  [ERROR_CODES.CONFIG_CONFLICT]: {
    hint: '配置内部自相矛盾',
    fix: '这是配置错误：`station_status` 会逐条列出冲突，请让用户按其修正。',
  },
  [ERROR_CODES.START_FAILED]: {
    hint: '宿主拒绝了这次创建',
    fix: '看回执里的原因；常见原因是深度上限或父会话已结束。',
  },
  [ERROR_CODES.OFFICIAL_POLICY_CONFLICT]: {
    hint: '岗位路由与官方白名单没有交集',
    fix: '插件只读官方设置、不会代为扩大：请让用户调整官方白名单，或改派到被官方允许的岗位。',
  },
  [ERROR_CODES.LEDGER_UNAVAILABLE]: {
    hint: '派出台账读不出来',
    fix: '没有台账就无法保证「派了必有记录」，因此一律拒绝。请检查存储服务；'
      + '这是刻意的 fail-closed，不是偶发故障。',
  },
  [ERROR_CODES.COVERAGE_INCOMPLETE]: {
    hint: '出现了目录外的派生入口，且严格覆盖模式已开启',
    fix: '让用户把该名字加入 `blockedToolNames`（确认要拦）或升级插件目录（确认是已知入口）。',
  },
  [ERROR_CODES.BACKEND_INCAPABLE]: {
    hint: '当前子智能体后端不支持必要的启动能力',
    fix: '让用户改用支持 `agentOptions` 的后端，或修正 `providerName`。',
  },
  [ERROR_CODES.TARGET_UNKNOWN]: {
    hint: '目标 agent 无法解析（不存在，或不在本受管会话的台账里）',
    fix: '先用 `station_status` 核对子会话 id；发消息给一个插件无法解释的 agent，'
      + '插件就无法为它的模型路由背书，因此拒绝。',
  },
  [ERROR_CODES.TARGET_FOREIGN]: {
    hint: '目标是另一个受管根的子会话',
    fix: '跨根投递等于绕过授权：请回到那个子会话所属的根会话里发消息。',
  },
  [ERROR_CODES.UNMANAGED_CHILD]: {
    hint: '受管谱系内的子会话，但台账里没有它的登记',
    fix: '这通常意味着一次绕过入口的创建。请让用户用 `station_status` 查「漏网」计数并核对会话记录。',
  },
  [ERROR_CODES.LINEAGE_MISMATCH]: {
    hint: '台账记录的归属根与现在算出来的根不一致',
    fix: '谱系被改写过（resume/clear/换父）。插件不会猜哪个才对，因此拒绝；'
      + '请让用户用 `station_status` 核对后再决定是否重建登记。',
  },
  [ERROR_CODES.LINEAGE_UNKNOWN]: {
    hint: '谱系算不出来（父会话已不可达）',
    fix: '这不是调用方能修的：fail-closed 下无法确认归属就不放行。请检查该子会话的父会话是否还存在。',
  },
  [ERROR_CODES.POLICY_UNREADABLE]: {
    hint: '判定所依赖的输入读不出来',
    fix: '插件在无法判定时一律拒绝（fail-closed）。请检查配置、入口目录与台账是否可读。',
  },
  [ERROR_CODES.INTERNAL]: {
    hint: '插件内部出现了未归类的失败',
    fix: '请把这条输出连同 `station_status` 一起反馈；在此之前不要假定受管保证仍然成立。',
  },
});

/**
 * 把任意抛出品归一化成**可直接展示**的拒绝描述。
 *
 * 三个消费点全部走这里：全局守卫文案、`dispatch` 的 catch、`station_status` 的 dry-run。
 *
 * @param {unknown} error 任何抛出品（`StationError` / `Error` / 字符串 / 其它）
 * @param {object} [options]
 * @param {boolean} [options.includeFix] 是否附上「修复」行（默认 true）
 * @returns {{code: string, message: string, hint: string, fix: string, isStation: boolean, text: string}}
 */
export function describeRefusal(error, options = {}) {
  const includeFix = options.includeFix !== false;

  // 非 StationError：如实说是插件没预料到的失败，不假装它有业务错误码。
  //
  // 但仍然给它一个**稳定**的码 `STATION_INTERNAL`，理由有三：
  // 1. 调用方（`renderDryRunRefusal`）需要一个可渲染的 code，空串会渲染成
  //    `决定：无法判定（：…）`——那个冒号前面什么都没有，是明显的半成品；
  // 2. 用户可以按这个码去搜；
  // 3. 它明确区别于所有"判定完成"的码，所以我们不会把它误报成"拒绝"。
  if (!(error instanceof StationError) && !(typeof error?.code === 'string' && error.code.startsWith('STATION_'))) {
    const message = String(error?.message ?? error ?? '未知错误');
    const hint = '插件内部出现了未归类的失败';
    const fix = '请把这条输出连同 `station_status` 一起反馈；在此之前不要假定受管保证仍然成立。';
    return {
      code: ERROR_CODES.INTERNAL,
      message,
      hint,
      fix,
      isStation: false,
      text: buildText({ code: ERROR_CODES.INTERNAL, message, hint, fix }, includeFix),
    };
  }

  const code = String(error.code);
  const message = String(error?.message ?? '');
  const table = REFUSAL_HINTS[code];
  // 码存在但文案表漏了：仍然给出一行可展示的文本，但不假装有 hint——
  // 缺行会被 `v04-error-codes.test.js` 判红，这里只是不让它变成崩溃。
  const hint = table?.hint ?? '（该错误码缺少可诊断文案）';
  const fix = table?.fix ?? '（该错误码缺少修复建议）';

  return {
    code,
    message,
    hint,
    fix,
    isStation: true,
    text: buildText({ code, message, hint, fix }, includeFix),
  };
}

/**
 * 拼出面向用户的正文。格式固定，便于断言与 `grep`：
 *
 *     派出所[STATION_TARGET_UNKNOWN]：目标「child-9」不在台账里
 *     说明：目标 agent 无法解析（不存在，或不在本受管会话的台账里）
 *     修复：先用 `station_status` …
 *
 * @param {object} parts
 * @returns {string}
 */
function buildText({ code, message, hint, fix }, includeFix) {
  const head = code === '' ? `派出所：${message}` : `派出所[${code}]：${message}`;
  const lines = [head, `说明：${hint}`];
  if (includeFix) lines.push(`修复：${fix}`);
  return lines.join('\n');
}

/**
 * guard 的返回值必须是一行紧凑文案（宿主渲染成 `Error: <reason>`，多行会很吵）。
 *
 * 但紧凑不等于丢失信息：码 + 说明 + 修复三步都要在，只是不用换行分隔。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function refusalLine(error) {
  const described = describeRefusal(error);
  if (!described.isStation) return `派出所：${described.message}（修复：${described.fix}）`;
  return `派出所[${described.code}]：${described.message}（修复：${described.fix}）`;
}
