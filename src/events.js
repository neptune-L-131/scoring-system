// events.js —— 事件触发（第二步接通的打卡/购买）
//
// 边界：
// 1. 只定义事件对象、事件环形记录与「事件 → 流」匹配计划；不写账本。
//    真正的执行在 event-bus.js：发起方事务提交后由 post-commit.js 触发。
// 2. 识别打卡、购买、杂事完成三类事件；预算超支、项目完成等留在后续阶段。
// 3. 事件键 = 类型 + 来源记录 id，天然唯一；撤销源动作不重发事件。
//    杂事完成：循环杂事用「本次满足的到期日」、一次性用完成时刻作来源 id。
// 4. 本模块不 import state/normalize/flow-engine，避免把预留结构接进运行时依赖。
import { EVENT_DEPTH_MAX, EVENT_KEEP, EVENT_MAX_FLOWS_PER_EVENT } from './constants.js';

export const EVENT_KINDS = ['checkin', 'purchase', 'chore.completed'];

const PAYLOAD_FIELDS = {
  checkin: ['taskId', 'streak', 'cost', 'logId', 'budgetEntryId'],
  purchase: ['productId', 'tier', 'price', 'paid', 'assetPayments', 'stockAfter', 'orderId', 'budgetEntryId'],
  'chore.completed': ['choreId', 'name', 'doneAt', 'due', 'cycleUnit'],
};

function tsOf(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function strOf(v) {
  return typeof v === 'string' ? v.trim() : '';
}
function numOr(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function isKind(kind) {
  return EVENT_KINDS.indexOf(kind) >= 0;
}

// 事件键：类型 + 来源记录 id（打卡日志 / 购买订单），不额外生成随机 id
export function eventKeyOf(kind, sourceId) {
  const k = isKind(kind) ? kind : '';
  const s = strOf(sourceId);
  return k && s ? (k + ':' + s) : '';
}

// 冻结载荷：只保留该事件类型声明的少量标量/资产支付列表，其它字段一律丢弃
function normalizePayload(kind, raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  (PAYLOAD_FIELDS[kind] || []).forEach(function (k) {
    const v = src[k];
    if (v === undefined || v === null) return;
    if (k === 'assetPayments') {
      const list = Array.isArray(v) ? v : [];
      const pays = list.slice(0, 20).map(function (p) {
        p = (p && typeof p === 'object') ? p : {};
        return { assetId: strOf(p.assetId), amount: Math.max(0, Math.round(numOr(p.amount))) };
      }).filter(function (p) { return p.assetId && p.amount > 0; });
      if (pays.length) out[k] = pays;
      return;
    }
    if (k === 'tier' || k === 'price' || k === 'paid' || k === 'streak' || k === 'cost' || k === 'stockAfter' || k === 'doneAt' || k === 'due') {
      out[k] = numOr(v);
      return;
    }
    const s = strOf(v);
    if (s) out[k] = s;
  });
  return out;
}

// 派发结果留痕：每条事件记录最近一次派发的逐流结果（失败原因可查，最多 20 条）
function normalizeResults(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, 20).forEach(function (r) {
    r = (r && typeof r === 'object') ? r : {};
    const flowId = strOf(r.flowId);
    const code = strOf(r.code);
    if (!flowId && !code) return;
    out.push({
      flowId: flowId,
      ok: r.ok === true,
      code: code,
      message: strOf(r.message).slice(0, 120),
      runId: strOf(r.runId),
      skipped: strOf(r.skipped),
    });
  });
  return out;
}

// 生成事件对象；类型/来源/时刻不合法时返回 null（不静默造一个无键事件）
export function makeEvent(kind, sourceId, occurredAt, payload) {
  if (!isKind(kind)) return null;
  const key = eventKeyOf(kind, sourceId);
  if (!key) return null;
  const at = tsOf(occurredAt);
  if (!at) return null;
  return {
    v: 1,
    kind: kind,
    key: key,
    sourceId: strOf(sourceId),
    occurredAt: at,
    payload: normalizePayload(kind, payload),
    results: [],
  };
}

// 一次完成的稳定来源 id：循环杂事用「本次满足的到期日」，一次性杂事用完成时刻。
// 循环杂事同一周期即使历史被重放/反复写，也只会得到同一个事件键。
export function choreCompletionSourceId(choreId, entry) {
  const id = strOf(choreId);
  if (!id) return '';
  const due = Math.round(numOr(entry && entry.due));
  if (due > 0) return id + ':due:' + due;
  const ts = tsOf(entry && entry.ts);
  return ts ? (id + ':done:' + ts) : '';
}

// 由完成历史条目构造 chore.completed 事件（只给用户手工完成的路径使用）。
export function makeChoreCompletedEvent(chore, entry) {
  if (!chore || !chore.id || !entry) return null;
  const sourceId = choreCompletionSourceId(chore.id, entry);
  if (!sourceId) return null;
  return makeEvent('chore.completed', sourceId, tsOf(entry.ts), {
    choreId: chore.id,
    name: chore.name || '',
    doneAt: tsOf(entry.ts),
    due: Math.round(numOr(entry.due)),
    cycleUnit: (chore.cycle && chore.cycle.unit) || '',
  });
}

export function normalizeEvent(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const kind = x.kind;
  if (!isKind(kind)) return null;
  const key = eventKeyOf(kind, x.sourceId);
  const at = tsOf(x.occurredAt);
  if (!key || !at) return null;
  return {
    v: 1,
    kind: kind,
    key: key,
    sourceId: strOf(x.sourceId),
    occurredAt: at,
    payload: normalizePayload(kind, x.payload),
    results: normalizeResults(x.results),
  };
}

// 事件环形记录：按事件键去重，新的在前，最多保留 EVENT_KEEP 条
export function normalizeEventStore(x) {
  const out = { v: 1, recent: [] };
  const list = (x && typeof x === 'object' && Array.isArray(x.recent)) ? x.recent : [];
  const seen = new Set();
  for (let i = 0; i < list.length && out.recent.length < EVENT_KEEP; i += 1) {
    const ev = normalizeEvent(list[i]);
    if (!ev || seen.has(ev.key)) continue;
    seen.add(ev.key);
    out.recent.push(ev);
  }
  return out;
}

// 登记事件（纯函数）：重复事件返回 added:false，调用方据此跳过派发
export function rememberEvent(store, ev) {
  const base = normalizeEventStore(store);
  const next = normalizeEvent(ev);
  if (!next) return { store: base, added: false, reason: 'BAD_EVENT' };
  for (let i = 0; i < base.recent.length; i += 1) {
    if (base.recent[i].key === next.key) return { store: base, added: false, reason: 'DUPLICATE' };
  }
  return {
    store: { v: 1, recent: [next].concat(base.recent).slice(0, EVENT_KEEP) },
    added: true,
    reason: '',
  };
}

// 流的触发方式：只有 trigger.type==='event' 且事件类型在白名单内才算事件触发流
export function eventTriggersOf(flow) {
  const t = flow && flow.trigger;
  if (!t || t.type !== 'event') return null;
  const kind = t.event && t.event.kind;
  return isKind(kind) ? { kind: kind } : null;
}

// 事件 → 流 的匹配计划：不改状态、不执行流，只回答“会命中谁、为什么跳过”
function matchEventFlows(ev, opts) {
  const o = opts || {};
  const flows = Array.isArray(o.flows) ? o.flows : [];
  const idem = (o.idem && typeof o.idem === 'object') ? o.idem : {};
  const matched = [];
  const skipped = [];
  flows.forEach(function (flow) {
    if (!flow || !flow.id) return;
    const trig = eventTriggersOf(flow);
    if (!trig || trig.kind !== ev.kind) return;
    if (flow.enabled === false || flow.invalid === true) {
      skipped.push({ flowId: flow.id, reason: 'disabled' });
      return;
    }
    const runKey = flow.id + '@event:' + ev.key;
    if (flow.lastEventKey === ev.key || idem[runKey]) {
      skipped.push({ flowId: flow.id, reason: 'already-run', runKey: runKey });
      return;
    }
    matched.push({ flowId: flow.id, name: flow.name || '', runKey: runKey });
  });
  let overflow = 0;
  if (matched.length > EVENT_MAX_FLOWS_PER_EVENT) {
    overflow = matched.length - EVENT_MAX_FLOWS_PER_EVENT;
    matched.length = EVENT_MAX_FLOWS_PER_EVENT;
  }
  return { matched: matched, skipped: skipped, overflow: overflow };
}

// 派发计划：本期只产出计划（executed 恒为 0），不落任何运行记录
export function planEventDispatch(ev, opts) {
  const e = normalizeEvent(ev);
  if (!e) return { ok: false, code: 'EVENT_BAD' };
  const depth = Math.max(0, Math.round(numOr((opts || {}).depth)));
  if (depth >= EVENT_DEPTH_MAX) return { ok: false, code: 'EVENT_DEPTH_LIMIT', event: e };
  const m = matchEventFlows(e, opts);
  return {
    ok: true,
    shadow: true,
    executed: 0,
    event: e,
    matched: m.matched,
    skipped: m.skipped,
    overflow: m.overflow,
  };
}

// 派发计划入口 planEventDispatch：只产出计划，不做执行（真实派发在 event-bus.js，
// 由 post-commit 的 emitPostCommit 在事务提交后触发）。
// 本模块不再导出 dispatchEvent 这类“看似执行、实则只算计划”的别名，消除语义歧义。
