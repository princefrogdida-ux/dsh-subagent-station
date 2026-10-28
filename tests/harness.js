/**
 * 测试夹具：一个最小的 cordis 宿主，足以挂载真实的 `ToolRuntime`。
 *
 * 为什么不用 stub 掉 `tools.register`（方案 10 阶段 1 的要求）：
 * v0.1 的 P1-1 是「`register()` 校验失败」，只有走真实 `ToolRuntime.register`
 * 才能让那个 bug 失败。所以这里 mount 的是真的 `@deepseek-ai/dsh-tools`，
 * 只把它依赖的 `systemPrompt` 面做一个足够小的替身。
 *
 * `systemPrompt` 需要满足 `ToolRuntime` 构造期的两个调用：
 * - `systemPrompt.tools(callback)`：声明 schema 供给源（这里只记录，不渲染）；
 * - `systemPrompt.section(...)`（仅 ptc 模式）：native 模式下不会走到。
 */

import { Context, Service } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';

/**
 * `systemPrompt` 的最小替身。
 *
 * 只实现 `ToolRuntime` 真正会调用的方法；其余方法缺失时的错误应当暴露出来，
 * 而不是被静默吞掉——所以这里不做 Proxy 兜底。
 */
class StubSystemPrompt extends Service {
  /** 已注册的 schema 供给源。 */
  providers = [];

  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  /** 注册一个 schema 供给源，返回撤销函数。 */
  tools(provider) {
    this.providers.push(provider);
    return () => {
      const index = this.providers.indexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  /** 提示词片段；测试里不需要真正渲染。 */
  section() {
    return () => {};
  }

  /** 运行期上下文片段。 */
  context() {
    return () => {};
  }

  getContextOrder() {
    return 0;
  }

  getSectionOrder() {
    return 0;
  }
}

/**
 * 起一个最小宿主。
 *
 * @returns {Promise<{ctx: Context, tools: object, systemPrompt: StubSystemPrompt, stop: () => Promise<void>}>}
 */
export async function startHost() {
  const ctx = new Context();
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  return {
    ctx,
    tools: ctx.tools,
    systemPrompt: ctx.get('systemPrompt'),
    stop: async () => {
      await ctx.fiber.dispose();
    },
  };
}

export { Context, Service };
