// chore-cycle.js —— 杂事循环重复 + 完成历史的判定内核
//
// 只做纯计算：不读 state、不写盘、不渲染。周期内的“今天做没做”一律由本模块判定，
// 腐化债 / 批量结算 / 超期天数只消费这里的结果，避免各自重算口径。
//
// 数据形状（全部可选；缺失即一次性杂事，行为不变）：
//   c.cycle = { unit:'day'|'week'|'month', interval:>=1, anchor, nextDue, lastDue }
//     anchor  首个到期日（本地零点时间戳）
//     nextDue 下一次到期日；完成时推进到严格晚于完成日的下一个格点
//     lastDue 最近一次被完成所满足的到期日（0 表示还没有完成记录）
//   c.history = [{ ts:完成时刻, due:这次完成满足的到期日(一次性为 0), settled:是否已进批次 }]
//
// 语义（用户已拍板）：
// 1) 只留最近一次：错过多个周期只推进到未来第一个格点，不生成多张待办。
// 2) 到期那天才重新出现：完成等待期内 done=true；今天 >= nextDue 即重新待办。
// 3) “今天做没做”看本周期内有没有完成（history 中 due===lastDue 的记录），不看完成时间。
import { addDays, addMonths, dayDiff, dayStart, now } from './time.js';

const CYCLE_UNITS = ['day', 'week', 'month'];

function toDayTs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return dayStart(n);
}

// 形状守卫：缺字段 / 非法单位 / 非法间隔一律返回 null（按一次性读入）。
function normalizeChoreCycle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (CYCLE_UNITS.indexOf(raw.unit) < 0) return null;
  const interval = Math.round(Number(raw.interval));
  if (!isFinite(interval) || interval < 1) return null;
  const anchor = toDayTs(raw.anchor);
  if (!anchor) return null;
  const nextDue = toDayTs(raw.nextDue) || anchor;
  const lastDue = toDayTs(raw.lastDue);
  return { unit: raw.unit, interval: interval, anchor: anchor, nextDue: nextDue, lastDue: lastDue };
}

// 完成历史守卫：非数组视为“没有历史”（返回 null，调用方不写回）；坏条目丢弃。
function normalizeChoreHistory(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach(function (e) {
    if (!e || typeof e !== 'object') return;
    const ts = Number(e.ts);
    if (!isFinite(ts) || ts <= 0) return;
    out.push({ ts: ts, due: toDayTs(e.due), settled: e.settled === true });
  });
  return out;
}

function choreCycleOf(c) {
  return normalizeChoreCycle(c && c.cycle);
}

function choreIsCyclic(c) {
  return !!choreCycleOf(c);
}

// 第 k 个格点（k>=0）：天/周按日历加天，月按日历加月（锚点不动，避免逐月累计漂移）。
function cycleGridAt(cy, k) {
  if (cy.unit === 'day') return addDays(cy.anchor, k * cy.interval);
  if (cy.unit === 'week') return addDays(cy.anchor, k * cy.interval * 7);
  return addMonths(cy.anchor, k * cy.interval);
}

// 严格晚于 ts 所在自然日的第一个到期日；若还没到锚点则返回锚点。
// 这样晚交多期时只跳到未来第一期，错过的不累积。
function choreCycleDueAfter(cycle, ts) {
  const cy = normalizeChoreCycle(cycle);
  if (!cy) return 0;
  const limit = dayStart(ts === undefined ? now() : ts);
  if (dayDiff(limit, cy.anchor) < 0) return cy.anchor;
  let k = 0;
  if (cy.unit === 'month') {
    const a = new Date(cy.anchor);
    const b = new Date(limit);
    k = Math.floor(((b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())) / cy.interval);
  } else {
    const step = cy.unit === 'week' ? cy.interval * 7 : cy.interval;
    k = Math.floor(dayDiff(limit, cy.anchor) / step);
  }
  if (!(k >= 0)) k = 0;
  let due = cycleGridAt(cy, k);
  // 月加法的估算可能超前一格：退到 <= limit 的最后一个格点，再向前走一格。
  while (k > 0 && dayDiff(due, limit) > 0) {
    k -= 1;
    due = cycleGridAt(cy, k);
  }
  while (dayDiff(due, limit) <= 0) {
    k += 1;
    due = cycleGridAt(cy, k);
  }
  return due;
}

// 本周期是否已完成：今天早于 nextDue（等待下一次到期）且 history 里有满足 lastDue 的记录。
// 无条件优先走 history，避免“完成时间”本身被当成今天做没做的依据。
function choreDoneInCycle(c, ts) {
  const cy = choreCycleOf(c);
  const today = dayStart(ts === undefined ? now() : ts);
  if (!cy) return !!(c && c.done);
  if (dayDiff(today, cy.nextDue) >= 0) return false;
  const hist = (c && Array.isArray(c.history)) ? c.history : [];
  if (cy.lastDue > 0) {
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      const e = hist[i];
      if (e && Number(e.due) === cy.lastDue) return true;
    }
    return false;
  }
  // 旧配置没有 lastDue 时回落到已有的完成标记，避免升级瞬间把等待中的卡片放出来。
  return !!(c && c.done);
}

// 记一次完成：写入 history、推进 nextDue、同步 done/doneAt。
// 返回 false 表示本周期已经完成（防重复）。
function choreMarkCompletion(c, ts) {
  if (!c) return false;
  const raw = Number(ts);
  const at = (isFinite(raw) && raw > 0) ? raw : now();
  const cy = choreCycleOf(c);
  if (cy) {
    if (choreDoneInCycle(c, at)) return false;
    const hist = Array.isArray(c.history) ? c.history : [];
    const due = cy.nextDue;
    hist.push({ ts: at, due: due, settled: false });
    c.history = hist;
    cy.lastDue = due;
    cy.nextDue = choreCycleDueAfter(cy, at);
    c.cycle = cy;
    c.done = true;
    c.doneAt = at;
    c.settled = false;
    return true;
  }
  c.done = true;
  c.doneAt = at;
  const hist = Array.isArray(c.history) ? c.history : [];
  hist.push({ ts: at, due: 0, settled: false });
  c.history = hist;
  return true;
}

// 取消最近一次完成：弹出 history 末条，循环杂事把 nextDue 退回该条的到期日。
function choreUndoCompletion(c) {
  if (!c) return false;
  const cy = choreCycleOf(c);
  const hist = Array.isArray(c.history) ? c.history : null;
  const last = (hist && hist.length) ? hist[hist.length - 1] : null;
  if (hist && last) hist.pop();
  if (cy && last && Number(last.due) > 0) {
    cy.nextDue = dayStart(Number(last.due));
    const prev = (hist && hist.length) ? hist[hist.length - 1] : null;
    cy.lastDue = (prev && Number(prev.due) > 0) ? dayStart(Number(prev.due)) : 0;
    c.cycle = cy;
    // settled 镜像同步回“剩余历史是否全部结算”
    c.settled = !!hist && hist.length > 0 && hist.every(function (e) { return !e || e.settled === true; });
  }
  c.done = false;
  c.doneAt = null;
  return true;
}

// 完成历史只读访问（给“已完成”区/回溯查询用；本步不接界面）。
function choreHistoryOf(c) {
  return (c && Array.isArray(c.history)) ? c.history.slice() : [];
}

export {
  CYCLE_UNITS, normalizeChoreCycle, normalizeChoreHistory, choreCycleOf, choreIsCyclic,
  choreCycleDueAfter, choreDoneInCycle, choreMarkCompletion, choreUndoCompletion, choreHistoryOf,
  toDayTs,
};
