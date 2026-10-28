/**
 * 阶段 1 回归：**真实的** `ctx.tools.register` 必须能接受插件注册的定义。
 *
 * 这条测试的存在理由（方案 10 阶段 1）：
 * 「补'真实调用 `ctx.tools.register`'的测试——这条测试必须能让 v0.1 的 bug 失败。」
 *
 * v0.1 的 P1-1 用裸 DSL 对象注册，`register()` 会以
 * `tool "..." must declare output { schema, render, presentationMeta? }` /
 * `unsupported JSON schema: ... required is not supported on type "string"`
 * 抛错，插件加载即失败。所以这里**不 stub** `register`——用真实的 `ToolRuntime`，
 * 只把它挂在一个最小的 cordis 上下文上。
 *
 * 运行：node --test tests/unit/register.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { startHost } from '../harness.js';
import * as station from '../../lib/host/index.js';

/**
 * 安装本插件并等它加载完；返回 Fiber 以便单独卸载。
 *
 * 这里按 cordis 加载器的做法，把模块的 `name` / `apply` / `inject` 一起交上去。
 * 只传 `apply` 会让 `ctx.tools` 因缺少 inject 声明而抛错——那是加载器契约，
 * 不是插件 bug，所以测试必须模拟完整。
 */
async function installStation(host) {
  return host.ctx.plugin(
    { name: station.name, apply: station.apply, inject: station.inject },
    station.Config({}),
  );
}

test('真实的 ctx.tools.register 接受插件定义（v0.1 会在这里失败）', async () => {
  const host = await startHost();
  try {
    await installStation(host);

    const names = host.tools.schemas().map((schema) => schema.name);
    assert.ok(names.includes('dispatch_roles'), `dispatch_roles 未注册，实际可见：${names.join(', ')}`);
    assert.ok(names.includes('dispatch_agent'), `dispatch_agent 未注册，实际可见：${names.join(', ')}`);
  } finally {
    await host.stop();
  }
});

test('两个工具的参数 schema 是编译后的 JSON Schema（required 为数组）', async () => {
  const host = await startHost();
  try {
    await installStation(host);

    const agent = host.tools.schemas().find((schema) => schema.name === 'dispatch_agent');
    assert.ok(agent !== undefined, 'dispatch_agent 必须在可见工具里');

    const params = agent.parameters;
    assert.equal(params.type, 'object');
    assert.deepEqual([...params.required].sort(), ['description', 'prompt', 'roleId'].sort());
    // v0.1 的错误形态：required 出现在属性上。
    for (const property of Object.values(params.properties)) {
      assert.equal(property.required, undefined, '属性上不应出现 required 字段');
    }
  } finally {
    await host.stop();
  }
});

test('render 用 (args, value) 签名渲染回执值，而不是把参数当值', async () => {
  const host = await startHost();
  try {
    await installStation(host);

    const definition = host.tools.get('dispatch_agent');
    assert.ok(definition !== undefined, 'dispatch_agent 定义必须可解析');

    // 用真实定义调用 render：第一个参数是 args，第二个才是值。
    // v0.1 写成 (value) 时，这里拿到的会是 args 对象，断言会失败。
    const blocks = definition.output.render(
      { roleId: 'reviewer', description: 't', prompt: 'p' },
      '派出已受理（回执 rcpt-1）',
    );
    assert.ok(Array.isArray(blocks), 'render 必须返回内容块数组');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /派出已受理/, '渲染的必须是第二个参数（值），不是第一个参数（args）');
    assert.doesNotMatch(blocks[0].text, /reviewer/, '不应把 args 当成值渲染出来');
  } finally {
    await host.stop();
  }
});

test('插件可卸载：卸载后两个工具都从可见集合消失', async () => {
  const host = await startHost();
  try {
    const before = host.tools.schemas().map((s) => s.name);
    const fiber = await installStation(host);
    assert.ok(host.tools.schemas().some((s) => s.name === 'dispatch_agent'));

    await fiber.dispose();

    const after = host.tools.schemas().map((s) => s.name);
    assert.ok(!after.includes('dispatch_agent'), `卸载后仍可见：${after.join(', ')}`);
    assert.deepEqual(after.sort(), before.sort(), '卸载后应回到安装前集合');
  } finally {
    await host.stop();
  }
});
