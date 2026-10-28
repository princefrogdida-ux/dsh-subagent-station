/**
 * 对照测试：证明「真实 `ctx.tools.register`」夹具**能**测出 v0.1 的两个真实缺陷。
 *
 * 阶段 0 的 C1 结论在写这条测试时被实测推翻了一次，这里记录**准确**的事实，
 * 因为它决定了为什么必须用 `defineTool`：
 *
 * 1. `register()` **不校验 `parameters`**（`.host-src/dsh-tools.js:2974-2983`
 *    只校验 `output`、`timeoutMs` 与保留名）。所以把 v0.1 的裸 DSL 对象
 *    塞进 `register()` **不会抛错**——我原先写的「加载期即失败」是错的。
 * 2. 真正的后果有两个，都比「抛错」更隐蔽：
 *    - **模型看到的 schema 是错的**：`schemaOf` 原样透传 `parameters`
 *      （`.host-src/dsh-tools.js:3139-3149`），所以 DSL 形状 `{ roleId: {...} }`
 *      会直接进入模型上下文，**没有 `type: 'object'` 也没有 `properties`**。
 *    - **参数完全不被校验**：`defineTool` 在 `execute` 外包了
 *      `validateJsonSchemaValue`（`.host-src/dsh-tools.js:866-870`），
 *      裸定义没有这一层，缺 required 也会照跑。
 * 3. `output.render` 的签名是 `(args, value)`（`.host-src/dsh-tools.js:857-859`、
 *    调用点 `3644` 传的就是这两个参数）。v0.1 写成 `(value)` 不会抛错，
 *    而是**把 args 当成结果渲染**——回执里出现 `[object Object]`。
 *
 * 这三条都是「静默错误」，正是必须换成 `defineTool` 的理由：
 * 它把静默错误变成编译期 schema 与运行期校验。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { startHost } from '../harness.js';

/** v0.1 实际使用的注册形状（DSL 参数 + 单参 render）。 */
function legacyDefinition(sink) {
  return {
    name: 'legacy_dispatch',
    description: 'v0.1 的写法',
    parameters: {
      roleId: { type: 'string', required: true, description: '岗位' },
      prompt: { type: 'string', required: true, description: '任务' },
    },
    output: {
      schema: { type: 'string' },
      render: (value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      sink.push(args);
      return '真实结果';
    },
  };
}

test('裸 DSL 定义能注册，但模型看到的 parameters 结构是坏的', async () => {
  const host = await startHost();
  try {
    host.tools.register(legacyDefinition([]));

    const projected = host.tools.schemas().find((s) => s.name === 'legacy_dispatch');
    assert.ok(projected !== undefined, '裸定义确实注册成功了（register 不校验 parameters）');

    // 这就是 v0.1 的真实缺陷：模型拿到的不是 JSON Schema 对象。
    assert.equal(projected.parameters.type, undefined, '没有 type: object');
    assert.equal(projected.parameters.properties, undefined, '没有 properties 包装');
    assert.ok('roleId' in projected.parameters, '岗位字段裸露在顶层');
  } finally {
    await host.stop();
  }
});

test('裸定义不做参数校验：缺 required 也会执行 execute', async () => {
  const host = await startHost();
  try {
    const seen = [];
    host.tools.register(legacyDefinition(seen));

    const definition = host.tools.get('legacy_dispatch');
    await definition.execute({}, {});

    assert.equal(seen.length, 1, 'execute 在缺参数时仍然被调用了');
    assert.deepEqual(seen[0], {}, '拿到的就是空参数');
  } finally {
    await host.stop();
  }
});

test('defineTool 在同一输入上拒绝，且 execute 不被调用', async () => {
  const seen = [];
  const definition = defineTool({
    name: 'compiled_dispatch',
    description: 'v0.2 的写法',
    parameters: {
      roleId: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      seen.push(args);
      return 'ok';
    },
  });

  await assert.rejects(
    () => definition.execute({}, {}),
    (error) => {
      assert.equal(error.name, 'ToolArgsError');
      assert.match(error.message, /roleId/);
      return true;
    },
  );
  assert.equal(seen.length, 0, 'defineTool 在参数不合法时不会调用 execute');

  // 而且模型看到的 schema 是对象根 + required 数组。
  assert.equal(definition.parameters.type, 'object');
  assert.deepEqual([...definition.parameters.required].sort(), ['prompt', 'roleId']);
});

test('单参 render 会把 args 当成结果渲染（v0.1 的 P1-2）', async () => {
  const host = await startHost();
  try {
    host.tools.register(legacyDefinition([]));
    const definition = host.tools.get('legacy_dispatch');

    // 运行时的调用形状：(exec.arguments, value)。见 .host-src/dsh-tools.js:3644。
    const blocks = definition.output.render({ roleId: 'reviewer', prompt: 'p' }, '真实结果');

    assert.equal(blocks[0].text, '[object Object]', '渲染的是 args 对象，不是结果');
    assert.notEqual(blocks[0].text, '真实结果', '真实结果被丢掉了');
  } finally {
    await host.stop();
  }
});
