// 删除项目时未完成的委派杂事：回杂事池 / 一起删除（第 6 轮 B3）。
// 覆盖：选择面板不改数据、回池保留杂事、连带删除同一事务、已完成杂事不参与、取消零写入。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from './shim.js';

const at = (d) => new Date(2026, 4, d || 10, 12, 0, 0, 0).getTime();
api.__setClockForTest(() => at());

function chore(id, extra) {
  return Object.assign({
    id, name: '杂事-' + id, done: false, doneAt: null, plannedAt: null,
    createdAt: at(1), settled: false, decayKey: null, archived: false, freshDays: 5,
  }, extra || {});
}

function affair(id, steps, extra) {
  return Object.assign({
    id, name: '项目-' + id, totalReward: 1,
    curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
    currentCell: 0, alreadyGiven: 0, domainId: null, plannedAt: null,
    steps: steps, ach: { enabled: false, amount: 0 }, createdAt: at(1),
    startedAt: null, doneAt: null,
  }, extra || {});
}

const step = (extra) => Object.assign({ text: '步骤', doneAt: null, plannedAt: null }, extra || {});

function seed() {
  api.resetState({
    scores: { vitality: 0, progress: {}, achievement: 0 },
    domains: [{ id: 'd_default', name: '默认' }],
    affairs: [
      affair('a1', [
        step({ text: '交水费', choreRef: { id: 'c1', origin: 'existing' } }),
        step({ text: '洗车', choreRef: { id: 'c2', origin: 'existing' } }),
        step({ text: '普通步骤' }),
      ]),
      affair('a2', [step({ text: '浇花', choreRef: { id: 'c4', origin: 'existing' } })]),
    ],
    chores: [
      chore('c1'),
      chore('c2', { done: true, doneAt: at(2) }),
      chore('c3'),
      chore('c4'),
      chore('c5', { archived: true }),
    ],
  });
  api.patchState(function (s) { s.choreOrder = ['c1', 'c2', 'c3', 'c4', 'c5']; });
}

let realConfirm;
beforeEach(() => { realConfirm = globalThis.confirm; });
afterEach(() => { globalThis.confirm = realConfirm; });

describe('委派杂事清单', () => {
  it('只列出未完成的委派杂事，已完成的与别的项目的不算', () => {
    seed();
    const ids = api.affairDeletionChores('a1').map(c => c.id);
    expect(ids).toEqual(['c1']);
  });
});

describe('删除入口', () => {
  it('有未完成的委派杂事时先开选择面板，不直接删除', () => {
    seed();
    api.delAffair('a1');
    expect(document.getElementById('affairDeleteId').value).toBe('a1');
    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(s.logs.length).toBe(0);
  });

  it('没有委派杂事时保持原来的确认流程：取消则零写入', () => {
    seed();
    globalThis.confirm = () => false;
    api.delAffair('a2');
    expect(api.getState().affairs.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(api.getState().logs.length).toBe(0);
  });
});

describe('回杂事池', () => {
  it('只删项目，未完成的杂事原样保留并重新可被认领', () => {
    seed();
    api.delAffair('a1');
    api.confirmAffairDelete('pool');

    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a2']);
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.choreOrder).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect([...api.claimedChoreIds()]).toEqual(['c4']);
    expect(s.logs[0].src).toBe('affair-del');
    expect(s.logs[0].desc).toBe('删除项目「项目-a1」');
  });

  it('取消选择面板零写入', () => {
    seed();
    const before = JSON.stringify(api.getState());
    api.delAffair('a1');
    api.cancelAffairDelete();
    expect(JSON.stringify(api.getState())).toBe(before);
  });
});

describe('删除撤销（B5 二）', () => {
  it('回杂事池：项目回到原下标、杂事不动、记录被消费', () => {
    seed();
    api.delAffair('a1');
    api.confirmAffairDelete('pool');
    const rec = api.getState().affairDeleteUndo[0];
    expect(rec.mode).toBe('pool');
    expect(rec.chores).toEqual([]);

    api.undoAffairDelete(rec.id);
    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.choreOrder).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.affairDeleteUndo.length).toBe(0);
    expect(s.logs[0].src).toBe('affair-restore');
  });

  it('一起删除：项目与杂事连位置一起恢复（含 choreOrder）', () => {
    seed();
    api.delAffair('a1');
    api.confirmAffairDelete('purge');
    expect(api.getState().chores.map(c => c.id)).toEqual(['c2', 'c3', 'c4', 'c5']);
    const rec = api.getState().affairDeleteUndo[0];
    expect(rec.mode).toBe('purge');

    api.undoAffairDelete(rec.id);
    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(s.affairs[0].steps[0].choreRef).toEqual({ id: 'c1', origin: 'existing' });
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.chores.find(c => c.id === 'c1').name).toBe('杂事-c1');
    expect(s.choreOrder).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('委派杂事已被别的项目占用时拒绝整笔恢复，零写入', () => {
    seed();
    api.delAffair('a1');
    api.confirmAffairDelete('purge');
    const rec = api.getState().affairDeleteUndo[0];
    api.patchState(s => {
      s.chores.push(chore('c1'));
      s.affairs.find(a => a.id === 'a2').steps.push(
        step({ text: '抢占', choreRef: { id: 'c1', origin: 'existing' } })
      );
    });
    const before = JSON.stringify(api.getState());
    const r = api.restoreAffairDeletion(rec.id);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(api.getState())).toBe(before);
  });
});

describe('一起删除', () => {
  it('项目与未完成的委派杂事同时删除；已完成的与其他项目的保留', () => {
    seed();
    api.delAffair('a1');
    api.confirmAffairDelete('purge');

    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a2']);
    expect(s.chores.map(c => c.id)).toEqual(['c2', 'c3', 'c4', 'c5']);
    expect(s.choreOrder).toEqual(['c2', 'c3', 'c4', 'c5']);
    expect([...api.claimedChoreIds()]).toEqual(['c4']);
    expect(s.logs.some(l => l.src === 'chore-delete' && l.desc.indexOf('杂事-c1') >= 0)).toBe(true);
    expect(s.logs[0].desc).toBe('删除项目「项目-a1」');
  });

  it('删除中途失败时项目与杂事都回滚，日志不变', () => {
    seed();
    api.delAffair('a1');
    const realEvent = api.Ledger.event;
    api.Ledger.event = function (desc) {
      if (desc.indexOf('删除项目') === 0) throw new Error('boom');
      return realEvent.apply(this, arguments);
    };
    try {
      api.confirmAffairDelete('purge');
    } finally {
      api.Ledger.event = realEvent;
    }

    const s = api.getState();
    expect(s.affairs.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.choreOrder).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(s.logs.length).toBe(0);
  });
});
