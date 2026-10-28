/**
 * 错误码：每一类拒绝都有稳定的插件错误码，便于测试断言与前端分类。
 * 说明文案保持中文（方案 9.1：稳定错误码 + 中文说明）。
 *
 * ### v0.3 审计（方案 §6.6、§12）
 *
 * 原则：**错误码表 = 可触发行为的清单，不是概念清单。** 一个不会抛出的错误码
 * 等于一句空承诺。本轮删掉了三个从未 `throw` 的码：
 *
 * | 码 | 为什么删 |
 * | --- | --- |
 * | `STATION_POLICY_DEVIATION` | 偏离**从不阻断**请求，只是记录（`request-lock.js` 写 `deviations` 表）。背离的可见性由 `station_status` 的「最近偏离」承担，不需要一个抛不出的码。 |
 * | `STATION_ROLE_NOT_CONFIGURED` | 概念上被 `STATION_CONFIG_CONFLICT` 与 `STATION_ROLE_NOT_FOUND` 完全覆盖，v0.2 从未抛出。 |
 * | `STATION_STORAGE_UNAVAILABLE` | 与 `STATION_LEDGER_UNAVAILABLE` 是同一个事实的两个名字。台账就是插件唯一的存储，留一个才不会让调用方猜该认哪个。 |
 *
 * 剩下的每个码都在 `lib/` 里至少有一个 `throw`（`tests/unit/error-codes.test.js` 会核对）。
 *
 * ### v0.4 归位（方案 §6.1，问题 7）
 *
 * v0.3 的判据是「每个码至少有一处 `throw`」，太弱——问题 7 正是"码存在、也抛了，
 * 但抛在不该抛的地方"。v0.4 改成**每个码只有一个触发情形**，并新增三个必须分开的码：
 *
 * | 码 | 唯一触发情形 | 修复动作 |
 * | --- | --- | --- |
 * | `ROUTE_UNKNOWN` | `routeId` 在任何岗位与全局路由表里都不存在 | 抄对 id |
 * | `ROUTE_NOT_ALLOWED` | id 存在，但不在该岗位允许集合内 | 改岗位配置 |
 * | `ROUTE_NOT_EFFECTIVE` | 被岗位允许，但被全局/快照/官方收窄 | 查全局那三层 |
 * | `TARGET_UNKNOWN` | 条件允许入口的目标 agent 无法解析 | 查 childId |
 * | `TARGET_FOREIGN` | 目标属于别的受管根 | 换根 |
 * | `UNMANAGED_CHILD` | 受管谱系内、未登记的子会话发起请求 | 查台账 |
 * | `LINEAGE_MISMATCH` | 台账 `rootSessionId` 与现算谱系不一致 | 查台账/谱系 |
 * | `LINEAGE_UNKNOWN` | 谱系算不出来（父会话不可达） | 宿主状态 |
 * | `POLICY_UNREADABLE` | 判定所依赖的输入读不出来（fail-closed 的统一出口） | 查配置/存储 |
 *
 * 这三个码对用户的**修复动作完全不同**——给同一个码等于让用户猜。
 *
 * ### v0.4 删除的一个码
 *
 * | 码 | 为什么删 |
 * | --- | --- |
 * | `STATION_UNKNOWN_CHILD` | 与新的 `STATION_UNMANAGED_CHILD` 是同一个事实的两个名字。v0.3 用它表示"子会话不在台账里"，而 v0.4 必须把这件事与"根本不归我管"分开（后者由 L3 的管辖区判定处理，不抛码）。同名二义正是 v0.3 删 `STORAGE_UNAVAILABLE` 时的同一个理由。 |
 */
export const ERROR_CODES = Object.freeze({
  ROLE_NOT_FOUND: 'STATION_ROLE_NOT_FOUND',
  ROLE_DISABLED: 'STATION_ROLE_DISABLED',
  FIXED_ROLE_OVERRIDE: 'STATION_FIXED_ROLE_OVERRIDE',
  /** 存在但不在岗位允许集合内（改岗位配置）。 */
  ROUTE_NOT_ALLOWED: 'STATION_ROUTE_NOT_ALLOWED',
  /** 在任何路由表里都不存在（抄错 id）。 */
  ROUTE_UNKNOWN: 'STATION_ROUTE_UNKNOWN',
  /** 被岗位允许，但被全局/快照/官方收窄（查全局那三层）。v0.4 从 NOT_ALLOWED 拆出。 */
  ROUTE_NOT_EFFECTIVE: 'STATION_ROUTE_NOT_EFFECTIVE',
  DEFAULT_ROUTE_INVALID: 'STATION_DEFAULT_ROUTE_INVALID',
  EMPTY_EFFECTIVE_SET: 'STATION_EMPTY_EFFECTIVE_SET',
  EFFORT_UNSUPPORTED: 'STATION_EFFORT_UNSUPPORTED',
  NOT_MANAGED_SESSION: 'STATION_NOT_MANAGED_SESSION',
  NESTED_DISPATCH_FORBIDDEN: 'STATION_NESTED_DISPATCH_FORBIDDEN',
  CONFIG_CONFLICT: 'STATION_CONFIG_CONFLICT',
  START_FAILED: 'STATION_START_FAILED',
  // v0.2 新增（方案 9.1）
  OFFICIAL_POLICY_CONFLICT: 'STATION_OFFICIAL_POLICY_CONFLICT',
  LEDGER_UNAVAILABLE: 'STATION_LEDGER_UNAVAILABLE',
  COVERAGE_INCOMPLETE: 'STATION_COVERAGE_INCOMPLETE',
  BACKEND_INCAPABLE: 'STATION_BACKEND_INCAPABLE',
  // v0.4 新增（方案 §6.1）——入口守卫的目标校验与谱系校验
  /** 条件允许入口（`send_message` 等）的目标 agent 无法解析。 */
  TARGET_UNKNOWN: 'STATION_TARGET_UNKNOWN',
  /** 目标属于别的受管根（跨根注入）。 */
  TARGET_FOREIGN: 'STATION_TARGET_FOREIGN',
  /** 受管谱系内、但台账里没有登记的子会话发起了请求。 */
  UNMANAGED_CHILD: 'STATION_UNMANAGED_CHILD',
  /** 台账记录的 `rootSessionId` 与现算谱系不一致。 */
  LINEAGE_MISMATCH: 'STATION_LINEAGE_MISMATCH',
  /** 谱系算不出来（父会话不在 `sessions` 里，且不是根）。 */
  LINEAGE_UNKNOWN: 'STATION_LINEAGE_UNKNOWN',
  /** 判定所依赖的输入读不出来（配置/目录/台账）。fail-closed 的统一出口。 */
  POLICY_UNREADABLE: 'STATION_POLICY_UNREADABLE',
  /** 插件内部未归类的失败（`describeRefusal` 的归一化出口，不是业务判定结果）。 */
  INTERNAL: 'STATION_INTERNAL',
});

/** 稳定的策略拒绝：携带错误码与中文说明。 */
export class StationError extends Error {
  /**
   * @param {string} code ERROR_CODES 之一
   * @param {string} message 面向用户/模型的中文说明
   * @param {object} [details] 可选的结构化细节（如可用候选）
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'StationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 思考强度取值：不假设所有模型都支持这三档，是否兼容由调用方按适配器信息判定。 */
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);

/** 岗位模式。 */
export const ROLE_MODES = Object.freeze(['fixed', 'allowlist']);

/**
 * 路由标识的唯一键：完整供应商/模型组合。
 * 方案 T04 要求「同名模型来自未授权供应商」不被按模型名误判，因此键必须含 provider。
 * @param {{provider: string, model: string}} route
 * @returns {string} `provider/model`
 */
export function routeKey(route) {
  return `${route.provider}/${route.model}`;
}

/**
 * 校验单条路由的结构是否完整。
 * @param {unknown} route
 * @returns {boolean}
 */
export function isCompleteRoute(route) {
  return (
    route !== null
    && typeof route === 'object'
    && typeof route.provider === 'string'
    && route.provider.length > 0
    && typeof route.model === 'string'
    && route.model.length > 0
  );
}

/**
 * 从岗位配置里取出「岗位允许的路由集合」。
 * 固定模式：只有默认路由；白名单模式：allowedRouteIds 对应的路由。
 * @param {object} role 已归一化的岗位
 * @param {Map<string, object>} routesById 全局路由表 routeId -> route
 * @returns {Array<object>} 路由对象数组（保持声明顺序）
 */
export function roleAllowedRoutes(role, routesById) {
  const ids = role.mode === 'fixed' ? [role.defaultRouteId] : role.allowedRouteIds;
  const result = [];
  for (const id of ids) {
    const route = routesById.get(id);
    if (route !== undefined) result.push(route);
  }
  return result;
}

/**
 * 归一化官方模型策略（方案 4.2）。
 *
 * 官方 `subagentModelSelection.current()` 返回 `{ enabled, allowedModels }`。
 * 三条规则必须在这里一次写死，避免调用方各自解释：
 * - 服务不存在（`undefined`）→ 视为「这一层不存在」，`status: 'absent'`；
 * - `enabled === false` → 同样视为「这一层不存在」，`status: 'disabled'`，
 *   **不是**「全拒绝」；
 * - `enabled === true` 且允许列表为空 → 官方自己的 `current()` 会抛错，
 *   走到这里说明配置不一致，按「全拒绝」处理（`status: 'empty'`），
 *   因为「启用了白名单却什么都没允许」只可能是配置错误，放行更危险。
 *
 * @param {{enabled: boolean, allowedModels: ReadonlyArray<{provider: string, model: string}>}|undefined} selection
 * @returns {{status: 'absent'|'disabled'|'enforced'|'empty', routes: Array<{provider: string, model: string}>}}
 */
export function normalizeOfficialPolicy(selection) {
  if (selection === undefined || selection === null) return { status: 'absent', routes: [] };
  if (selection.enabled !== true) return { status: 'disabled', routes: [] };
  const routes = [];
  for (const raw of selection.allowedModels ?? []) {
    if (!isCompleteRoute(raw)) continue;
    routes.push({ provider: raw.provider, model: raw.model });
  }
  return { status: routes.length === 0 ? 'empty' : 'enforced', routes };
}

/**
 * 计算派出时的有效路由集合（方案 4.2）：
 *
 *  岗位允许集合 ∩ 插件全局允许集合 ∩ 受管会话策略快照 ∩ 官方会话允许集合
 *
 * `officialRoutes` 只在官方策略**启用**时传入；`absent`/`disabled` 传 `undefined`，
 * 表示这一层不参与求交（方案 4.2：「官方 enabled: false 时，这一层视为不存在」）。
 *
 * @param {object} args
 * @param {object} args.role 岗位
 * @param {Map<string, object>} args.routesById 全局路由表
 * @param {ReadonlyArray<object>} args.globalAllowedRoutes 插件全局允许路由
 * @param {ReadonlyArray<object>} args.snapshotRoutes 受管会话的策略快照路由
 * @param {ReadonlyArray<object>} [args.officialRoutes] 官方会话允许路由（存在时参与求交）
 * @returns {Array<object>} 有效路由，保持岗位声明顺序
 */
export function effectiveRoutes({ role, routesById, globalAllowedRoutes, snapshotRoutes, officialRoutes }) {
  const layers = [globalAllowedRoutes, snapshotRoutes];
  if (officialRoutes !== undefined) layers.push(officialRoutes);

  const allowedKeys = layers.map((layer) => new Set(layer.map(routeKey)));
  return roleAllowedRoutes(role, routesById).filter((route) => {
    const key = routeKey(route);
    return allowedKeys.every((set) => set.has(key));
  });
}

/**
 * 官方策略把岗位的全部候选路由都排除时，给出可诊断的拒绝（方案 4.2、9.1）。
 *
 * 只在「岗位本来有候选、但被官方层全部排除」时返回错误；
 * 岗位自己没配好路由属于 `findConfigConflicts` 的职责，不在这里重复报。
 *
 * @param {object} args
 * @param {object} args.role
 * @param {Map<string, object>} args.routesById
 * @param {ReadonlyArray<object>} args.globalAllowedRoutes
 * @param {ReadonlyArray<object>} args.snapshotRoutes
 * @returns {StationError|undefined}
 */
export function officialConflictReason({ role, routesById, globalAllowedRoutes, snapshotRoutes }) {
  const withoutOfficial = effectiveRoutes({ role, routesById, globalAllowedRoutes, snapshotRoutes });
  if (withoutOfficial.length === 0) return undefined;
  return new StationError(
    ERROR_CODES.OFFICIAL_POLICY_CONFLICT,
    `岗位「${role.label ?? role.roleId}」与官方「子智能体模型选择」策略没有交集：`
    + `本插件允许 ${withoutOfficial.map((r) => routeKey(r)).join(' / ')}，`
    + '但官方策略没有允许其中任何一个。'
    + '插件只读官方设置、不会代为扩大；请让用户调整官方白名单，或改派到被官方允许的岗位。',
    { stationRoutes: withoutOfficial.map((r) => ({ ...r })) },
  );
}

/**
 * 解析一次派出请求最终要使用的路由。
 *
 * 规则（方案 5.2）：
 * - 固定模式：不提供覆盖时用默认值；显式选择同一路由可接受；选择别的必须报错，不静默纠正。
 * - 白名单模式：可选择岗位集合内、且有效集合内的路由；未选择时用岗位默认值。
 * - 未指定时一律使用岗位默认值，绝不隐式继承父会话路由。
 *
 * @param {object} args
 * @param {object} args.role 岗位
 * @param {object|undefined} args.roleRouteId 省略 `undefined`
 * @param {ReadonlyArray<object>} args.effective 有效路由（四层求交后）
 * @param {object|undefined} args.defaultRoute 岗位默认路由（不在有效集合内时为 undefined）
 * @param {Map<string, object>} [args.routesById] 全局路由表；用于把「不存在」与「未授权」分开。
 *   省略时退化为 v0.3 行为（不区分 `ROUTE_UNKNOWN`），保留是为了不打断既有调用方。
 * @returns {{route: object, reason: string}}
 *
 * @throws {StationError} `ROUTE_UNKNOWN` / `ROUTE_NOT_ALLOWED` / `ROUTE_NOT_EFFECTIVE` /
 *   `FIXED_ROLE_OVERRIDE` / `EMPTY_EFFECTIVE_SET`——每个码只对应一种情形（方案 §6.1）。
 */
export function resolveRoute({ role, roleRouteId, effective, defaultRoute, routesById }) {
  const effectiveKeys = new Set(effective.map(routeKey));

  if (roleRouteId === undefined || roleRouteId === null || roleRouteId === '') {
    if (defaultRoute === undefined) {
      throw new StationError(
        ERROR_CODES.EMPTY_EFFECTIVE_SET,
        `岗位「${role.label ?? role.roleId}」的默认路由不在当前有效授权集合内（岗位授权与全局/会话策略的交集为空）。`
        + '请让用户检查全局允许路由，或为该岗位选择一个交集内的默认路由。',
      );
    }
    return { route: defaultRoute, reason: 'role-default' };
  }

  if (role.mode === 'fixed') {
    if (roleRouteId !== role.defaultRouteId) {
      throw new StationError(
        ERROR_CODES.FIXED_ROLE_OVERRIDE,
        `岗位「${role.label ?? role.roleId}」采用固定模型，不能改为请求的路由「${roleRouteId}」。`
        + '请移除路由覆盖后重试，或让用户修改岗位配置。',
        { defaultRouteId: role.defaultRouteId },
      );
    }
    if (defaultRoute === undefined || !effectiveKeys.has(routeKey(defaultRoute))) {
      throw new StationError(
        ERROR_CODES.EMPTY_EFFECTIVE_SET,
        `岗位「${role.label ?? role.roleId}」的固定路由不在当前有效授权集合内。`,
      );
    }
    return { route: defaultRoute, reason: 'fixed-role' };
  }

  // 白名单模式：三条拒绝必须分开（方案 §6.1 的归位表）。
  //
  // v0.3 对「不在白名单」与「不在有效集合」都抛 `ROUTE_NOT_ALLOWED`，而
  // `ROUTE_UNKNOWN` 只在配置冲突的描述里用过。用户拿到同一个码要自己猜是
  // 抄错 id、改岗位配置、还是查全局那三层——三种修复动作完全不同。
  const declared = new Set(role.allowedRouteIds);

  // 第一关：这个 id 到底存不存在？传了 `routesById` 才判得了。
  if (routesById !== undefined && !declared.has(roleRouteId) && !routesById.has(roleRouteId)) {
    throw new StationError(
      ERROR_CODES.ROUTE_UNKNOWN,
      `路由「${roleRouteId}」在任何路由表里都不存在（全局 ${routesById.size} 条、`
      + `岗位「${role.label ?? role.roleId}」声明 ${role.allowedRouteIds.length} 条）。`
      + '请让用户核对路由标识是否写错。',
      { requested: roleRouteId, knownRouteIds: [...routesById.keys()] },
    );
  }

  // 第二关：存在，但这个岗位没授权它。
  if (!declared.has(roleRouteId)) {
    throw new StationError(
      ERROR_CODES.ROUTE_NOT_ALLOWED,
      `路由「${roleRouteId}」不在岗位「${role.label ?? role.roleId}」允许的路由列表内。`
      + '该路由确实存在，只是这个岗位没有授权它；请改派到被授权的岗位，或让用户把该路由加入岗位白名单。',
      { allowedRouteIds: [...role.allowedRouteIds] },
    );
  }

  // 第三关：岗位授权了，但被全局/快照/官方收窄。
  const picked = effective.find((route) => {
    return route.routeId === roleRouteId;
  });
  if (picked === undefined) {
    throw new StationError(
      ERROR_CODES.ROUTE_NOT_EFFECTIVE,
      `路由「${roleRouteId}」被岗位允许，但不在当前有效授权集合内（受全局允许路由、受管会话快照或官方策略收窄）。`
      + `当前有效集合：${effective.length > 0 ? effective.map((route) => route.routeId).join(' / ') : '（空）'}。`
      + '请让用户检查全局允许路由、快照代数与官方白名单这三层。',
      { effectiveRouteIds: effective.map((route) => route.routeId) },
    );
  }
  return { route: picked, reason: 'caller-selected' };
}

/**
 * 校验思考强度（方案 5.2：思考强度与路由分别校验）。
 *
 * 只接受岗位为「这条路由」声明的允许值；不携带其它模型专属的继承强度。
 *
 * @param {object} args
 * @param {object} args.route 已解析的路由
 * @param {string|undefined} args.requested 调用者请求的强度
 * @returns {{effort: string|undefined, reason: string}}
 */
export function resolveEffort({ route, requested }) {
  const allowed = route.efforts ?? [];
  const roleDefault = route.defaultEffort;

  if (requested === undefined || requested === null || requested === '') {
    if (roleDefault === undefined) return { effort: undefined, reason: 'adapter-default' };
    if (!allowed.includes(roleDefault)) {
      throw new StationError(
        ERROR_CODES.EFFORT_UNSUPPORTED,
        `路由「${route.routeId}」的默认思考强度「${roleDefault}」不在该路由允许的取值内。`,
        { allowed },
      );
    }
    return { effort: roleDefault, reason: 'route-default' };
  }

  if (!REASONING_EFFORTS.includes(requested)) {
    throw new StationError(
      ERROR_CODES.EFFORT_UNSUPPORTED,
      `思考强度「${requested}」不是已知取值；可用取值为：${REASONING_EFFORTS.join(' / ')}。`,
      { allowed, known: REASONING_EFFORTS },
    );
  }
  if (!allowed.includes(requested)) {
    throw new StationError(
      ERROR_CODES.EFFORT_UNSUPPORTED,
      `路由「${route.routeId}」不支持思考强度「${requested}」（只探测到：${allowed.length > 0 ? allowed.join(' / ') : '未声明任何强度'}）。`
      + '不同模型支持的强度不同，插件不会把其它模型的强度沿用到这条路由上。',
      { allowed },
    );
  }
  return { effort: requested, reason: 'caller-selected' };
}

/**
 * 归一化全局策略：路由列表去重、丢弃结构不完整的条目。
 * @param {ReadonlyArray<object>} routes
 * @returns {{routes: Array<object>, routesById: Map<string, object>}}
 */
export function normalizeRoutes(routes) {
  const routesById = new Map();
  for (const raw of routes ?? []) {
    if (!isCompleteRoute(raw)) continue;
    if (typeof raw.routeId !== 'string' || raw.routeId.length === 0) continue;
    if (routesById.has(raw.routeId)) continue;
    routesById.set(raw.routeId, {
      routeId: raw.routeId,
      provider: raw.provider,
      model: raw.model,
      efforts: Array.isArray(raw.efforts) ? raw.efforts.filter((e) => REASONING_EFFORTS.includes(e)) : [],
      ...(typeof raw.defaultEffort === 'string' && raw.defaultEffort.length > 0
        ? { defaultEffort: raw.defaultEffort }
        : {}),
    });
  }
  return { routes: [...routesById.values()], routesById };
}

/**
 * 归一化岗位列表。
 * @param {ReadonlyArray<object>} roles
 * @returns {Map<string, object>}
 */
export function normalizeRoles(roles) {
  const rolesById = new Map();
  for (const raw of roles ?? []) {
    if (raw === null || typeof raw !== 'object') continue;
    if (typeof raw.roleId !== 'string' || raw.roleId.length === 0) continue;
    if (rolesById.has(raw.roleId)) continue;
    const mode = ROLE_MODES.includes(raw.mode) ? raw.mode : 'fixed';
    const allowedRouteIds = Array.isArray(raw.allowedRouteIds)
      ? raw.allowedRouteIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    rolesById.set(raw.roleId, {
      roleId: raw.roleId,
      label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : raw.roleId,
      description: typeof raw.description === 'string' ? raw.description : '',
      enabled: raw.enabled !== false,
      mode,
      defaultRouteId: typeof raw.defaultRouteId === 'string' ? raw.defaultRouteId : '',
      // 固定模式下允许集合恒等于默认路由，避免两种字段产生互相矛盾的授权。
      allowedRouteIds: mode === 'fixed'
        ? (typeof raw.defaultRouteId === 'string' && raw.defaultRouteId !== '' ? [raw.defaultRouteId] : [])
        : allowedRouteIds,
    });
  }
  return rolesById;
}

/**
 * 交叉引用检查（方案 4.1 第 3 步）：返回全部配置冲突。
 * 冲突是「说明性」结果——保存可以成功，但受影响的岗位不可派出。
 * @param {object} args
 * @param {Map<string, object>} args.rolesById
 * @param {Map<string, object>} args.routesById
 * @returns {Array<{level: string, code: string, roleId?: string, message: string}>}
 */
export function findConfigConflicts({ rolesById, routesById }) {
  const conflicts = [];
  for (const role of rolesById.values()) {
    if (role.mode === 'fixed') {
      if (role.defaultRouteId === '' || !routesById.has(role.defaultRouteId)) {
        conflicts.push({
          level: 'error',
          code: ERROR_CODES.DEFAULT_ROUTE_INVALID,
          roleId: role.roleId,
          message: `岗位「${role.label}」的固定路由「${role.defaultRouteId || '(空)'}」在全局路由表中不存在。`,
        });
      }
      continue;
    }
    for (const id of role.allowedRouteIds) {
      if (!routesById.has(id)) {
        conflicts.push({
          level: 'error',
          code: ERROR_CODES.ROUTE_UNKNOWN,
          roleId: role.roleId,
          message: `岗位「${role.label}」的白名单包含不存在的路由「${id}」。`,
        });
      }
    }
    if (role.defaultRouteId !== '' && !role.allowedRouteIds.includes(role.defaultRouteId)) {
      conflicts.push({
        level: 'error',
        code: ERROR_CODES.DEFAULT_ROUTE_INVALID,
        roleId: role.roleId,
        message: `岗位「${role.label}」的默认路由「${role.defaultRouteId}」不在其白名单内。`,
      });
    }
    if (role.allowedRouteIds.length === 0) {
      conflicts.push({
        level: 'error',
        code: ERROR_CODES.EMPTY_EFFECTIVE_SET,
        roleId: role.roleId,
        message: `岗位「${role.label}」是白名单模式，但没有允许任何路由。`,
      });
    }
  }
  return conflicts;
}

/**
 * 岗位是否可派出：存在、启用、且没有配置冲突。
 * @param {object} role
 * @param {ReadonlyArray<object>} conflicts
 * @returns {object|undefined} 拒绝原因
 */
export function roleBlockReason(role, conflicts) {
  if (!role.enabled) {
    return new StationError(
      ERROR_CODES.ROLE_DISABLED,
      `岗位「${role.label}」已被用户禁用，不能派新任务。`,
    );
  }
  const own = conflicts.filter((c) => c.roleId === role.roleId && c.level === 'error');
  if (own.length > 0) {
    return new StationError(
      ERROR_CODES.CONFIG_CONFLICT,
      `岗位「${role.label}」存在配置冲突，不能派出：${own.map((c) => c.message).join('；')}`,
    );
  }
  return undefined;
}

/**
 * 构建一次派出的可解释决策摘要（回执用，方案 8.3）。
 * @param {object} args
 * @param {object} args.role
 * @param {object} args.route
 * @param {string|undefined} args.effort
 * @param {string} args.routeReason
 * @param {string} args.effortReason
 * @param {number} args.policyRevision
 * @returns {object}
 */
export function decisionSummary({ role, route, effort, routeReason, effortReason, policyRevision, effectiveRouteCount }) {
  return {
    roleId: role.roleId,
    roleLabel: role.label,
    mode: role.mode,
    provider: route.provider,
    model: route.model,
    routeId: route.routeId,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    routeReason,
    effortReason,
    policyRevision,
    // 四层求交后还剩几条候选（方案 §10.2 的 dry-run 要显示它）。
    // 由调用方传入：只有它知道快照与官方层的实况。
    ...(effectiveRouteCount === undefined ? {} : { effectiveRouteCount }),
  };
}
