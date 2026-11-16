// 项目族事务边界：undo 快照必须与进度/账务同生共死。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from './shim.js';

const CURVE = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function seed() {
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 100, progress: { d_default: 0 }, achievement: 0 },
    affairs: [{
      id: 'a1', name: '装修', domainId: 'd_default', totalReward: 1,
      curve: { type: 'even', values: CURVE.slice() },
      currentCell: 0, alreadyGiven: 0, steps: [], ach: { enabled: false, amount: 0 },
      startedAt: null, doneAt: null, archived: false,
      budget: { categoryId: 'bc1', mode: 'fixed', amount: 20 }, budgetRef: null,
    }],
  });
  api.patchState(s => {
    s.ext.budgets.categories.push(api.normalizeBudgetCategory({
      id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 100,
      defaultProgressDomainId: 'd_default',
    }, { domainIds: new Set(['d_default']) }));
  });
}

let realCommit;
beforeEach(() => { seed(); realCommit = api.BudgetEngine.commitEntry; });
afterEach(() => { api.BudgetEngine.commitEntry = realCommit; });

describe('项目族事务回滚', () => {
  it('推进失败时 undo 栈不新增快照、项目状态与流水均不落', () => {
    api.BudgetEngine.commitEntry = () => { throw new Error('boom'); };
    api.advanceAffairStep('a1');
    const s = api.getState();
    const stack = (s.affairUndo && s.affairUndo.a1) || [];
    expect(stack.length).toBe(0);
    expect(s.affairs[0].currentCell).toBe(0);
    expect(s.affairs[0].alreadyGiven).toBe(0);
    expect(s.affairs[0].doneAt).toBeNull();
    expect(s.logs.length).toBe(0);
    expect(s.ext.budgets.ledger.length).toBe(0);
    expect(s.scores.vitality).toBe(100);
    expect(s.scores.progress.d_default).toBe(0);
  });

  it('推进成功时栈里恰好一条快照，撤销后回到原点', () => {
    api.advanceAffairStep('a1');
    let s = api.getState();
    expect(s.affairUndo.a1.length).toBe(1);
    expect(s.affairs[0].currentCell).toBe(9);
    api.affairUndoAction('a1');
    s = api.getState();
    expect(s.affairUndo.a1.length).toBe(0);
    expect(s.affairs[0].currentCell).toBe(0);
    expect(s.affairs[0].alreadyGiven).toBe(0);
    expect(s.affairs[0].doneAt).toBeNull();
  });
});
