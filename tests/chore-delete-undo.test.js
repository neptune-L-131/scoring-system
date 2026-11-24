// 杂事删除撤销：快照（对象 / 原下标 / choreOrder 名次 / cycle / history / tags）与恢复冲突。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const cycle = () => ({ unit: 'day', interval: 1, anchor: 1000, nextDue: 5000, lastDue: 4000 });

function seedChores() {
  api.resetState({
    chores: [
      { id: 'c1', name: '一', tags: ['电脑'], cycle: cycle(), history: [{ ts: 1, due: 1000, settled: false, tags: ['电脑'] }] },
      { id: 'c2', name: '二', tags: ['电话'], cycle: cycle(), history: [{ ts: 2, due: 2000, settled: false }] },
      { id: 'c3', name: '三' },
    ],
    choreOrder: ['c1', 'c2', 'c3'],
  });
}

describe('杂事删除撤销', () => {
  it('恢复回原位置与原顺序，循环 nextDue / history / tags 按删除前快照回填', () => {
    seedChores();
    expect(api.deleteChoreCore('c2').ok).toBe(true);
    const live = api.getLive();
    expect(live.chores.map(c => c.id)).toEqual(['c1', 'c3']);
    expect(live.choreOrder).toEqual(['c1', 'c3']);
    const rec = live.choreDeleteUndo[0];
    expect(rec.index).toBe(1);
    expect(rec.orderIndex).toBe(1);

    expect(api.restoreChoreDeletion(rec.id).ok).toBe(true);
    expect(api.getLive().chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(api.getLive().choreOrder).toEqual(['c1', 'c2', 'c3']);
    const c2 = api.getLive().chores[1];
    // nextDue / lastDue 是删除前的值，不会因为撤销时重新计算而改变
    expect(c2.cycle.nextDue).toBe(5000);
    expect(c2.cycle.lastDue).toBe(4000);
    expect(c2.tags).toEqual(['电话']);
    expect(api.getLive().choreDeleteUndo).toEqual([]);
  });

  it('删除首条后撤销仍回到首位，循环快照完整保留', () => {
    seedChores();
    api.deleteChoreCore('c1');
    const rec = api.getLive().choreDeleteUndo[0];
    api.restoreChoreDeletion(rec.id);
    expect(api.getLive().chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3']);
    const c1 = api.getLive().chores[0];
    expect(c1.cycle.nextDue).toBe(5000);
    expect(c1.history).toEqual([{ ts: 1, due: 1000, settled: false, tags: ['电脑'] }]);
    expect(c1.tags).toEqual(['电脑']);
  });

  it('同 id 已被占用时恢复拒绝且零写入，撤销记录保留', () => {
    seedChores();
    api.deleteChoreCore('c2');
    const rec = api.getLive().choreDeleteUndo[0];
    api.patchState(s => { s.chores.push({ id: 'c2', name: '占用者' }); });
    const before = JSON.stringify(api.getLive().chores);

    const r = api.restoreChoreDeletion(rec.id);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(api.getLive().chores)).toBe(before);
    expect(api.getLive().choreDeleteUndo).toHaveLength(1);
  });

  it('撤销快照最多保留 5 条', () => {
    api.resetState({ chores: [], choreOrder: [] });
    for (let i = 1; i <= 6; i++) {
      api.patchState(s => { s.chores.push({ id: 'x' + i, name: 'x' + i }); });
      api.deleteChoreCore('x' + i);
    }
    const list = api.getLive().choreDeleteUndo;
    expect(list).toHaveLength(5);
    expect(list.map(r => r.chore.id)).toEqual(['x2', 'x3', 'x4', 'x5', 'x6']);
  });

  it('读档保留合法快照、丢弃损坏条目（与项目删除同一放行口径）', () => {
    const raw = api.defaults();
    raw.choreDeleteUndo = [
      { v: 1, id: 'u1', chore: { id: 'c1', name: '一' }, index: 0, orderIndex: 0 },
      null,
      { v: 1, id: 'u2' },
      { v: 1, id: 'u3', chore: [] },
    ];
    const parsed = api.parseState(JSON.stringify(raw));
    expect(parsed.choreDeleteUndo).toHaveLength(1);
    expect(parsed.choreDeleteUndo[0].id).toBe('u1');
  });
});
