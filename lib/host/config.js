/**
 * 宿主端 Config：在 DSH 0.2.x 上，插件的 `Config` 就是它的设置段。
 *
 * 两个来自参考插件的硬约束（`dsh-subagent-default-model` 的源码注释记录过）：
 *
 * 1. 每个字段都必须有 `.default(...)`。设置表面由 `projectForm()` 生成，它会
 *    丢弃解析为 `undefined` 的字段；裸 `z.string()` 会让该字段完全不出现在
 *    设置卡片能读写的描述里。
 * 2. 每个可写字段都必须标记 volatile，否则设置写入闸门会以
 *    `Config field "…" is not volatile` 拒绝保存。`volatile()` 是 schemastery
 *    3.18.4 的糖；3.18.1 上回退到等价的 `extra('volatile', true)`。
 */
import z from '@deepseek-ai/schemastery';

/**
 * 把一个 schemastery 字段标记为 volatile。
 * @param {object} schema
 * @returns {object} 已标记的字段（无法标记时原样返回）
 */
export function volatileField(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  if (typeof schema?.extra === 'function' && schema.meta?.volatile !== true) {
    return schema.extra('volatile', true);
  }
  return schema;
}

/**
 * 一条可授权路由：精确的供应商/模型组合，外加它为这条路由声明的思考强度。
 *
 * 注意：这里**不**给子字段加 volatile。schemastery 3.18.5 会直接拒绝
 * 「volatile 字段位于数组元素内」的 schema：
 *   `$.allowedRoutes.*.routeId volatile fields require a fixed object path ...`
 * volatile 只标在顶层字段上（host 的热更新以整段字段为单位）。
 */
const ROUTE_SCHEMA = z.object({
  routeId: z.string().default('').description('插件内的路由标识，唯一；实际授权按完整 provider/model 组合判断'),
  provider: z.string().default('').description('供应商标识，与官方模型选择设置同名'),
  model: z.string().default('').description('模型标识'),
  efforts: z.array(z.string()).default([]).description('这条路由允许的思考强度；留空表示不向调用者提供强度选择'),
  defaultEffort: z.string().default('').description('这条路由的默认思考强度；必须出现在 efforts 中'),
});

/** 一个岗位：标识、用途、模式与路由授权。 */
const ROLE_SCHEMA = z.object({
  roleId: z.string().default('').description('稳定的岗位标识'),
  label: z.string().default('').description('岗位显示名称'),
  description: z.string().default('').description('岗位用途，供主智能体选择岗位时阅读'),
  enabled: z.boolean().default(true).description('禁用后禁止新派出；不会中断已在运行的任务'),
  mode: z.union([z.const('fixed'), z.const('allowlist')]).default('fixed').description('fixed 只使用默认路由；allowlist 可在白名单内选择'),
  defaultRouteId: z.string().default('').description('默认路由标识；fixed 模式下它就是唯一允许的路由'),
  allowedRouteIds: z.array(z.string()).default([]).description('白名单模式允许的路由标识'),
});

export const StationConfig = z.object({
  managedSessionIds: volatileField(z.array(z.string()).default([]).description(
    '显式启用受管模式的根会话 ID。为空时只对当前会话生效（见 managedScope）。初次安装不会接管任何既有会话。',
  )),
  allowedRoutes: volatileField(z.array(ROUTE_SCHEMA).default([]).description(
    '插件全局允许的精确供应商/模型组合。必须与岗位授权取交集；插件不会自动扩大官方白名单。',
  )),
  roles: volatileField(z.array(ROLE_SCHEMA).default([]).description(
    '岗位列表。未配置完成前不允许派出，也不会预置任何真实付费模型。',
  )),
  requireManagedSession: volatileField(z.boolean().default(true).description(
    '为 true 时，只有受管会话内的调用者才能派出子智能体。',
  )),
  forbidNestedDispatch: volatileField(z.boolean().default(true).description(
    '为 true 时，受管子智能体不允许创建下一层子智能体。',
  )),
  blockNativeDelegation: volatileField(z.boolean().default(true).description(
    '为 true 时，受管根会话禁止使用原生派出入口（subagent / subagent_fork / workflow），必须改走 dispatch_agent。'
    + '关闭它会让受管会话的模型路由失去保证，只用于兼容既有工作流。',
  )),
  strictCoverage: volatileField(z.boolean().default(false).description(
    '为 true 时，一旦发现目录外的派生工具就拒绝派出（而不是仅告警）。',
  )),
  blockedToolNames: volatileField(z.array(z.string()).default([]).description(
    '补充要拦截的派生入口名（私有工具）。这些名字总按「受管会话一律拒绝」处理，并计入覆盖诊断。',
  )),
  providerName: volatileField(z.string().default('spawn').description(
    '子智能体后端名。默认 spawn（@deepseek-ai/dsh-subagent-spawn-in-process）。'
    + '改名部署时必须同步这里，否则派出会以 STATION_BACKEND_INCAPABLE 拒绝。',
  )),
  receiptLimit: volatileField(z.number().default(50).description('台账保留的回执条数上限')),
  // ── v0.3 新增（方案 §11.1）────────────────────────────────────────────────
  // 三个字段都有默认值，旧配置读进来不需要迁移。
  unknownEntryPolicy: volatileField(
    z.union([z.const('block-delegation-like'), z.const('allow'), z.const('deny-all')])
      .default('block-delegation-like')
      .description(
        '目录外入口的默认处理。block-delegation-like（默认）拦名字像派生入口的（只作用于子会话）；'
        + 'allow 全部放行（仅进诊断清单）；deny-all 拦全部目录外入口（最严，可能误伤普通工具）。',
      ),
  ),
  snapshotEpoch: volatileField(z.number().default(0).description(
    '受管根快照的重建代数。改动这个数字会强制所有受管根按当前 allowedRoutes 重新冻结，'
    + '这是唯一会让「放宽」生效的入口。台账里会记录每根冻结时的代数。',
  )),
  manageAllNewRoots: volatileField(z.boolean().default(false).description(
    '为 true 时，新建的**根**会话自动纳入受管（子会话本就随根）。'
    + '默认 false，行为与 v0.2 完全一致：必须先把自己的会话 id 抄进 managedSessionIds。',
  )),
}).default({});

/** 插件导出的 Config。 */
export const Config = StationConfig;
