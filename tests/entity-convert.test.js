// entity-convert：杂事 ↔ 项目同 id 换表、有损确认、最近一次转换撤销（第 4 轮 P3）
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { api } from './shim.js';

const at = (d, h, m) => new Date(2026, 4, d, h || 0, m || 0, 0, 0).getTime();
let realConfirm;

function seed() {
  api.__setClockForTest(() => at(10, 12));
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
    tasks: [],
    affairs: [{
      id: 'a1', name: '装修', domainId: 'd2', createdAt: at(1, 9), plannedAt: at(10, 10),
      steps: [{ text: '量尺寸', plannedAt: at(10, 10) }, { text: '下单', plannedAt: at(9, 10) }],
      currentCell: 2, alreadyGiven: 30, totalReward: 0.1, doneAt: null, archived: false,
      ach: { enabled: true, amount: 7 }, budget: { mode: 'fixed', amount: 100 }, budgetRef: null,
    }, {
      id: 'a2', name: '空项目', domainId: null, createdAt: at(2, 9), plannedAt: null,
      steps: [], currentCell: 0, alreadyGiven: 0, doneAt: at(9, 9), archived: false,
      ach: { enabled: false, amount: 0 }, budget: null, budgetRef: null,
    }],
    chores: [{
      id: 'c1', name: '交水费', createdAt: at(1, 9), plannedAt: at(10, 8), done: false, doneAt: null,
      archived: false, settled: false, freshDays: 3, decayKey: '2026-05-09', budget: { mode: 'fixed', amount: 30 }, budgetRef: null,
    }, {
      id: 'c2', name: '已完成杂事', createdAt: at(1, 9), plannedAt: at(5, 8), done: true, doneAt: at(5, 9),
      archived: false, settled: true, freshDays: null, decayKey: '2026-05-05',
    }],
    logs: [],
  });
  api.patchState(s => { s.affairUndo = {}; s.conversions = []; });
}

beforeEach(() => {
  realConfirm = globalThis.confirm;
  seed();
});
afterEach(() => { globalThis.confirm = realConfirm; });
afterAll(() => api.__setClockForTest(null));

describe('entity-convert：杂事 → 项目（同 id 换表）', () => {
  it('不复制记录、不改 id；补齐 steps / 进度轴 / 曲线字段，预算绑定跟随', () => {
    const before = api.getState().chores.find(c => c.id === 'c1');
    const r = api.choreToAffair('c1');
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.chores.some(c => c.id === 'c1')).toBe(false);
    const a = s.affairs.find(x => x.id === 'c1');
    expect(a).toBeTruthy();
    expect(a.name).toBe('交水费');
    expect(a.createdAt).toBe(before.createdAt);
    expect(a.plannedAt).toBe(before.plannedAt);
    expect(a.steps).toEqual([]);
    expect(a.currentCell).toBe(0);
    expect(a.alreadyGiven).toBe(0);
    expect(a.totalReward).toBe(0.1);
    expect(a.curve.values.length).toBe(10);
    expect(a.ach).toEqual({ enabled: false, amount: 0 });
    expect(a.budget).toEqual({ mode: 'fixed', amount: 30 });
    expect(s.conversions.length).toBe(1);
    expect(s.conversions[0].dir).toBe('chore->affair');
    expect(s.conversions[0].snapshot.name).toBe('交水费');
  });

  it('已完成杂事转换后视为已完成项目，且不补发进度', () => {
    api.choreToAffair('c2');
    const a = api.getState().affairs.find(x => x.id === 'c2');
    expect(a.currentCell).toBe(9);
    expect(a.alreadyGiven).toBe(0);
    expect(a.doneAt).toBe(at(5, 9));
  });

  it('已归档杂事拒绝转换，且不写状态', () => {
    api.patchState(s => { s.chores[0].archived = true; });
    const before = JSON.stringify(api.getState());
    const r = api.choreToAffair('c1');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(api.getState())).toBe(before);
  });
});

describe('entity-convert：项目 → 杂事（有损确认）', () => {
  it('存在有损字段时必须确认；取消则整体不动作', () => {
    const before = JSON.stringify(api.getState());
    const asked = [];
    globalThis.confirm = msg => { asked.push(msg); return false; };
    const r = api.affairToChore('a1');
    expect(r.ok).toBe(false);
    expect(r.canceled).toBe(true);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('步骤 2 步');
    expect(asked[0]).toContain('进度轴');
    expect(asked[0]).toContain('已发放进度 30');
    expect(asked[0]).toContain('完成成果点 7');
    expect(JSON.stringify(api.getState())).toBe(before);
  });

  it('确认后换表为杂事；有损字段不残留，完成项目标记为已结算', () => {
    globalThis.confirm = () => true;
    const r = api.affairToChore('a1');
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.affairs.some(x => x.id === 'a1')).toBe(false);
    const c = s.chores.find(x => x.id === 'a1');
    expect(c.name).toBe('装修');
    expect(c.steps).toBeUndefined();
    expect(c.currentCell).toBeUndefined();
    expect(c.done).toBe(false);
    expect(c.settled).toBe(false);
    expect(c.budget).toEqual({ mode: 'fixed', amount: 100 });
    expect(c.createdAt).toBe(at(1, 9));
  });

  it('无有损字段时不弹确认', () => {
    globalThis.confirm = () => { throw new Error('不应弹确认'); };
    const r = api.affairToChore('a2');
    expect(r.ok).toBe(true);
    const c = api.getState().chores.find(x => x.id === 'a2');
    expect(c.done).toBe(true);
    expect(c.doneAt).toBe(at(9, 9));
    expect(c.settled).toBe(true);
  });
});

describe('entity-convert：撤销边界', () => {
  it('刚转换后允许撤销，且逐字段还原原始记录', () => {
    const before = api.getState().chores.find(c => c.id === 'c1');
    api.choreToAffair('c1');
    expect(api.canUndoConversion()).toBe(true);
    const r = api.undoConversion();
    expect(r.ok).toBe(true);
    expect(api.getState().affairs.some(x => x.id === 'c1')).toBe(false);
    expect(api.getState().chores.find(c => c.id === 'c1')).toEqual(before);
    expect(api.getState().conversions.length).toBe(0);
  });

  it('转换后产生新流水 → 明确不可撤销', () => {
    api.choreToAffair('c1');
    api.Ledger.event('无关动作', 'test');
    const st = api.conversionUndoState();
    expect(st.ok).toBe(false);
    expect(st.reason).toContain('新流水');
    const r = api.undoConversion();
    expect(r.ok).toBe(false);
    expect(api.getState().chores.some(c => c.id === 'c1')).toBe(false);
  });

  it('跨结算周期（周）→ 明确不可撤销', () => {
    api.choreToAffair('c1');
    api.__setClockForTest(() => at(10, 12) + 8 * 864e5);
    const st = api.conversionUndoState();
    expect(st.ok).toBe(false);
    expect(st.reason).toContain('结算周期');
  });

  it('只认最近一次转换：撤销一次后不能再撤销更早的那次', () => {
    globalThis.confirm = () => true;
    api.choreToAffair('c1');
    api.affairToChore('a1');
    expect(api.lastConversion().entityId).toBe('a1');
    expect(api.undoConversion().ok).toBe(true);
    // a1 已还原为项目；再撤销应因“撤销本身写了新流水”而失败
    expect(api.canUndoConversion()).toBe(false);
    expect(api.getState().affairs.some(x => x.id === 'a1')).toBe(true);
    expect(api.getState().affairs.some(x => x.id === 'c1')).toBe(true);
  });
});

describe('entity-convert：affairUndo 快照迁移', () => {
  it('项目转杂事时把旧撤销栈移出 affairUndo，撤销转换后原样恢复', () => {
    const snap = [{ cell: 1, given: 10 }];
    api.patchState(s => { s.affairUndo = { a1: JSON.parse(JSON.stringify(snap)) }; });
    globalThis.confirm = () => true;
    api.affairToChore('a1');
    expect(api.getState().affairUndo.a1).toBeUndefined();
    expect(api.lastConversion().affairUndo).toEqual(snap);
    expect(api.undoConversion().ok).toBe(true);
    expect(api.getState().affairUndo.a1).toEqual(snap);
  });

  it('杂事转项目不会凭空产生 affairUndo 栈', () => {
    api.choreToAffair('c1');
    expect(api.getState().affairUndo.c1).toBeUndefined();
    api.undoConversion();
    expect(api.getState().affairUndo.c1).toBeUndefined();
  });
});
