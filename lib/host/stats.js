/**
 * 判定计数（方案 §6.7「自证」/ 不变量 I10「任何零结论都必须同时给出它被观测过的证据」）。
 *
 * 为什么需要它：v0.3 的 `station_status` 报「偏离 0 条」，而问题 8 指出——
 * 那个 0 区分不出「确实没有偏离」与「从来没写过」。同一个毛病在守卫上更严重：
 *
 *     「拒绝 0 次」既可能是「没有漏网」，也可能是「守卫根本没跑」。
 *
 * 所以每次判定都要留下**三个**可证伪的痕迹：
 *
 * - `evaluated`：这个守卫一共被问过多少次（0 = 它没跑过，不是"很干净"）；
 * - `firstEvaluatedAt` / `lastEvaluatedAt`：第一次/最近一次是什么时候；
 * - `denials`：按错误码分组的拒绝次数。
 *
 * 这不是日志（不落盘、不上报），只是内存里的计数器——方案 §2.3 的预算是
 * 「非候选名零服务访问」，所以计数器的写也必须是无分配的整数自增。
 */

/**
 * 创建一个判定计数器。
 *
 * @returns {object} 计数器句柄
 */
export function createStats() {
  let evaluated = 0;
  let firstEvaluatedAt;
  let lastEvaluatedAt;
  /** 候选名判定次数（进入现算的次数）——与 `evaluated` 分开，才能看出预筛是否生效。 */
  let candidates = 0;
  /** `error code → 次数`。 */
  const denials = new Map();

  return {
    /**
     * 记一次判定。
     *
     * @param {object} args
     * @param {boolean} args.candidate 是否是候选名（进入了现算）
     * @param {string} [args.deniedCode] 若拒绝，拒绝码
     */
    record({ candidate, deniedCode }) {
      const now = Date.now();
      evaluated += 1;
      if (firstEvaluatedAt === undefined) firstEvaluatedAt = now;
      lastEvaluatedAt = now;
      if (candidate) candidates += 1;
      if (typeof deniedCode === 'string' && deniedCode !== '') {
        denials.set(deniedCode, (denials.get(deniedCode) ?? 0) + 1);
      }
    },

    /**
     * 读出当前快照。
     *
     * `observed` 是**关键的**那一位：它为 false 时，`evaluated: 0` 的含义是
     * 「守卫从未运行」，而不是「一切干净」。渲染层必须据此改口（§6.7）。
     *
     * @param {number} [now] 便于测试注入
     * @returns {object}
     */
    snapshot(now = Date.now()) {
      return {
        observed: firstEvaluatedAt !== undefined,
        evaluated,
        candidates,
        firstEvaluatedAt,
        lastEvaluatedAt,
        /** 距最近一次判定的毫秒数；从未判定时为空——**不是 0**。 */
        sinceLastMs: lastEvaluatedAt === undefined ? undefined : Math.max(0, now - lastEvaluatedAt),
        denials: [...denials.entries()]
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
        deniedTotal: [...denials.values()].reduce((sum, n) => sum + n, 0),
      };
    },

    /** 卸载时清零，避免热重载后旧计数冒充新守卫的观测。 */
    reset() {
      evaluated = 0;
      candidates = 0;
      firstEvaluatedAt = undefined;
      lastEvaluatedAt = undefined;
      denials.clear();
    },
  };
}

/**
 * 把一个时间戳渲染成人可读的相对/绝对混合形式。
 *
 * 为什么不用纯相对时间：问题 1 的现场证据正是「`上次扫描` 全程停在 18:57:17」——
 * 用户需要看到**绝对时刻**才能把「配置写入时间」与「判定时间」对上。
 *
 * @param {number|undefined} at
 * @returns {string}
 */
export function formatMoment(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '（从未）';
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 把「距今多久」渲染成中文短语。
 * @param {number|undefined} ms
 * @returns {string}
 */
export function formatAgo(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '（从未发生）';
  if (ms < 1000) return '刚刚';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
