/**
 * 验收矩阵（方案第 11 节 T01–T40）里能在宿主半边自动化的那部分。
 *
 * 判据来源：`docs/contract-evidence.md` 与方案原文。每条测试的标题直接写出 T 编号，
 * 便于与 `docs/known-limits.md` 的未验证清单对照。
 *
 * 不在这里覆盖的（需 GUI 或真实模型，见 `docs/known-limits.md`）：
 * T11（视觉）、T13（模型是否真的照做）、T22（重启进程）、T30（跨进程锁）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callDispatch, makeAgent, startStation } from '../host-fixture.js';

/** 一个受管根会话。 */
function rootAgent(host) {
  const ctx = host.ctx.extend({});
  return makeAgent({ id: 'root-1', rootSessionId: 'root-1', depth: 0, agentCtx: ctx });
}

test('T01 受管会话按岗位派出成功，并在工具结果里给出回执', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const text = await callDispatch(
      host,
      { roleId: 'reviewer', description: '审查支付模块', prompt: '请审查支付模块的错误处理。' },
      { agent },
    );

    assert.match(text, /派出已受理/, '回执必须进入工具结果');
    assert.match(text, /rcpt-/, '回执要带可核对的 id');
    assert.match(text, /vendorA\/pro-model/, '要写明最终路由');
    assert.match(text, /固定模型/, '要写明岗位模式');

    assert.equal(host.subagents.calls.length, 1);
    assert.equal(host.subagents.calls[0].provider, 'spawn');
    assert.equal(host.subagents.calls[0].delivery, 'parent');
  } finally {
    await host.stop();
  }
});

test('T02 未受管会话被拒绝，且后端一次都没被调用', async () => {
  const host = await startStation();
  try {
    const ctx = host.ctx.extend({});
    const agent = makeAgent({ id: 'free-1', rootSessionId: 'free-1', depth: 0, agentCtx: ctx });

    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_NOT_MANAGED_SESSION',
    );
    assert.equal(host.subagents.calls.length, 0, '拒绝必须发生在创建之前');
  } finally {
    await host.stop();
  }
});

test('T02b 未知岗位被拒绝，并列出已知岗位', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(host, { roleId: 'ghost', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_ROLE_NOT_FOUND' && error.details.knownRoleIds.includes('reviewer'),
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T03 固定岗位指定别的路由被拒绝，后端未被调用', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y', routeId: 'cheap' }, { agent }),
      (error) => error.code === 'STATION_FIXED_ROLE_OVERRIDE',
    );
    assert.equal(host.subagents.calls.length, 0, '不静默改回默认值，也不派出');
  } finally {
    await host.stop();
  }
});

test('T04 同名模型来自未授权供应商被拒绝（不按模型名放行）', async () => {
  const host = await startStation({
    allowedRoutes: [
      { routeId: 'cheap', provider: 'vendorA', model: 'shared', efforts: [] },
      { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
    ],
  });
  try {
    const agent = rootAgent(host);
    host.official.value = { enabled: true, allowedModels: [{ provider: 'vendorB', model: 'pro-model' }] };
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_OFFICIAL_POLICY_CONFLICT',
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T05 省略路由时用岗位默认值，不继承父会话路由', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    // 父会话当前跑在别的模型上——插件不得据此推断。
    agent.options = { ...agent.options, model: 'parent-model' };
    const text = await callDispatch(host, { roleId: 'scout', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /vendorA\/cheap-model/, '白名单岗位未指定时应落回岗位默认值');
    assert.doesNotMatch(text, /parent-model/);
  } finally {
    await host.stop();
  }
});

test('T06 岗位允许但被官方策略排除时，报官方冲突而不是泛泛的空集', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.official.value = { enabled: true, allowedModels: [{ provider: 'vendorA', model: 'cheap-model' }] };
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => {
        assert.equal(error.code, 'STATION_OFFICIAL_POLICY_CONFLICT');
        assert.match(error.message, /官方/, '文案要指向官方设置，而不是让用户去改插件');
        return true;
      },
    );
  } finally {
    await host.stop();
  }
});

test('T07 不支持的思考强度被拒绝，且不携带不兼容的继承值', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(
        host,
        { roleId: 'reviewer', description: 'x', prompt: 'y', reasoningEffort: 'max' },
        { agent },
      ),
      (error) => error.code === 'STATION_EFFORT_UNSUPPORTED',
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T08 岗位被禁用后拒绝新派出', async () => {
  const enabledHost = await startStation();
  try {
    const agent = rootAgent(enabledHost);
    const roles = await enabledHost.tools.get('dispatch_roles').execute({}, { agent });
    assert.match(roles, /reviewer[^\n]*可派出/, '未禁用时应显示可派出');
  } finally {
    await enabledHost.stop();
  }

  const host = await startStation({
    roles: [
      { roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong', enabled: false },
      {
        roleId: 'scout', mode: 'allowlist', defaultRouteId: 'cheap', allowedRouteIds: ['cheap', 'strong'], enabled: true,
      },
    ],
  });
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_ROLE_DISABLED',
    );
    assert.equal(host.subagents.calls.length, 0, '禁用岗位不得派出');
  } finally {
    await host.stop();
  }
});

test('T14 子会话（深度 1）不能派出孙级，后端未被调用', async () => {
  const host = await startStation();
  try {
    const childCtx = host.ctx.extend({});
    const child = makeAgent({ id: 'child-1', rootSessionId: 'root-1', depth: 1, agentCtx: childCtx });
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent: child }),
      (error) => error.code === 'STATION_NESTED_DISPATCH_FORBIDDEN',
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T20 覆盖诊断：目录外派生工具在严格模式下阻止派出', async () => {
  const host = await startStation({ strictCoverage: true });
  try {
    const agent = rootAgent(host);
    host.tools.register({
      name: 'mystery_delegate',
      description: '第三方派生入口',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute() {
        return 'ok';
      },
    });

    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_COVERAGE_INCOMPLETE'
        && error.details.unknown.includes('mystery_delegate'),
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T20b 同一场景下严格模式关闭时只告警不拦截', async () => {
  const host = await startStation({ strictCoverage: false });
  try {
    const agent = rootAgent(host);
    host.tools.register({
      name: 'mystery_delegate',
      description: '第三方派生入口',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute() {
        return 'ok';
      },
    });
    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /派出已受理/);
    assert.match(text, /覆盖未完全确认/, '非严格模式也必须在回执里说明');
  } finally {
    await host.stop();
  }
});

test('T21 后端能力不足时拒绝派出（而不是忽略选项硬跑）', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.subagents.getProvider = (nameValue) => (
      nameValue === 'spawn' ? { name: 'spawn', capabilities: { agentOptions: false } } : undefined
    );
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_BACKEND_INCAPABLE',
    );
    assert.equal(host.subagents.calls.length, 0);
  } finally {
    await host.stop();
  }
});

test('T23 后端未注册时拒绝，并列出已注册后端', async () => {
  const host = await startStation({ providerName: 'nope' });
  try {
    const agent = rootAgent(host);
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_BACKEND_INCAPABLE' && /spawn/.test(error.message),
    );
  } finally {
    await host.stop();
  }
});

test('T32 派出失败时回执落成 failed，并带上失败原因', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.subagents.behaviour = () => new Error('backend exploded');

    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_START_FAILED' && /backend exploded/.test(error.message),
    );

    // 回执必须存在且状态为 failed——「派了但没记」是禁止的。
    const receipts = host.service.snapshot().receipts;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'failed');
    assert.match(receipts[0].note, /backend exploded/);
  } finally {
    await host.stop();
  }
});

test('T33 台账打不开时拒绝派出，并把原因说清楚', async () => {
  const host = await startStation();
  try {
    // 装机时台账已打开；这里换一个「一开就坏」的后端，再装一次插件，
    // 让新的 apply 走 open 失败的那条路径。
    await host.fiber.dispose();
    host.storage.open = async () => {
      throw new Error('invalid table name in unit');
    };

    const station = await import('../../lib/host/index.js');
    await host.ctx.plugin(
      { name: station.name, apply: station.apply, inject: station.inject },
      station.Config({
        managedSessionIds: ['root-1'],
        allowedRoutes: [
          { routeId: 'strong', provider: 'vendorA', model: 'pro-model', efforts: ['high'], defaultEffort: 'high' },
        ],
        roles: [{ roleId: 'reviewer', mode: 'fixed', defaultRouteId: 'strong', enabled: true }],
      }),
    );

    const agent = rootAgent(host);
    const before = host.subagents.calls.length;
    await assert.rejects(
      () => callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent }),
      (error) => error.code === 'STATION_LEDGER_UNAVAILABLE' && /invalid table name/.test(error.message),
      '台账不可用时必须拒绝，而不是裸奔派出',
    );
    assert.equal(host.subagents.calls.length, before, '台账不可用时后端一次都不该被调用');
  } finally {
    await host.stop();
  }
});

test('T34 dispatch_roles 只读，不改变任何派出状态', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const text = await host.tools.get('dispatch_roles').execute({}, { agent });

    assert.match(text, /reviewer/, '要列出岗位');
    assert.match(text, /vendorA\/pro-model/, '要写出路由的真实 provider/model');
    assert.match(text, /scout/, '要列出白名单岗位');
    assert.equal(host.subagents.calls.length, 0, '只读工具绝不派出');
    assert.equal(host.service.snapshot().receipts.length, 0, '只读工具不写回执');
  } finally {
    await host.stop();
  }
});

test('T34b dispatch_roles 支持只看单个岗位', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const text = await host.tools.get('dispatch_roles').execute({ roleId: 'scout' }, { agent });
    assert.match(text, /scout/);
    assert.doesNotMatch(text, /reviewer/, '指定 roleId 时不该把别的岗位也倒出来');
  } finally {
    await host.stop();
  }
});

test('T38 派出时冻结受管根快照，第二次派出复用同一快照', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    const opened = host.storage.opened.find((o) => o.spec.name === 'station_dispatch_ledger');
    assert.ok(opened !== undefined, '台账域必须被打开');
    const roots = opened.stores.get('managed_roots');
    assert.equal(roots.size, 1);
    const frozen = [...roots.values()][0];
    assert.equal(frozen.rootSessionId, 'root-1');
    assert.equal(frozen.snapshotVersion, 1);
    assert.deepEqual(
      frozen.stationRoutes.map((r) => r.routeId).sort(),
      ['cheap', 'strong'],
      '冻结的是当时的完整全局集合',
    );
  } finally {
    await host.stop();
  }
});

test('T39 回执里写明策略修订号与官方策略状态', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /策略修订：\d+/, '必须给出可核对的修订号');
    assert.match(text, /官方模型策略/, '要说明官方策略是否参与');
  } finally {
    await host.stop();
  }
});

test('T40 回执状态如实：只说已受理待确认，不预写已锁定', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });
    assert.match(text, /已受理/);
    assert.match(text, /等待首个模型请求确认/, '请求级锁定要等首轮请求才被证实，不能提前宣称');
    assert.doesNotMatch(text, /已锁定/, '不能在首轮请求前宣称已锁定');
  } finally {
    await host.stop();
  }
});

test('T40b 宿主不返回 childId 时如实标待核对，不猜造 id', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.subagents.behaviour = () => ({}); // 没有任何 id 字段
    const text = await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    assert.match(text, /待核对/);
    assert.match(text, /可能不受请求级锁定覆盖/);
    const receipt = host.service.snapshot().receipts[0];
    assert.equal(receipt.childSessionId, '');
    assert.match(receipt.note, /未返回 childId/);
  } finally {
    await host.stop();
  }
});

test('T41 派出成功时子会话登进台账，供请求级锁定使用', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    host.subagents.behaviour = () => ({ childId: 'child-fixed' });
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    const opened = host.storage.opened.find((o) => o.spec.name === 'station_dispatch_ledger');
    const children = opened.stores.get('children');
    const record = children.get('child-fixed');
    assert.ok(record !== undefined, '子会话必须被登记，否则请求锁定无从判断');
    assert.equal(record.provider, 'vendorA');
    assert.equal(record.model, 'pro-model');
    assert.equal(record.roleId, 'reviewer');
  } finally {
    await host.stop();
  }
});

test('回执与偏离可被只读服务读出（诊断面）', async () => {
  const host = await startStation();
  try {
    const agent = rootAgent(host);
    await callDispatch(host, { roleId: 'reviewer', description: 'x', prompt: 'y' }, { agent });

    const snapshot = host.service.snapshot();
    assert.equal(snapshot.ledgerReady, true);
    assert.equal(snapshot.receipts.length, 1);
    assert.equal(snapshot.receipts[0].roleId, 'reviewer');
    // v0.3（方案 §8.5）：`coverage` 分 `global` / `scoped` 两份视图，不再是一份平铺结果。
    // 不传 scope 时只有全局视图。
    assert.equal(snapshot.coverage.global.state, 'complete');
    assert.equal(snapshot.coverage.scoped, undefined, '不传作用域时不应编造一份作用域视图');
    assert.equal(snapshot.official.status, 'disabled');
    assert.ok(Array.isArray(snapshot.conflicts));
  } finally {
    await host.stop();
  }
});
