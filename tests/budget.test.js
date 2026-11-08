// 现实预算规则引擎：analyze / commitEntry / settlePeriod / reconcileDue / 水位 / 扩容 / 跨期。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const CAT = {
  id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 100,
  defaultProgressDomainId: 'd_default',
};

function seed(catOver, stateOver) {
  api.resetState(Object.assign({
    domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
    scores: { vitality: 100, progress: {}, achievement: 100 },
  }, stateOver || {}));
  const cat = api.normalizeBudgetCategory(Object.assign({}, CAT, catOver || {}), {
    domainIds: new Set(['d_default', 'd2']),
  });
  api.patchState(s => { s.ext.budgets.categories.push(cat); });
  return api.getState().ext.budgets.categories[0];
}

function commit(amount, ts, opts) {
  let result = null;
  const r = api.Ledger.txn(tx => {
    const plan = api.BudgetEngine.prepareEntry('bc1', amount, Object.assign({ ts }, opts || {}));
    result = api.BudgetEngine.commitEntry(tx, plan, {});
  }, { save: 'none', render: false });
  return { ok: r.ok, error: r.error, result };
}

describe('analyze：只读判定', () => {
  it('合法金额、分类缺失、金额非法', () => {
    seed();
    const ts = at(2024, 3, 6);
    const ok = api.BudgetEngine.preview('bc1', 30, ts);
    expect(ok).toMatchObject({ ok: true, amount: 30, spentAfter: 30, limitAfter: 100, overspendAfter: 0 });
    expect(api.BudgetEngine.preview('nope', 30, ts)).toMatchObject({ ok: false, code: 'BUDGET_CATEGORY_MISSING' });
    expect(api.BudgetEngine.preview('bc1', 0, ts)).toMatchObject({ ok: false, code: 'BUDGET_INVALID_AMOUNT' });
  });

  it('停用/归档分类拒绝记账', () => {
    seed({ enabled: false });
    expect(api.BudgetEngine.preview('bc1', 10, at(2024, 3, 6))).toMatchObject({ code: 'BUDGET_CATEGORY_DISABLED' });
    seed({ archived: true });
    expect(api.BudgetEngine.preview('bc1', 10, at(2024, 3, 6))).toMatchObject({ code: 'BUDGET_CATEGORY_ARCHIVED' });
  });

  it('analyze 不修改状态（preview 与真实入账共用同一份计算）', () => {
    seed();
    const ts = at(2024, 3, 6);
    api.BudgetEngine.preview('bc1', 30, ts);
    const s = api.getState();
    expect(s.ext.budgets.periods.bc1).toBeUndefined();
    expect(s.ext.budgets.ledger).toHaveLength(0);
  });
});

describe('惩罚规则', () => {
  it('固定额 episode：只在跨过超支起点的那一笔触发', () => {
    seed({ rules: [{ kind: 'penalty', params: { mode: 'fixed', value: 5, per: 'episode' }, target: { account: 'vitality' } }] });
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    expect(api.getState().ext.budgets.periods.bc1[api.BudgetEngine.preview('bc1', 1, ts).periodKey].penaltyCharged).toBe(0);

    const crossing = api.BudgetEngine.preview('bc1', 80, ts);
    expect(crossing.overspendBefore).toBe(0);
    expect(crossing.overspendAfter).toBe(10);
    expect(crossing.effects).toHaveLength(1);
    expect(crossing.effects[0]).toMatchObject({ kind: 'penalty', account: 'vitality', amount: 5 });

    expect(commit(80, ts).ok).toBe(true);
    let s = api.getState();
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(s.ext.budgets.periods.bc1[key]).toMatchObject({ spent: 110, entryCount: 2, penaltyCharged: 5, penalizedOverspend: 10 });
    expect(s.scores.vitality).toBe(95);
    expect(s.logs.some(l => l.src === 'budget-penalty' && l.amt === -5)).toBe(true);

    // 已在超支里继续记一笔：不再重复触发 episode
    const again = api.BudgetEngine.preview('bc1', 1, ts);
    expect(again.effects).toHaveLength(0);
    expect(commit(1, ts).ok).toBe(true);
    s = api.getState();
    expect(s.ext.budgets.periods.bc1[key].penaltyCharged).toBe(5);
  });

  it('比例额 per=entry：按新增超支的 50% 扣', () => {
    seed({ limit: 100, rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } }] });
    const ts = at(2024, 3, 6);
    expect(commit(60, ts).ok).toBe(true); // 未超支 → 不扣
    expect(commit(60, ts).ok).toBe(true); // 超支 20 → 扣 10
    const s = api.getState();
    expect(s.scores.vitality).toBe(90);
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(s.ext.budgets.periods.bc1[key]).toMatchObject({ spent: 120, penaltyCharged: 10, penalizedOverspend: 20 });
  });
});

describe('消费反哺', () => {
  it('按每笔金额比例发放到指定进度领域', () => {
    seed({ limit: 1000, rules: [{ kind: 'feedback', params: { mode: 'ratio', rate: 0.1 }, target: { account: 'progress', domainId: 'd_default' } }] });
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    const s = api.getState();
    expect(s.scores.progress.d_default).toBe(3);
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(s.ext.budgets.periods.bc1[key].feedbackGranted).toBe(3);
    expect(s.logs.find(l => l.src === 'budget-feedback')).toMatchObject({ st: 'progress', amt: 3, dom: 'd_default' });
  });

  it('capPerPeriod 按周期累计封顶', () => {
    seed({ limit: 1000, rules: [{ kind: 'feedback', params: { mode: 'ratio', rate: 1, capPerPeriod: 5 }, target: { account: 'achievement' } }] });
    const ts = at(2024, 3, 6);
    commit(3, ts);
    commit(3, ts);
    commit(3, ts);
    const s = api.getState();
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(s.ext.budgets.periods.bc1[key].feedbackGranted).toBe(5);
    expect(s.scores.achievement).toBe(105);
  });
});

describe('结余奖励与结期', () => {
  it('reconcileDue 只结算已结束周期，奖励按结余比例发放且幂等', () => {
    seed({ cycle: 'month', rules: [{ kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }] });
    const jan = at(2024, 1, 15, 12);
    expect(commit(40, jan).ok).toBe(true);
    expect(api.getState().scores.achievement).toBe(100); // 记账时不发奖励

    const changed = api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 2));
    expect(changed).toBe(true);
    let s = api.getState();
    const p = s.ext.budgets.periods.bc1['M:2024-01'];
    expect(p).toMatchObject({ spent: 40, rewardSettled: true, rewardAmount: 12, closedAt: at(2024, 2, 1) });
    expect(p.settlementSnapshot).toMatchObject({ limit: 100, spent: 40, surplus: 60, rewardAmount: 12 });
    expect(p.settlementSnapshot.rules).toHaveLength(1);
    expect(s.scores.achievement).toBe(112);

    // 再次结算：不重复发
    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 3))).toBe(false);
    expect(api.getState().scores.achievement).toBe(112);
  });

  it('未结束的周期不结算', () => {
    seed({ cycle: 'month', rules: [{ kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }] });
    commit(40, at(2024, 1, 15, 12));
    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 1, 20))).toBe(false);
    expect(api.getState().scores.achievement).toBe(100);
  });
});

describe('额度扩容与水位', () => {
  const od = { enabled: true, currency: 'achievement', rate: 2, maxRealityPerPeriod: 300, maxCostPerPeriod: 150 };

  it('扩容抬高有效限额；水位只增不减', () => {
    seed({ overdraft: od, rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 0.5 }, target: { account: 'vitality' } }] });
    const ts = at(2024, 3, 6);
    expect(commit(120, ts).ok).toBe(true); // 超支 20 → 扣 10
    const key = Object.keys(api.getState().ext.budgets.periods.bc1)[0];
    expect(api.getState().ext.budgets.periods.bc1[key].penalizedOverspend).toBe(20);

    const plan = api.BudgetEngine.preview('bc1', 10, ts, { topup: 50 });
    expect(plan).toMatchObject({ ok: true, limitBefore: 100, limitAfter: 150, spentAfter: 130, overspendAfter: 0, waterBefore: 20 });
    expect(plan.effects).toHaveLength(0); // 扩容后不再新增超支，不重复扣

    expect(commit(10, ts, { topup: 50 }).ok).toBe(true);
    const s = api.getState();
    const p = s.ext.budgets.periods.bc1[key];
    expect(p).toMatchObject({ topupAmount: 50, topupCost: 25, penalizedOverspend: 20, penaltyCharged: 10 });
    expect(s.scores.achievement).toBe(75);
  });

  it('扩容上限：现实额度与花费分别封顶', () => {
    seed({ overdraft: { enabled: true, currency: 'achievement', rate: 1, maxRealityPerPeriod: 20, maxCostPerPeriod: 10 } });
    const ts = at(2024, 3, 6);
    expect(api.BudgetEngine.preview('bc1', 10, ts, { topup: 30 })).toMatchObject({ ok: false, code: 'BUDGET_TOPUP_LIMIT' });
    const costFail = api.BudgetEngine.preview('bc1', 10, ts, { topup: 15 });
    expect(costFail).toMatchObject({ ok: false, code: 'BUDGET_TOPUP_LIMIT' });
    expect(costFail.reason).toContain('花费');
  });

  it('未开启扩容时拒绝 topup', () => {
    seed();
    expect(api.BudgetEngine.preview('bc1', 10, at(2024, 3, 6), { topup: 10 })).toMatchObject({ ok: false, code: 'BUDGET_TOPUP_DISABLED' });
  });

  it('余额不足时整笔拒绝（含惩罚/扩容花费）', () => {
    seed({
      overdraft: od,
      rules: [{ kind: 'penalty', params: { mode: 'fixed', value: 50, per: 'episode' }, target: { account: 'vitality' } }],
    }, { scores: { vitality: 10, progress: {}, achievement: 100 } });
    const ts = at(2024, 3, 6);
    const plan = api.BudgetEngine.preview('bc1', 120, ts);
    expect(plan.insufficient).toMatchObject({ account: 'vitality', diff: 40 });
    const r = commit(120, ts);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BUDGET_INSUFFICIENT');
    expect(api.getState().scores.vitality).toBe(10); // 回滚
  });
});

describe('跨期保护', () => {
  it('旧周期账目拒绝撤销，当期数据不受影响', () => {
    seed({ cycle: 'month' });
    const jan = at(2024, 1, 15, 12);
    expect(commit(40, jan).ok).toBe(true);
    let s = api.getState();
    const entryId = s.ext.budgets.ledger[0].id;
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(api.BudgetEngine.reverseEntry(entryId)).toBe(false);
    s = api.getState();
    expect(s.ext.budgets.ledger[0].status).toBe('active');
    expect(s.ext.budgets.periods.bc1[key].spent).toBe(40);
  });

  it('当期账目可撤销，惩罚流水一并退回', () => {
    seed({ rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } }] });
    const ts = at(2024, 3, 6);
    expect(commit(120, ts).ok).toBe(true);
    let s = api.getState();
    const entryId = s.ext.budgets.ledger[0].id;
    // 用当前时间把周期造出来：账目时间改成“现在”所在周
    const nowTs = Date.now();
    api.patchState(st => {
      const e = st.ext.budgets.ledger[0];
      const b = api.budgetBounds('week', nowTs, 1);
      const oldKey = e.periodKey;
      const p = st.ext.budgets.periods.bc1[oldKey];
      delete st.ext.budgets.periods.bc1[oldKey];
      p.key = b.key; p.start = b.start; p.end = b.end;
      st.ext.budgets.periods.bc1[b.key] = p;
      e.periodKey = b.key;
      e.ts = nowTs;
      st.ext.budgets.current.bc1 = b.key;
      st.logs.forEach(l => { if (l.budCatId) l.budPeriodKey = b.key; });
    });
    expect(api.BudgetEngine.reverseEntry(entryId)).toBe(true);
    s = api.getState();
    const p = s.ext.budgets.periods.bc1[s.ext.budgets.current.bc1];
    expect(s.ext.budgets.ledger[0].status).toBe('reversed');
    expect(p.spent).toBe(0);
    expect(p.entryCount).toBe(0);
    expect(p.penaltyCharged).toBe(0);
    expect(s.scores.vitality).toBe(100);
  });
});

describe('budget_remaining 点态指标', () => {
  it('剩余额度 = 基础限额 + 本期扩容 - 已花', () => {
    seed();
    const ts = Date.now();
    expect(commit(30, ts).ok).toBe(true);
    expect(api.pointMetricValue('budget_remaining', { target: 'bc1' }, ts)).toBe(70);
    api.patchState(s => { s.ext.budgets.categories[0].limit = 50; });
    expect(api.pointMetricValue('budget_remaining', { target: 'bc1' }, ts)).toBe(20);
  });
});

