/**
 * 请求级路由锁定（方案 §2.4 L3 / §4 S2）——v0.4 改成**全局挂载 + 每次现算归属**。
 *
 * ### 宿主契约（S2 实测，`.host-src` C8/C9）
 *
 * `agent/request` 是 **agent 作用域的 waterfall**：`agent.ctx` 上的监听器只收到
 * 该 agent 的请求；而**普通上下文**（`scopeOf(ctx) === undefined`）上的监听器
 * 收到**全部** agent 的请求。S2-a 实测：`["global:a","global:b"]`。
 *
 * 于是 L3 不必逐子挂载。v0.3 那套「台账就绪后补扫一次、给既有子会话挂锁定」
 * （`index.js` 的 `pendingSweeps`）整段删除：**不存在"还没挂上锁定的子会话"这种状态**。
 *
 * ### 但全局化带来一个新风险，必须自校验（写进 `docs/known-limits.md`）
 *
 * 全局监听器不分来源，所以它**不能**用闭包里的 agent 判断身份。v0.3 的
 * `request-lock.js` 是按 agent 闭包挂的，改全局时这一处是唯一的真实风险点：
 * 一旦把 A 的请求压到 B 的路由上，就是「看起来受管、实际用了错模型」的最坏形态。
 *
 * 因此每次请求都必须：
 * 1. 从 `payload.agent.session.id` **现读**本轮的子会话 id；
 * 2. 从台账查它该用哪个路由；
 * 3. 核对台账的 `rootSessionId` 与现算谱系是否一致（`LINEAGE_MISMATCH`）；
 * 4. 只要有任何一环读不出来 → **抛错拒绝这一轮**（fail-closed，I8）。
 *
 * ### 几处必须遵守的细节，抄错任何一条都会静默失效
 *
 * 1. **必须 `await next()`**，不能跳过。宿主用 waterfall 的返回值作为最终配置，
 *    不调 `next()` 等于丢弃上游所有改写（`.host-src/dsh-agent-loop.js:1191-1195`）。
 * 2. **必须扩散返回**，保留 `temperature` / `maxTokens` / `stop` 等不归我们管的字段。
 * 3. `next()` 返回的对象被 `deepFreeze` 过（`.host-src/dsh-agent-loop.js:1186`），
 *    所以**不能原地改**，只能构造新对象。
 *
 * ### 只锁子会话，根不锁（方案 §5.3 的关键论证）
 *
 * 父会话处于 `depth === 0`，L3 按设计不锁根会话——根的模型是用户自己选的，
 * 锁定它反而是越权。子会话能做的只是"提供信息让父继续工作"，这本来就是子智能体的
 * 正常用途。**真正的风险是"子会话让父去派生新子智能体"，而那条路径被 L2 拦住。**
 */
import { ERROR_CODES, StationError } from '../shared/policy.js';

/**
 * 挂载全局请求锁定。
 *
 * @param {object} args
 * @param {object} args.ctx 插件根上下文（**不是** agent 的）
 * @param {() => object|undefined} args.readLedger 读取台账句柄（每轮现读）
 * @param {() => object} args.readPolicy 读取实时策略（判断"这归不归我们管"）
 * @param {(agent: object) => {rootSessionId: string, lineage: 'full'|'limited', hops: number}} args.resolveLineage
 *   现算某个 agent 的谱系（由 `entry-governor.js` 的 `resolveRootSessionId` 提供）
 * @param {(policy: object, agent: object) => {managed: boolean, isChild: boolean, rootSessionId: string}} args.classify
 *   受管判定（复用 `classifyAgent`，避免两处规则漂移）
 * @param {() => boolean} args.isEnabled 实时开关（插件卸载后不再生效）
 * @param {ReturnType<import('./stats.js').createStats>} [args.stats] 计数器
 * @returns {() => void} 撤销函数
 */
export function mountRequestLock({
  ctx, readLedger, readPolicy, resolveLineage, classify, isEnabled, stats,
}) {
  /** 已经升到 `observed` 的子会话（只写一次，方案 §6.3）。 */
  const observed = new Set();

  const handler = async (payload, next) => {
    if (!isEnabled()) return next();

    // ── 归属现算：只处理**子会话**的请求 ─────────────────────────────────────
    //
    // 全局监听器会收到根会话的请求。根的模型是用户自己选的，锁它属于越权（§5.3）。
    const agent = payload?.agent;
    const childSessionId = typeof agent?.session?.id === 'string' ? agent.session.id : '';

    const depth = (() => {
      const persisted = Number(agent?.session?.header?.delegationDepth);
      const runtime = Number(agent?.options?.subagentDepth);
      return Math.max(Number.isFinite(persisted) ? persisted : 0, Number.isFinite(runtime) ? runtime : 0);
    })();

    // 不是子会话（或没有身份）：不干预。
    if (depth < 1 || childSessionId === '') return next();

    // ── 管辖区：**只有落在受管范围内的子会话**才由这里裁决 ───────────────────
    //
    // 全局挂载带来一个新问题：v0.3 只给"受管子会话"挂锁定，全局化之后
    // 未受管谱系里的子会话也会被这个监听器看到。把它们一律当"漏网"拒绝，
    // 等于插件越权接管了用户没交给它的会话（v0.3 的 T61「未受管会话完全不受影响」）。
    //
    // 所以先算身份：不受管 ⇒ 原样放行，不读台账、不拒绝。
    const policy = readPolicy();
    const classified = classify(policy, agent);
    if (!classified.managed) return next();

    const current = await next();
    if (payload?.signal?.aborted === true) return current;

    const ledger = readLedger();
    if (ledger === undefined || typeof ledger.getChild !== 'function') {
      // 台账没就绪：**拒绝**而不是放行。没有台账就无法确认这个子会话该用哪个模型，
      // 而"不知道就放行"正是要消灭的那类保证（I8）。
      throw new StationError(
        ERROR_CODES.LEDGER_UNAVAILABLE,
        `派出所：派出台账尚未就绪，无法确认子会话「${childSessionId}」的批准路由，这一轮请求已被拒绝。`
        + '无法判定的请求一律拒绝（fail-closed），请在台账就绪后重试。',
        { childSessionId },
      );
    }

    let assignment;
    try {
      assignment = ledger.getChild(childSessionId);
    } catch (error) {
      throw new StationError(
        ERROR_CODES.POLICY_UNREADABLE,
        `派出所：读取派出台账失败，无法确认子会话「${childSessionId}」的批准路由，这一轮请求已被拒绝。`
        + `原因：${String(error?.message ?? error)}`,
        { childSessionId },
      );
    }

    if (assignment === undefined) {
      throw new StationError(
        ERROR_CODES.UNMANAGED_CHILD,
        `派出所：子会话「${childSessionId}」属于受管谱系（根 ${classified.rootSessionId}），`
        + '但派出台账里没有它的登记，无法确认它应当使用哪个岗位模型。'
        + '为避免「看起来受管、实际随便换模型」，这一轮请求已被拒绝。'
        + '（这通常意味着一次绕过入口的创建。请用 `station_status` 查「漏网」计数并核对会话记录。）',
        { childSessionId, rootSessionId: classified.rootSessionId },
      );
    }

    // ── 谱系一致性核对（方案 §9.2 / 改进方案 §9.2）──────────────────────────
    //
    // 台账记的 `rootSessionId` 是**派出那一刻**算出来的。resume / clear / 换父之
    // 后，现在算出来的可能不同。两者不一致时不猜哪个对——那是把一次改写伪装成正常。
    const lineage = resolveLineage(agent);
    // 谱系**没走到底** ⇒ 无法判定，但要分清"走到的半路"与"记下的根"是否一致。
    //
    // v0.4 修：v0.3 只查 `hops === 0`，而一个"有父但父查不到"的子会话 `hops` 是 1
    // ——于是它会被当成"谱系已知"，用那个**半路** id 去做一致性核对。
    //
    // 但也不能一律拒绝 `limited`：宿主在某些情况下（父会话已从 `sessions` 里
    // 被清掉、但台账记的根正是走到的那一层）能给出的信息是**足够**的——
    // 我们走到的正是台账记的那个根，那就没有不一致，拒绝它只会误伤正常运行。
    //
    // 判据：`limited` 且走到的那一层**不等于**台账记的根 ⇒ 说不清 ⇒ 拒绝（I8）。
    const walkedToRoot = lineage?.lineage !== 'limited';
    const sameAsRecorded = typeof lineage?.rootSessionId === 'string'
      && lineage.rootSessionId !== ''
      && lineage.rootSessionId === assignment.rootSessionId;
    if (lineage?.hops === 0 || (!walkedToRoot && !sameAsRecorded)) {
      throw new StationError(
        ERROR_CODES.LINEAGE_UNKNOWN,
        `派出所：无法解析子会话「${childSessionId}」的完整谱系（${
          lineage?.hops === 0
            ? '一层都走不出去'
            : `只走到 ${lineage?.rootSessionId || '未知'}，而台账记的是 ${assignment.rootSessionId || '未知'}`}），`
        + '因此无法确认它是否仍属于台账记录的受管根。无法判定时一律拒绝（fail-closed）。',
        { childSessionId, recordedRoot: assignment.rootSessionId },
      );
    }
    const nowRoot = lineage?.rootSessionId;
    if (typeof nowRoot === 'string' && nowRoot !== '' && typeof assignment.rootSessionId === 'string'
      && assignment.rootSessionId !== '' && nowRoot !== assignment.rootSessionId) {
      throw new StationError(
        ERROR_CODES.LINEAGE_MISMATCH,
        `派出所：子会话「${childSessionId}」的谱系与台账不一致——`
        + `台账记为根「${assignment.rootSessionId}」，现在算出来是根「${nowRoot}」。`
        + '谱系被改写过（resume / clear / 换父）。插件不猜哪个才对，因此拒绝这一轮请求。'
        + '（请用 `station_status` 核对后再决定是否重建登记。）',
        { childSessionId, recordedRoot: assignment.rootSessionId, currentRoot: nowRoot },
      );
    }

    const desired = { provider: assignment.provider, model: assignment.model };
    const effort = typeof assignment.reasoningEffort === 'string' && assignment.reasoningEffort.length > 0
      ? assignment.reasoningEffort
      : undefined;

    // 偏离判定（方案 3.4）：只在真正不同的时候记一次，且不阻断本轮。
    //
    // v0.4 给偏离加了 `kind` 字段（方案 §7）：`error`（这一轮确实要换模型）与
    // `notice`（宿主自己改了但被压回）要能分开统计。
    if (current.provider !== desired.provider || current.model !== desired.model) {
      try {
        await ledger.recordDeviation({
          childSessionId,
          receiptId: assignment.receiptId,
          turn: Number(payload?.turn) || 0,
          attemptedProvider: String(current.provider ?? ''),
          attemptedModel: String(current.model ?? ''),
          forcedProvider: desired.provider,
          forcedModel: desired.model,
          kind: classifyDeviation(current.provider, current.model, desired),
          at: Date.now(),
        });
      } catch {
        // 记录偏离失败不应让本来正确的请求失败——路由仍会被压回台账值。
      }
    }

    // 扩散返回：保留 temperature / maxTokens / stop 等未关注字段（方案 3.2 第 3 条）。
    const result = {
      ...current,
      ...desired,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };

    // 首次成功压回时把回执升到 observed（方案 §6.3，G4）。**只写一次**。
    //
    // 为什么放在这里而不是每轮都写：`observed` 的全部含义是「至少有一轮被正确压回」，
    // 那一刻已经发生，之后每轮再写只是把存储变成热路径（方案 §6.3 末段明令不引入
    // 「每轮都写」的行为）。
    if (!observed.has(childSessionId)) {
      observed.add(childSessionId);
      try {
        await ledger.markObserved?.(childSessionId);
      } catch {
        // 故意吞掉：路由已经正确了，写入失败只会让回执停在 started，
        // 重启对账会把它标成 unverified（如实）。
      }
    }

    return result;
  };

  const dispose = ctx.on('agent/request', handler);
  return () => {
    observed.clear();
    if (typeof dispose === 'function') dispose();
  };
}

/**
 * 给一次偏离分类（方案 §7 的 `kind` 字段）。
 *
 * 为什么要分：v0.3 把两种完全不同的现象记成同一行——
 * - 宿主给了别的模型，我们压回台账值（**真正需要用户知道**）；
 * - 宿主给了空/缺失路由（例如首次请求还没定），我们补上台账值（**正常初值化**）。
 * 后者数量大、无害，混在一起会让"偏离 12 次"这个数字失去意义。
 *
 * @param {unknown} attemptedProvider
 * @param {unknown} attemptedModel
 * @param {{provider: string, model: string}} desired
 * @returns {'error'|'notice'}
 */
function classifyDeviation(attemptedProvider, attemptedModel, desired) {
  const p = typeof attemptedProvider === 'string' ? attemptedProvider : '';
  const m = typeof attemptedModel === 'string' ? attemptedModel : '';
  // 空路由不是冲突，是尚未初始化。
  if (p === '' && m === '') return 'notice';
  // 只有一半不同：宿主在做某种退化，记录但仍算冲突（用户该看）。
  if (p === desired.provider || m === desired.model) return 'notice';
  return 'error';
}
