// 委派步骤的创建 / 解除 / 杂事池过滤（第 6 轮 B2）。
// 覆盖：候选排除、就地新建与步骤同一事务、引用校验失败不留痕、解除后杂事回池。
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

function seed(extra) {
  api.resetState(Object.assign({
    scores: { vitality: 0, progress: {}, achievement: 0 },
    domains: [{ id: 'd_default', name: '默认' }],
    affairs: [],
    chores: [chore('c1'), chore('c2')],
  }, extra || {}));
}

// 走真实的编辑入口：打开项目弹窗 → 改草稿 → 保存
function saveThroughModal(affairId, name) {
  api.openAffairModal(affairId);
  if (name) document.getElementById('affairName').value = name;
  api.handleAffairSave();
}

let realPrompt;
beforeEach(() => {
  realPrompt = globalThis.prompt;
  // openAffairModal 里以全局内联处理器名字调用预算绑定刷新
  globalThis.budgetBindingModeChange = api.budgetBindingModeChange;
});
afterEach(() => { globalThis.prompt = realPrompt; });

describe('候选杂事', () => {
  it('排除已被其他项目认领、已完成与已归档的杂事', () => {
    seed({
      chores: [chore('c1'), chore('c2'), chore('c3', { done: true, doneAt: at(2) }), chore('c4', { archived: true })],
      affairs: [affair('a1', [step({ text: '甲', choreRef: { id: 'c1', origin: 'existing' } })])],
    });
    const ids = api.delegationCandidates('a2', [], -1).map(c => c.id);
    expect(ids).toEqual(['c2']);
  });

  it('本草稿其他步骤已选的杂事也不会重复出现在候选里', () => {
    seed({ chores: [chore('c1'), chore('c2')] });
    const draft = [step({ choreRef: { id: 'c1', origin: 'existing' } }), step()];
    expect(api.delegationCandidates('', draft, 1).map(c => c.id)).toEqual(['c2']);
  });
});

describe('创建入口：就地新建与步骤同一事务', () => {
  it('新建项目时就地新建杂事：保存后两边同时存在且引用合法', () => {
    seed();
    globalThis.prompt = () => '买材料';
    api.openAffairModal('');
    document.getElementById('affairName').value = '装修';
    api.affairAddStep();
    api.affairStepInput(0, '准备材料');
    api.affairStepDelegateNew(0);
    api.handleAffairSave();

    const s = api.getState();
    const a = s.affairs[0];
    expect(a.name).toBe('装修');
    expect(a.steps.length).toBe(1);
    expect(a.steps[0].choreRef.origin).toBe('inline');
    const created = s.chores.find(c => c.id === a.steps[0].choreRef.id);
    expect(created && created.name).toBe('买材料');
    expect(api.affairStepIssues(s.affairs, s.chores)).toEqual([]);
  });

  it('中途失败时新建的杂事与项目都不留痕', () => {
    seed();
    globalThis.prompt = () => '买材料';
    api.openAffairModal('');
    document.getElementById('affairName').value = '装修';
    api.affairAddStep();
    api.affairStepInput(0, '准备材料');
    api.affairStepDelegateNew(0);

    const realEvent = api.Ledger.event;
    api.Ledger.event = function (desc) {
      if (desc.indexOf('创建项目') === 0) throw new Error('boom');
      return realEvent.apply(this, arguments);
    };
    try {
      api.handleAffairSave();
    } finally {
      api.Ledger.event = realEvent;
    }

    const s = api.getState();
    expect(s.affairs.length).toBe(0);
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(s.logs.length).toBe(0);
  });

  it('引用已被其他项目认领的杂事：整单拒绝，草稿没有写入', () => {
    seed({
      chores: [chore('c1'), chore('c2')],
      affairs: [affair('a1', [step({ text: '占用', choreRef: { id: 'c1', origin: 'existing' } })])],
    });
    api.openAffairModal('a1');
    api.affairAddStep();
    api.affairStepInput(1, '抢同一条');
    api.affairStepDelegateExisting(1, 'c1');
    api.handleAffairSave();

    const s = api.getState();
    expect(s.affairs[0].steps.length).toBe(1);
    expect(s.affairs[0].steps[0].choreRef).toEqual({ id: 'c1', origin: 'existing' });
    expect(s.chores.length).toBe(2);
  });
});

describe('创建入口：引用已有杂事', () => {
  it('保存后步骤带上 origin=existing 的引用，且该杂事离开杂事池', () => {
    seed();
    api.openAffairModal('');
    document.getElementById('affairName').value = '装修';
    api.affairAddStep();
    api.affairStepInput(0, '交水费');
    api.affairStepDelegateExisting(0, 'c1');
    api.handleAffairSave();

    const s = api.getState();
    expect(s.affairs[0].steps[0].choreRef).toEqual({ id: 'c1', origin: 'existing' });
    expect([...api.claimedChoreIds()]).toEqual(['c1']);

    api.renderChores();
    const html = document.getElementById('chorePanel').innerHTML;
    expect(html).not.toContain('data-chore-id="c1"');
    expect(html).toContain('data-chore-id="c2"');
  });
});

describe('解除入口', () => {
  it('解除后步骤变回纯步骤，杂事回池（仍存在）', () => {
    seed({
      affairs: [affair('a1', [step({ text: '交水费', choreRef: { id: 'c1', origin: 'existing' } })])],
    });
    api.openAffairModal('a1');
    api.affairStepUndelegate(0);
    api.handleAffairSave();

    const s = api.getState();
    expect(s.affairs[0].steps[0].choreRef).toBeUndefined();
    expect(s.affairs[0].steps[0].text).toBe('交水费');
    expect(s.chores.find(c => c.id === 'c1')).toBeTruthy();
    expect([...api.claimedChoreIds()]).toEqual([]);
    expect(api.affairStepIssues(s.affairs, s.chores)).toEqual([]);
  });

  it('取消就地新建的草稿：保存后不创建任何杂事', () => {
    seed();
    api.openAffairModal('');
    document.getElementById('affairName').value = '装修';
    api.affairAddStep();
    api.affairStepInput(0, '准备');
    globalThis.prompt = () => '不该存在';
    api.affairStepDelegateNew(0);
    api.affairStepUndelegate(0);
    api.handleAffairSave();

    const s = api.getState();
    expect(s.affairs[0].steps[0].choreRef).toBeUndefined();
    expect(s.chores.map(c => c.id)).toEqual(['c1', 'c2']);
  });
});
