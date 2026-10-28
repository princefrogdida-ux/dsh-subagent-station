import assert from 'node:assert/strict';
import { test } from 'node:test';

import { childIdOf, resolveStarter } from '../../lib/host/index.js';

test('DSH 0.2.1：优先使用 startActivation，且原样传 spec', async () => {
  const seen = [];
  const service = {
    async startActivation(spec) {
      seen.push(spec);
      return { childId: 'child-1' };
    },
    // 0.2.1 上不应走到这里；存在也不得被优先选择。
    async start() {
      throw new Error('start 不应被调用');
    },
  };
  const start = resolveStarter(service);
  const spec = { provider: 'spawn', label: 'x', request: { prompt: [] }, delivery: 'parent' };
  const out = await start(spec);
  assert.deepEqual(seen, [spec], 'spec 必须原样转发，不得改写');
  assert.deepEqual(out, { childId: 'child-1' });
});

test('只有 start(name, request) 的 0.2.0 后端被明确拒绝，不再静默降级', () => {
  // v0.2 刻意删除 0.2.0 的降级分支：那条路径不支持预留 childId、也没有 delivery，
  // 走它会得到与 v0.2 状态机（intent → started → observed）不一致的行为。
  // 用户看到的必须是「这个后端不支持」而不是「派出成功但没被锁定」。
  const service = { async start() { throw new Error('start 不应被调用'); } };
  assert.equal(resolveStarter(service), undefined, '缺少 startActivation 时必须返回 undefined');
});

test('没有任何启动入口时返回 undefined（由调用方明确拒绝）', () => {
  assert.equal(resolveStarter(undefined), undefined);
  assert.equal(resolveStarter({}), undefined);
  assert.equal(resolveStarter({ getProvider() {} }), undefined);
});

test('childIdOf 读取两代返回形状', () => {
  assert.equal(childIdOf({ childId: 'a' }), 'a');
  assert.equal(childIdOf({ localAgent: { session: { id: 'b' } } }), 'b');
  assert.equal(childIdOf({ session: { id: 'c' } }), 'c');
  // 读不到时必须是 undefined，不能伪造成字符串。
  assert.equal(childIdOf({}), undefined);
  assert.equal(childIdOf(null), undefined);
  assert.equal(childIdOf({ childId: '' }), undefined);
});
