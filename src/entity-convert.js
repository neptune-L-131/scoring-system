import { AFFAIR_CURVES } from './constants.js';
import { Ledger } from './ledger.js';
import { commit } from './persist.js';
import { affairSteps, clone, now, uid } from './pure.js';
import { state } from './state.js';
import { periodKeyOf } from './time.js';
import { toast } from './toast.js';
// entity-convert.js —— 杂事 ↔ 项目 的同 id 换表转换（第 4 轮 P3）
//
// 设计口径：
// 1) 同一条记录只换表：id / 名称 / 创建时间 / 日程 / 预算绑定原样带走，不复制记录、不新建实体。
// 2) 只记录“最近一次转换”的快照，撤销也只允许撤销这一次；撤销边界见 conversionUndoState。
// 3) 项目降级为杂事时，进度轴 / 步骤 / 已发放进度 / 成果点会在换表后丢失，
//    必须先让用户明确确认；用户取消时整体不动作（不写表、不写流水）。

const CONVERSIONS_MAX = 10;
const PERIOD_PROBE = [{ period: 'week', anchor: 1 }, { period: 'month' }];

function conversions() {
  if (!Array.isArray(state.conversions)) state.conversions = [];
  return state.conversions;
}

// 有损字段：只做判定与文案，不改数据
function lossyFieldsOf(a) {
  if (!a) return [];
  const out = [];
  const steps = affairSteps(a).length;
  if (steps > 0) out.push('步骤 ' + steps + ' 步');
  if ((Number(a.currentCell) || 0) > 0) out.push('进度轴已推进到第 ' + Math.round(a.currentCell) + ' 格');
  if ((Number(a.alreadyGiven) || 0) > 0) out.push('已发放进度 ' + a.alreadyGiven);
  if (a.ach && Number(a.ach.amount) > 0) out.push('完成成果点 ' + a.ach.amount);
  return out;
}

function stashAffairUndo(id) {
  if (!state.affairUndo || !state.affairUndo[id]) return null;
  const stash = clone(state.affairUndo[id]);
  delete state.affairUndo[id];
  return stash;
}

function restoreAffairUndo(id, stash) {
  if (!state.affairUndo) state.affairUndo = {};
  if (stash && stash.length) state.affairUndo[id] = clone(stash);
  else delete state.affairUndo[id];
}

// 转换后写一条事件流水；返回值用于记录“撤销边界”的日志基线
function writeConvertEvent(desc, id) {
  return Ledger.event(desc, 'entity-convert', { affairId: id, choreId: id });
}

function pushRecord(rec) {
  const list = conversions();
  list.push(rec);
  if (list.length > CONVERSIONS_MAX) list.shift();
  return rec;
}

function baseRecord(dir, id, snapshot, undoStash) {
  const ts = now();
  const keys = PERIOD_PROBE.map(function (c) { return periodKeyOf(c, ts); });
  return {
    id: uid(), at: ts, dir: dir, entityId: id,
    weekKey: keys[0], monthKey: keys[1],
    snapshot: snapshot, affairUndo: undoStash,
    logsAt: 0, headLogId: null,
  };
}

function sealRecord(rec) {
  rec.logsAt = (state.logs || []).length;
  rec.headLogId = state.logs && state.logs[0] ? state.logs[0].id : null;
  return rec;
}

// 杂事 → 项目：补 steps / 进度轴 / 曲线 / 成果点等字段
function choreToAffair(id) {
  const c = (state.chores || []).find(function (x) { return x.id === id; });
  if (!c) return { ok: false, reason: '杂事不存在' };
  if (c.archived) return { ok: false, reason: '已归档的杂事不能转为项目' };
  const ts = now();
  const pdids = Array.isArray(c.progressDomainIds) ? c.progressDomainIds.map(String).filter(Boolean) : [];
  const a = {
    id: c.id,
    name: c.name,
    totalReward: 0.1,
    curve: { type: 'even', values: AFFAIR_CURVES.even.slice() },
    // 已完成的杂事转换后视为已完成项目：不补发进度、不补成果点
    currentCell: c.done ? 9 : 0,
    alreadyGiven: 0,
    // 杂事的产出领域只有一个时，转换后作为项目的归属领域；多领域/未配置则留空
    domainId: pdids.length === 1 ? pdids[0] : null,
    plannedAt: c.plannedAt || null,
    steps: [],
    ach: { enabled: false, amount: 0 },
    createdAt: c.createdAt || ts,
    startedAt: null,
    doneAt: c.done ? (c.doneAt || ts) : null,
    archived: false,
    archivedAt: null,
    budget: c.budget || null,
    budgetRef: c.budgetRef || null,
  };
  const rec = baseRecord('chore->affair', c.id, clone(c), stashAffairUndo(c.id));
  state.chores = state.chores.filter(function (x) { return x.id !== c.id; });
  if (!Array.isArray(state.affairs)) state.affairs = [];
  state.affairs.push(a);
  const ev = writeConvertEvent('杂事「' + c.name + '」转为项目', c.id);
  pushRecord(sealRecord(rec));
  commit('已转为项目「' + c.name + '」');
  return { ok: true, id: c.id, logId: ev && ev.id };
}

// 项目 → 杂事：有损字段先确认；取消则整体不动作
function affairToChore(id, opts) {
  const a = (state.affairs || []).find(function (x) { return x.id === id; });
  if (!a) return { ok: false, reason: '项目不存在' };
  if (a.archived) return { ok: false, reason: '已归档的项目不能转为杂事' };
  const lossy = lossyFieldsOf(a);
  if (lossy.length) {
    const ask = (opts && typeof opts.confirm === 'function') ? opts.confirm : (typeof confirm === 'function' ? confirm : null);
    if (ask) {
      const yes = ask('转为杂事会丢失：' + lossy.join('、') + '。\n确定继续？');
      if (!yes) return { ok: false, canceled: true };
    }
  }
  const ts = now();
  const c = {
    id: a.id,
    name: a.name,
    done: !!a.doneAt,
    doneAt: a.doneAt || null,
    plannedAt: a.plannedAt || null,
    createdAt: a.createdAt || ts,
    // 已完成项目转换后直接标记已结算：避免被杂事批量结算重复发奖
    settled: !!a.doneAt,
    freshDays: null,
    decayKey: null,
    archived: false,
    archivedAt: null,
    budget: a.budget || null,
    budgetRef: a.budgetRef || null,
    // 项目的产出走进度轴；转为杂事后不保留“每次完成产出”，只保留领域归属
    progressAmount: 0,
    progressDomainIds: a.domainId ? [a.domainId] : [],
  };
  const rec = baseRecord('affair->chore', a.id, clone(a), stashAffairUndo(a.id));
  state.affairs = state.affairs.filter(function (x) { return x.id !== a.id; });
  if (!Array.isArray(state.chores)) state.chores = [];
  state.chores.push(c);
  const ev = writeConvertEvent('项目「' + a.name + '」转为杂事', a.id);
  pushRecord(sealRecord(rec));
  commit('已转为杂事「' + a.name + '」');
  return { ok: true, id: a.id, logId: ev && ev.id };
}

// 撤销边界：
// - 只认最近一次转换；
// - 转换后日志数量与队首流水必须完全没变（任何新流水都说明发生过业务动作）；
// - 未跨“结算周期”：周周期（周一为界，预算默认口径）与月周期都必须与转换时一致。
function conversionUndoState(ts) {
  const list = conversions();
  const rec = list[list.length - 1];
  if (!rec) return { ok: false, reason: '没有可撤销的转换' };
  const t = Number(ts) > 0 ? Number(ts) : now();
  if (periodKeyOf(PERIOD_PROBE[0], t) !== rec.weekKey) return { ok: false, reason: '已跨结算周期（周），不可撤销转换' };
  if (periodKeyOf(PERIOD_PROBE[1], t) !== rec.monthKey) return { ok: false, reason: '已跨结算周期（月），不可撤销转换' };
  const head = state.logs && state.logs[0] ? state.logs[0].id : null;
  if ((state.logs || []).length !== rec.logsAt || head !== rec.headLogId) {
    return { ok: false, reason: '转换后已产生新流水，不可撤销转换' };
  }
  return { ok: true, record: rec };
}

// 最近一次转换（只读，供 UI 判断是否显示撤销入口）
function lastConversion() {
  const list = conversions();
  return list.length ? list[list.length - 1] : null;
}

function canUndoConversion() {
  return conversionUndoState().ok;
}

function undoConversion() {
  const st = conversionUndoState();
  if (!st.ok) {
    toast(st.reason, 'warn');
    return { ok: false, reason: st.reason };
  }
  const rec = st.record;
  const list = conversions();
  if (rec.dir === 'chore->affair') {
    state.affairs = (state.affairs || []).filter(function (x) { return x.id !== rec.entityId; });
    if (!Array.isArray(state.chores)) state.chores = [];
    state.chores.push(clone(rec.snapshot));
  } else {
    state.chores = (state.chores || []).filter(function (x) { return x.id !== rec.entityId; });
    if (!Array.isArray(state.affairs)) state.affairs = [];
    state.affairs.push(clone(rec.snapshot));
  }
  restoreAffairUndo(rec.entityId, rec.affairUndo);
  list.pop();
  const name = rec.snapshot && rec.snapshot.name ? rec.snapshot.name : '';
  writeConvertEvent('撤销事项转换「' + name + '」', rec.entityId);
  commit('已撤销转换「' + name + '」');
  return { ok: true, dir: rec.dir, id: rec.entityId };
}

export {
  CONVERSIONS_MAX, lossyFieldsOf, choreToAffair, affairToChore,
  conversionUndoState, lastConversion, canUndoConversion, undoConversion,
};
