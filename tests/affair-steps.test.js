// 项目步骤的两种形状 + 「委派杂事」独占引用（第 6 轮 B1）。
// 覆盖：形状守卫、脏数据降级、只读聚合、读档归一、编辑保存不冲掉引用。
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from './shim.js';

function step(extra) {
  return Object.assign({ text: '步骤', doneAt: null, plannedAt: null }, extra || {});
}

function chore(id, extra) {
  return Object.assign({
    id, name: '杂事-' + id, done: false, doneAt: null, plannedAt: null,
    createdAt: 1, settled: false, decayKey: null, archived: false,
  }, extra || {});
}

beforeEach(() => {
  api.resetState({ scores: { vitality: 0, progress: {}, achievement: 0 } });
});

describe('步骤形状判定', () => {
  it('没有 choreRef 的步骤是纯步骤，老存档零迁移', () => {
    const s = step({ text: '量尺寸' });
    expect(api.stepChoreRef(s)).toBeNull();
    expect(api.isDelegatedStep(s)).toBe(false);
    const affairs = [{ id: 'a1', name: '装修', steps: [s] }];
    const r = api.normalizeAffairStepRefs(affairs, []);
    expect(r.changed).toBe(false);
    expect(r.dropped).toEqual([]);
    expect(affairs[0].steps[0]).toBe(s);
    expect(affairs[0].steps[0]).toEqual({ text: '量尺寸', doneAt: null, plannedAt: null });
  });

  it('合法引用被识别为委派步骤', () => {
    const s = step({ choreRef: { id: 'c1', origin: 'existing' } });
    expect(api.stepChoreRef(s)).toEqual({ id: 'c1', origin: 'existing' });
    expect(api.isDelegatedStep(s)).toBe(true);
  });

  it('缺 origin / 空 id / 未知 origin / 非对象一律不算委派', () => {
    expect(api.stepChoreRef(step({ choreRef: { id: 'c1' } }))).toBeNull();
    expect(api.stepChoreRef(step({ choreRef: { id: '  ', origin: 'existing' } }))).toBeNull();
    expect(api.stepChoreRef(step({ choreRef: { id: 'c1', origin: 'ghost' } }))).toBeNull();
    expect(api.stepChoreRef(step({ choreRef: 'c1' }))).toBeNull();
    expect(api.stepChoreRef(null)).toBeNull();
  });

  it('makeChoreRef 不产出半个引用', () => {
    expect(api.makeChoreRef('c1', 'inline')).toEqual({ id: 'c1', origin: 'inline' });
    expect(api.makeChoreRef('', 'inline')).toBeNull();
    expect(api.makeChoreRef('c1', 'nope')).toBeNull();
  });
});

describe('读档归一：脏引用降级为纯步骤', () => {
  it('同一条杂事被两个步骤引用时，先出现者保留，后来者降级', () => {
    const affairs = [{
      id: 'a1', name: '装修', steps: [
        step({ text: '第一步', choreRef: { id: 'c1', origin: 'existing' } }),
        step({ text: '第二步', choreRef: { id: 'c1', origin: 'existing' } }),
      ],
    }];
    const r = api.normalizeAffairStepRefs(affairs, [chore('c1')]);
    expect(r.changed).toBe(true);
    expect(r.dropped.map(x => x.type)).toEqual(['duplicate-chore-ref']);
    expect(affairs[0].steps[0].choreRef).toEqual({ id: 'c1', origin: 'existing' });
    expect(affairs[0].steps[1].choreRef).toBeUndefined();
    // 步骤本身与文本都还在，只是变回纯步骤
    expect(affairs[0].steps[1].text).toBe('第二步');
  });

  it('引用不存在的杂事 → 降级', () => {
    const affairs = [{ id: 'a1', name: '装修', steps: [step({ text: '甲', choreRef: { id: 'ghost', origin: 'existing' } })] }];
    const r = api.normalizeAffairStepRefs(affairs, [chore('c1')]);
    expect(r.changed).toBe(true);
    expect(r.dropped[0].type).toBe('missing-chore');
    expect(affairs[0].steps[0].choreRef).toBeUndefined();
  });

  it('引用形状非法 / 委派步骤没有文本 → 降级', () => {
    const affairs = [{
      id: 'a1', name: '装修', steps: [
        step({ text: '甲', choreRef: { id: 'c1', origin: 'bad' } }),
        step({ text: '  ', choreRef: { id: 'c2', origin: 'inline' } }),
      ],
    }];
    const r = api.normalizeAffairStepRefs(affairs, [chore('c1'), chore('c2')]);
    expect(r.dropped.map(x => x.type)).toEqual(['bad-chore-ref', 'delegated-step-no-text']);
    expect(affairs[0].steps.every(s => s.choreRef === undefined)).toBe(true);
  });

  it('步骤不是数组时补成空数组；非对象步骤原位保留（撤销快照按位置对齐）', () => {
    const affairs = [
      { id: 'a1', name: '坏结构', steps: { text: 'x' } },
      { id: 'a2', name: '混合', steps: [null, step({ text: '甲', choreRef: { id: 'c1', origin: 'existing' } })] },
    ];
    const r = api.normalizeAffairStepRefs(affairs, [chore('c1')]);
    expect(r.changed).toBe(true);
    expect(affairs[0].steps).toEqual([]);
    expect(affairs[1].steps.length).toBe(2);
    expect(affairs[1].steps[0]).toBeNull();
    expect(affairs[1].steps[1].choreRef).toEqual({ id: 'c1', origin: 'existing' });
  });

  it('幂等：归一一次后再跑不再变化', () => {
    const affairs = [{ id: 'a1', name: '装修', steps: [step({ text: '甲', choreRef: { id: 'ghost', origin: 'existing' } })] }];
    api.normalizeAffairStepRefs(affairs, []);
    const second = api.normalizeAffairStepRefs(affairs, []);
    expect(second.changed).toBe(false);
    expect(second.dropped).toEqual([]);
  });
});

describe('引用不变式的只读校验', () => {
  it('逐条列出违反项，类型齐全', () => {
    const affairs = [{
      id: 'a1', name: '装修', steps: [
        step({ text: '', choreRef: { id: 'c1', origin: 'existing' } }),
        step({ text: '甲', choreRef: { id: 'ghost', origin: 'existing' } }),
        step({ text: '乙', choreRef: { origin: 'inline' } }),
        step({ text: '丙', choreRef: { id: 'c2', origin: 'inline' } }),
        step({ text: '丁', choreRef: { id: 'c2', origin: 'inline' } }),
      ],
    }];
    const issues = api.affairStepIssues(affairs, [chore('c2')]);
    const types = issues.map(x => x.type).sort();
    expect(types).toEqual([
      'bad-chore-ref', 'delegated-step-no-text', 'duplicate-chore-ref',
      'duplicate-chore-ref', 'missing-chore',
    ]);
  });

  it('合法引用不产生任何问题', () => {
    const affairs = [{ id: 'a1', name: '装修', steps: [step({ text: '甲', choreRef: { id: 'c1', origin: 'existing' } })] }];
    expect(api.affairStepIssues(affairs, [chore('c1')])).toEqual([]);
  });
});

describe('只读聚合视图', () => {
  beforeEach(() => {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      affairs: [{
        id: 'a1', name: '装修', steps: [
          step({ text: '纯步骤' }),
          step({ text: '约水电', choreRef: { id: 'c1', origin: 'existing' } }),
          step({ text: '买瓷砖', choreRef: { id: 'c2', origin: 'inline' } }),
        ],
      }],
      chores: [chore('c1'), chore('c2'), chore('c3')],
    });
  });

  it('这条杂事被哪个项目的哪个步骤引用', () => {
    const claims = api.choreClaimsOf('c1');
    expect(claims.length).toBe(1);
    expect(claims[0].affairId).toBe('a1');
    expect(claims[0].affairName).toBe('装修');
    expect(claims[0].stepIndex).toBe(1);
    expect(claims[0].origin).toBe('existing');
    expect(api.choreClaimOf('c1').step.text).toBe('约水电');
    expect(api.isChoreClaimed('c1')).toBe(true);
    expect(api.isChoreClaimed('c3')).toBe(false);
    expect(api.choreClaimsOf('c3')).toEqual([]);
  });

  it('这个项目有哪些委派步骤', () => {
    const list = api.affairDelegatedSteps(api.getState().affairs[0]);
    expect(list.map(x => [x.stepIndex, x.choreId, x.origin])).toEqual([
      [1, 'c1', 'existing'],
      [2, 'c2', 'inline'],
    ]);
  });

  it('被引用的杂事集合可直接用于杂事池过滤', () => {
    const ids = api.claimedChoreIds();
    expect([...ids].sort()).toEqual(['c1', 'c2']);
  });
});

describe('读档与保存的读取兼容', () => {
  it('parseState 归一：老步骤保持原样，脏引用被降级', () => {
    const raw = api.defaults();
    raw.affairs = [{
      id: 'a1', name: '装修', steps: [
        { text: '老步骤', doneAt: 5, plannedAt: 6 },
        { text: '委派', doneAt: null, plannedAt: null, choreRef: { id: 'ghost', origin: 'existing' } },
      ],
    }];
    raw.chores = [chore('c1')];
    const s = api.parseState(JSON.stringify(raw));
    expect(s.affairs[0].steps[0]).toEqual({ text: '老步骤', doneAt: 5, plannedAt: 6 });
    expect(s.affairs[0].steps[1].choreRef).toBeUndefined();
  });

  it('项目编辑保存不会冲掉委派步骤的 choreRef', () => {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      domains: [{ id: 'd_default', name: '默认' }],
      affairs: [{
        id: 'a1', name: '装修', totalReward: 1,
        curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
        currentCell: 0, alreadyGiven: 0, domainId: null, plannedAt: null,
        steps: [step({ text: '约水电', choreRef: { id: 'c1', origin: 'existing' } })],
        ach: { enabled: false, amount: 0 }, createdAt: 1, startedAt: null, doneAt: null,
      }],
      chores: [chore('c1')],
    });
    api.openAffairModal && (globalThis.budgetBindingModeChange = api.budgetBindingModeChange);
    api.openAffairModal('a1');
    document.getElementById('affairName').value = '装修（改名）';
    api.handleAffairSave();
    const a = api.getState().affairs[0];
    expect(a.name).toBe('装修（改名）');
    expect(a.steps[0].choreRef).toEqual({ id: 'c1', origin: 'existing' });
    expect(a.steps[0].text).toBe('约水电');
  });
});

describe('步骤稳定 id（第 6 轮 B5 一）', () => {
  it('ensureAffairStepIds 只补缺失/空白/重复的 id，其余原样保留且幂等', () => {
    const a = {
      steps: [
        { stepId: 's1', text: '甲', doneAt: 1 },
        { text: '乙' },
        { stepId: 's1', text: '丙' },
        null,
        { stepId: '   ', text: '丁' },
      ],
    };
    expect(api.ensureAffairStepIds(a)).toBe(true);
    expect(a.steps[0]).toEqual({ stepId: 's1', text: '甲', doneAt: 1 });
    const ids = [a.steps[0].stepId, a.steps[1].stepId, a.steps[2].stepId, a.steps[4].stepId];
    ids.forEach(id => expect(typeof id === 'string' && id.length > 0).toBe(true));
    expect(new Set(ids).size).toBe(4);
    expect(a.steps[3]).toBeNull();
    expect(api.ensureAffairStepIds(a)).toBe(false);
  });

  it('归一化守卫只删 choreRef，stepId 与其余字段原样保留', () => {
    const affairs = [{
      id: 'a1', name: '装修', steps: [
        step({ stepId: 's1', text: '甲', doneAt: 3, choreRef: { id: 'ghost', origin: 'existing' } }),
      ],
    }];
    const r = api.normalizeAffairStepRefs(affairs, []);
    expect(r.changed).toBe(true);
    expect(r.dropped[0].type).toBe('missing-chore');
    expect(affairs[0].steps[0].choreRef).toBeUndefined();
    expect(affairs[0].steps[0].stepId).toBe('s1');
    expect(affairs[0].steps[0].doneAt).toBe(3);
  });

  it('编辑保存保留既有 stepId；新增步骤拿到自己的 id，且经 parseState 往返不丢', () => {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      domains: [{ id: 'd_default', name: '默认' }],
      affairs: [{
        id: 'a1', name: '装修', totalReward: 1,
        curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
        currentCell: 0, alreadyGiven: 0, domainId: null, plannedAt: null,
        steps: [{ stepId: 'keep-me', text: '老步骤', doneAt: null, plannedAt: null }],
        ach: { enabled: false, amount: 0 }, createdAt: 1, startedAt: null, doneAt: null,
      }],
      chores: [],
    });
    api.openAffairModal && (globalThis.budgetBindingModeChange = api.budgetBindingModeChange);
    api.openAffairModal('a1');
    api.affairAddStep();
    api.affairStepInput(1, '新步骤');
    api.handleAffairSave();

    const steps = api.getState().affairs[0].steps;
    expect(steps[0].stepId).toBe('keep-me');
    expect(steps[0].text).toBe('老步骤');
    expect(typeof steps[1].stepId === 'string' && steps[1].stepId.length > 0).toBe(true);
    expect(steps[1].stepId).not.toBe('keep-me');
    const round = api.parseState(JSON.stringify(api.getState()));
    expect(round.affairs[0].steps.map(s => s.stepId)).toEqual([steps[0].stepId, steps[1].stepId]);
  });
});
