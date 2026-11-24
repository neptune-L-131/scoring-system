// 单实体条件（D2）：文案、主体候选、B6 直达判据、入口能力隔离。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const anchor = () => document.getElementById('__condAnchor');
const panelHTML = () => document.getElementById('condPanel').innerHTML;
const leaf = (over) => Object.assign({
  range: 'period', metric: 'checkins', op: '>=', value: 1,
  targetType: 'all', newFilter: 'none', target: '', aggregate: 'sum',
}, over || {});

// 非动作流入口：走共用绑定函数（能力会被复位为关闭）
function bindNonFlow(box) {
  const draft = { mode: 'all', items: [leaf()] };
  api.setCondDraftContext(draft, box || 'condItemsTest', '', null, null);
  api.openCondMetricPanel('0', anchor());
  api.pickCondRange('total'); // 进入指标列表，便于断言 list 内容
  return draft;
}

// 动作流入口：真实走 openFlowModal -> bindFlowCond
function flowDraft() {
  api.openFlowModal();
  api.addCondItem('');
  api.openCondMetricPanel('0', anchor());
}

function commitOf(path) {
  return api.condNodeAt(path || '0');
}

describe('cycle.js：实体主体与指标文案', () => {
  it('项目/杂事主体短语；找不到时给出「已不存在」', () => {
    api.resetState({
      affairs: [{ id: 'a1', name: '装修' }],
      chores: [{ id: 'c1', name: '倒垃圾' }],
    });
    expect(api.condScopePhrase({ targetType: 'entity', target: 'affair:a1' })).toBe('项目「装修」');
    expect(api.condScopePhrase({ targetType: 'entity', target: 'chore:c1' })).toBe('杂事「倒垃圾」');
    expect(api.condScopePhrase({ targetType: 'entity', target: 'affair:gone' })).toBe('项目「gone」已不存在');
    expect(api.condScopePhrase({ targetType: 'entity', target: 'chore:gone' })).toBe('杂事「gone」已不存在');
    expect(api.condScopePhrase({ targetType: 'entity', target: '' })).toBe('（未选择事项）');
  });

  it('9 个实体指标都有展示名；entity 下用短名避免与主体重复', () => {
    expect(api.metricNameLabel({ metric: 'affair_cell', targetType: 'all' })).toBe('项目当前格数');
    expect(api.metricNameLabel({ metric: 'chore_overdue_days', targetType: 'all' })).toBe('杂事超期天数');
    expect(api.metricNameLabel({ metric: 'chore_cycle_due_in', targetType: 'all' })).toBe('杂事距下次到期天数');
    expect(api.metricNameLabel({ metric: 'affair_cell', targetType: 'entity' })).toBe('当前格数');
    expect(api.metricNameLabel({ metric: 'affair_steps', targetType: 'entity' })).toBe('推进步数');
    expect(api.metricNameLabel({ metric: 'affair_stall', targetType: 'entity' })).toBe('停滞天数');
    expect(api.metricNameLabel({ metric: 'affair_progress', targetType: 'entity' })).toBe('进度值');
    expect(api.metricNameLabel({ metric: 'affair_completed', targetType: 'entity' })).toBe('完成数');
    expect(api.metricNameLabel({ metric: 'chore_completed', targetType: 'entity' })).toBe('完成数');
    expect(api.metricNameLabel({ metric: 'chore_idle', targetType: 'entity' })).toBe('不活跃天数');
    expect(api.metricNameLabel({ metric: 'chore_overdue_days', targetType: 'entity' })).toBe('超期天数');
    expect(api.metricNameLabel({ metric: 'chore_cycle_due_in', targetType: 'entity' })).toBe('距下次到期天数');
    // 非 entity 目标保持原展示名
    expect(api.metricNameLabel({ metric: 'affair_steps', targetType: 'all' })).toBe('项目推进步数');
  });

  it('条件标签把主体与指标拼成「项目「X」·当前格数」', () => {
    api.resetState({ affairs: [{ id: 'a1', name: '装修' }] });
    const label = api.condItemLabel(leaf({
      range: 'today', metric: 'affair_cell', targetType: 'entity', target: 'affair:a1', value: 5,
    }));
    expect(label).toBe('项目「装修」·当前格数 ≥ 5');
  });
});

describe('condTargetTypesFor：entity 只对 9 个实体指标开放', () => {
  const nine = [
    'affair_cell', 'affair_steps', 'affair_stall', 'affair_progress', 'affair_completed',
    'chore_completed', 'chore_overdue_days', 'chore_idle', 'chore_cycle_due_in',
  ];

  it('允许时 9 个指标都包含 entity', () => {
    nine.forEach(m => expect(api.condTargetTypesFor(m, true)).toContain('entity'));
  });

  it('实体专属指标只返回 entity；能力关闭时没有候选主体', () => {
    ['affair_cell', 'chore_overdue_days', 'chore_cycle_due_in'].forEach(m => {
      expect(api.condTargetTypesFor(m, true)).toEqual(['entity']);
      expect(api.condTargetTypesFor(m)).toEqual([]);
    });
  });

  it('共享指标追加 entity，不牺牲既有聚合主体', () => {
    expect(api.condTargetTypesFor('affair_steps', true)).toEqual(['all', 'domain', 'entity']);
    expect(api.condTargetTypesFor('chore_completed', true)).toEqual(['all', 'entity']);
    expect(api.condTargetTypesFor('affair_steps')).toEqual(['all', 'domain']);
    expect(api.condTargetTypesFor('chore_completed')).toEqual(['all']);
  });
});

describe('B6 直达判据：只有候选集恰为 [all] 才直达', () => {
  it('候选集只有一个非 all 目标时不直达（entity 专属指标）', () => {
    flowDraft();
    api.pickCondMetric('affair_cell');
    // 未提交成 all，进入实体两步选择
    expect(commitOf().metric).toBe('checkins');
    expect(commitOf().targetType).toBe('all');
    expect(panelHTML()).toContain('选择事项类型');
  });

  it('单主体 milestone 也不直达，仍先选具体里程碑', () => {
    flowDraft();
    api.pickCondMetric('milestone_unlocked');
    expect(commitOf().metric).toBe('checkins');
    expect(panelHTML()).toContain('选择里程碑');
  });

  it('候选集恰为 [all] 的指标仍然一步直达', () => {
    flowDraft();
    api.pickCondMetric('achievement');
    expect(commitOf()).toMatchObject({ metric: 'achievement', targetType: 'all' });
  });
});

describe('既有单主体目标行为不变（task / milestone / budget / asset）', () => {
  it('task：任务不活跃 -> 按任务 -> 选具体任务', () => {
    flowDraft();
    api.pickCondMetric('task_idle');
    expect(panelHTML()).toContain('统计主体');
    api.pickCondTargetType('task');
    expect(panelHTML()).toContain('选择任务');
    api.pickCondTask('t1');
    expect(commitOf()).toMatchObject({ metric: 'task_idle', targetType: 'task', target: 't1' });
  });

  it('milestone：直接进入里程碑列表并提交', () => {
    flowDraft();
    api.pickCondMetric('milestone_unlocked');
    api.pickCondMilestone('m1');
    expect(commitOf()).toMatchObject({ metric: 'milestone_unlocked', targetType: 'milestone', target: 'm1' });
  });

  it('budget：直接进入预算分类列表并提交', () => {
    flowDraft();
    api.pickCondMetric('budget_remaining');
    api.pickCondBudgetCat('c1');
    expect(commitOf()).toMatchObject({ metric: 'budget_remaining', targetType: 'budget', target: 'c1' });
  });

  it('asset：直接进入资产列表并提交', () => {
    flowDraft();
    api.pickCondMetric('asset_issued');
    expect(panelHTML()).toContain('选择资产');
    api.pickCondAsset('star');
    expect(commitOf()).toMatchObject({ metric: 'asset_issued', targetType: 'asset', target: 'star' });
  });
});

describe('实体候选集：默认排除已归档', () => {
  it('项目列表只出现未归档项目', () => {
    api.resetState({
      affairs: [
        { id: 'a1', name: '在办项目' },
        { id: 'a2', name: '归档项目', archived: true },
      ],
    });
    flowDraft();
    api.pickCondMetric('affair_cell');
    api.pickCondEntityKind('affair');
    expect(api.condEntityCandidates('affair').map(x => x.id)).toEqual(['a1']);
    expect(panelHTML()).toContain('只列出未归档的项目');
  });

  it('杂事列表只出现未归档杂事', () => {
    api.resetState({
      chores: [
        { id: 'c1', name: '在办杂事' },
        { id: 'c2', name: '归档杂事', archived: true },
      ],
    });
    flowDraft();
    // chore_idle 是共享指标：先选「按单个事项」再进杂事列表
    api.pickCondMetric('chore_idle');
    api.pickCondTargetType('entity');
    expect(panelHTML()).toContain('选择事项类型');
    api.pickCondEntityKind('chore');
    expect(api.condEntityCandidates('chore').map(x => x.id)).toEqual(['c1']);
    expect(panelHTML()).toContain('只列出未归档的杂事');
  });

  it('选完实体后提交 kind:id 且 newFilter/aggregate 归一', () => {
    api.resetState({ affairs: [{ id: 'a1', name: '装修' }] });
    flowDraft();
    api.pickCondMetric('affair_steps');
    api.pickCondTargetType('entity');
    api.pickCondEntityKind('affair');
    api.pickCondEntity('affair:a1');
    expect(commitOf()).toMatchObject({
      metric: 'affair_steps', targetType: 'entity', target: 'affair:a1',
      newFilter: 'none', aggregate: 'sum',
    });
  });
});

describe('入口能力隔离：entity 只在动作流条件里可选', () => {
  it('共用绑定函数复位能力；预算 / 门槛面板不出现实体', () => {
    api.setCondEntityAllowed(true);
    bindNonFlow('budCondItems');
    expect(api.isCondEntityAllowed()).toBe(false);
    // 实体专属指标不出现在指标列表
    expect(panelHTML()).not.toContain('项目当前格数');
    // 共享指标也没有「按单个事项」主体
    api.pickCondMetric('affair_completed');
    expect(panelHTML()).not.toContain('按单个事项');
    expect(api.condTargetTypesFor('affair_completed')).not.toContain('entity');
  });

  it('商品 / 里程碑门槛同样拿不到 entity', () => {
    bindNonFlow('prodGateCondItems');
    expect(panelHTML()).not.toContain('项目当前格数');
    api.pickCondMetric('affair_completed');
    expect(panelHTML()).not.toContain('按单个事项');
  });

  it('动作流入口显式打开后才出现 entity', () => {
    api.openFlowModal();
    expect(api.isCondEntityAllowed()).toBe(true);
    api.addCondItem('');
    api.openCondMetricPanel('0', anchor());
    api.pickCondRange('total');
    expect(panelHTML()).toContain('项目当前格数');
    api.pickCondMetric('affair_completed');
    expect(panelHTML()).toContain('按单个事项');
  });
});
