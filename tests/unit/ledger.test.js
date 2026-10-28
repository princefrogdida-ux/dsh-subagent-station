/**
 * 台账（G5）单元测试。
 *
 * 这里用**契约替身**而不是真实 `storageDomain`：真实域的 `open()` 需要
 * `ctx.storage.backend` 提供 `kv` facet（`.host-src/dsh-storage-domain.js:360-362`），
 * 那是宿主装配的一部分，搬进单测只会测到宿主自己。
 *
 * 替身严格按已核实的域契约实现（`docs/contract-evidence.md` C5）：
 * `open(spec)` → `{ table(name), close() }`，`KvTable` 有 `get/entries/put`。
 *
 * 关键点：**zod 校验是真的**。每条写入都会过一遍域声明里的 `valueSchema`，
 * 所以这里的 schema 错误会立刻暴露，而不是等到真实后端才炸。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StationError } from '../../lib/shared/policy.js';
import { LEDGER_DOMAIN, RECEIPT_STATUS, openLedger } from '../../lib/host/ledger.js';

/** 一张内存表，按域契约做 zod 校验。 */
function inMemoryTable(tableSpec, store) {
  return {
    get: (key) => store.get(key),
    keys: () => [...store.keys()],
    entries: () => [...store.entries()],
    size: () => store.size,
    async put(key, value) {
      // 真实域在写入前用 valueSchema 校验；这里保持一致。
      const parsed = tableSpec.valueSchema.parse(value);
      store.set(key, parsed);
      return parsed;
    },
    async delete(key) {
      return store.delete(key);
    },
  };
}

/**
 * 契约替身：`open(spec)` 返回域句柄。
 *
 * @param {object} [options]
 * @param {(spec: object) => void} [options.onOpen] 观察打开的域
 */
function fakeStorageDomain(options = {}) {
  const opened = [];
  return {
    opened,
    async open(spec) {
      options.onOpen?.(spec);
      const stores = new Map();
      for (const table of Object.keys(spec.tables)) stores.set(table, new Map());
      const domain = {
        name: spec.name,
        table(name) {
          const tableSpec = spec.tables[name];
          if (tableSpec === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`);
          return inMemoryTable(tableSpec, stores.get(name));
        },
        async close() {
          opened.push({ spec, closed: true });
        },
      };
      opened.push({ spec, domain });
      return domain;
    },
  };
}

/** 一份合法的回执。 */
function receipt(overrides = {}) {
  return {
    receiptId: 'rcpt-1',
    status: RECEIPT_STATUS.INTENT,
    roleId: 'reviewer',
    roleLabel: '代码审查',
    mode: 'fixed',
    rootSessionId: 'root-1',
    parentSessionId: 'root-1',
    childSessionId: '',
    route: { routeId: 'strong', provider: 'vendorA', model: 'pro-model' },
    routeReason: 'role-default',
    effortReason: 'route-default',
    policyRevision: 123,
    snapshotVersion: 1,
    createdAt: 1000,
    updatedAt: 1000,
    note: '',
    ...overrides,
  };
}

test('打开台账：域名与版本符合声明', async () => {
  const storage = fakeStorageDomain();
  const ledger = await openLedger(storage);
  try {
    assert.equal(storage.opened.length, 1);
    const { spec } = storage.opened[0];
    assert.equal(spec.name, 'station_dispatch_ledger');
    assert.equal(spec.version, 2, 'v0.4 台账格式是 2（新增 meta 表与偏离 kind）');
    assert.equal(spec.layout, 'per-record');
    assert.deepEqual(
      spec.compatibleVersions,
      [1],
      '必须声明兼容 v1：升级插件不该让用户在跑的子会话失去解释能力（§11.2）',
    );
    // 六张表都必须声明，少一张就会在运行时 table() 抛错。
    assert.deepEqual(
      Object.keys(spec.tables).sort(),
      ['children', 'deviations', 'escapes', 'managed_roots', 'meta', 'receipts'],
      'v0.4 多了 meta（台账自身的证据，§7.2）与 escapes（漏网子会话，T81）',
    );
  } finally {
    await ledger.close();
  }
});

test('域名与表名必须是 snake_case（json 后端会拒绝 camelCase）', () => {
  // 真实后端的规则：`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
  // （@deepseek-ai/dsh-storage 的 `validateDescriptor`，被 storage-json 调用）。
  // 违反它时整个域打不开，插件会以 STATION_LEDGER_UNAVAILABLE 拒绝一切派出——
  // 这个 bug 只在真实宿主里暴露，所以必须在这里钉死。
  const NAME = /^[a-z][a-z0-9_]*$/;
  assert.match(LEDGER_DOMAIN.name, NAME, '域名必须合法');
  for (const table of Object.keys(LEDGER_DOMAIN.tables)) {
    assert.match(table, NAME, `表名「${table}」不合法：json 后端会拒绝，导致台账完全打不开`);
  }
});

test('域的 zod schema 真的拒绝坏数据（不是只声明不校验）', () => {
  assert.throws(
    () => LEDGER_DOMAIN.tables.receipts.valueSchema.parse({ receiptId: 'x' }),
    '缺字段的回执必须被 schema 拒绝',
  );
  assert.throws(
    () => LEDGER_DOMAIN.tables.receipts.valueSchema.parse(receipt({ status: 'made-up' })),
    '状态机外的状态必须被拒绝',
  );
});

test('回执写入后能读回，且按创建时间倒序', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    await ledger.putReceipt(receipt({ receiptId: 'a', createdAt: 100 }));
    await ledger.putReceipt(receipt({ receiptId: 'b', createdAt: 300 }));
    await ledger.putReceipt(receipt({ receiptId: 'c', createdAt: 200 }));

    assert.equal(ledger.getReceipt('b').receiptId, 'b');
    assert.equal(ledger.getReceipt('nope'), undefined);
    assert.deepEqual(ledger.listReceipts().map((r) => r.receiptId), ['b', 'c', 'a']);
  } finally {
    await ledger.close();
  }
});

test('写入失败转成 STATION_LEDGER_UNAVAILABLE，让调用方拒绝派出', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    // 故意写一条状态不在枚举里的回执，触发 zod 拒绝。
    await assert.rejects(
      () => ledger.putReceipt(receipt({ status: 'bogus' })),
      (error) => error instanceof StationError && error.code === 'STATION_LEDGER_UNAVAILABLE',
    );
  } finally {
    await ledger.close();
  }
});

test('域打不开时抛 STATION_LEDGER_UNAVAILABLE，而不是静默降级', async () => {
  const broken = {
    async open() {
      throw new Error('backend is gone');
    },
  };
  await assert.rejects(
    () => openLedger(broken),
    (error) => error instanceof StationError
      && error.code === 'STATION_LEDGER_UNAVAILABLE'
      && /backend is gone/.test(error.message),
  );
});

test('关闭后拒绝读写（避免卸载后还在写）', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  await ledger.close();
  await assert.rejects(
    () => ledger.putReceipt(receipt()),
    (error) => error instanceof StationError && error.code === 'STATION_LEDGER_UNAVAILABLE',
  );
  assert.throws(
    () => ledger.listReceipts(),
    (error) => error instanceof StationError && error.code === 'STATION_LEDGER_UNAVAILABLE',
  );
});

test('关闭是幂等的', async () => {
  const storage = fakeStorageDomain();
  const ledger = await openLedger(storage);
  await ledger.close();
  await ledger.close();
  // 域句柄的 close 只应被调用一次。
  assert.equal(storage.opened.filter((o) => o.closed === true).length, 1);
});

test('受管根快照：首次冻结，之后只收紧不放松', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    const first = await ledger.putManagedRoot({
      rootSessionId: 'root-1',
      snapshotVersion: 1,
      policyRevision: 10,
      createdAt: 1,
      stationRoutes: [
        { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model' },
        { routeId: 'strong', provider: 'vendorA', model: 'pro-model' },
      ],
      officialRoutes: [],
      officialStatus: 'absent',
    });
    assert.equal(first.snapshotVersion, 1);
    assert.equal(ledger.getManagedRoot('root-1').stationRoutes.length, 2);

    // 收紧：只保留 strong。这是「放宽永不隐式生效，收紧必须立即生效」里的收紧那一半。
    const tightened = await ledger.tightenManagedRoot('root-1', {
      stationRoutes: [{ routeId: 'strong', provider: 'vendorA', model: 'pro-model' }],
      policyRevision: 11,
    });
    assert.deepEqual(tightened.stationRoutes.map((r) => r.routeId), ['strong']);
    assert.equal(tightened.policyRevision, 11);

    // 再「收紧」成一个比当前更大的集合：交集仍是 strong，不可能被扩大。
    const attemptedWiden = await ledger.tightenManagedRoot('root-1', {
      stationRoutes: [
        { routeId: 'cheap', provider: 'vendorA', model: 'cheap-model' },
        { routeId: 'strong', provider: 'vendorA', model: 'pro-model' },
        { routeId: 'new', provider: 'vendorB', model: 'brand-new' },
      ],
      policyRevision: 12,
    });
    assert.deepEqual(
      attemptedWiden.stationRoutes.map((r) => r.routeId),
      ['strong'],
      '收紧操作永远不能把已移除的路由加回来',
    );
  } finally {
    await ledger.close();
  }
});

test('对不存在的受管根做收紧是无操作，不凭空创建', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    const result = await ledger.tightenManagedRoot('never-seen', {
      stationRoutes: [{ routeId: 'x', provider: 'p', model: 'm' }],
      policyRevision: 1,
    });
    assert.equal(result, undefined);
    assert.equal(ledger.getManagedRoot('never-seen'), undefined);
  } finally {
    await ledger.close();
  }
});

test('子会话登记与偏离记录', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    await ledger.putChild({
      childSessionId: 'child-1',
      rootSessionId: 'root-1',
      roleId: 'reviewer',
      receiptId: 'rcpt-1',
      provider: 'vendorA',
      model: 'pro-model',
      createdAt: 5,
    });
    assert.equal(ledger.getChild('child-1').roleId, 'reviewer');
    assert.equal(ledger.getChild('other'), undefined);
    assert.equal(ledger.listChildren().length, 1);

    await ledger.recordDeviation({
      childSessionId: 'child-1',
      receiptId: 'rcpt-1',
      turn: 3,
      attemptedProvider: 'vendorB',
      attemptedModel: 'sneaky',
      forcedProvider: 'vendorA',
      forcedModel: 'pro-model',
      at: 10,
    });
    // 同一轮重复记录只应留一条（键是 childSessionId#turn）。
    await ledger.recordDeviation({
      childSessionId: 'child-1',
      receiptId: 'rcpt-1',
      turn: 3,
      attemptedProvider: 'vendorB',
      attemptedModel: 'sneaky',
      forcedProvider: 'vendorA',
      forcedModel: 'pro-model',
      at: 11,
    });
    const deviations = ledger.listDeviations('child-1');
    assert.equal(deviations.length, 1, '同一轮不应堆积重复偏离');
    assert.equal(deviations[0].attemptedModel, 'sneaky');
  } finally {
    await ledger.close();
  }
});

test('重启对账：未完结回执标 unverified，且不自动重派', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    // intent、started 且子会话不存在 → 标 unverified。
    await ledger.putReceipt(receipt({ receiptId: 'stale-intent', status: RECEIPT_STATUS.INTENT }));
    await ledger.putReceipt(receipt({
      receiptId: 'stale-started', status: RECEIPT_STATUS.STARTED, childSessionId: 'gone-child',
    }));
    // 已完结的回执不该被动。
    await ledger.putReceipt(receipt({
      receiptId: 'done', status: RECEIPT_STATUS.SETTLED, childSessionId: 'live-child',
    }));

    const stale = await ledger.reconcileStaleReceipts((id) => id === 'live-child');

    assert.deepEqual(stale.map((r) => r.receiptId).sort(), ['stale-intent', 'stale-started']);
    for (const record of stale) {
      assert.equal(record.status, RECEIPT_STATUS.UNVERIFIED);
      assert.match(record.note, /不会自动重派/);
    }
    assert.equal(ledger.getReceipt('done').status, RECEIPT_STATUS.SETTLED, '已完结的回执不得被改写');
  } finally {
    await ledger.close();
  }
});

test('重启对账：子会话仍存活则不误标', async () => {
  const ledger = await openLedger(fakeStorageDomain());
  try {
    await ledger.putReceipt(receipt({
      receiptId: 'alive', status: RECEIPT_STATUS.STARTED, childSessionId: 'child-1',
    }));
    await ledger.putChild({
      childSessionId: 'child-1',
      rootSessionId: 'root-1',
      roleId: 'reviewer',
      receiptId: 'alive',
      provider: 'vendorA',
      model: 'pro-model',
      createdAt: 1,
    });

    const stale = await ledger.reconcileStaleReceipts(() => true);
    assert.deepEqual(stale, [], '存活且已登记的派出一律不标 unverified');
    assert.equal(ledger.getReceipt('alive').status, RECEIPT_STATUS.STARTED);
  } finally {
    await ledger.close();
  }
});
