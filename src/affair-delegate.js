// affair-delegate.js —— 委派步骤的写入侧：候选、就地新建、解除、删除项目时的去留与撤销（第 6 轮 B2/B3/B5）
//
// 与 affair-steps.js 的分工：
//   affair-steps.js  只读：形状守卫、读档归一、认领聚合（单一事实来源在步骤的 choreRef 上）；
//   本文件           只在事务内写：为草稿步骤补 choreRef、为 origin=inline 的步骤建杂事、
//                    删除项目时拍撤销快照。
//
// 调用约定：resolveDelegatedSteps / deleteAffairCore / restoreAffairDeletion 只能在外层事务内调用
// （handleAffairSave / delAffair / undoAffairDelete 的 runCommand）。三者都把所有校验放在任何
// 副作用之前；校验通过后才写状态，随后外层若失败，Ledger 快照会把本次写入一并回滚。
import { state } from './state.js';
import { clone, now, uid } from './pure.js';
import { affairDelegatedSteps, buildChoreClaimIndex, stepChoreRef } from './affair-steps.js';
import { choreOrderInsert, choreOrderRemove } from './chore-list.js';
import { choreIsCyclic, choreMarkCompletion } from './chore-cycle.js';
import { choreDoneNow } from './utils.js';
import { Ledger } from './ledger.js';

function otherAffairs(affairId) {
  const own = String(affairId || '');
  return (state.affairs || []).filter(function (a) { return a && a.id !== own; });
}

// 候选杂事：排除已归档、本周期已完成、以及被其他项目 / 本草稿其他步骤认领的。
// exceptIndex 是正在编辑的那一步（它自己的引用不算冲突）。
function delegationCandidates(affairId, draftSteps, exceptIndex) {
  const blocked = new Set(buildChoreClaimIndex(otherAffairs(affairId)).keys());
  (Array.isArray(draftSteps) ? draftSteps : []).forEach(function (s, i) {
    if (i === exceptIndex) return;
    const ref = stepChoreRef(s);
    if (ref) blocked.add(ref.id);
  });
  return (state.chores || []).filter(function (c) {
    return c && c.id && !c.archived && !choreDoneNow(c) && !blocked.has(c.id);
  });
}

// 就地新建：形状与 addChoreFromInput 完全一致，流水同样记 chore-create。
function makeInlineChore(name) {
  const c = {
    id: uid(), name: name, done: false, doneAt: null, plannedAt: null,
    createdAt: now(), settled: false, freshDays: null, decayKey: null, tags: [],
  };
  if (!Array.isArray(state.chores)) state.chores = [];
  state.chores.push(c);
  state.choreOrder = choreOrderInsert(state.choreOrder, c.id);
  Ledger.event('新增杂事「' + name + '」', 'chore-create');
  return c;
}

// 把草稿步骤解析成可落盘的步骤：
//   - origin=inline 的 pendingChoreName → 新建杂事并写入 {id, origin:'inline'}；
//   - origin=existing 的引用 → 校验存在性与独占性；
//   - 解除委派就是草稿里没有 choreRef，这里不做任何事。
// 返回 {ok:true, steps} 或 {ok:false, reason}；失败时不留下任何写入。
function resolveDelegatedSteps(affairId, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const claimedElsewhere = new Set(buildChoreClaimIndex(otherAffairs(affairId)).keys());
  const choreIds = new Set((state.chores || []).map(function (c) { return c && c.id; }).filter(Boolean));
  const used = new Set();
  const pending = [];

  // 1) 先校验全部已有引用，此阶段没有副作用
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.pendingChoreName === 'string' ? s.pendingChoreName.trim() : '';
    if (name) { pending.push({ step: s, name: name }); continue; }
    const ref = stepChoreRef(s);
    if (!ref) { delete s.choreRef; continue; }
    if (ref.origin !== 'existing') return { ok: false, reason: '委派来源无效' };
    if (!choreIds.has(ref.id)) return { ok: false, reason: '引用的杂事已不存在' };
    if (claimedElsewhere.has(ref.id)) return { ok: false, reason: '这条杂事已被其他项目的步骤委派' };
    if (used.has(ref.id)) return { ok: false, reason: '同一条杂事不能同时委派给两个步骤' };
    used.add(ref.id);
  }

  // 2) 校验通过后才产生副作用；外层事务失败会连同这些杂事一起回滚
  pending.forEach(function (p) {
    delete p.step.choreRef;
    delete p.step.pendingChoreName;
    const c = makeInlineChore(p.name);
    p.step.choreRef = { id: c.id, origin: 'inline' };
  });
  list.forEach(function (s) {
    if (s && typeof s === 'object') delete s.pendingChoreName;
  });
  return { ok: true, steps: list };
}

// 删除项目时受影响的委派杂事：只取「未完成」的那些（按步骤顺序去重）。
// 已完成的委派杂事不参与删除选择：删项目后引用随步骤消失，它照旧留在杂事池的已完成区。
// 只读、不修数据；引用指向的杂事若已不存在则跳过。
function affairDeletionChores(affair) {
  const a = (typeof affair === 'string')
    ? (state.affairs || []).find(function (x) { return x && x.id === affair; })
    : affair;
  if (!a) return [];
  const byId = new Map();
  (state.chores || []).forEach(function (c) {
    if (c && typeof c.id === 'string' && c.id) byId.set(c.id, c);
  });
  const seen = new Set();
  const out = [];
  affairDelegatedSteps(a).forEach(function (d) {
    if (seen.has(d.choreId)) return;
    seen.add(d.choreId);
    const c = byId.get(d.choreId);
    if (!c || choreDoneNow(c)) return;
    out.push(c);
  });
  return out;
}

// 删除项目（必须在调用方事务内）：mode='purge' 时连同未完成的委派杂事一起删除，
// 其余值只删项目本身，杂事回池。两种分支的写入都在同一事务里，不会出现只删了一边。
// 成功后由外层的 runCommand 统一落盘 / 渲染 / 提示。
function deleteAffairCore(affairId, mode) {
  const id = String(affairId || '');
  const a = (state.affairs || []).find(function (x) { return x && x.id === id; });
  if (!a) return { ok: false, reason: '项目已不存在' };
  const purge = mode === 'purge';
  const chores = purge ? affairDeletionChores(a) : [];
  // 快照在任何删除动作之前拍下（含项目原位置、杂事原位置与 choreOrder 名次），
  // 但只在删除全部成功后并入撤销栈；事务失败时 state 整体回滚，记录不会留在内存里。
  const undoRec = makeAffairDeleteUndo(a, chores);
  state.affairs = (state.affairs || []).filter(function (x) { return x.id !== id; });
  if (purge && chores.length) {
    const ids = new Set(chores.map(function (c) { return c.id; }));
    state.chores = (state.chores || []).filter(function (c) { return !c || !ids.has(c.id); });
    chores.forEach(function (c) {
      state.choreOrder = choreOrderRemove(state.choreOrder, c.id);
      Ledger.event('删除杂事「' + c.name + '」（随项目「' + a.name + '」一并删除）', 'chore-delete');
    });
  }
  pushAffairDeleteUndo(undoRec);
  Ledger.event('删除项目「' + a.name + '」', 'affair-del');
  return { ok: true, removedChores: chores.map(function (c) { return c.name; }), undoId: undoRec.id };
}

// ===== B5 二：项目删除的撤销快照 =====
// 只在内存 + state 里留最近几条（由 normalize 读档放行、save 落盘），不另造审计存储。
// 记录要能整笔恢复：项目字段、项目在 affairs 里的原下标、被一起删掉的杂事（含原下标与
// choreOrder 名次）。回池分支没有杂事实体要恢复，chores 为空。
const AFFAIR_DELETE_UNDO_LIMIT = 5;

function affairDeleteUndoList() {
  if (!Array.isArray(state.affairDeleteUndo)) state.affairDeleteUndo = [];
  return state.affairDeleteUndo;
}

function makeAffairDeleteUndo(a, chores) {
  const order = Array.isArray(state.choreOrder) ? state.choreOrder : [];
  const all = Array.isArray(state.chores) ? state.chores : [];
  return {
    v: 1,
    id: uid(),
    at: now(),
    mode: chores.length ? 'purge' : 'pool',
    affair: clone(a),
    affairIndex: (state.affairs || []).indexOf(a),
    chores: (chores || []).map(function (c) {
      return {
        chore: clone(c),
        index: all.indexOf(c),
        // -1 = 删除时该条不在 choreOrder 里（例如从未设置过顺序），恢复时也不凭空插入
        orderIndex: order.indexOf(c.id),
      };
    }),
  };
}

function pushAffairDeleteUndo(rec) {
  if (!rec) return;
  const list = affairDeleteUndoList();
  list.push(rec);
  while (list.length > AFFAIR_DELETE_UNDO_LIMIT) list.shift();
}

// 撤销一次删除（必须在调用方事务内）：整笔恢复项目与被一起删掉的杂事。
// 恢复前先按 B1 的引用不变式校验：引用的杂事必须存在（或即将被本次恢复带回），
// 且不能已被其他项目的步骤认领——否则拒绝，不做有损恢复。
function restoreAffairDeletion(recId) {
  const list = affairDeleteUndoList();
  const at = list.findIndex(function (x) { return x && x.id === recId; });
  if (at < 0) return { ok: false, reason: '没有可恢复的删除记录' };
  const rec = list[at];
  const a = rec && rec.affair;
  if (!a || typeof a !== 'object' || Array.isArray(a) || !a.id) {
    return { ok: false, reason: '删除记录已损坏' };
  }
  if ((state.affairs || []).some(function (x) { return x && x.id === a.id; })) {
    return { ok: false, reason: '项目已存在，无法恢复' };
  }
  const restChores = (Array.isArray(rec.chores) ? rec.chores : [])
    .filter(function (r) { return r && r.chore && typeof r.chore === 'object' && r.chore.id; });
  const restIds = new Set(restChores.map(function (r) { return r.chore.id; }));
  const byId = new Map();
  (state.chores || []).forEach(function (c) { if (c && c.id) byId.set(c.id, c); });
  const claims = buildChoreClaimIndex(state.affairs || []);
  const bad = affairDelegatedSteps(a).find(function (d) {
    return claims.has(d.choreId) || (!byId.has(d.choreId) && !restIds.has(d.choreId));
  });
  if (bad) {
    return {
      ok: false,
      reason: '委派杂事「' + String(bad.step.text || '') + '」已不可用，无法整笔恢复',
    };
  }

  const affairs = Array.isArray(state.affairs) ? state.affairs : (state.affairs = []);
  const ai = Math.max(0, Math.min(Number(rec.affairIndex) || 0, affairs.length));
  affairs.splice(ai, 0, clone(a));

  if (!Array.isArray(state.chores)) state.chores = [];
  restChores.slice().sort(function (x, y) { return (x.index || 0) - (y.index || 0); })
    .forEach(function (r) {
      if (state.chores.some(function (c) { return c && c.id === r.chore.id; })) return;
      const ci = Math.max(0, Math.min(Number(r.index) || 0, state.chores.length));
      state.chores.splice(ci, 0, clone(r.chore));
    });

  // choreOrder 按原名次插回；原本就不在序列里（orderIndex<0）的保持不插入。
  if (!Array.isArray(state.choreOrder)) state.choreOrder = [];
  restChores.slice().sort(function (x, y) { return (x.orderIndex || 0) - (y.orderIndex || 0); })
    .forEach(function (r) {
      if (Number(r.orderIndex) < 0) return;
      if (state.choreOrder.indexOf(r.chore.id) >= 0) return;
      const oi = Math.max(0, Math.min(Number(r.orderIndex) || 0, state.choreOrder.length));
      state.choreOrder.splice(oi, 0, r.chore.id);
    });

  list.splice(at, 1);
  Ledger.event('恢复项目「' + a.name + '」', 'affair-restore', { affairId: a.id });
  return { ok: true, id: a.id, mode: rec.mode, chores: restChores.map(function (r) { return r.chore.name; }) };
}

// ===== B4：项目完成时自动判定委派杂事 =====
// 口径（刻意如此，不要当“结算遗漏”补上）：
//   **只写完成态，不做结算** —— 不发活力点、不发进度、不走现实预算、不进批量结算池。
// 理由：项目推进到第 9 格本身已按曲线发过格奖励；委派杂事再各发一次 = 同一份工作计两次奖。
// 因此这里只调 choreMarkCompletion（循环杂事靠它推进 nextDue，否则永远不再出现），
// 绝不调用 Ledger.post / Ledger.postSplits / BudgetEngine / settleChoreBatches。
//
// “不进结算池”的落地方式：完成记录落盘后立刻置 settled=true（= 无需入账），
// 这样 choreSettlePool 不会在之后的批次结算里再发一次活力点。
//
// 可追溯：每条自动完成的杂事都写一条 src='chore-auto-done' 的账本事件（复用既有
// Ledger.event + logs，不另造审计存储），事后能与用户手点的 chore-check 区分开。
//
// 必须在调用方事务内调用（affairApplyProgress 的 runCommand）；失败由外层整单回滚。
// 返回被自动判定完成的杂事 [{id,name}]（完成提示与撤销快照用），没有则返回空数组。
//
// 反向不对称（刻意如此，不是漏写）：
//   项目完成 → 委派杂事自动完成（本函数）；
//   杂事完成 → 项目步骤 **不** 自动完成。
// 理由：项目进度是用户对阶段的判断，不能被单个杂事拖动。杂事完成只作为「可推进」的
// 提示显示在步骤行，是否勾掉这一步仍由用户决定，因此也绝不在这里写 step.doneAt。
function affairAutoCompleteDelegatedChores(a, ts) {
  const at = (isFinite(Number(ts)) && Number(ts) > 0) ? Number(ts) : now();
  const byId = new Map();
  (state.chores || []).forEach(function (c) {
    if (c && typeof c.id === 'string' && c.id) byId.set(c.id, c);
  });
  const seen = new Set();
  const done = [];
  affairDelegatedSteps(a).forEach(function (d) {
    if (seen.has(d.choreId)) return;
    seen.add(d.choreId);
    const c = byId.get(d.choreId);
    if (!c || c.archived) return;
    if (choreDoneNow(c, at)) return;            // 本周期已完成：不重复写历史
    if (!choreMarkCompletion(c, at)) return;    // 防重复的最终裁决在 chore-cycle
    const hist = Array.isArray(c.history) ? c.history : [];
    const last = hist.length ? hist[hist.length - 1] : null;
    if (last && Number(last.ts) === at) last.settled = true;
    // 循环杂事按“剩余历史是否全部结算”同步镜像；一次性杂事直接标记无需入账
    if (choreIsCyclic(c)) {
      c.settled = hist.length > 0 && hist.every(function (e) { return !e || e.settled === true; });
    } else {
      c.settled = true;
    }
    Ledger.event(
      '项目「' + a.name + '」完成，自动判定杂事「' + c.name + '」完成（未结算）',
      'chore-auto-done', { affairId: a.id, choreId: c.id }
    );
    done.push({ id: c.id, name: c.name });
  });
  return done;
}

export { delegationCandidates, resolveDelegatedSteps, affairDeletionChores, deleteAffairCore, affairAutoCompleteDelegatedChores, restoreAffairDeletion, AFFAIR_DELETE_UNDO_LIMIT };
