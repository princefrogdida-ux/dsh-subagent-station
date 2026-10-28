/**
 * 阶段 0 / C1：`defineTool` 的真实行为。
 *
 * 方案第 13 条要求「每一条附运行时输出或源码行号」。这里全部实测，不读源码猜。
 * 运行：node tests/contract/c1-define-tool.mjs
 */
import { defineTool, parameterSchemaSpecToJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';

const out = [];
function record(label, value) {
  out.push({ label, value });
  console.log(`\n### ${label}`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

// 1. DSL `required: true` → 编译成 `required: string[]` 数组？
const dslCompiled = parameterSchemaSpecToJsonSchema({
  roleId: { type: 'string', required: true, description: 'Role id from dispatch_roles.' },
  prompt: { type: 'string', required: true },
  routeId: { type: 'string', description: 'Optional.' },
});
record('C1-a parameterSchemaSpecToJsonSchema({required:true})', dslCompiled);

// 2. 手写 JsonSchemaNode 用 `required: 'true'`（v0.1 的写法）会怎样？
try {
  assertSupportedJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string', required: true } },
  });
  record('C1-b 手写 schema 把 required 放在属性里', 'ACCEPTED (意外)');
} catch (error) {
  record('C1-b 手写 schema 把 required 放在属性里', `REJECTED: ${error.message}`);
}

// 3. `output.schema` 支持哪些根类型？
const roots = [
  ['{type:"string"}', { type: 'string' }],
  ['{type:"object", additionalProperties:false, properties:{...}}', { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }],
  ['{type:"object", properties:{...}}（无 additionalProperties）', { type: 'object', properties: { a: { type: 'string' } } }],
];
for (const [label, schema] of roots) {
  try {
    assertSupportedJsonSchema(schema);
    record(`C1-c output.schema ${label}`, 'ACCEPTED');
  } catch (error) {
    record(`C1-c output.schema ${label}`, `REJECTED: ${error.message}`);
  }
}

// 4. defineTool 产出的定义形状：render 的真实调用签名是什么？
const tool = defineTool({
  name: 'probe_tool',
  description: 'probe',
  parameters: {
    roleId: { type: 'string', required: true },
  },
  output: {
    schema: { type: 'string' },
    render: (...renderArgs) => {
      record('C1-d render 实际收到的参数个数', renderArgs.length);
      record('C1-d render 实参[0]（第一个参数）', renderArgs[0]);
      record('C1-d render 实参[1]（第二个参数）', renderArgs[1]);
      return [{ type: 'text', text: String(renderArgs[1]) }];
    },
  },
  execute: async () => 'the-value',
});
record('C1-e defineTool 产出的顶层键', Object.keys(tool));
record('C1-e tool.parameters（编译后）', tool.parameters);
record('C1-e tool.output.schema（编译后）', tool.output.schema);

tool.output.render({ roleId: 'r1' }, 'the-value');

// 5. execute 的参数校验：非法参数是否在 execute 之前就被拦？
let executeCalled = false;
const strict = defineTool({
  name: 'strict_tool',
  description: 'strict',
  parameters: { n: { type: 'number', required: true } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  execute: async () => {
    executeCalled = true;
    return 'ok';
  },
});
try {
  await strict.execute({ n: 'not-a-number' }, { signal: new AbortController().signal });
  record('C1-f 非法参数', `未拦截（execute 被调用=${executeCalled}）`);
} catch (error) {
  record('C1-f 非法参数', `拦截：${error.name} / ${error.code ?? '-'} / ${error.message}；execute 被调用=${executeCalled}`);
}

console.log('\n\n=== 汇总 ===');
for (const item of out) console.log(`- ${item.label}`);
