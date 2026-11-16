// checkIn 事务边界：档位写入必须在 Ledger.txn 内，事务失败时随快照回滚。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from './shim.js';

const BASE_CAT = { id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 100 };

function seed() {
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 100, progress: {}, achievement: 0 },
    tasks: [{
      id: 't1', name: '阶段任务', initialValue: 10, interestRate: 10, debtRate: 20,
      pendingDebt: 0, streak: 0, lastCheckIn: null, checkInCount: 0, totalEarned: 0,
      collectionId: 'c_default', domainIds: ['d_default'], scoreTypes: ['vitality'],
      stageRewards: { v: [10, 20, 30, 40, 50], p: [], last: 0 },
      budget: { categoryId: 'bc1', mode: 'fixed', amount: 10 },
    }],
  });
  api.patchState(s => {
    s.ext.budgets.categories.push(api.normalizeBudgetCategory(Object.assign({}, BASE_CAT), { domainIds: new Set(['d_default']) }));
  });
}

let realCommit;
beforeEach(() => { seed(); realCommit = api.BudgetEngine.commitEntry; });
afterEach(() => { api.BudgetEngine.commitEntry = realCommit; });

describe('checkIn 事务回滚', () => {
  it('事务中途抛错时 stageRewards.last 保持原值', () => {
    api.BudgetEngine.commitEntry = () => { throw new Error('boom'); };
    // 命令层统一兜底：不再向调用方抛错，而是回滚后返回 {ok:false}
    const r = api.checkIn('t1', 3);
    expect(r.ok).toBe(false);
    const s = api.getState();
    expect(s.tasks[0].stageRewards.last).toBe(0);
    expect(s.scores.vitality).toBe(100);
    expect(s.logs.length).toBe(0);
    expect(s.ext.budgets.ledger.length).toBe(0);
  });

  it('事务成功时档位正常落值（确认移动未改变语义）', () => {
    const live = api.getLive().tasks[0];
    const preview = api.stageNetAt(live, 'vitality', 3, api.calcCheckIn(live));
    api.checkIn('t1', 3);
    const s = api.getState();
    expect(s.tasks[0].stageRewards.last).toBe(3);
    expect(s.scores.vitality - 100).toBe(preview);
  });
});
