// M3a 退款引擎基线场景（不是 vitest 用例）。
// 用法：node tests/tools/dump-refund.mjs <输出文件>
//
// 一条完整“支出 → 主动退回 → 结期”链路，锁定退款的经济语义：
// - 退回不递减 spent / 不增笔数，只增加 refund；
// - 结算超支按净额，结余奖励仍按 gross spent；
// - budget_remaining 与净额同口径；
// - activityContext.entryAmount 不被退回条目污染。
// 全部时间点显式传入，输出不含 id / 时间戳，保证跨日运行哈希稳定。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

api.resetState({
  domains: [{ id: 'd_default', name: '默认' }],
  scores: { vitality: 100, progress: { d_default: 0 }, achievement: 100 },
});

const mkCat = (id, name, limit, rules) => api.normalizeBudgetCategory(
  { id, name, cycle: 'month', anchor: 1, limit, rules },
  { domainIds: new Set(['d_default']) },
);

api.patchState(s => {
  s.ext.budgets.categories.push(
    mkCat('bc1', '餐饮', 100, [
      { kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } },
      { kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } },
    ]),
    mkCat('bc2', '订阅', 100, [
      { kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } },
    ]),
  );
});

function spend(catId, amount, ts) {
  const r = api.Ledger.txn(() => {
    const plan = api.BudgetEngine.prepareEntry(catId, amount, { ts });
    api.BudgetEngine.commitEntry(null, plan, {});
  }, { save: 'none', render: false });
  if (!r.ok) throw new Error('spend failed: ' + JSON.stringify(r.error));
}

function refund(catId, amount, ts) {
  const r = api.Ledger.txn(() => {
    const plan = api.BudgetEngine.prepareRefund(catId, amount, ts);
    if (!plan.ok) throw new Error('refund prepare failed: ' + plan.code);
    api.BudgetEngine.commitRefund(null, plan);
  }, { save: 'none', render: false });
  if (!r.ok) throw new Error('refund failed: ' + JSON.stringify(r.error));
}

const T1 = at(2026, 5, 6, 10);
const T2 = at(2026, 5, 8, 10);
const T3 = at(2026, 5, 20, 10);
const T4 = at(2026, 5, 22, 10);
const T_SETTLE = at(2026, 6, 2, 0);

spend('bc1', 60, T1);
spend('bc2', 120, T2);
refund('bc1', 20, T3);
refund('bc2', 50, T4);

const ctx = api.BudgetEngine.activityContext(T4);
const remaining = {
  bc1: api.pointMetricValue('budget_remaining', { target: 'bc1' }, T4),
  bc2: api.pointMetricValue('budget_remaining', { target: 'bc2' }, T4),
};

api.BudgetEngine.reconcileDue('bc1', T_SETTLE);
api.BudgetEngine.reconcileDue('bc2', T_SETTLE);

const s = api.getState();
const periodKey = k => k.replace(/\d{4}-\d{2}(-\d{2})?/, '<period>');
const periodSummary = p => ({
  key: periodKey(p.key),
  spent: p.spent, refund: p.refund, entryCount: p.entryCount,
  penaltyCharged: p.penaltyCharged, penalizedOverspend: p.penalizedOverspend,
  rewardSettled: p.rewardSettled, rewardAmount: p.rewardAmount,
  snapshot: p.settlementSnapshot ? {
    spent: p.settlementSnapshot.spent,
    overspend: p.settlementSnapshot.overspend,
    surplus: p.settlementSnapshot.surplus,
    rewardAmount: p.settlementSnapshot.rewardAmount,
    currency: p.settlementSnapshot.currency,
  } : null,
});

const out = {
  scores: s.scores,
  activity: {
    entryAmount: ctx.entryAmount, spent: ctx.spent, overspend: ctx.overspend,
    entryCount: ctx.entryCount, currency: ctx.currency, mixed: ctx.mixed,
  },
  remaining,
  periods: {
    bc1: Object.keys(s.ext.budgets.periods.bc1).map(k => periodSummary(s.ext.budgets.periods.bc1[k])),
    bc2: Object.keys(s.ext.budgets.periods.bc2).map(k => periodSummary(s.ext.budgets.periods.bc2[k])),
  },
  ledger: s.ext.budgets.ledger.map(e => ({
    categoryId: e.categoryId, amount: e.amount, refundAmount: e.refundAmount,
    source: e.source, status: e.status, currency: e.currency,
  })),
};

const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'm3a-refund.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
console.log('vitality=' + out.scores.vitality, 'achievement=' + out.scores.achievement,
  'bc1=' + JSON.stringify(remaining.bc1), 'bc2=' + JSON.stringify(remaining.bc2));
