import { affairLastAdvance, affairSteps, effectiveLastTs, getTaskDomainIds, taskCheckedToday } from './pure.js';
import { state } from './state.js';
import { addDays, dayStart, now } from './time.js';
import { choreOverdueDays } from './utils.js';
// entity-kit.js —— Task / Affair / Chore 的统一“只读”访问层（第 4 轮第二阶段）
//
// 三张表仍是各自独立的存储结构，本模块只在读取侧把它们映射成同一个“事项”概念：
//   kind: 'task' | 'affair' | 'chore'
// 所有函数只读 state，不写 state、不调用 save、不触发渲染，供 UI / 查询复用。
// 约束：本模块不得 import render-work.js / undo.js（避免与渲染层互相依赖）。

const ENTITY_KINDS = ['task', 'affair', 'chore'];
const KIND_LABEL = { task: '任务', affair: '项目', chore: '杂事' };

// 统一实体引用：'task:t1' / {kind:'task',id:'t1'} / {type:'chore',id:'c1'}
function normalizeEntityRef(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    const i = ref.indexOf(':');
    if (i <= 0) return null;
    const kind = ref.slice(0, i);
    const id = ref.slice(i + 1);
    return (ENTITY_KINDS.indexOf(kind) >= 0 && id) ? { kind: kind, id: id } : null;
  }
  if (typeof ref === 'object') {
    const kind = ref.kind || ref.type;
    if (ENTITY_KINDS.indexOf(kind) >= 0 && ref.id) return { kind: kind, id: String(ref.id) };
  }
  return null;
}

function entityRef(kind, id) { return normalizeEntityRef({ kind: kind, id: id }); }

// 按引用取实体；找不到时 entity 为 null（调用方不需要再判 kind）
function findEntity(ref) {
  const r = normalizeEntityRef(ref);
  if (!r) return null;
  let entity = null;
  if (r.kind === 'task') entity = (state.tasks || []).find(function (t) { return t && t.id === r.id; }) || null;
  else if (r.kind === 'affair') entity = (state.affairs || []).find(function (a) { return a && a.id === r.id; }) || null;
  else entity = (state.chores || []).find(function (c) { return c && c.id === r.id; }) || null;
  return { kind: r.kind, id: r.id, entity: entity };
}

function entityName(ref) {
  const f = findEntity(ref);
  return f && f.entity ? String(f.entity.name || '') : '';
}

// 归属领域：任务可多领域；项目单领域（无领域即“活力点”类项目）；杂事无领域
function entityDomainIds(ref) {
  const f = findEntity(ref);
  if (!f || !f.entity) return [];
  if (f.kind === 'task') return getTaskDomainIds(f.entity);
  if (f.kind === 'affair') return f.entity.domainId ? [f.entity.domainId] : [];
  return [];
}

// 活跃：任务未归档；项目未完成且未归档；杂事未完成且未归档
function entityActive(ref) {
  const f = findEntity(ref);
  if (!f || !f.entity) return false;
  const e = f.entity;
  if (f.kind === 'task') return !e.archived;
  if (f.kind === 'affair') return !e.doneAt && !e.archived;
  return !e.done && !e.archived;
}

// 上次活动时间：只读实体上的既有时间字段，不做任何推导写入
function entityLastActivity(ref) {
  const f = findEntity(ref);
  if (!f || !f.entity) return null;
  const e = f.entity;
  let ts = 0;
  if (f.kind === 'task') ts = effectiveLastTs(e) || e.createdAt || 0;
  else if (f.kind === 'affair') ts = affairLastAdvance(e) || e.plannedAt || e.createdAt || 0;
  else ts = e.doneAt || e.plannedAt || e.createdAt || 0;
  return ts > 0 ? ts : null;
}

// 统一口径快照（返回值是新对象，调用方随意修改都不会写回 state）
function entityMeta(ref) {
  const f = findEntity(ref);
  if (!f) return null;
  const e = f.entity;
  const meta = {
    kind: f.kind,
    ref: f.kind + ':' + f.id,
    id: f.id,
    label: KIND_LABEL[f.kind],
    exists: !!e,
    name: e ? String(e.name || '') : '',
    domainIds: entityDomainIds(f),
    active: entityActive(f),
    archived: !!(e && e.archived),
    done: !!(e && (f.kind === 'affair' ? e.doneAt : (f.kind === 'chore' ? e.done : false))),
    createdAt: e && e.createdAt ? e.createdAt : null,
    lastActivityAt: entityLastActivity(f),
  };
  if (f.kind === 'task' && e) {
    meta.checkedToday = taskCheckedToday(e);
    meta.streak = Math.max(0, Math.round(Number(e.streak) || 0));
  }
  if (f.kind === 'affair' && e) {
    const steps = affairSteps(e);
    meta.steps = { total: steps.length, done: steps.filter(function (s) { return s.doneAt; }).length };
    meta.currentCell = Math.max(0, Math.min(9, Math.round(Number(e.currentCell) || 0)));
  }
  if (f.kind === 'chore' && e) {
    meta.overdueDays = choreOverdueDays(e);
  }
  return meta;
}

// 实体历史：实体自身时间点 + 可见流水 + 已绑定的现实账目，按时间倒序
// 只读；不依赖日志完整性（日志被裁剪后仍能返回实体字段上的时间点）。
function entityHistory(ref, opts) {
  const f = findEntity(ref);
  if (!f || !f.entity) return [];
  const limit = (opts && Number(opts.limit) > 0) ? Math.round(Number(opts.limit)) : 200;
  const e = f.entity;
  const id = f.id;
  const out = [];
  function push(ev) { if (ev && ev.ts) out.push(ev); }

  push({ ts: Number(e.createdAt) || 0, kind: 'entity', src: 'created', label: '创建' });
  if (f.kind === 'affair') {
    push({ ts: Number(e.plannedAt) || 0, kind: 'entity', src: 'planned', label: '安排日程' });
    push({ ts: Number(e.startedAt) || 0, kind: 'entity', src: 'started', label: '开始推进' });
    affairSteps(e).forEach(function (s, i) {
      if (s && s.doneAt) push({ ts: Number(s.doneAt) || 0, kind: 'entity', src: 'step-done', label: '完成第 ' + (i + 1) + ' 步：' + String(s.text || '') });
    });
    push({ ts: Number(e.doneAt) || 0, kind: 'entity', src: 'completed', label: '完成项目' });
  } else if (f.kind === 'chore') {
    push({ ts: Number(e.plannedAt) || 0, kind: 'entity', src: 'planned', label: '安排日期' });
    push({ ts: Number(e.doneAt) || 0, kind: 'entity', src: 'completed', label: '完成杂事' });
  }
  push({ ts: Number(e.archivedAt) || 0, kind: 'entity', src: 'archived', label: '归档' });

  const taskLogIds = new Set();
  (state.logs || []).forEach(function (l) {
    if (!l) return;
    let hit = false;
    if (f.kind === 'task') { hit = l.taskId === id; if (hit) taskLogIds.add(l.id); }
    else if (f.kind === 'affair') hit = l.affairId === id;
    else hit = l.choreId === id;
    if (!hit) return;
    push({
      ts: Number(l.time) || 0, kind: 'log', src: l.src || 'log',
      label: String(l.desc || ''), amount: Number(l.amt) || 0,
      domain: l.dom || '', id: l.id,
    });
  });

  // 现实账目：通过 links 反查归属（任务经打卡流水 id 间接关联）
  const ledger = (state.ext && state.ext.budgets && state.ext.budgets.ledger) || [];
  ledger.forEach(function (be) {
    if (!be) return;
    const links = be.links || {};
    let hit = false;
    if (f.kind === 'affair') hit = links.affairId === id;
    else if (f.kind === 'chore') hit = links.choreId === id;
    else hit = !!links.checkinLogId && taskLogIds.has(links.checkinLogId);
    if (!hit) return;
    push({
      ts: Number(be.ts) || 0, kind: 'budget', src: be.source || 'budget',
      label: String(be.note || '现实账目'), amount: Number(be.amount) || 0,
      status: be.status || 'active', id: be.id,
    });
  });

  out.sort(function (a, b) {
    return (Number(b.ts) || 0) - (Number(a.ts) || 0) || String(a.id || '').localeCompare(String(b.id || ''));
  });
  return out.slice(0, limit);
}

// 今天该做什么：任务（今日可打卡 / 已打卡）+ 项目日程（今天及逾期）+ 到期杂事
// 只读汇总，不写 state。opts.ts 仅用于测试注入“今天”。
function todayAgenda(opts) {
  const ts = (opts && Number(opts.ts) > 0) ? Number(opts.ts) : now();
  const today = dayStart(ts);
  const tomorrow = addDays(today, 1);
  const out = [];

  (state.tasks || []).forEach(function (t) {
    if (!t || t.archived) return;
    const checked = taskCheckedToday(t);
    out.push({
      kind: 'task', id: t.id, title: String(t.name || ''),
      subtitle: '', status: checked ? 'done' : 'todo',
      dueAt: null, overdue: false, domainIds: getTaskDomainIds(t),
    });
  });

  (state.affairs || []).forEach(function (a) {
    if (!a || a.doneAt || a.archived) return;
    const steps = affairSteps(a);
    const timed = [];
    steps.forEach(function (s, i) { if (s && !s.doneAt && s.plannedAt) timed.push({ step: s, index: i, ts: s.plannedAt }); });
    if (timed.length) {
      timed.forEach(function (u) {
        if (u.ts >= tomorrow) return;
        out.push({
          kind: 'affair', id: a.id, title: String(u.step.text || ''),
          subtitle: String(a.name || ''), status: 'todo', stepIndex: u.index,
          dueAt: u.ts, overdue: u.ts < today,
          domainIds: a.domainId ? [a.domainId] : [],
        });
      });
      return;
    }
    if (a.plannedAt && a.plannedAt < tomorrow) {
      out.push({
        kind: 'affair', id: a.id, title: String(a.name || ''), subtitle: '',
        status: 'todo', stepIndex: -1, dueAt: a.plannedAt, overdue: a.plannedAt < today,
        domainIds: a.domainId ? [a.domainId] : [],
      });
    }
  });

  (state.chores || []).forEach(function (c) {
    if (!c || c.archived || c.done) return;
    const overdue = choreOverdueDays(c, ts) > 0;
    const dueToday = !!c.plannedAt && dayStart(c.plannedAt) === today;
    if (!overdue && !dueToday) return;
    out.push({
      kind: 'chore', id: c.id, title: String(c.name || ''), subtitle: '',
      status: 'todo', dueAt: c.plannedAt || null, overdue: overdue, domainIds: [],
    });
  });

  // 逾期优先，其次按到期时间（无到期时间排后），最后按标题稳定排序
  out.sort(function (a, b) {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const at = a.dueAt == null ? Infinity : a.dueAt;
    const bt = b.dueAt == null ? Infinity : b.dueAt;
    if (at !== bt) return at - bt;
    return String(a.title).localeCompare(String(b.title));
  });
  return out;
}

export {
  ENTITY_KINDS, KIND_LABEL,
  normalizeEntityRef, entityRef, findEntity, entityName, entityDomainIds,
  entityActive, entityLastActivity, entityMeta, entityHistory, todayAgenda,
};
