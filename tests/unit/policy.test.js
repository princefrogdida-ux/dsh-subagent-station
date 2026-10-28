import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERROR_CODES,
  StationError,
  effectiveRoutes,
  findConfigConflicts,
  normalizeRoles,
  normalizeRoutes,
  resolveEffort,
  resolveRoute,
  roleBlockReason,
} from '../../lib/shared/policy.js';

/** 构造一组测试路由：同模型名来自两个供应商，用来验证 T04。 */
function routes() {
  const { routesById, routes: list } = normalizeRoutes([
    { routeId: 'cheap', provider: 'vendorA', model: 'shared-model', efforts: ['low', 'medium'] },
    { routeId: 'cheap-other-vendor', provider: 'vendorB', model: 'shared-model', efforts: ['low'] },
    { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
  ]);
  return { routesById, list };
}

test('T05 省略路由时使用岗位默认值，不继承父会话路由', () => {
  const { routesById } = routes();
  const roles = normalizeRoles([
    { roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong' },
  ]);
  const role = roles.get('reviewer');
  const effective = effectiveRoutes({
    role,
    routesById,
    globalAllowedRoutes: [routesById.get('strong')],
    snapshotRoutes: [routesById.get('strong')],
  });
  const { route, reason } = resolveRoute({
    role,
    roleRouteId: undefined,
    effective,
    defaultRoute: effective.find((r) => r.routeId === role.defaultRouteId),
  });
  assert.equal(route.routeId, 'strong');
  assert.equal(route.provider, 'vendorA');
  assert.equal(reason, 'role-default');
});

test('T02 固定岗位请求其他路由时在创建前拒绝，不静默改回默认值', () => {
  const { routesById } = routes();
  const role = normalizeRoles([{ roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong' }]).get('reviewer');
  const effective = [routesById.get('strong')];
  assert.throws(
    () => resolveRoute({ role, roleRouteId: 'cheap', effective, defaultRoute: effective[0] }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.FIXED_ROLE_OVERRIDE,
  );
});

test('固定岗位显式选择同一条路由可以接受', () => {
  const { routesById } = routes();
  const role = normalizeRoles([{ roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong' }]).get('reviewer');
  const effective = [routesById.get('strong')];
  const { reason } = resolveRoute({ role, roleRouteId: 'strong', effective, defaultRoute: effective[0] });
  assert.equal(reason, 'fixed-role');
});

test('T04 同名模型来自未授权供应商必须拒绝，不能按模型名放行', () => {
  const { routesById } = routes();
  const role = normalizeRoles([{
    roleId: 'scout',
    mode: 'allowlist',
    defaultRouteId: 'cheap',
    allowedRouteIds: ['cheap', 'cheap-other-vendor'],
  }]).get('scout');

  // 全局只授权 vendorA 的那条路由；vendorB 的同名模型不得通过。
  const effective = effectiveRoutes({
    role,
    routesById,
    globalAllowedRoutes: [routesById.get('cheap'), routesById.get('strong')],
    snapshotRoutes: [routesById.get('cheap'), routesById.get('strong')],
  });
  assert.deepEqual(effective.map((r) => r.routeId), ['cheap']);

  assert.throws(
    () => resolveRoute({
      role,
      roleRouteId: 'cheap-other-vendor',
      effective,
      defaultRoute: routesById.get('cheap'),
    }),
    // v0.4 归位（方案 §6.1）：这个 id **存在**、岗位也**授权了**它，
    // 只是被全局层收窄掉了 ⇒ `ROUTE_NOT_EFFECTIVE`，不是 `ROUTE_NOT_ALLOWED`。
    (error) => error instanceof StationError && error.code === ERROR_CODES.ROUTE_NOT_EFFECTIVE,
  );
});

test('T06 有效交集为空时拒绝并说明配置冲突', () => {
  const { routesById } = routes();
  const role = normalizeRoles([{
    roleId: 'scout',
    mode: 'allowlist',
    defaultRouteId: 'cheap',
    allowedRouteIds: ['cheap'],
  }]).get('scout');
  const effective = effectiveRoutes({
    role,
    routesById,
    globalAllowedRoutes: [routesById.get('strong')],
    snapshotRoutes: [routesById.get('strong')],
  });
  assert.deepEqual(effective, []);
  assert.throws(
    () => resolveRoute({ role, roleRouteId: undefined, effective, defaultRoute: undefined }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.EMPTY_EFFECTIVE_SET,
  );
});

test('T07 不支持的思考强度被拒绝，不携带不兼容的继承值', () => {
  const { routesById } = routes();
  const cheap = routesById.get('cheap');
  assert.throws(
    () => resolveEffort({ route: cheap, requested: 'high' }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.EFFORT_UNSUPPORTED,
  );
  // 未指定时用该路由自己的声明，而不是从别的模型继承。
  assert.deepEqual(resolveEffort({ route: cheap, requested: undefined }), {
    effort: undefined,
    reason: 'adapter-default',
  });
  const strong = routesById.get('strong');
  assert.deepEqual(resolveEffort({ route: strong, requested: undefined }), {
    effort: 'high',
    reason: 'route-default',
  });
  assert.throws(
    () => resolveEffort({ route: strong, requested: 'ultra' }),
    (error) => error instanceof StationError && error.code === ERROR_CODES.EFFORT_UNSUPPORTED,
  );
});

test('配置冲突：白名单引用不存在的路由会被报告', () => {
  const { routesById } = routes();
  const roles = normalizeRoles([{
    roleId: 'ghost',
    mode: 'allowlist',
    defaultRouteId: 'missing',
    allowedRouteIds: ['missing'],
  }]);
  const conflicts = findConfigConflicts({ rolesById: roles, routesById });
  // `missing` 同时出现在白名单与默认路由里，但只有一条冲突：报一条就足以
  // 让人看出这个岗位不可派出，重复上报同一根因只会淹没其它问题。
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, ERROR_CODES.ROUTE_UNKNOWN);
  assert.equal(conflicts[0].roleId, 'ghost');
});

test('禁用的岗位禁止新派出，但不代表已有任务被中断', () => {
  const role = normalizeRoles([{ roleId: 'x', enabled: false, mode: 'fixed', defaultRouteId: 'a' }]).get('x');
  const reason = roleBlockReason(role, []);
  assert.equal(reason.code, ERROR_CODES.ROLE_DISABLED);
});

test('固定模式的允许集合恒等于默认路由', () => {
  const role = normalizeRoles([{
    roleId: 'x',
    mode: 'fixed',
    defaultRouteId: 'a',
    allowedRouteIds: ['a', 'b'],
  }]).get('x');
  assert.deepEqual(role.allowedRouteIds, ['a']);
});
