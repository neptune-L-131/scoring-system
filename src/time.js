// time.js —— 全系统唯一时间源（P0 引入，P1 逐处替换调用点）
//
// 为什么需要它：打卡、流水、活跃度索引、统计桶、预算周期、周/月活动原先各自
// 读 `Date.now()` / `new Date()`，并且用 ±n*864e5 或 Math.round(msDiff/864e5)
// 推算"自然日"。毫秒算术在夏令时切换日会多/少 1 小时，在 23:59–00:01 之间
// 多次读时钟会让同一笔事务落到两个自然日（"今天打卡了但算在昨天"）。
//
// 本模块的两条硬规则：
// 1) 日界一律用本地日历运算：`new Date(y, m, d ± n)`；日差用日历索引
//    `Date.UTC(y, m, d) / 864e5` 相减，绝不拿毫秒差四舍五入当"天数"。
// 2) 同一笔业务事务只读一次时钟（见 business.js checkIn 的 txNow），
//    本模块的 now() 不保证事务内多次读取一致，它只负责提供"当前时刻"。
//
// 时区口径：本地时区、本地 00:00 为日界。业务日界本轮固定 0 点，
// 所有带 `cutoff` 参数的函数预留了"业务日从几点开始"的能力（0..23 小时），
// 目前所有调用方都不传，等价于本地自然日。设备时区变更后，历史 dayKey
// 是写入时按当时本地时间算出来的字符串，不会自动重算（口径见设计稿）。
//
// 时钟回拨保护：now() 单调不减。设备时间被手动调早时，返回上一次读到的时刻，
// 避免"流水时间倒退 / 冷却时间变成负数"。测试用 __setClockForTest 注入假时钟
// 时会重置这个基线，所以假时钟可以自由前后移动。

const MS_DAY = 864e5;
// 宿主机历史数据里可能出现的非法时区偏移上限（用于诊断，不影响计算）
const CUTOFF_MIN = 0;
const CUTOFF_MAX = 23;

let injectedClock = null;
let lastNow = 0;
let clockRollbacks = 0;

function pad2(n) { return String(n).padStart(2, '0'); }

// 把任意"看起来像时间戳"的输入归一为本地时间戳；空值/非法值回落到当前时刻。
// 注意：这里刻意不用 `Number(ts) || now()`，因为 0 会被当成空值——
// 与 pure.js 里 budgetBounds 的历史行为保持一致（0 视为未传）。
function asTs(ts) {
  const n = Number(ts);
  return (isFinite(n) && n > 0) ? n : now();
}

function clampCutoff(cutoff) {
  const n = Math.round(Number(cutoff));
  if (!isFinite(n)) return 0;
  return Math.min(CUTOFF_MAX, Math.max(CUTOFF_MIN, n));
}

// ===== 时钟 =====
// 当前时刻；单调不减（设备时钟回拨时夹到上一次读到的值）。
function now() {
  const t = injectedClock ? Number(injectedClock()) : Date.now();
  const v = isFinite(t) ? t : lastNow;
  if (v < lastNow) {
    clockRollbacks++;
    return lastNow;
  }
  lastNow = v;
  return v;
}

// 测试钩子：注入假时钟（传 null 恢复真实时钟）。
// resetMonotonic=false 时保留单调基线，用于测试"时钟回拨被夹住"。
function __setClockForTest(fn, resetMonotonic) {
  injectedClock = (typeof fn === 'function') ? fn : null;
  if (resetMonotonic !== false) lastNow = 0;
  return now();
}

// 诊断用：本进程内发生过多少次时钟回拨（不参与业务计算）。
function __clockRollbacks() { return clockRollbacks; }

// ===== 日界与日键 =====
// 某时刻所属"业务日"的起点。cutoff=0 时即本地 00:00；
// cutoff=3 表示业务日从本地 03:00 开始，凌晨 1 点仍属前一业务日。
function dayStart(ts, cutoff) {
  const t = asTs(ts);
  const d = new Date(t);
  const c = clampCutoff(cutoff);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (c === 0) return todayStart;
  const boundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), c).getTime();
  return t >= boundary ? boundary : addDays(boundary, -1);
}

// 自然日键 YYYY-MM-DD（按本地日历；cutoff>0 时为该业务日的日历日）。
function dayKeyOf(ts, cutoff) {
  const d = new Date(dayStart(ts, cutoff));
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 日历日索引：以本地年月日构造 UTC 零点再除以一天。
// 结果与夏令时无关（UTC 无 DST），同一天恒定同一整数。
function dayIndex(ts) {
  const d = new Date(asTs(ts));
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
}

// 日历日差：a 的日期减 b 的日期（a 更晚为正）。DST 切换日恒为 ±1。
function dayDiff(a, b) {
  return dayIndex(a) - dayIndex(b);
}

// 按日历加减天数，保留时分秒（DST 切换日经过的实际毫秒数可能不是 n*864e5）。
function addDays(ts, n) {
  const d = new Date(asTs(ts));
  const k = Math.round(Number(n) || 0);
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + k,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
  ).getTime();
}

function todayKey(cutoff) { return dayKeyOf(now(), cutoff); }

function isToday(ts, cutoff) { return dayKeyOf(ts, cutoff) === todayKey(cutoff); }

// ===== 周 / 周期 =====
// anchor: 1=周一 … 7=周日；返回该周起始日的本地零点时间戳。
function weekStart(ts, anchor) {
  const base = dayStart(ts);
  const d = new Date(base);
  const dow = (d.getDay() + 6) % 7 + 1; // 1=Mon … 7=Sun
  const a = Math.min(7, Math.max(1, Math.round(Number(anchor) || 1)));
  let diff = dow - a;
  if (diff < 0) diff += 7;
  return addDays(base, -diff);
}

function weekKey(ts, anchor) { return dayKeyOf(weekStart(ts, anchor)); }

// 周期键：日 / 月 / 周（周键为起始日）。与既有 periodKey 的输出完全一致。
function periodKeyOf(cfg, ts) {
  const c = cfg || {};
  if (c.period === 'day') return dayKeyOf(ts);
  if (c.period === 'month') {
    const d = new Date(asTs(ts));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  return weekKey(ts, c.anchor || 1);
}

// 周期区间：period = 'day' | 'week' | 'month'；end 为开区间（下一周期起点）。
function rangeOf(period, ts, anchor) {
  if (period === 'month') {
    const d = new Date(asTs(ts));
    const y = d.getFullYear(), m = d.getMonth();
    return {
      key: y + '-' + pad2(m + 1),
      start: new Date(y, m, 1).getTime(),
      end: new Date(y, m + 1, 1).getTime(),
    };
  }
  if (period === 'day') {
    const s = dayStart(ts);
    return { key: dayKeyOf(s), start: s, end: addDays(s, 1) };
  }
  const s = weekStart(ts, anchor);
  return { key: dayKeyOf(s), start: s, end: addDays(s, 7) };
}

// 预算周期边界：键带 M:/W: 前缀（历史数据与 UI 都依赖这个格式）。
function budgetBounds(cycle, ts, anchor) {
  if (cycle === 'month') {
    const r = rangeOf('month', ts, anchor);
    return { key: 'M:' + r.key, start: r.start, end: r.end };
  }
  const r = rangeOf('week', ts, anchor);
  return { key: 'W:' + r.key, start: r.start, end: r.end };
}

// 距今 N 个自然日之前的日期键（N 取绝对值向 0 取整，负数按 0 处理）。
function keyOffset(daysAgo) {
  const n = Math.max(0, Math.round(Number(daysAgo) || 0));
  return dayKeyOf(addDays(dayStart(now()), -n));
}

// 相对参考时刻的日历日差（ref 缺省为当前时刻）。正数表示未来。
function relativeDay(ts, ref) {
  return dayIndex(ts) - dayIndex(ref === undefined ? now() : ref);
}

// 业务日键：本轮 cutoff 固定 0，等价于 dayKeyOf；参数为后续"业务日从几点开始"预留。
function businessDayKey(ts, cutoff) { return dayKeyOf(ts, cutoff); }

export {
  now, dayStart, dayKeyOf, dayIndex, dayDiff, addDays, todayKey, isToday,
  weekStart, weekKey, periodKeyOf, rangeOf, budgetBounds, keyOffset, relativeDay, businessDayKey,
  __setClockForTest, __clockRollbacks,
};
