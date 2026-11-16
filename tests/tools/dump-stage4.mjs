// 阶段 4 专用场景基线（不是测试，vitest 不收集）。
// 用法：node tests/tools/dump-stage4.mjs <输出文件>
//
// 覆盖动作流的核心链路（两段彼此独立，各自 resetState + 固定时钟）：
//   A) 手动流：一条流执行 → 同参干跑对照 → 整单撤销 → 撤销后再跑一次
//      步骤覆盖 7 个原子：货币发放/扣除、资产发放/消耗、备注、实体归档、成就复核。
//   B) 周期流：资产 grant/spend 与额度计量
//      同一周期连跑两次：第二次被资产周期额度拒绝并整单回滚；跨到下一周期后重新可跑。
//
// 导出稳定：固定时钟（api.__setClockForTest）+ 固定 fixture；
// id / 时间戳 / 周期键 / 运行期 entryId 一律归一化，连跑两次哈希必须一致。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const DAY = 864e5;
// 2026-05-10 是周日 → anchor=1 的本周起点为 05-04；T1 为下一周起点
const T0 = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
const T1 = T0 + 7 * DAY;
let clock = T0;
api.__setClockForTest(() => clock);

const TRUE_COND = {
  mode: 'all',
  items: [{ metric: 'lifetime_achievement', op: '>=', value: 0, range: 'total' }],
};

// ===== 归一化：日期/周期键 → <period>；手动运行键里的时间戳 → <ts> =====
function normText(s) {
  return String(s)
    .replace(/\d{4}-\d{2}-\d{2}/g, '<period>')
    .replace(/\d{4}-\d{2}/g, '<period>')
    .replace(/@\d{9,}/g, '@<ts>');
}
function normDeep(v) {
  if (typeof v === 'string') return normText(v);
  if (Array.isArray(v)) return v.map(normDeep);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach(k => { o[k] = normDeep(v[k]); });
    return o;
  }
  return v;
}
function sortedObj(o) {
  const r = {};
  Object.keys(o || {}).sort().forEach(k => { r[k] = o[k]; });
  return r;
}

// ===== 只保留可观察数值与结构，去掉 id / time / flowRunId 等运行期标识 =====
function logView(l) {
  return {
    st: l.st || '', amt: l.amt, src: l.src || '', dom: l.dom || '',
    desc: l.desc || '', card: l.card || '', stepId: l.stepId || '',
    taskId: l.taskId || '', hasFlowRunId: !!l.flowRunId,
    childCount: Array.isArray(l.childLogIds) ? l.childLogIds.length : null,
  };
}
function cardsView(s) {
  const out = {};
  Object.keys(s.cards || {}).sort().forEach(k => { out[k] = Number(s.cards[k]) || 0; });
  return out;
}
function tasksView(s) {
  return (s.tasks || []).map(t => ({
    id: t.id, name: t.name, archived: !!t.archived, hasArchivedAt: !!t.archivedAt,
  }));
}
function metersView(s) {
  const by = (s.ext && s.ext.assetMeters && s.ext.assetMeters.byAsset) || {};
  const out = [];
  Object.keys(by).sort().forEach(aid => {
    Object.keys(by[aid] || {}).sort().forEach(pk => {
      const m = by[aid][pk] || {};
      out.push({
        assetId: aid, period: normText(pk),
        issued: Number(m.issued) || 0, spent: Number(m.spent) || 0, runs: Number(m.runs) || 0,
      });
    });
  });
  return out;
}
function statsView(s) {
  const st = (s.ext && s.ext.stats) || {};
  const inv = st.invisible || {};
  const evi = st.evicted || {};
  return {
    lifetimeVitalityIn: st.lifetimeVitalityIn || 0,
    lifetimeVitalityOut: st.lifetimeVitalityOut || 0,
    lifetimeAchievementIn: st.lifetimeAchievementIn || 0,
    invisibleVitality: inv.vitality || 0,
    invisibleCards: sortedObj(inv.cards),
    evictedVitality: evi.vitality || 0,
    evictedCards: sortedObj(evi.cards),
  };
}
function watermarksView(s) {
  const w = (s.ext && s.ext.watermarks) || {};
  return {
    vitality: (w.vitality && w.vitality.best) || 0,
    achievement: (w.achievement && w.achievement.best) || 0,
    totalProgress: (w.totalProgress && w.totalProgress.best) || 0,
  };
}
// 账本投影：撤销应完全还原的“用户可见账”。统计累计与水位是只增不减的痕迹，故不在此列。
// 余额为 0 的卡键是写入后留下的空壳（初始 fixture 里没有），不计入“已还原”口径。
function bizView(s) {
  const cards = {};
  Object.keys(s.cards || {}).sort().forEach(k => {
    const n = Number(s.cards[k]) || 0;
    if (n) cards[k] = n;
  });
  return {
    scores: s.scores,
    cards: cards,
    logs: (s.logs || []).map(logView),
    tasks: tasksView(s),
    assetMeters: metersView(s),
  };
}

// 步骤输出：去掉 entryId（运行期 id），数组只留长度与样本
function stableOutput(out) {
  const o = (out && typeof out === 'object') ? out : {};
  const res = {};
  Object.keys(o).sort().forEach(k => {
    if (k === 'entryId') return;
    if (k === 'entryIds') { res[k] = Array.isArray(o[k]) ? o[k].length : 0; return; }
    const v = o[k];
    if (v === undefined) return;
    if (Array.isArray(v)) res[k] = { len: v.length, sample: v.slice(0, 4) };
    else if (v && typeof v === 'object') res[k] = '<obj>';
    else res[k] = v;
  });
  return res;
}
function stepView(st) {
  return {
    stepId: st.stepId, atom: st.atom, kind: st.kind, pass: !!st.pass,
    input: normDeep(st.input || {}), output: stableOutput(st.output),
    logCount: (st.logIds || []).length,
  };
}
function runView(rec) {
  if (!rec) return null;
  const j = rec.journal || null;
  const outputs = {};
  Object.keys(rec.stepOutputs || {}).sort().forEach(k => {
    outputs[k] = stableOutput(rec.stepOutputs[k]);
  });
  return {
    flowId: rec.flowId, flowName: rec.flowName, trigger: rec.trigger,
    runKey: normText(rec.runKey || ''), period: normText(rec.periodKey || ''),
    status: rec.status,
    deltas: rec.deltas || null,
    stepOutputs: outputs,
    childLogCount: (rec.childLogIds || []).length,
    journal: j ? {
      steps: (j.steps || []).map(stepView),
      logCount: (j.logIds || []).length,
      accounts: (j.accounts || []).map(a => ({ key: a.key, before: a.before, after: a.after, delta: a.delta })),
      assets: (j.assets || []).map(a => ({
        assetId: a.assetId, period: normText(a.periodKey || ''),
        before: a.before, after: a.after, delta: a.delta,
        issuedBefore: a.issuedBefore, spentBefore: a.spentBefore, runsBefore: a.runsBefore,
        meterExisted: !!a.meterExisted,
      })),
      totals: j.totals || null,
    } : null,
    undo: rec.undo ? {
      removedLogs: rec.undo.removedLogs,
      restoredEntities: rec.undo.restoredEntities,
      restoredAssets: rec.undo.restoredAssets,
    } : null,
  };
}
function runsView(s) {
  const runs = (s.ext && s.ext.flowRuns) || { seq: 0, byId: {}, recent: [] };
  const byId = runs.byId || {};
  return {
    seq: runs.seq || 0,
    byIdCount: Object.keys(byId).length,
    recent: (runs.recent || []).map(id => runView(byId[id])),
  };
}
function idemView(s) {
  const idem = (s.ext && s.ext.assetMeters && s.ext.assetMeters.idem) || {};
  return Object.keys(idem).sort().map(normText);
}
function snapshotOf(s) {
  return {
    scores: s.scores,
    cards: cardsView(s),
    logs: (s.logs || []).map(logView),
    tasks: tasksView(s),
    stats: statsView(s),
    watermarks: watermarksView(s),
    assetMeters: metersView(s),
    idem: idemView(s),
    lastRun: (s.flows || []).map(f => ({ id: f.id, lastRun: normText(f.lastRun || '') })),
    runs: runsView(s),
  };
}
function capture() {
  const s = api.getState();
  return { snap: snapshotOf(s), biz: JSON.stringify(bizView(s)) };
}

// ===== 结果投影 =====
function dryView(r) {
  return {
    ok: r.ok, wouldRun: !!r.wouldRun, skipped: r.skipped || '',
    flowId: r.flowId, trigger: r.trigger, period: normText(r.periodKey || ''),
    runKey: normText(r.runKey || ''), condition: r.condition,
    accounts: (r.accounts || []).map(a => ({ key: a.key, before: a.before, after: a.after, delta: a.delta })),
    assets: (r.assets || []).map(a => ({
      assetId: a.assetId, period: normText(a.periodKey || ''),
      balanceBefore: a.balanceBefore, balanceAfter: a.balanceAfter, balanceDelta: a.balanceDelta,
      issued: a.issued, spent: a.spent, runs: a.runs,
      deltaIssued: a.deltaIssued, deltaSpent: a.deltaSpent, deltaRuns: a.deltaRuns,
    })),
    totals: r.totals || null,
    entryCount: (r.entries || []).length,
    warnings: (r.warnings || []).map(w => w.code),
    error: r.error ? { code: r.error.code } : null,
  };
}
function resultView(r) {
  if (!r) return null;
  if (r.ok && r.skipped) return { ok: true, skipped: r.skipped, runKey: normText(r.runKey || '') };
  if (!r.ok) {
    return {
      ok: false,
      errorCode: (r.error && r.error.code) || '',
      errorInfo: r.error ? normDeep(r.error.info || {}) : null,
    };
  }
  return {
    ok: true,
    runKey: normText(r.runKey || ''),
    totals: r.totals || null,
    deltas: r.deltas || null,
    stepOutputs: (function () {
      const o = {};
      Object.keys(r.stepOutputs || {}).sort().forEach(k => { o[k] = stableOutput(r.stepOutputs[k]); });
      return o;
    })(),
  };
}
function undoView(r) {
  if (!r) return null;
  if (!r.ok) return { ok: false, errorCode: (r.error && r.error.code) || '' };
  return {
    ok: true,
    flowId: r.flowId,
    removedLogs: r.removedLogs,
    restoredEntities: r.restoredEntities,
    restoredAssets: r.restoredAssets,
  };
}
function balanceMap(view) {
  const out = { vitality: view.scores.vitality, achievement: view.scores.achievement };
  Object.keys(view.cards || {}).sort().forEach(k => { if (Number(view.cards[k])) out['card:' + k] = Number(view.cards[k]); });
  return out;
}
function deltaMap(before, after) {
  const b = balanceMap(before);
  const a = balanceMap(after);
  const keys = Object.keys(b).concat(Object.keys(a)).filter((k, i, arr) => arr.indexOf(k) === i).sort();
  const out = {};
  keys.forEach(k => {
    const d = (Number(a[k]) || 0) - (Number(b[k]) || 0);
    if (d) out[k] = d;
  });
  return out;
}

// ===== 固定 fixture =====
function baseState() {
  return {
    scores: { vitality: 10, progress: {}, achievement: 0 },
    tasks: [{
      id: 't_idle', name: '旧任务', domainIds: ['d_default'], lastCheckIn: T0 - 10 * DAY,
      archived: false,
    }],
  };
}
function addStar() {
  api.patchState(s => {
    s.assetDefs.push(api.normalizeAssetDef({
      id: 'star', name: '星星', unit: '颗', maxBalance: 10, maxIssuedPerPeriod: 3,
      issuePeriod: { cycle: 'week', anchor: 1 }, origin: 'user',
    }));
  });
}

// ===== 段 A：执行 → 干跑 → 撤销 → 再跑 =====
function setupManual() {
  api.resetState(baseState());
  addStar();
  api.patchState(s => {
    s.flows.push(api.normalizeFlow({
      id: 'f_manual', name: '手动动作流', trigger: { type: 'manual' },
      condition: TRUE_COND, limits: { maxRunsPerPeriod: 1 },
      steps: [
        { id: 'grant', atom: 'currency.grant', params: { account: 'vitality', amount: 3 } },
        { id: 'spend', atom: 'currency.spend', params: { account: 'vitality', amount: 1 } },
        { id: 'gift', atom: 'asset.grant', params: { assetId: 'star', amount: 2 } },
        { id: 'use', atom: 'asset.spend', params: { assetId: 'star', amount: 1 } },
        { id: 'note', atom: 'log.note', params: { desc: '阶段四动作流备注' } },
        { id: 'archive', atom: 'entity.archiveIdle', params: { kind: 'task', idleDays: 7 } },
        { id: 'recheck', atom: 'engine.recheckAchievements', params: {} },
      ],
    }));
  });
}

clock = T0;
setupManual();
const a0 = capture();
const run1 = api.FlowEngine.runFlow('f_manual', { trigger: 'manual', ts: T0 });
const a2 = capture();

// 干跑对照：同一 ts 下的重跑会被资产周期额度拦住（干跑如实反映这一点），
// 因此预演下一周期（T1）并与本周期实际执行的增量做对照；干跑不得改变任何状态。
const dryBefore = capture();
clock = T1;
const dry = api.FlowEngine.dryRun('f_manual', { trigger: 'manual', ts: T1 });
clock = T0;
const dryAfter = capture();

const undo = api.FlowEngine.undoFlowRun(run1.runId, { ts: T0 });
const a3 = capture();

// 撤销后再跑一次（同周期、同触发方式）：资产计量已回到执行前，应能再次成功
const run2 = api.FlowEngine.runFlow('f_manual', { trigger: 'manual', ts: T0 });
const a4 = capture();

const segA = {
  initial: a0.snap,
  afterRun: a2.snap,
  afterUndo: a3.snap,
  afterRerun: a4.snap,
  dryRun: dryView(dry),
  run1: resultView(run1),
  undo: undoView(undo),
  run2: resultView(run2),
  flags: {
    dryRunMatchesRun: JSON.stringify(deltaMap(a0.snap, a2.snap)) === JSON.stringify(
      (function () {
        const o = {};
        (dry.accounts || []).forEach(a => { if (a.delta) o[a.key] = a.delta; });
        return Object.keys(o).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
      })()
    ),
    dryRunNoSideEffect: JSON.stringify(dryBefore.snap) === JSON.stringify(dryAfter.snap),
    undoRestored: a0.biz === a3.biz,
    rerunMatchesRun: a2.biz === a4.biz,
    runIdsDiffer: run1.runId !== run2.runId,
  },
};

// ===== 段 B：资产 grant/spend 与周期额度计量 =====
clock = T0;
api.resetState(baseState());
addStar();
api.patchState(s => {
  s.flows.push(api.normalizeFlow({
    id: 'f_period', name: '周常动作流', trigger: { type: 'period', period: 'week', anchor: 1 },
    condition: TRUE_COND, limits: { maxRunsPerPeriod: 2 },
    steps: [
      { id: 'grant', atom: 'currency.grant', params: { account: 'vitality', amount: 2 } },
      { id: 'gift', atom: 'asset.grant', params: { assetId: 'star', amount: 2 } },
    ],
  }));
});

const b0 = capture();
const b1run = api.FlowEngine.runFlow('f_period', { ts: T0 });
const b1 = capture();
// 同周期第二次：货币已发放后才撞上资产周期上限（3），整单回滚
const b2run = api.FlowEngine.runFlow('f_period', { ts: T0 });
const b2 = capture();
// 跨到下一周期：计量重新起算，可再次执行
clock = T1;
const b3run = api.FlowEngine.runFlow('f_period', { ts: T1 });
const b3 = capture();

const segB = {
  initial: b0.snap,
  afterRun1: b1.snap,
  afterQuotaRefused: b2.snap,
  afterNextPeriodRun: b3.snap,
  run1: resultView(b1run),
  run2: resultView(b2run),
  run3: resultView(b3run),
  flags: {
    quotaRefused: !b2run.ok && b2run.error && b2run.error.code === 'FLOW_ASSET_PERIOD_CAP',
    quotaRollbackClean: b1.biz === b2.biz,
    nextPeriodRuns: b3run.ok && !b3run.skipped,
    periodCount: b3.snap.assetMeters.length,
    seqOnlySuccess: b3.snap.runs.seq,
  },
};

const out = { segA: segA, segB: segB };
const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'stage4-scenario.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
console.log('A run1=' + (run1.ok ? 'ok' : 'fail') + ' undo=' + (undo.ok ? undo.removedLogs : undo.error.code)
  + ' rerun=' + (run2.ok ? 'ok' : 'fail') + ' star=' + segA.afterRerun.cards.star
  + ' flags=' + JSON.stringify(segA.flags));
console.log('B run1=' + (b1run.ok ? 'ok' : 'fail') + ' run2=' + (b2run.ok ? 'ok' : b2run.error.code)
  + ' run3=' + (b3run.ok ? 'ok' : 'fail') + ' meters=' + segB.afterNextPeriodRun.assetMeters.length);
