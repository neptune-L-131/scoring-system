// 项目完成时自动判定委派杂事（第 6 轮 B4）。
// 覆盖：只写完成态不结算、循环杂事推进周期、可追溯事件、撤销同批回退、失败整单回滚。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from './shim.js';

let clock = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
const at = (d) => new Date(2026, 4, d || 10, 12, 0, 0, 0).getTime();
api.__setClockForTest(() => clock);

function chore(id, extra) {
  return Object.assign({
    id, name: '杂事-' + id, done: false, doneAt: null, plannedAt: null,
    createdAt: at(1), settled: false, freshDays: 5, decayKey: null, archived: false, tags: [],
  }, extra || {});
}

function affair(id, steps, extra) {
  return Object.assign({
    id, name: '项目-' + id, totalReward: 0,
    curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
    currentCell: 0, alreadyGiven: 0, domainId: null, plannedAt: null,
    steps: steps, ach: { enabled: false, amount: 0 }, createdAt: at(1),
    startedAt: null, doneAt: null,
  }, extra || {});
}

const ref = (id) => ({ choreRef: { id: id, origin: 'existing' } });
const step = (extra) => Object.assign({ text: '步骤', doneAt: null, plannedAt: null }, extra || {});

function seed(extra) {
  api.resetState(Object.assign({
    scores: { vitality: 0, progress: {}, achievement: 0 },
    domains: [{ id: 'd_default', name: '默认' }],
    affairs: [],
    chores: [],
  }, extra || {}));
}

beforeEach(() => {
  clock = at(10);
  api.__setClockForTest(() => clock);
});
afterEach(() => { clock = at(10); });

describe('项目完成 → 自动判定委派杂事', () => {
  it('未完成的委派杂事被判定完成，且不发奖励、不进结算池', () => {
    seed({
      chores: [chore('c1'), chore('c2')],
      affairs: [affair('a1', [step({ text: '交水费', ...ref('c1') })])],
    });
    api.completeAffair('a1');

    const s = api.getState();
    expect(s.affairs[0].doneAt).toBe(at(10));
    expect(s.chores.find(c => c.id === 'c1').done).toBe(true);
    // 未被委派的杂事不受影响
    expect(s.chores.find(c => c.id === 'c2').done).toBe(false);
    // 只写完成态：没有活力点/进度变化，也没有待结算条目
    expect(s.scores.vitality).toBe(0);
    expect(s.scores.progress.d_default).toBeUndefined();
    expect(api.choreSettlePool()).toEqual([]);
    expect(s.chores.find(c => c.id === 'c1').progressAward).toBeUndefined();
  });

  it('留下 chore-auto-done 流水，能与用户手点的完成区分', () => {
    seed({
      chores: [chore('c1')],
      affairs: [affair('a1', [step({ text: '交水费', ...ref('c1') })])],
    });
    api.completeAffair('a1');
    const logs = api.getState().logs;
    const hit = logs.find(l => l.src === 'chore-auto-done');
    expect(hit).toBeTruthy();
    expect(hit.desc).toContain('项目「项目-a1」完成');
    expect(hit.desc).toContain('杂事「杂事-c1」');
    expect(hit.choreId).toBe('c1');
    expect(hit.affairId).toBe('a1');
    expect(hit.amt).toBe(0);
  });

  it('循环杂事走 choreMarkCompletion 推进周期，到期会再次出现', () => {
    const cyc = chore('c1', {
      cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 },
    });
    seed({
      chores: [cyc],
      affairs: [affair('a1', [step({ text: '浇花', ...ref('c1') })])],
    });
    api.completeAffair('a1');

    let c = api.getState().chores[0];
    expect(c.done).toBe(true);
    expect(c.cycle.nextDue).toBe(api.dayStart(at(11)));
    expect(c.history.length).toBe(1);
    expect(c.history[0].due).toBe(api.dayStart(at(10)));
    expect(api.choreDoneNow(c)).toBe(true);

    // 第二天到期：重新待办（不会因为自动判定被永久压成已完成）
    clock = at(11);
    c = api.getState().chores[0];
    expect(api.choreDoneNow(c)).toBe(false);
  });

  it('本周期已完成的委派杂事不重复写历史', () => {
    seed({
      chores: [chore('c1', { done: true, doneAt: at(9) })],
      affairs: [affair('a1', [step({ text: '交水费', ...ref('c1') })])],
    });
    api.completeAffair('a1');
    const s = api.getState();
    expect(s.chores[0].doneAt).toBe(at(9));
    expect(api.choreHistoryOf(s.chores[0])).toEqual([]);
    expect(s.logs.some(l => l.src === 'chore-auto-done')).toBe(false);
  });
});

describe('撤销：自动完成的杂事同批回退', () => {
  it('撤销项目完成后，一次性杂事回到未完成', () => {
    seed({
      chores: [chore('c1')],
      affairs: [affair('a1', [step({ text: '交水费', ...ref('c1') })])],
    });
    api.completeAffair('a1');
    api.affairUndoAction('a1');

    const s = api.getState();
    expect(s.affairs[0].currentCell).toBe(0);
    expect(s.affairs[0].doneAt).toBeNull();
    expect(s.chores[0].done).toBe(false);
    expect(s.chores[0].doneAt).toBeNull();
    expect(s.chores[0].settled).toBe(false);
    expect(api.choreHistoryOf(s.chores[0])).toEqual([]);
  });

  it('撤销后循环杂事的 nextDue 回到本周期', () => {
    seed({
      chores: [chore('c1', {
        cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 },
      })],
      affairs: [affair('a1', [step({ text: '浇花', ...ref('c1') })])],
    });
    api.completeAffair('a1');
    api.affairUndoAction('a1');

    const c = api.getState().chores[0];
    expect(c.done).toBe(false);
    expect(c.cycle.nextDue).toBe(at(10));
    expect(c.cycle.lastDue).toBe(0);
    expect(api.choreHistoryOf(c)).toEqual([]);
    expect(api.choreDoneNow(c)).toBe(false);
  });
});

describe('撤销：步骤快照按 stepId 对齐（B5 一）', () => {
  it('压快照时补齐 stepId，写进 state 并随读档往返保留', () => {
    seed({ affairs: [affair('a1', [step({ text: 'A' })])] });
    const live = api.getLive();
    api.affairPushUndo(live.affairs[0]);
    const id = live.affairs[0].steps[0].stepId;
    expect(typeof id).toBe('string');
    expect(live.affairUndo.a1[0].steps[0].id).toBe(id);
    const round = api.parseState(JSON.stringify(api.getState()));
    expect(round.affairs[0].steps[0].stepId).toBe(id);
  });

  it('窗口内删除前面的步骤并插入新步骤，撤销不写到错误的步骤上', () => {
    seed({ affairs: [affair('a1', [step({ text: 'A' }), step({ text: 'B' })])] });
    const live = api.getLive();
    const a = live.affairs[0];
    api.affairPushUndo(a);
    // 窗口内：删掉 A，在最前面插入已完成的新步骤 X；B 未被完成
    a.steps = [{ stepId: 'sx', text: 'X', doneAt: 111, plannedAt: null }, a.steps[1]];
    api.affairUndoAction('a1');

    const steps = api.getState().affairs[0].steps;
    expect(steps.map(s => s.text)).toEqual(['X', 'B']);
    expect(steps[0].doneAt).toBe(111);
    expect(steps[1].doneAt).toBeNull();
  });

  it('窗口内改名后撤销仍对同一步骤回退完成态', () => {
    seed({ affairs: [affair('a1', [step({ text: 'A' })])] });
    const live = api.getLive();
    api.affairPushUndo(live.affairs[0]);
    live.affairs[0].steps[0].text = 'A（改名）';
    live.affairs[0].steps[0].doneAt = at(10);
    api.affairUndoAction('a1');

    const s = api.getState().affairs[0].steps[0];
    expect(s.text).toBe('A（改名）');
    expect(s.doneAt).toBeNull();
  });

  it('旧快照（无 stepId）在步骤数未变时按原下标回填', () => {
    seed({ affairs: [affair('a1', [step({ text: 'A', doneAt: at(10) }), step({ text: 'B', doneAt: at(10) })])] });
    api.patchState(s => {
      s.affairUndo = { a1: [{
        cell: 0, given: 0, doneAt: null, startedAt: null,
        steps: [{ doneAt: null }, { doneAt: at(3) }],
        budgetRef: null, chorePre: [], autoChores: null,
      }] };
    });
    api.affairUndoAction('a1');
    expect(api.getState().affairs[0].steps.map(s => s.doneAt)).toEqual([null, at(3)]);
  });

  it('旧快照（无 stepId）在步骤数已变时整段跳过，不写错位置', () => {
    seed({ affairs: [affair('a1', [step({ text: 'A', doneAt: at(10) })])] });
    api.patchState(s => {
      s.affairUndo = { a1: [{
        cell: 0, given: 0, doneAt: null, startedAt: null,
        steps: [{ doneAt: null }, { doneAt: at(3) }],
        budgetRef: null, chorePre: [], autoChores: null,
      }] };
    });
    api.affairUndoAction('a1');
    expect(api.getState().affairs[0].steps[0].doneAt).toBe(at(10));
  });
});

describe('事务边界', () => {
  it('自动判定后续写入失败时，杂事完成态与进度一起回滚', () => {
    seed({
      chores: [chore('c1')],
      affairs: [affair('a1', [step({ text: '交水费', ...ref('c1') })])],
    });
    const realEvent = api.Ledger.event;
    api.Ledger.event = function (desc) {
      if (String(desc).indexOf('自动判定') >= 0) throw new Error('boom');
      return realEvent.apply(this, arguments);
    };
    try {
      api.completeAffair('a1');
    } finally {
      api.Ledger.event = realEvent;
    }

    const s = api.getState();
    expect(s.affairs[0].currentCell).toBe(0);
    expect(s.affairs[0].doneAt).toBeNull();
    expect(s.chores[0].done).toBe(false);
    expect(api.choreHistoryOf(s.chores[0])).toEqual([]);
    expect((s.affairUndo.a1 || []).length).toBe(0);
    expect(s.logs.length).toBe(0);
  });
});
