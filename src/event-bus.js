// event-bus.js —— 事件触发执行器（阶段 5 第二步）
//
// 时序：打卡/购买的事务成功提交后，runCommand 调用 emitPostCommit(events)，
// 本模块在这里才真正执行事件流；任何流失败都不会回滚发起方事务。
// 约束：
// 1. 同一事件同一条流只执行一次：flow.lastEventKey + 持久幂等表（跨刷新不重放）。
// 2. 单事件最多触发 EVENT_MAX_FLOWS_PER_EVENT 条；不抬高上限。
// 3. 深度固定为 1：派发中再次产生事件只登记、不再派发；事件流自身也不会产生事件。
// 4. 失败/跳过写进事件记录的 results，并额外落一条可查日志，不静默吞掉。
import { normalizeEvent, normalizeEventStore, planEventDispatch, rememberEvent } from './events.js';
import { FlowEngine } from './flow-engine.js';
import { Ledger } from './ledger.js';
import { setPostCommitHandler } from './post-commit.js';
import { state } from './state.js';

function ensureEventStore() {
  if (!state.ext) state.ext = {};
  state.ext.events = normalizeEventStore(state.ext.events);
  return state.ext.events;
}

function stamp(key, result) {
  const store = ensureEventStore();
  for (let i = 0; i < store.recent.length; i += 1) {
    if (store.recent[i].key !== key) continue;
    const rec = store.recent[i];
    if (!Array.isArray(rec.results)) rec.results = [];
    rec.results.push(result);
    if (rec.results.length > 20) rec.results = rec.results.slice(-20);
    return true;
  }
  return false;
}

function errorCodeOf(r) {
  const e = (r && r.error) || {};
  if (e.code) return String(e.code);
  if (Array.isArray(e.errors) && e.errors.length && e.errors[0] && e.errors[0].code) return String(e.errors[0].code);
  return 'FLOW_EVENT_FAILED';
}

function flowNameOf(flowId) {
  const flow = (state.flows || []).find(f => f && f.id === flowId);
  return (flow && flow.name) || '动作流';
}

function dispatchOne(ev, meta) {
  ensureEventStore();
  const idem = (state.ext.assetMeters && state.ext.assetMeters.idem) || {};
  const plan = planEventDispatch(ev, { flows: state.flows, idem: idem, depth: 0 });
  if (!plan.ok) {
    stamp(ev.key, { ok: false, code: String(plan.code || 'EVENT_BAD') });
    Ledger.event('事件派发被拒绝：' + String(plan.code || 'EVENT_BAD'), 'flow-event-error', {
      eventKey: ev.key, eventKind: ev.kind,
    });
    return;
  }
  if (meta.nested) {
    // 重入护栏：深度恒为 1，只登记不执行
    stamp(ev.key, { ok: false, code: 'EVENT_REENTRANT', message: '事件派发中产生的新事件不递归执行' });
    return;
  }
  plan.matched.forEach(function (m) {
    let r;
    try {
      r = FlowEngine.runFlow(m.flowId, { trigger: 'event', event: ev, ts: ev.occurredAt });
    } catch (e) {
      r = { ok: false, error: { code: 'FLOW_EVENT_EXCEPTION', message: (e && e.message) || '' } };
    }
    if (r && r.ok) {
      stamp(ev.key, {
        flowId: m.flowId,
        ok: true,
        runId: r.runId || '',
        skipped: r.skipped || '',
      });
      return;
    }
    const code = errorCodeOf(r);
    const message = (r && r.error && r.error.message) ? String(r.error.message).slice(0, 120) : '';
    stamp(ev.key, { flowId: m.flowId, ok: false, code: code, message: message });
    // 可查的失败记录：事务已提交，这里只追加日志，绝不影响发起方的打卡/购买
    Ledger.event('事件触发「' + flowNameOf(m.flowId) + '」未执行：' + code, 'flow-event-error', {
      eventKey: ev.key, eventKind: ev.kind, flowId: m.flowId, trigger: 'event',
    });
  });
  plan.skipped.forEach(function (s) {
    stamp(ev.key, {
      flowId: s.flowId,
      ok: s.reason !== 'disabled',
      skipped: s.reason,
      code: s.reason === 'already-run' ? 'EVENT_ALREADY_RUN' : '',
    });
  });
  if (plan.overflow > 0) {
    stamp(ev.key, {
      ok: false,
      code: 'EVENT_OVERFLOW',
      message: '单次事件超出上限，' + plan.overflow + ' 条流未触发',
    });
  }
}

// 供测试直接调用；生产路径只通过 post-commit 注册的 handler 进入
export function handlePostCommitEvents(rawEvents, meta) {
  meta = meta || {};
  const list = Array.isArray(rawEvents) ? rawEvents : [];
  ensureEventStore();
  list.forEach(function (raw) {
    const ev = normalizeEvent(raw);
    if (!ev) {
      Ledger.event('事件数据不合法，已忽略派发', 'flow-event-error', {
        kind: raw && raw.kind ? String(raw.kind) : '', sourceId: raw && raw.sourceId ? String(raw.sourceId) : '',
      });
      return;
    }
    const rem = rememberEvent(state.ext.events, ev);
    state.ext.events = rem.store;
    dispatchOne(ev, meta);
  });
}

setPostCommitHandler(handlePostCommitEvents);
