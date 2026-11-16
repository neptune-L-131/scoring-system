// 第五轮第二个场景基线（不是测试，vitest 不收集）。
// 用法：node tests/tools/dump-scenario2.mjs <输出文件>
//
// 三段彼此独立的场景，每段都从 resetState 重新起步、各自注入固定时钟，
// 互不干扰（批量结算与腐化链路共存会互相改变 vitality/流水，故分段）。
//   A) 项目推进与撤销 + 杂事勾选/腐化/取消 + 预算跨期冲正
//   B) 结余奖励：穿过周期边界触发 reconcileDue，验证发放、rewardSettled 与账目一致
//   C) 杂事批量结算：小阈值走一次真实 settleChoreBatches 发活力点
//
// 导出时去掉 id / 时间戳 / 周期键中的具体年月日 / 关联 id，只保留可观察数值与结构。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const DAY = 864e5;
// 2026-05-10 是周日 → 该周为 05-04（周一）～05-10，跨 8 天即进入下一周
const T0 = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
const T_MONTH_END = new Date(2026, 5, 2, 12, 0, 0, 0).getTime();
let clock = T0;
api.__setClockForTest(() => clock);

const CURVE = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function baseState() {
  return {
    domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
    scores: { vitality: 100, progress: { d_default: 0, d2: 0 }, achievement: 0 },
    tasks: [{
      id: 't1', name: '周任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
      initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0,
      checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
    }],
    logs: [],
  };
}

function periodKey(k) { return String(k).replace(/\d{4}-\d{2}(-\d{2})?/, '<period>'); }

function snapshot() {
  const s = api.getState();
  return {
    scores: s.scores,
    logs: s.logs.map(l => ({
      st: l.st, amt: l.amt, amtV: l.amtV, amtP: l.amtP, desc: l.desc, src: l.src, dom: l.dom,
      taskId: l.taskId || '', affairId: l.affairId || '', choreId: l.choreId || '',
      recurring: !!l.recurring, splits: l.splits || null,
    })),
    affairs: s.affairs.map(a => ({
      name: a.name, currentCell: a.currentCell, alreadyGiven: a.alreadyGiven,
      hasStarted: !!a.startedAt, hasDone: !!a.doneAt, undoStack: (s.affairUndo[a.id] || []).length,
      budgetRef: !!a.budgetRef,
    })),
    chores: s.chores.map(c => ({
      name: c.name, done: !!c.done, settled: !!c.settled, hasDecayKey: !!c.decayKey,
      progressAmount: c.progressAmount, progressDomainIds: c.progressDomainIds || [],
      award: c.progressAward ? { amount: c.progressAward.amount, parts: c.progressAward.parts } : null,
      budgetRef: !!c.budgetRef,
    })),
    budgets: {
      categories: s.ext.budgets.categories.map(c => ({ name: c.name, cycle: c.cycle, limit: c.limit, rules: c.rules.map(r => r.kind) })),
      periods: Object.values(s.ext.budgets.periods).flatMap(m => Object.values(m || {})).map(p => ({
        key: periodKey(p.key), spent: p.spent, entryCount: p.entryCount,
        penaltyCharged: p.penaltyCharged, feedbackGranted: p.feedbackGranted,
        topupAmount: p.topupAmount, rewardAmount: p.rewardAmount, rewardSettled: p.rewardSettled,
        hasSettlementSnapshot: !!p.settlementSnapshot,
        snapshotRules: p.settlementSnapshot ? p.settlementSnapshot.rules.map(r => r.amount) : null,
      })),
      ledger: s.ext.budgets.ledger.map(e => ({
        amount: e.amount, status: e.status, kind: e.kind, note: e.note,
        source: e.source || '', periodKey: periodKey(e.periodKey || ''), txnId: e.txnId || '',
        links: e.links ? Object.keys(e.links).sort() : null,
      })),
    },
    stats: {
      lifetimeVitalityIn: s.ext.stats.lifetimeVitalityIn, lifetimeVitalityOut: s.ext.stats.lifetimeVitalityOut,
      lifetimeProgressIn: s.ext.stats.lifetimeProgressIn, lifetimeAchievementIn: s.ext.stats.lifetimeAchievementIn,
      totalCheckins: s.ext.stats.totalCheckins,
    },
  };
}

// ===== 段 A：项目推进撤销 / 杂事勾选腐化 / 预算跨期冲正 =====
clock = T0;
api.resetState(Object.assign(baseState(), {
  tasks: [{
    id: 't1', name: '周任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
    initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0,
    checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
    budget: { categoryId: 'bc1', mode: 'fixed', amount: 10 },
  }],
  affairs: [{
    id: 'a1', name: '装修', domainId: 'd_default', totalReward: 1,
    curve: { type: 'even', values: CURVE.slice() },
    currentCell: 0, alreadyGiven: 0, steps: [], ach: { enabled: false, amount: 0 },
    plannedAt: T0, startedAt: null, doneAt: null, archived: false,
    budget: { categoryId: 'bc1', mode: 'fixed', amount: 20 }, budgetRef: null,
  }],
  chores: [
    {
      id: 'c1', name: '写周报', done: false, doneAt: null, plannedAt: T0,
      createdAt: T0 - 2 * DAY, settled: false, freshDays: 1, decayKey: null,
      progressAmount: 0.1, progressDomainIds: ['d2'],
      budget: { categoryId: 'bc1', mode: 'fixed', amount: 10 }, budgetRef: null,
    },
    {
      id: 'c2', name: '交水费', done: false, doneAt: null, plannedAt: T0 - 6 * DAY,
      createdAt: T0 - 8 * DAY, settled: false, freshDays: 0, decayKey: null,
      progressAmount: 0, progressDomainIds: [], budget: null, budgetRef: null,
    },
  ],
}));
api.patchState(s => {
  s.ext.budgets.categories.push(api.normalizeBudgetCategory({
    id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 100,
    defaultProgressDomainId: 'd_default',
  }, { domainIds: new Set(['d_default', 'd2']) }));
  s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 99, batchY: 0 });
});

const a1 = api.getLive().affairs[0];
const snap = api.affairPushUndo(a1);
const abr = api.resolveActionBudget(a1, { kind: 'affair', id: 'a1', source: 'affair', ts: clock });
api.affairApplyProgress(a1, 4, { plan: abr.plan, snap: snap });
api.affairUndoAction('a1');

api.toggleChoreDone('c1');
api.processChoreDecay(true);
api.toggleChoreDone('c1');
api.toggleChoreDone('c1');

api.checkIn('t1');
const checkinId = api.getState().logs.find(l => l.src === 'checkin' && l.taskId === 't1').id;
clock = T0 + 8 * DAY;
api.undoLog(checkinId);

const segA = snapshot();

// ===== 段 B：结余奖励（跨月结算） =====
clock = T0;
api.resetState(Object.assign(baseState(), {
  tasks: [{
    id: 't1', name: '月任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
    initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0,
    checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
    budget: { categoryId: 'bc1', mode: 'fixed', amount: 40 },
  }],
}));
api.patchState(s => {
  s.ext.budgets.categories.push(api.normalizeBudgetCategory({
    id: 'bc1', name: '餐饮', cycle: 'month', limit: 100,
    rules: [{ id: 'r1', kind: 'reward', enabled: true, params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }],
    defaultProgressDomainId: 'd_default',
  }, { domainIds: new Set(['d_default']) }));
});

api.checkIn('t1'); // 本月支出 40
const settledChanged = api.BudgetEngine.reconcileDue('bc1', T_MONTH_END); // 5 月结期：结余 60 × 0.2 = 12
const settledAgain = api.BudgetEngine.reconcileDue('bc1', T_MONTH_END + DAY); // 幂等：不应重复发放

const segB = Object.assign(snapshot(), { settledChanged: settledChanged, settledAgain: settledAgain });

// ===== 段 C：杂事批量结算 =====
clock = T0;
api.resetState(Object.assign(baseState(), {
  scores: { vitality: 0, progress: { d_default: 0, d2: 0 }, achievement: 0 },
  chores: [1, 2, 3, 4, 5, 6].map(function (i) {
    return {
      id: 'ch' + i, name: '杂事' + i, done: true, doneAt: T0 - (7 - i) * DAY,
      plannedAt: T0 - (7 - i) * DAY, createdAt: T0 - 10 * DAY,
      settled: false, freshDays: null, decayKey: null, progressAmount: 0, progressDomainIds: [],
      budget: null, budgetRef: null,
    };
  }),
}));
api.patchState(s => { s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 5, batchY: 3 }); });
const batchGain = api.settleChoreBatches(true);
const segC = Object.assign(snapshot(), { batchGain: batchGain });

const out = { segA: segA, segB: segB, segC: segC };
const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'round5-scenario2.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
console.log('A logs=' + segA.logs.length + ' ledger=' + segA.budgets.ledger.length + ' vitality=' + segA.scores.vitality);
console.log('B reward=' + segB.scores.achievement + ' settled=' + segB.budgets.periods.map(p => p.rewardSettled + ':' + p.rewardAmount).join(','));
console.log('C gain=' + segC.batchGain + ' vitality=' + segC.scores.vitality + ' settled=' + segC.chores.filter(c => c.settled).length);
