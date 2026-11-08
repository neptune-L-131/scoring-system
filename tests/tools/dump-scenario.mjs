// 拆分前后的“行为不变”对照工具（不是测试，vitest 不会收集它）。
// 用法：node tests/tools/dump-scenario.mjs <输出文件>
// 跑一条完整业务链路（打卡 → 预算记账+惩罚 → 买商品含贷款 → 周期归档），
// 把可观察结果归一化（去掉 id / 时间戳）后写入 JSON；拆分前后各跑一次并 diff。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const DAY = 864e5;
const ok = r => {
  if (!r || r.ok === false) throw new Error('scenario step failed: ' + JSON.stringify(r && r.error));
  return r;
};

// 1) 基础数据
api.resetState({
  domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
  scores: { vitality: 0, progress: { d_default: 0, d2: 0 }, achievement: 0 },
  tasks: [
    { id: 't1', name: '停滞任务', domainIds: ['d_default'], scoreTypes: ['vitality'], initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0, checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: Date.now() - 20 * DAY, pendingDebt: 0, archived: false },
    { id: 't2', name: '日常任务', domainIds: ['d_default', 'd2'], scoreTypes: ['both'], initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 2, checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false },
  ],
  products: [{ id: 'p1', name: '咖啡', tier: 'daily', price: 5, stock: 10, sold: 0, debtRate: 0, gate: api.defaultProductGate(), budget: null }],
});

// 2) 打卡
api.checkIn('t2');

// 3) 预算：每周 30，超支起点固定罚 4 活力点
api.patchState(s => {
  const cat = api.normalizeBudgetCategory({ id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 30, rules: [{ kind: 'penalty', params: { mode: 'fixed', value: 4, per: 'episode' }, target: { account: 'vitality' } }] }, { domainIds: new Set(['d_default', 'd2']) });
  s.ext.budgets.categories.push(cat);
});
api.Ledger.txn(() => {
  const plan = api.BudgetEngine.prepareEntry('bc1', 40, { ts: Date.now(), note: '午饭' });
  api.BudgetEngine.commitEntry(null, plan, {});
}, { save: 'none', render: false });

// 4) 买商品：余额不足自动贷款
api.buyProduct('p1');
api.buyProduct('p1');
api.buyProduct('p1');

// 5) 周期活动：任务不活跃 14 天 → 归档
api.patchState(s => {
  s.activities.push(api.normalizeActivity({
    id: 'act_archive', name: '自动归档', enabled: true, period: 'week', anchor: 1,
    condition: { mode: 'all', items: [] },
    result: { items: [{ type: 'archive', entity: 'task', idleDays: 14 }] },
    lastRun: null,
  }));
});
api.processActivities(true);

// 6) 归一化导出（去掉 id / 时间，保留所有数值与结构）
const s = api.getState();
const periodKey = k => k.replace(/\d{4}-\d{2}(-\d{2})?/, '<period>');
const out = {
  scores: s.scores,
  logs: s.logs.map(l => ({
    st: l.st, amt: l.amt, amtV: l.amtV, amtP: l.amtP, desc: l.desc, src: l.src, dom: l.dom,
    taskId: l.taskId || '', prodId: l.prodId || '', splits: l.splits || null,
    prevStreak: l.prevStreak, prevLastCheckIn: l.prevLastCheckIn === null ? null : 'ts',
  })),
  shadow: s.ext.shadow.map(x => ({ acct: x.acct, delta: x.delta, label: x.label, before: x.before, after: x.after })),
  tasks: s.tasks.map(t => ({
    name: t.name, checkInCount: t.checkInCount, streak: t.streak, totalEarned: t.totalEarned,
    pendingDebt: t.pendingDebt, archived: !!t.archived, hasLastCheckIn: t.lastCheckIn !== null,
  })),
  loans: s.loans.map(l => ({ amount: l.amount, currency: l.currency, debtRate: l.debtRate, productName: l.productName })),
  products: s.products.map(p => ({ name: p.name, price: p.price, stock: p.stock, sold: p.sold })),
  budgets: {
    categories: s.ext.budgets.categories.map(c => ({ name: c.name, cycle: c.cycle, limit: c.limit, rules: c.rules.map(r => r.kind) })),
    periods: Object.values(s.ext.budgets.periods).flat().map(p => ({
      key: periodKey(p.key), spent: p.spent, entryCount: p.entryCount, penaltyCharged: p.penaltyCharged,
      feedbackGranted: p.feedbackGranted, topupAmount: p.topupAmount, rewardAmount: p.rewardAmount, rewardSettled: p.rewardSettled,
    })),
    ledger: s.ext.budgets.ledger.map(e => ({ amount: e.amount, status: e.status, note: e.note, kind: e.kind })),
  },
  stats: {
    lifetimeVitalityIn: s.ext.stats.lifetimeVitalityIn, lifetimeVitalityOut: s.ext.stats.lifetimeVitalityOut,
    lifetimeProgressIn: s.ext.stats.lifetimeProgressIn, lifetimeAchievementIn: s.ext.stats.lifetimeAchievementIn,
    lifetimeAchievementEarned: s.ext.stats.lifetimeAchievementEarned,
    buyCount: s.ext.stats.buyCount, totalCheckins: s.ext.stats.totalCheckins,
    invisible: s.ext.stats.invisible, evicted: s.ext.stats.evicted,
  },
  activities: s.activities.map(a => ({ name: a.name, enabled: a.enabled, hasLastRun: !!a.lastRun })),
};

const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'round5-scenario.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
console.log('logs=' + out.logs.length, 'shadow=' + out.shadow.length, 'vitality=' + out.scores.vitality, 'achievement=' + out.scores.achievement);
