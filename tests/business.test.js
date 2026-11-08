// 业务纯函数：打卡/跳过/杂事/项目/归一化/阶段奖励。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
const todayStart = () => api.dayStartTs(Date.now());
const daysAgo = n => todayStart() - n * DAY;

const baseTask = extra => Object.assign({
  id: 't1', name: '任务', initialValue: 10, interestRate: 10, debtRate: 20,
  pendingDebt: 0, streak: 0, lastCheckIn: null, checkInCount: 0, totalEarned: 0,
}, extra || {});

describe('calcCheckIn：打卡结算', () => {
  it('首次打卡：连胜 1，无利息，无债务', () => {
    const c = api.calcCheckIn(baseTask());
    expect(c).toMatchObject({ isFirst: true, gapDays: 0, newStreak: 1, broken: false, bonus: 0, gross: 10, debt: 0, net: 10 });
  });

  it('昨天打过：连胜 +1，利息按 (连胜-1) 计', () => {
    const c = api.calcCheckIn(baseTask({ lastCheckIn: daysAgo(1) + 12 * 3600e3, streak: 3 }));
    expect(c).toMatchObject({ isFirst: false, gapDays: 1, newStreak: 4, broken: false });
    expect(c.bonus).toBeCloseTo(3, 10); // 10 × 10% × 3
    expect(c.net).toBeCloseTo(13, 10);
  });

  it('同一天再算（守卫外的纯计算）：连胜不变，利息按当前连胜', () => {
    const c = api.calcCheckIn(baseTask({ lastCheckIn: Date.now(), streak: 3 }));
    expect(c.gapDays).toBe(0);
    expect(c.newStreak).toBe(3);
    expect(c.bonus).toBeCloseTo(2, 10); // 10 × 10% × (3-1)
  });

  it('断更 ≥2 天：连胜重置为 1，记录 broken', () => {
    const c = api.calcCheckIn(baseTask({ lastCheckIn: daysAgo(3), streak: 7 }));
    expect(c).toMatchObject({ gapDays: 3, newStreak: 1, broken: true, bonus: 0, gross: 10 });
  });

  it('待扣债从本次收益里全额抵扣，净额允许为负', () => {
    const c = api.calcCheckIn(baseTask({ pendingDebt: 13 }));
    expect(c.net).toBeCloseTo(-3, 10);
    expect(c.debt).toBe(13);
  });

  it('有豁免记录时按 lastExempt 计算间隔', () => {
    const c = api.calcCheckIn(baseTask({ lastCheckIn: daysAgo(3), lastExempt: daysAgo(1) + 3600e3, streak: 2 }));
    expect(c.gapDays).toBe(1);
    expect(c.newStreak).toBe(3);
  });
});

describe('calcSkip：今天不打会发生什么', () => {
  it('从未打卡：不产生债务', () => {
    expect(api.calcSkip(baseTask())).toMatchObject({ debt: 0, gapAfterSkip: 1 });
  });

  it('昨天打过：明日进入债务期，加一天日债', () => {
    const r = api.calcSkip(baseTask({ lastCheckIn: daysAgo(1), debtRate: 20 }));
    expect(r.debt).toBeCloseTo(2, 10);
    expect(r.gapAfterSkip).toBe(2);
  });

  it('已经在债务期：继续累加', () => {
    const r = api.calcSkip(baseTask({ lastCheckIn: daysAgo(3), debtRate: 20, pendingDebt: 4 }));
    expect(r.debt).toBeCloseTo(2, 10);
    expect(r.gapAfterSkip).toBe(4);
    expect(r.desc).toContain('累计6');
  });

  it('debtRate=0 时不计债', () => {
    expect(api.calcSkip(baseTask({ lastCheckIn: daysAgo(1), debtRate: 0 }))).toMatchObject({ debt: 0, gapAfterSkip: 2 });
  });
});

describe('choreOverdueDays：杂事超期', () => {
  const base = at => ({ id: 'c1', name: '倒垃圾', done: false, createdAt: at, plannedAt: null, freshDays: 0 });

  it('保鲜期当天不算超期，次日起计', () => {
    const created = daysAgo(3) + 10 * 3600e3;
    expect(api.choreOverdueDays(base(created), Date.now())).toBe(3);
    const withFresh2 = Object.assign(base(created), { freshDays: 2 });
    expect(api.choreOverdueDays(withFresh2, Date.now())).toBe(1);
  });

  it('计划时间优先于创建时间', () => {
    const c = { createdAt: daysAgo(10), plannedAt: daysAgo(1), freshDays: 0, done: false };
    expect(api.choreOverdueDays(c, Date.now())).toBe(1);
  });

  it('已完成的杂事不算超期', () => {
    expect(api.choreOverdueDays({ createdAt: daysAgo(30), done: true }, Date.now())).toBe(0);
  });

  it('按自然日取整，不受当天几点影响', () => {
    const c = { createdAt: daysAgo(2) + 3600e3, done: false, freshDays: 0 };
    expect(api.choreOverdueDays(c, Date.now())).toBe(2);
  });
});

describe('杂事腐化档位', () => {
  it('档位边界：≤3 用第一档，≤7 用第二档，其余第三档', () => {
    const cfg = api.defaultChoreConfig();
    expect(api.choreTierRate(0, cfg)).toBe(0);
    expect(api.choreTierRate(3, cfg)).toBe(0.2);
    expect(api.choreTierRate(4, cfg)).toBe(1);
    expect(api.choreTierRate(7, cfg)).toBe(1);
    expect(api.choreTierRate(8, cfg)).toBe(3);
  });

  it('日腐化 = 超期件数 × 档位系数', () => {
    expect(api.choreDailyDecay(4, api.defaultChoreConfig())).toBe(4);
    expect(api.choreDailyDecay(8, api.defaultChoreConfig())).toBe(24);
    expect(api.choreDailyDecay(0, api.defaultChoreConfig())).toBe(0);
  });

  it('normalizeChoreConfig 修正非法值，并保证第二档下限大于第一档', () => {
    const c = api.normalizeChoreConfig({ freshDays: -5, batchN: 0, tier1Max: 5, tier2Max: 2, tier1Rate: -1 });
    expect(c.freshDays).toBe(0); // 负数被夹到下限 0
    expect(c.batchN).toBe(1);
    expect(c.tier1Rate).toBe(0);
    expect(c.tier2Max).toBeGreaterThan(c.tier1Max);
  });
});

describe('项目奖励曲线', () => {
  it('affairTargetAt 按累计比例换算奖励，格 9 为 100%', () => {
    const a = { totalReward: 100, currentCell: 0 };
    expect(api.affairTargetAt(a, 0)).toBe(10);
    expect(api.affairTargetAt(a, 4)).toBe(50);
    expect(api.affairTargetAt(a, 9)).toBe(100);
  });

  it('自定义曲线生效，非法曲线回落到平均曲线', () => {
    const late = { totalReward: 100, curve: { type: 'lateHeavy', values: api.AFFAIR_CURVES.lateHeavy } };
    expect(api.affairTargetAt(late, 0)).toBe(2);
    const broken = { totalReward: 100, curve: { type: 'custom', values: [1, 2, 3] } };
    expect(api.affairTargetAt(broken, 0)).toBe(10);
  });

  it('小额奖励保留两位小数', () => {
    expect(api.affairTargetAt({ totalReward: 0.1 }, 0)).toBe(0.01);
  });

  it('affairLastAdvance 取开始时间与所有步骤完成时间的最大值', () => {
    const a = { startedAt: 100, steps: [{ text: 'a', doneAt: 300 }, { text: 'b', doneAt: 200 }, { text: 'c' }] };
    expect(api.affairLastAdvance(a)).toBe(300);
    expect(api.affairDoneSteps(a)).toBe(2);
    expect(api.affairTotalSteps(a)).toBe(3);
  });

  it('affairIsDone 由 doneAt 或推进到格 9 决定', () => {
    expect(api.affairIsDone({ currentCell: 9 })).toBe(true);
    expect(api.affairIsDone({ currentCell: 5 })).toBe(false);
    expect(api.affairIsDone({ currentCell: 5, doneAt: 1 })).toBe(true);
  });
});

describe('阶段奖励档位', () => {
  const t = { stageRewards: { v: [10, 20, 30, 40, 50], p: [1, 2, 3, 4, 5], last: 0 } };

  it('stageValueAt：整数格取档位值，半格取相邻均值，9 格外推半档', () => {
    expect(api.stageValueAt(t, 'vitality', 0)).toBe(10);
    expect(api.stageValueAt(t, 'vitality', 1)).toBe(15);
    expect(api.stageValueAt(t, 'vitality', 2)).toBe(20);
    expect(api.stageValueAt(t, 'progress', 8)).toBe(5);
    expect(api.stageValueAt(t, 'vitality', 9)).toBe(55);
  });

  it('stageCellLabel 命名', () => {
    expect(api.stageCellLabel(0)).toBe('起步');
    expect(api.stageCellLabel(1)).toBe('起步+');
    expect(api.stageCellLabel(2)).toBe('训练');
    expect(api.stageCellLabel(9)).toBe('超常+');
  });

  it('stageNetAt 扣掉债务但不因债务超过收益而抹平整个收益', () => {
    expect(api.stageNetAt(t, 'vitality', 0, { bonus: 3, debt: 2 })).toBe(11);
    expect(api.stageNetAt(t, 'vitality', 0, { bonus: 0, debt: 99 })).toBe(0);
  });

  it('stageSel 夹回 0..9，非法 stageRewards 视为无档位', () => {
    const sr = last => ({ stageRewards: { v: [1, 2, 3, 4, 5], p: [1, 2, 3, 4, 5], last } });
    expect(api.stageSel(sr(-3))).toBe(0);
    expect(api.stageSel(sr(99))).toBe(9);
    expect(api.stageSel({ stageRewards: { last: 5 } })).toBe(0);
    expect(api.stageSel({})).toBe(0);
  });
});

describe('归一化函数', () => {
  it('normalizeCondItem：非法范围/指标丢弃，days 夹回 1，未知枚举回落默认', () => {
    expect(api.normalizeCondItem({ range: 'nope', metric: 'checkins' })).toBe(null);
    expect(api.normalizeCondItem({ range: 'today', metric: 'nope' })).toBe(null);
    const it = api.normalizeCondItem({
      range: 'recent', metric: 'checkins', op: '>', value: '3', days: 0,
      targetType: 'bogus', target: 't1', newFilter: 'new_task', aggregate: 'any',
    });
    expect(it).toEqual({
      range: 'recent', metric: 'checkins', op: '>', value: 3, days: 7,
      targetType: 'all', target: '', newFilter: 'new_task', aggregate: 'any',
    });
  });

  it('normalizeCondNode：分组递归并过滤空项', () => {
    const node = api.normalizeCondNode({
      group: true, mode: 'any',
      items: [{ range: 'today', metric: 'vitality', op: '>=', value: 1 }, { range: 'bad', metric: 'x' }],
    });
    expect(node.group).toBe(true);
    expect(node.mode).toBe('any');
    expect(node.items).toHaveLength(1);
  });

  it('normalizeRewardItem：结构动作 archive 有独立默认值', () => {
    expect(api.normalizeRewardItem({ type: 'archive', entity: 'nope' })).toEqual({ type: 'archive', entity: 'task', idleDays: 1 });
    expect(api.normalizeRewardItem({ type: 'archive', entity: 'chore', idleDays: '5' })).toEqual({ type: 'archive', entity: 'chore', idleDays: 5 });
    expect(api.normalizeRewardItem({ type: 'vitality', amount: '7.5' })).toEqual({ type: 'vitality', amount: 7.5 });
    // cap 为 0/空时回落到默认上限 3（与奖励项编辑器一致）
    expect(api.normalizeRewardItem({ type: 'card', card: 'exemption', amount: 2, cap: 0 })).toMatchObject({ amount: 2, cap: 3 });
    expect(api.normalizeRewardItem({ type: 'bogus' })).toBe(null);
  });

  it('normalizeTaskNums：字符串转数字，计数不为负，非法时间归空', () => {
    const t = api.normalizeTaskNums({
      initialValue: '12.5', interestRate: '5', debtRate: 'x', vitalityCost: null,
      checkInCount: '-3', streak: '2.6', totalEarned: '8', pendingDebt: '1.5',
      lastCheckIn: '0', archivedAt: 'bad',
    });
    expect(t.initialValue).toBe(12.5);
    expect(t.debtRate).toBe(0);
    expect(t.vitalityCost).toBe(0);
    expect(t.checkInCount).toBe(0);
    expect(t.streak).toBe(3);
    expect(t.totalEarned).toBe(8);
    expect(t.pendingDebt).toBe(1.5);
    expect(t.lastCheckIn).toBe(null);
    expect(t.archivedAt).toBe(null);
  });

  it('normalizeProductGate：夹回范围，清空失效引用，保留条件树', () => {
    const ctx = { domainIds: new Set(['d_default']), achIds: new Set(['a1']) };
    const g = api.normalizeProductGate({
      minLifetime: -3,
      activity: { domainId: 'd_missing', days: 999, times: '2' },
      milestoneId: 'a_missing',
      condition: { mode: 'any', items: [{ range: 'total', metric: 'checkins', op: '>=', value: 1 }] },
    }, ctx);
    expect(g.minLifetime).toBe(0);
    expect(g.activity).toEqual({ domainId: '', days: 90, times: 2 });
    expect(g.milestoneId).toBe('');
    expect(g.condition.mode).toBe('any');
    expect(g.condition.items).toHaveLength(1);
  });

  it('normalizeActivity：缺省字段补齐，禁用的活动保持禁用', () => {
    const a = api.normalizeActivity({ name: '', enabled: false });
    expect(a.name).toBe('未命名活动');
    expect(a.enabled).toBe(false);
    expect(a.period).toBe('week');
  });
});
