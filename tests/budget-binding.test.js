// 事项 × 现实预算绑定：固定/临时两种模式、事务整单回滚、撤销两条路径、
// 冲正与结余奖励隔离、水位乱序重算、allowNegative 作用域、系数校验、分级裁剪、budgetRef 存活。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const BASE_CAT = {
  id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 100,
  defaultProgressDomainId: 'd_default',
};

const BASE_TASK = {
  id: 't1', name: '任务', initialValue: 10, interestRate: 10, debtRate: 20,
  pendingDebt: 0, streak: 0, lastCheckIn: null, checkInCount: 0, totalEarned: 0,
  collectionId: 'c_default', domainIds: ['d_default'], scoreTypes: ['vitality'],
};

function seed(catOver, taskOver, scoresOver) {
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: Object.assign({ vitality: 100, progress: {}, achievement: 100 }, scoresOver || {}),
  });
  const cat = api.normalizeBudgetCategory(Object.assign({}, BASE_CAT, catOver || {}), {
    domainIds: new Set(['d_default']),
  });
  api.patchState(s => {
    s.ext.budgets.categories.push(cat);
    if (taskOver !== null) s.tasks.push(Object.assign({}, BASE_TASK, taskOver || {}));
  });
  return api.getState();
}

function currentPeriod(s) {
  const key = s.ext.budgets.current.bc1;
  return s.ext.budgets.periods.bc1[key];
}

function budgetEntry(s, id) {
  return s.ext.budgets.ledger.find(e => e.id === id);
}

describe('绑定解析：固定 / 每次输入', () => {
  it('固定金额：按实体绑定金额出计划，解析阶段不写任何状态', () => {
    seed({}, { budget: { categoryId: 'bc1', mode: 'fixed', amount: 30 } });
    const t = api.getLive().tasks[0];
    const r = api.resolveActionBudget(t, { kind: 'task', id: 't1', source: 'task', ts: Date.now() });
    expect(r).toMatchObject({ status: 'ok', amount: 30 });
    expect(r.plan).toMatchObject({ ok: true, source: 'task', amount: 30 });
    const s = api.getState();
    expect(s.ext.budgets.ledger).toHaveLength(0);
    expect(s.ext.budgets.periods.bc1).toBeUndefined();
  });

  it('每次输入：显式金额优先，无显式金额时回退 lastAmount', () => {
    seed({}, { budget: { categoryId: 'bc1', mode: 'prompt', amount: 0, lastAmount: 25 } });
    const t = api.getLive().tasks[0];
    expect(api.resolveActionBudget(t, { kind: 'task', id: 't1', source: 'task', amount: 12 }).amount).toBe(12);
    expect(api.resolveActionBudget(t, { kind: 'task', id: 't1', source: 'task' }).amount).toBe(25);
    expect(api.needsAmountPrompt(t)).toBe(true);
    expect(t.budget.lastAmount).toBe(25); // 解析不刷新 lastAmount
  });

  it('分类失效降级为 skip，不阻断事项本身', () => {
    seed({}, { budget: { categoryId: 'gone', mode: 'fixed', amount: 30 } });
    const r = api.resolveActionBudget(api.getLive().tasks[0], { kind: 'task', id: 't1', source: 'task' });
    expect(r.status).toBe('skip');
    expect(r.reason).toContain('已删除');
  });
});

describe('打卡 × 绑定预算', () => {
  it('固定金额：同一事务落账，打卡流水带 budgetRef，撤销后账目同步消失', () => {
    seed({}, { budget: { categoryId: 'bc1', mode: 'fixed', amount: 30 } });
    api.checkIn('t1');
    let s = api.getState();
    const log = s.logs.find(l => l.src === 'checkin');
    expect(log).toBeTruthy();
    expect(log.budgetRef).toMatchObject({ catId: 'bc1', amount: 30 });
    expect(s.ext.budgets.ledger).toHaveLength(1);
    expect(s.ext.budgets.ledger[0]).toMatchObject({
      source: 'task', status: 'active', amount: 30,
      links: { checkinLogId: log.id },
    });
    expect(currentPeriod(s).spent).toBe(30);

    api.undoLog(log.id);
    s = api.getState();
    expect(s.logs.some(l => l.src === 'checkin')).toBe(false);
    expect(budgetEntry(s, log.budgetRef.entryId).status).toBe('reversed');
    expect(currentPeriod(s).spent).toBe(0);
    expect(currentPeriod(s).entryCount).toBe(0);
  });

  it('账目已提交后事务失败：打卡、成本、现实账全部整单回滚', () => {
    seed({}, { budget: { categoryId: 'bc1', mode: 'fixed', amount: 30 }, vitalityCost: 5 });
    const orig = api.BudgetEngine.commitEntry;
    api.BudgetEngine.commitEntry = function (tx, plan, extra) {
      orig(tx, plan, extra); // 先真的写进事务，再由后续失败触发回滚
      const e = new Error('TEST_ABORT');
      e.__txn = true;
      e.code = 'TEST_ABORT';
      e.info = { reason: '模拟事务后续失败' };
      throw e;
    };
    try {
      api.checkIn('t1');
    } finally {
      api.BudgetEngine.commitEntry = orig;
    }
    const s = api.getState();
    expect(s.logs.some(l => l.src === 'checkin' || l.src === 'cost')).toBe(false);
    expect(s.scores.vitality).toBe(100); // 成本已退回
    expect(s.ext.budgets.ledger).toHaveLength(0); // 现实账目未写入
    expect(s.ext.budgets.periods.bc1).toBeUndefined();
    expect(s.tasks[0].checkInCount).toBe(0);
    expect(s.tasks[0].lastCheckIn).toBe(null);
  });
});

describe('撤销联动：当期硬撤 / 跨期冲正', () => {
  function commitAt(amount, ts) {
    let out = null;
    const r = api.Ledger.txn(tx => {
      const plan = api.BudgetEngine.prepareEntry('bc1', amount, { ts, source: 'task' });
      out = api.BudgetEngine.commitEntry(tx, plan, { checkinLogId: 'log-x' });
    }, { save: 'none', render: false });
    expect(r.ok).toBe(true);
    return { entryId: out.entry.id, ref: { entryId: out.entry.id, catId: 'bc1', amount, periodKey: out.entry.periodKey } };
  }

  it('当期：reverseEntry 硬撤，原始账目标记 reversed', () => {
    seed();
    const { ref } = commitAt(30, Date.now());
    expect(api.reverseBoundBudget(ref)).toMatchObject({ ok: true, mode: 'reverse' });
    const s = api.getState();
    expect(budgetEntry(s, ref.entryId).status).toBe('reversed');
    expect(currentPeriod(s).spent).toBe(0);
    expect(currentPeriod(s).refund).toBe(0);
  });

  it('跨期：compensateEntry 冲正，历史周期冻结、本期只记退回额度', () => {
    seed({ cycle: 'month' });
    const { ref } = commitAt(40, at(2024, 1, 15));
    expect(api.reverseBoundBudget(ref)).toMatchObject({ ok: true, mode: 'compensate' });
    const s = api.getState();
    const orig = budgetEntry(s, ref.entryId);
    expect(orig).toMatchObject({ status: 'compensated', periodKey: 'M:2024-01', amount: 40 });
    // 历史周期的已花与奖励口径不变
    expect(s.ext.budgets.periods.bc1['M:2024-01'].spent).toBe(40);
    const cur = Object.keys(s.ext.budgets.periods.bc1)
      .map(k => s.ext.budgets.periods.bc1[k])
      .find(p => p.key !== 'M:2024-01');
    expect(cur.refund).toBe(40);
    const rev = s.ext.budgets.ledger.find(e => e.source === 'reversal');
    expect(rev).toMatchObject({ amount: 0, refundAmount: 40, status: 'active' });
    expect(rev.links.reversalOf).toBe(ref.entryId);
  });

  it('冲正不影响已结算的结余奖励', () => {
    seed({ cycle: 'month', rules: [{ kind: 'reward', params: { mode: 'ratio', rate: 0.2 }, target: { account: 'achievement' } }] });
    const { ref } = commitAt(40, at(2024, 1, 15));
    expect(api.BudgetEngine.reconcileDue('bc1', at(2024, 2, 2))).toBe(true);
    let s = api.getState();
    const pJan = s.ext.budgets.periods.bc1['M:2024-01'];
    expect(pJan).toMatchObject({ rewardSettled: true, rewardAmount: 12 });
    expect(s.scores.achievement).toBe(112);

    api.reverseBoundBudget(ref);
    s = api.getState();
    const after = s.ext.budgets.periods.bc1['M:2024-01'];
    expect(after.rewardAmount).toBe(12);
    expect(after.settlementSnapshot).toMatchObject({ spent: 40, surplus: 60, rewardAmount: 12 });
    expect(s.scores.achievement).toBe(112); // 冲正不追回、也不再发
  });
});

describe('水位重算：与撤销顺序无关', () => {
  function seedThree() {
    seed({ rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 0.5, per: 'entry' }, target: { account: 'vitality' } }] });
    const ids = [];
    [60, 60, 20].forEach(amount => {
      const r = api.Ledger.txn(tx => {
        const plan = api.BudgetEngine.prepareEntry('bc1', amount, { ts: Date.now(), source: 'task' });
        ids.push(api.BudgetEngine.commitEntry(tx, plan, {}).entry.id);
      }, { save: 'none', render: false });
      expect(r.ok).toBe(true);
    });
    return ids;
  }

  it('先撤早期账目不会提前压低水位；三种顺序最终水位一致', () => {
    let ids = seedThree();
    let s = api.getState();
    expect(currentPeriod(s).penalizedOverspend).toBe(40);

    api.BudgetEngine.reverseEntry(ids[0]); // 撤掉水位 0 的第一笔：剩余快照仍为 40
    s = api.getState();
    expect(currentPeriod(s).penalizedOverspend).toBe(40);
    api.BudgetEngine.reverseEntry(ids[2]);
    expect(currentPeriod(api.getState()).penalizedOverspend).toBe(20);
    api.BudgetEngine.reverseEntry(ids[1]);
    s = api.getState();
    expect(currentPeriod(s)).toMatchObject({ spent: 0, entryCount: 0, penalizedOverspend: 0 });

    // 反序撤销：最终状态完全相同
    ids = seedThree();
    [2, 1, 0].forEach(i => api.BudgetEngine.reverseEntry(ids[i]));
    s = api.getState();
    expect(currentPeriod(s)).toMatchObject({ spent: 0, entryCount: 0, penalizedOverspend: 0 });
  });
});

describe('allowNegative 的作用域', () => {
  it('未传 allowNegative：余额不足整笔拒绝（商品/手工记账语义不变）', () => {
    seed({
      rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 1, per: 'entry' }, target: { account: 'vitality' } }],
    }, null, { vitality: 0, progress: {}, achievement: 100 });
    let code = '';
    try {
      api.BudgetEngine.prepareEntry('bc1', 120, { ts: Date.now(), source: 'product' });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe('BUDGET_INSUFFICIENT');
  });

  it('显式 allowNegative：计划保留，账户允许转负', () => {
    seed({
      rules: [{ kind: 'penalty', params: { mode: 'ratio', rate: 1, per: 'entry' }, target: { account: 'vitality' } }],
    }, null, { vitality: 0, progress: {}, achievement: 100 });
    const plan = api.BudgetEngine.prepareEntry('bc1', 120, { ts: Date.now(), source: 'task', allowNegative: true });
    expect(plan.insufficient).toBe(null);
    expect(plan.deficit).toMatchObject({ account: 'vitality', diff: 20 });
  });
});

describe('规则校验：结余转化系数之和 ≤ 1', () => {
  const mk = (rate, enabled = true) => ({
    id: 'r' + rate, kind: 'reward', enabled,
    params: { mode: 'ratio', rate, capPerPeriod: null, minAmount: 0, per: 'episode', value: 0 },
    target: { account: 'achievement' },
  });

  it('两条 reward 比例之和 > 1 被拒', () => {
    const cat = { defaultProgressDomainId: 'd_default', rules: [mk(0.6), mk(0.5)] };
    expect(api.BudgetEngine.validateRule(cat, cat.rules[1], 2)).toContain('系数之和');
  });

  it('合计恰为 1 或含停用规则时放行', () => {
    const ok = { defaultProgressDomainId: 'd_default', rules: [mk(0.5), mk(0.5)] };
    expect(api.BudgetEngine.validateRule(ok, ok.rules[1], 2)).toBe('');
    const off = { defaultProgressDomainId: 'd_default', rules: [mk(0.9), mk(0.5, false)] };
    expect(api.BudgetEngine.validateRule(off, off.rules[1], 2)).toBe('');
  });
});

describe('pruneLedger 分级裁剪', () => {
  it('当期账目与有实体引用的历史账目不被删除', () => {
    seed();
    [10, 20].forEach(amount => {
      const r = api.Ledger.txn(tx => {
        const plan = api.BudgetEngine.prepareEntry('bc1', amount, { ts: Date.now(), source: 'manual' });
        api.BudgetEngine.commitEntry(tx, plan, {});
      }, { save: 'none', render: false });
      expect(r.ok).toBe(true);
    });
    api.patchState(s => {
      s.ext.budgets.settings.ledgerMax = 4;
      const oldTs = Date.now() - 90 * 864e5;
      const mkHist = (id, links) => ({
        id, ts: oldTs, categoryId: 'bc1', amount: 1, source: 'manual', productId: '', note: '',
        periodKey: 'W:old-' + id, status: 'active', reversedAt: null,
        topupAdded: 0, topupCost: 0, penaltyOverspendDelta: 0,
        links: Object.assign({ purchaseLogId: '', topupLogId: '', penaltyLogIds: [], feedbackLogIds: [], checkinLogId: '', affairId: '', affairAdvanceId: '', choreId: '', reversalOf: '' }, links),
        snapshot: null,
      });
      s.ext.budgets.ledger.push(
        mkHist('h_ref', { choreId: 'c1' }),
        mkHist('h_free1', {}),
        mkHist('h_free2', {}),
        Object.assign(mkHist('h_gone', {}), { status: 'reversed' }),
      );
    });
    api.BudgetEngine.pruneLedger();
    const s = api.getState();
    const left = s.ext.budgets.ledger.map(e => e.id);
    expect(left).toHaveLength(4); // 上限 4
    expect(left).toContain('h_ref');
    expect(left.includes('h_free1') && left.includes('h_free2')).toBe(false);
    const keptCurrent = s.ext.budgets.ledger.filter(e => e.periodKey === s.ext.budgets.current.bc1);
    expect(keptCurrent).toHaveLength(2);
  });
});

describe('重算历史不清空 budgetRef', () => {
  it('recalcTaskHistory 重写打卡流水后 budgetRef 仍在，撤销仍能定位现实账目', () => {
    seed({}, { budget: { categoryId: 'bc1', mode: 'fixed', amount: 30 } });
    api.checkIn('t1');
    const before = api.getState();
    const ref = before.logs.find(l => l.src === 'checkin').budgetRef;
    expect(ref).toBeTruthy();

    const live = api.getLive().tasks[0];
    const r = api.recalcTaskHistory(live, Object.assign({}, live, { initialValue: 12, interestRate: 0 }));
    expect(r.ok).toBe(true);

    const s = api.getState();
    const log = s.logs.find(l => l.src === 'checkin');
    expect(log.budgetRef).toMatchObject({ entryId: ref.entryId, catId: 'bc1', amount: 30 });
    expect(log.amt).toBe(12);

    api.reverseBoundBudget(log.budgetRef);
    const after = api.getState();
    expect(budgetEntry(after, ref.entryId).status).toBe('reversed');
    expect(currentPeriod(after).spent).toBe(0);
  });
});
