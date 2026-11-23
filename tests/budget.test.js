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
    // reverseEntry 改为返回结果对象（副作用交给命令层）
    expect(api.BudgetEngine.reverseEntry(entryId).ok).toBe(false);
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
    expect(api.BudgetEngine.reverseEntry(entryId).ok).toBe(true);
    s = api.getState();
    const p = s.ext.budgets.periods.bc1[s.ext.budgets.current.bc1];
    expect(s.ext.budgets.ledger[0].status).toBe('reversed');
    expect(p.spent).toBe(0);
    expect(p.entryCount).toBe(0);
    expect(p.penaltyCharged).toBe(0);
    expect(s.scores.vitality).toBe(100);
  });
});

describe('主动退回（M3a）', () => {
  function doRefund(amount, ts) {
    let out = null;
    const r = api.Ledger.txn(tx => {
      const plan = api.BudgetEngine.prepareRefund('bc1', amount, ts);
      out = { plan };
      if (!plan.ok) return;
      out.res = api.BudgetEngine.commitRefund(tx, plan);
    }, { save: 'none', render: false });
    return { ok: r.ok, error: r.error, plan: out && out.plan, entry: out && out.res && out.res.entry };
  }
  const period = s => s.ext.budgets.periods.bc1[Object.keys(s.ext.budgets.periods.bc1)[0]];

  it('退回只增加 refund：spent / 笔数不变，金额始终存正数', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(60, ts).ok).toBe(true);
    const r = doRefund(20, ts + 1000);
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(period(s)).toMatchObject({ spent: 60, refund: 20, entryCount: 1 });
    expect(r.entry).toMatchObject({
      amount: 0, refundAmount: 20, source: 'refund', status: 'active', currency: 'CNY',
    });
    expect(api.BudgetEngine.netSpentOf(period(s))).toBe(40);
  });

  it('退回不计入结余奖励：结余与奖励仍按 gross spent', () => {
    seed({ cycle: 'month', rules: [{ kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }] });
    const jan = at(2024, 1, 15, 12);
    expect(commit(60, jan).ok).toBe(true);
    expect(doRefund(20, at(2024, 1, 20, 12)).ok).toBe(true);
    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 2))).toBe(true);
    const p = api.getState().ext.budgets.periods.bc1['M:2024-01'];
    // 若退回被算进结余，surplus 会变成 60、奖励 12；正确口径是 40 / 8
    expect(p.settlementSnapshot).toMatchObject({ spent: 60, overspend: 0, surplus: 40, rewardAmount: 8 });
    expect(api.getState().scores.achievement).toBe(108);
  });

  it('结算超支用净额；已罚水位不因退回回退', () => {
    seed({
      cycle: 'month', limit: 100,
      rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } }],
    });
    const jan = at(2024, 1, 15, 12);
    expect(commit(120, jan).ok).toBe(true); // 超支 20 → 罚 10
    expect(api.getState().scores.vitality).toBe(90);
    expect(doRefund(50, at(2024, 1, 20, 12)).ok).toBe(true);
    expect(period(api.getState())).toMatchObject({ spent: 120, refund: 50, penalizedOverspend: 20, penaltyCharged: 10 });
    expect(api.BudgetEngine.overspendOf(api.getState().ext.budgets.categories[0], period(api.getState()))).toBe(0);

    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 2))).toBe(true);
    const s = api.getState();
    expect(s.ext.budgets.periods.bc1['M:2024-01'].settlementSnapshot.overspend).toBe(0);
    expect(s.scores.vitality).toBe(90); // 已罚不返还
  });

  it('超额 / 0 / 负数直接报错，不夹紧、无部分写入', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(60, ts).ok).toBe(true);
    expect(api.BudgetEngine.prepareRefund('bc1', 61, ts)).toMatchObject({
      ok: false, code: 'BUDGET_REFUND_EXCEEDS_SPENT', maxRefundable: 60,
    });
    expect(api.BudgetEngine.prepareRefund('bc1', 0, ts).code).toBe('BUDGET_INVALID_AMOUNT');
    expect(api.BudgetEngine.prepareRefund('bc1', -5, ts).code).toBe('BUDGET_INVALID_AMOUNT');
    expect(period(api.getState()).refund).toBe(0);
    expect(api.getState().ext.budgets.ledger.some(e => e.source === 'refund')).toBe(false);

    // 事务内二次校验：即使伪造一份超额计划，也必须整笔拒绝
    const forged = { ok: true, direction: 'refund', catId: 'bc1', amount: 61, ts };
    const r = api.Ledger.txn(tx => api.BudgetEngine.commitRefund(tx, forged), { save: 'none', render: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BUDGET_REFUND_EXCEEDS_SPENT');
    expect(period(api.getState()).refund).toBe(0);
  });

  it('撤销 / 冲正 / 退回互不替代', () => {
    seed();
    const ts = Date.now();
    expect(commit(60, ts).ok).toBe(true);
    expect(doRefund(20, ts).ok).toBe(true);
    const s = api.getState();
    const refundId = s.ext.budgets.ledger.find(e => e.source === 'refund').id;
    const spendId = s.ext.budgets.ledger.find(e => e.source === 'manual').id;

    expect(api.BudgetEngine.reverseEntry(refundId)).toMatchObject({ ok: false, code: 'BUDGET_ENTRY_IS_REFUND' });
    expect(api.BudgetEngine.compensateEntry({ catId: 'bc1', entryId: refundId, amount: 20 })).toMatchObject({
      ok: false, code: 'BUDGET_ENTRY_IS_REFUND',
    });
    expect(api.BudgetEngine.reverseRefund(spendId)).toMatchObject({ ok: false, code: 'BUDGET_ENTRY_NOT_REFUND' });

    expect(api.BudgetEngine.reverseRefund(refundId).ok).toBe(true);
    const after = api.getState();
    expect(period(after)).toMatchObject({ spent: 60, refund: 0, entryCount: 1 });
    expect(after.ext.budgets.ledger.find(e => e.id === refundId).status).toBe('reversed');
    // 没有多出一条冲正记录
    expect(after.ext.budgets.ledger.some(e => e.source === 'reversal')).toBe(false);
  });

  it('退回不污染 activityContext.entryAmount', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    expect(doRefund(10, ts + 5000).ok).toBe(true); // 更晚的一笔退回
    const act = api.BudgetEngine.activityContext(ts);
    expect(act).toMatchObject({ entryAmount: 30, spent: 30, entryCount: 1 });
  });

  it('跨期冲正的零金额条目不污染 activityContext.entryAmount', () => {
    seed();
    const prev = at(2024, 2, 28);
    const cur = at(2024, 3, 6);
    expect(commit(30, prev).ok).toBe(true);
    expect(commit(40, cur).ok).toBe(true);
    const orig = api.getState().ext.budgets.ledger.find(e => e.amount === 30);
    api.__setClockForTest(() => cur + 5000);
    try {
      expect(api.BudgetEngine.compensateEntry({ catId: 'bc1', entryId: orig.id, amount: 30 }).ok).toBe(true);
    } finally {
      api.__setClockForTest(null);
    }
    const act = api.BudgetEngine.activityContext(cur);
    // 只统计当前周期：本期真实消费 40；更晚的零金额冲正不能把 entryAmount 置 0
    expect(act).toMatchObject({ entryAmount: 40, spent: 40, entryCount: 1 });
  });

  it('budget_remaining 与 overspendOf 同口径（净额）', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    expect(doRefund(20, ts).ok).toBe(true);
    expect(api.pointMetricValue('budget_remaining', { target: 'bc1' }, ts)).toBe(90);
  });

  it('退回条目重载后 source 与币种仍在', () => {
    seed({ currency: 'USD' });
    const ts = at(2024, 3, 6);
    expect(commit(60, ts).ok).toBe(true);
    expect(doRefund(20, ts).ok).toBe(true);
    const re = api.parseState(JSON.stringify(api.getState()));
    const e = re.ext.budgets.ledger.find(x => x.source === 'refund');
    expect(e).toMatchObject({ source: 'refund', amount: 0, refundAmount: 20, currency: 'USD' });
    expect(period(re).refund).toBe(20);
  });

  it('commitEntry 拒绝退款计划（方向不可混用）', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(60, ts).ok).toBe(true);
    const plan = api.BudgetEngine.prepareRefund('bc1', 10, ts);
    const r = api.Ledger.txn(tx => api.BudgetEngine.commitEntry(tx, plan, {}), { save: 'none', render: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BUDGET_REFUND_WRONG_PATH');
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

describe('币种基座（M1）', () => {
  const ctx = { domainIds: new Set(['d_default', 'd2']) };
  const catWith = over => api.normalizeBudgetCategory(Object.assign({}, CAT, over), ctx);

  it('旧分类不补 currency 键；读取层缺省 CNY', () => {
    seed();
    const cat = api.getState().ext.budgets.categories[0];
    expect('currency' in cat).toBe(false);
    expect(api.currencyOf(cat)).toBe('CNY');
    expect(api.currencyOf({ currency: 'usd' })).toBe('CNY');
    expect(api.historicalCurrencyOf({})).toBe('CNY');
    expect(api.historicalCurrencyOf({ currency: 'USD' })).toBe('USD');
  });

  it('normalize 只保留合法币种：非法删除、表外合法代码保留', () => {
    expect(catWith({ currency: 'USD' }).currency).toBe('USD');
    expect(catWith({ currency: 'XYZ' }).currency).toBe('XYZ');
    expect('currency' in catWith({ currency: 'usd' })).toBe(false);
    expect('currency' in catWith({ currency: 123 })).toBe(false);
    expect('currency' in catWith({})).toBe(false);
  });

  it('分类/周期/条目币种经存档往返仍在（normalize 不丢字段）', () => {
    seed({ currency: 'USD' });
    expect(commit(30, at(2024, 3, 6)).ok).toBe(true);
    const s = api.getState();
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    const re = api.parseState(JSON.stringify(s));
    expect(re.ext.budgets.categories[0].currency).toBe('USD');
    expect(re.ext.budgets.periods.bc1[key].currency).toBe('USD');
    expect(re.ext.budgets.ledger[0].currency).toBe('USD');
  });

  it('新周期写入币种快照；引擎的金额公式不受影响', () => {
    seed({ currency: 'USD' });
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    const s = api.getState();
    const key = Object.keys(s.ext.budgets.periods.bc1)[0];
    expect(s.ext.budgets.periods.bc1[key]).toMatchObject({ spent: 30, entryCount: 1, currency: 'USD' });
    expect(s.ext.budgets.ledger[0]).toMatchObject({ amount: 30, currency: 'USD' });
  });

  it('结算快照写入币种快照', () => {
    seed({
      cycle: 'month', currency: 'USD',
      rules: [{ kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }],
    });
    expect(commit(40, at(2024, 1, 15, 12)).ok).toBe(true);
    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 2))).toBe(true);
    const p = api.getState().ext.budgets.periods.bc1['M:2024-01'];
    expect(p.settlementSnapshot).toMatchObject({ spent: 40, surplus: 60, currency: 'USD' });
  });

  it('跨期冲正的新条目也带币种快照', () => {
    seed({ currency: 'USD' });
    expect(commit(40, at(2024, 1, 15, 12)).ok).toBe(true);
    const entryId = api.getState().ext.budgets.ledger[0].id;
    const r = api.BudgetEngine.compensateEntry({ catId: 'bc1', entryId: entryId, amount: 40 });
    expect(r.ok).toBe(true);
    const rev = api.getState().ext.budgets.ledger.find(e => e.source === 'reversal');
    expect(rev).toMatchObject({ amount: 0, refundAmount: 40, currency: 'USD' });
  });

  it('activityContext：单币种与今天一致，混合币种只保留计数', () => {
    seed();
    const ts = at(2024, 3, 6);
    expect(commit(30, ts).ok).toBe(true);
    expect(api.BudgetEngine.activityContext(ts)).toMatchObject({
      currency: 'CNY', mixed: false, spent: 30, overspend: 0, entryCount: 1, entryAmount: 30,
    });

    api.patchState(s => {
      s.ext.budgets.categories.push(catWith({ id: 'bc2', name: '订阅', currency: 'USD' }));
    });
    const mixed = api.BudgetEngine.activityContext(ts);
    expect(mixed).toMatchObject({ currency: null, mixed: true, spent: 30, entryCount: 1, entryAmount: 30 });
  });
});

