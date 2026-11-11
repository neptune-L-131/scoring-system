// 删除多领域任务：进度值搬回默认领域必须按分均摊，扣减与回填严格零和，撤销可精确还原。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const totalCents = s => Object.values(s.scores.progress).reduce((a, v) => a + Math.round(v * 100), 0);

function seed() {
  api.resetState({
    domains: [
      { id: 'd_default', name: '默认' },
      { id: 'd2', name: '二' },
      { id: 'd3', name: '三' },
      { id: 'd4', name: '四' },
    ],
    scores: { vitality: 0, progress: { d_default: 5, d2: 3.34, d3: 3.33, d4: 3.33 }, achievement: 0 },
    tasks: [{
      id: 't1', name: '三领域任务', domainIds: ['d2', 'd3', 'd4'], scoreTypes: ['progress'],
      initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
      checkInCount: 0, streak: 0, totalEarned: 10, lastCheckIn: null, pendingDebt: 0, archived: false,
    }],
  });
}

describe('delTask：多领域进度搬回默认领域', () => {
  it('三领域 10 分：按分扣减，回填同额，总进度逐分不变', () => {
    seed();
    const before = api.getState();
    api.delTask('t1');
    const s = api.getState();

    expect(s.scores.progress).toEqual({ d_default: 15, d2: 0, d3: 0, d4: 0 });
    expect(totalCents(s)).toBe(totalCents(before));
    expect(totalCents(s)).toBe(1500);

    const log = s.logs.find(l => l.src === 'delete-task');
    expect(log.progressMoved.fromDomains.map(x => x.amount)).toEqual([3.34, 3.33, 3.33]);
    expect(log.progressMoved.totalMoved).toBe(10);
    expect(s.tasks.find(t => t.id === 't1')).toBeUndefined();
  });

  it('撤销删除后各领域余额精确还原（逐分相等，无容差）', () => {
    seed();
    const before = api.getState();
    api.delTask('t1');
    const logId = api.getState().logs.find(l => l.src === 'delete-task').id;
    api.Ledger.reverse(logId);
    const s = api.getState();

    expect(s.scores.progress).toEqual(before.scores.progress);
    expect(totalCents(s)).toBe(totalCents(before));
    expect(s.tasks.map(t => t.id)).toEqual(['t1']);
  });
});
