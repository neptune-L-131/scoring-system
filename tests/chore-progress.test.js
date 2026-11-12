// 杂事产出进度（第 4 轮 P4）：懒默认值、勾选发放、取消零和、批量结算不重复发放、转换保留领域
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api } from './shim.js';

const at = (d, h) => new Date(2026, 4, d, h || 9, 0, 0, 0).getTime();

function seed() {
  api.__setClockForTest(() => at(10, 12));
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }, { id: 'd1', name: '一' }, { id: 'd2', name: '二' }],
    scores: { vitality: 0, progress: {}, achievement: 0 },
    tasks: [],
    affairs: [],
    chores: [
      { id: 'c1', name: '写周报', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null, progressAmount: 0.05, progressDomainIds: ['d1', 'd2'] },
      { id: 'c2', name: '默认领域', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null, progressAmount: 1 },
      { id: 'c3', name: '未配置', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null },
    ],
    logs: [],
  });
  api.patchState(s => { s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 10, batchY: 5 }); });
}

beforeEach(seed);
afterAll(() => api.__setClockForTest(null));

const prog = id => api.getState().scores.progress[id] || 0;
const totalProg = () => Object.values(api.getState().scores.progress || {}).reduce((a, b) => a + b, 0);

describe('杂事产出进度：懒默认值', () => {
  it('未配置的杂事按 0 / 默认领域读取，不改 state', () => {
    const before = JSON.stringify(api.getState());
    expect(api.choreProgressOf({ id: 'x', name: 'x' })).toEqual({ amount: 0, domainIds: ['d_default'] });
    expect(api.choreProgressParts({ id: 'x' })).toEqual([]);
    expect(api.choreProgressOf({ progressAmount: 2, progressDomainIds: [] })).toEqual({ amount: 2, domainIds: ['d_default'] });
    expect(JSON.stringify(api.getState())).toBe(before);
  });

  it('按分精确分摊，尾差归前几个领域', () => {
    expect(api.choreProgressParts({ progressAmount: 0.05, progressDomainIds: ['d1', 'd2'] }))
      .toEqual([{ did: 'd1', amt: 0.03 }, { did: 'd2', amt: 0.02 }]);
  });
});

describe('杂事产出进度：勾选 / 取消零和', () => {
  it('勾选按领域发放，并记录分摊快照', () => {
    api.toggleChoreDone('c1');
    expect(prog('d1')).toBe(0.03);
    expect(prog('d2')).toBe(0.02);
    expect(totalProg()).toBe(0.05);
    const c = api.getState().chores.find(x => x.id === 'c1');
    expect(c.done).toBe(true);
    expect(c.progressAward).toEqual({ amount: 0.05, parts: [{ did: 'd1', amt: 0.03 }, { did: 'd2', amt: 0.02 }] });
    expect(api.getState().logs.some(l => l.src === 'chore-progress' && l.choreId === 'c1')).toBe(true);
  });

  it('取消勾选按快照逐分回退，回到零', () => {
    api.toggleChoreDone('c1');
    api.toggleChoreDone('c1');
    expect(prog('d1')).toBe(0);
    expect(prog('d2')).toBe(0);
    expect(totalProg()).toBe(0);
    const c = api.getState().chores.find(x => x.id === 'c1');
    expect(c.done).toBe(false);
    expect(c.progressAward).toBeUndefined();
    expect(api.getState().logs.some(l => l.src === 'chore-progress-undo')).toBe(true);
  });

  it('勾选后改配置再取消：仍按勾选时的快照回退（零和）', () => {
    api.toggleChoreDone('c1');
    api.patchState(s => {
      const c = s.chores.find(x => x.id === 'c1');
      c.progressAmount = 9;
      c.progressDomainIds = ['d1'];
    });
    api.toggleChoreDone('c1');
    expect(totalProg()).toBe(0);
    expect(prog('d1')).toBe(0);
    expect(prog('d2')).toBe(0);
  });

  it('未配置领域回落到默认领域', () => {
    api.toggleChoreDone('c2');
    expect(prog('d_default')).toBe(1);
    expect(totalProg()).toBe(1);
  });
});

describe('杂事产出进度：批量结算路径', () => {
  it('批量结算只发活力点，不重复发进度', () => {
    api.patchState(s => { s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 1, batchY: 2 }); });
    api.toggleChoreDone('c2');
    // 勾选时发 1 进度；同事务内的批量结算只加 2 活力点
    expect(totalProg()).toBe(1);
    expect(api.getState().scores.vitality).toBe(2);
    expect(api.getState().chores.find(x => x.id === 'c2').settled).toBe(true);
    // 再次结算没有未结算杂事，进度不变
    api.settleChoreBatches(true);
    expect(totalProg()).toBe(1);
  });
});

describe('杂事产出进度：与项目转换', () => {
  it('杂事→项目：单一产出领域转为项目归属领域', () => {
    api.patchState(s => {
      const c = s.chores.find(x => x.id === 'c1');
      c.progressDomainIds = ['d2'];
    });
    api.choreToAffair('c1');
    const a = api.getState().affairs.find(x => x.id === 'c1');
    expect(a.domainId).toBe('d2');
    expect(a.progressAmount).toBeUndefined();
  });

  it('项目→杂事：不继承每次完成产出，只保留领域归属', () => {
    globalThis.confirm = () => true;
    api.patchState(s => {
      s.affairs.push({ id: 'a9', name: '装修', domainId: 'd1', createdAt: at(1), plannedAt: null, steps: [], currentCell: 0, alreadyGiven: 0, ach: { enabled: false, amount: 0 }, doneAt: null, archived: false });
    });
    api.affairToChore('a9');
    const c = api.getState().chores.find(x => x.id === 'a9');
    expect(c.progressAmount).toBe(0);
    expect(c.progressDomainIds).toEqual(['d1']);
  });
});
