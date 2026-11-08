// 条件求值：evalNode / evalCondItem / 指标取值 / 商品门槛翻译。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
// 固定在“今天 23:59:59.999”：测试期间新建的流水（time=now）一定落在窗口内，
// 同时日期窗口仍是今天，避免跑到午夜附近时出现假失败。
const T = api.dayStartTs(Date.now() + DAY) - 1;
const week = { period: 'week', anchor: 1 };
const item = (over) => Object.assign({ range: 'total', metric: 'checkins', op: '>=', value: 0, targetType: 'all', target: '', newFilter: 'none', aggregate: 'sum' }, over);
const leafPass = item({ value: 0 });
const leafFail = item({ value: 999 });

describe('evalNode：条件树组合', () => {
  it('空组恒为真', () => {
    expect(api.evalNode({ group: true, mode: 'all', items: [] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'any', items: [] }, week, T)).toBe(true);
  });

  it('all / any 语义', () => {
    expect(api.evalNode({ group: true, mode: 'all', items: [leafPass, leafPass] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'all', items: [leafPass, leafFail] }, week, T)).toBe(false);
    expect(api.evalNode({ group: true, mode: 'any', items: [leafPass, leafFail] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'any', items: [leafFail, leafFail] }, week, T)).toBe(false);
  });

  it('嵌套组按层求值', () => {
    const node = {
      group: true, mode: 'any', items: [
        { group: true, mode: 'all', items: [leafFail, leafPass] },
        leafPass,
      ],
    };
    expect(api.evalNode(node, week, T)).toBe(true);
  });

  it('未知 mode 回落 all', () => {
    expect(api.evalNode({ group: true, mode: 'weird', items: [leafPass, leafFail] }, week, T)).toBe(false);
  });
});

describe('opSatisfied：比较符', () => {
  it('默认按 >= 处理未知比较符', () => {
    expect(api.opSatisfied(3, '>', 2)).toBe(true);
    expect(api.opSatisfied(2, '>', 2)).toBe(false);
    expect(api.opSatisfied(2, '<', 3)).toBe(true);
    expect(api.opSatisfied(3, '<=', 3)).toBe(true);
    expect(api.opSatisfied(3, '>=', 3)).toBe(true);
    expect(api.opSatisfied(3, 'bogus', 3)).toBe(true);
  });
});

describe('evalCondItem：累计与窗口', () => {
  it('累计打卡次数 = 各任务 checkInCount 之和', () => {
    api.resetState({ tasks: [{ id: 't1', checkInCount: 2 }, { id: 't2', checkInCount: 3 }] });
    expect(api.evalCondItem(item({ metric: 'checkins', value: 5 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ metric: 'checkins', value: 6 }), week, T)).toBe(false);
  });

  it('今日/最近 N 天读统计日桶', () => {
    api.resetState();
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test' } });
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', value: 10 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', value: 11 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'vitality', value: 10 }), week, T)).toBe(true);
  });

  it('主体筛选：按任务与按领域', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
      tasks: [{ id: 't1', name: '任务一', domainIds: ['d2'] }],
    });
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 6, reason: { src: 'test', taskId: 't1' } });
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'task', target: 't1', value: 6 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'task', target: 't1', value: 7 }), week, T)).toBe(false);
    // 流水没有 dom 时按任务领域归属 d2
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'domain', target: 'd2', value: 6 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'domain', target: 'd_default', value: 1 }), week, T)).toBe(false);
  });

  it('aggreggate=any：任一实体满足即可', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
      tasks: [
        { id: 't1', name: 'a', domainIds: ['d_default'] },
        { id: 't2', name: 'b', domainIds: ['d2'] },
      ],
    });
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 5, reason: { src: 'test', taskId: 't2' } });
    const base = { range: 'today', metric: 'vitality', targetType: 'task', aggregate: 'any', value: 5 };
    // 未指定 target 时“任一任务”仍成立（t2 今天 +5）
    expect(api.evalCondItem(item(Object.assign({}, base, { target: '' })), week, T)).toBe(true);
    expect(api.evalCondItem(item(Object.assign({}, base, { target: 't2' })), week, T)).toBe(true);
    expect(api.evalCondItem(item(Object.assign({}, base, { target: 't1' })), week, T)).toBe(false);
  });

  it('新增任务 / 新增领域按 createdAt 计窗口', () => {
    api.resetState({
      tasks: [{ id: 't1', createdAt: T - DAY }, { id: 't0', createdAt: T - 30 * DAY }],
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二', createdAt: T - DAY }],
    });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_tasks', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_tasks', value: 2 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_domains', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_domains', value: 2 }), week, T)).toBe(false);
  });
});

describe('evalCondItem：预算指标走 BudgetEngine 注入的上下文', () => {
  const act = { period: 'week', anchor: 1, budgetCtx: { entryAmount: 30, spent: 120, overspend: 20, entryCount: 3 } };
  it('四个预算指标只读上下文', () => {
    const q = (metric, value) => api.evalCondItem(item({ range: 'period', metric, value }), act, T);
    expect(q('budget_entry_amount', 30)).toBe(true);
    expect(q('budget_entry_amount', 31)).toBe(false);
    expect(q('budget_period_spent', 120)).toBe(true);
    expect(q('budget_period_overspend', 20)).toBe(true);
    expect(q('budget_entry_count', 3)).toBe(true);
  });

  it('没有上下文时预算指标按 0 处理', () => {
    expect(api.evalCondItem(item({ range: 'period', metric: 'budget_entry_amount', value: 1 }), week, T)).toBe(false);
  });
});

describe('evalCondItem：阶段 1 指标（项目 / 杂事 / 不活跃）', () => {
  it('task_idle 取未归档任务的最大不活跃天数', () => {
    api.resetState({
      tasks: [
        { id: 't1', lastCheckIn: T - 20 * DAY },
        { id: 't2', lastCheckIn: T - 3 * DAY },
        { id: 't3', lastCheckIn: T - 50 * DAY, archived: true },
      ],
    });
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', value: 20 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', value: 21 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', targetType: 'task', target: 't2', value: 3 }), week, T)).toBe(true);
  });

  it('chore_overdue 数未完成且超期的杂事', () => {
    api.resetState({
      chores: [
        { id: 'c1', done: false, createdAt: T - 10 * DAY, freshDays: 0 },
        { id: 'c2', done: true, createdAt: T - 10 * DAY, freshDays: 0 },
        { id: 'c3', done: false, createdAt: T - DAY, freshDays: 7 },
      ],
    });
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_overdue', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_overdue', value: 2 }), week, T)).toBe(false);
  });

  it('affair_completed / affair_steps 窗口统计', () => {
    api.resetState({
      affairs: [
        { id: 'a1', doneAt: T - 3600e3, steps: [{ text: 'x', doneAt: T - 3600e3 }, { text: 'y' }] },
        { id: 'a2', doneAt: T - 30 * DAY, steps: [] },
      ],
    });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_completed', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_completed', value: 2 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_completed', value: 2 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_steps', value: 1 }), week, T)).toBe(true);
  });

  it('chore_completed / chore_decay / chore_batches', () => {
    api.resetState({
      chores: [{ id: 'c1', done: true, doneAt: T - 3600e3 }, { id: 'c2', done: true, doneAt: T - 20 * DAY }],
    });
    api.Ledger.event('杂事腐化', 'chore-decay', { amt: -5 });
    api.Ledger.event('批量结算', 'chore-batch', { amt: 0 });
    api.Ledger.event('批量结算', 'chore-batch', { amt: 0 });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_completed', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'total', metric: 'chore_completed', value: 2 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_decay', value: 5 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_batches', value: 2 }), week, T)).toBe(true);
  });

  it('affair_progress 累计口径读实体字段（不受日志截断影响）', () => {
    api.resetState({
      affairs: [
        { id: 'a1', domainId: 'd_default', alreadyGiven: 12 },
        { id: 'a2', domainId: 'd_default', alreadyGiven: 8 },
      ],
    });
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_progress', value: 20 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_progress', value: 21 }), week, T)).toBe(false);
  });
});

describe('商品门槛：三段式兼容层', () => {
  it('日常级永远可买', () => {
    expect(api.evaluateProductGate({ tier: 'daily', gate: { minLifetime: 999 } })).toMatchObject({ ok: true, deny: false, tier: 'daily' });
  });

  it('品质级把 minLifetime 与领域活跃度翻译成两条叶子', () => {
    const gate = { minLifetime: 5, activity: { domainId: 'd_default', days: 7, times: 3 } };
    const cond = api.gateConditionOf(gate, 'quality');
    expect(cond.items).toHaveLength(2);
    expect(cond.items[0]).toMatchObject({ metric: 'lifetime_achievement', op: '>=', value: 5, range: 'total' });
    expect(cond.items[1]).toMatchObject({ metric: 'domain_activity', value: 3, days: 7, targetType: 'domain', target: 'd_default', range: 'recent' });
  });

  it('专属级即使没绑里程碑也保留一条必失败叶子', () => {
    const cond = api.gateConditionOf({ milestoneId: '' }, 'exclusive');
    expect(cond.items).toHaveLength(1);
    expect(cond.items[0]).toMatchObject({ metric: 'milestone_unlocked', target: '' });
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: {} }).deny).toBe(true);
  });

  it('条件树存在时优先于三段式字段', () => {
    const gate = {
      minLifetime: 999,
      condition: { mode: 'all', items: [{ range: 'total', metric: 'checkins', op: '>=', value: 0 }] },
    };
    expect(api.evaluateProductGate({ tier: 'quality', gate }).ok).toBe(true);
  });

  it('里程碑已解锁时可购买；引用不存在的里程碑则拒绝', () => {
    api.resetState({ achievements: [{ id: 'a1', name: '里程碑', unlocked: true, threshold: 0, points: 1 }] });
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: { milestoneId: 'a1' } }).ok).toBe(true);
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: { milestoneId: 'nope' } }).deny).toBe(true);
  });

  it('领域活跃度读活跃度索引，不受日志截断影响', () => {
    api.resetState();
    api.noteCheckinActivity(['d_default'], 1, T);
    const gate = { activity: { domainId: 'd_default', days: 7, times: 1 } };
    expect(api.evaluateProductGate({ tier: 'quality', gate }).ok).toBe(true);
    const need3 = { activity: { domainId: 'd_default', days: 7, times: 3 } };
    const r = api.evaluateProductGate({ tier: 'quality', gate: need3 });
    expect(r.deny).toBe(true);
    expect(r.reasons.join('')).toContain('领域');
  });

  it('any 组整体失败时合并成一条原因', () => {
    api.resetState();
    const gate = {
      condition: {
        mode: 'any',
        items: [
          { range: 'total', metric: 'checkins', op: '>=', value: 5 },
          { range: 'total', metric: 'achievement', op: '>=', value: 5 },
        ],
      },
    };
    const r = api.evaluateProductGate({ tier: 'quality', gate });
    expect(r.deny).toBe(true);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('满足任一');
  });
});

describe('门槛点态指标', () => {
  it('lifetime_achievement 读单调累计字段', () => {
    api.resetState();
    api.patchState(s => { s.ext.stats.lifetimeAchievementEarned = 42; });
    expect(api.pointMetricValue('lifetime_achievement', { targetType: 'all' }, T)).toBe(42);
  });

  it('checkin_streak 取未归档任务最大连胜', () => {
    api.resetState({
      tasks: [
        { id: 't1', streak: 4 },
        { id: 't2', streak: 9 },
        { id: 't3', streak: 99, archived: true },
      ],
    });
    expect(api.pointMetricValue('checkin_streak', { targetType: 'all' }, T)).toBe(9);
  });
});
