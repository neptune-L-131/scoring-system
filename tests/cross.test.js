// 跨域逻辑：打卡回放、历史重算、统计重建、流水聚合、结构归档、周期活性。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
const opts = { save: 'none', render: false };

describe('applyCheckinGain：按分配明细精确反向', () => {
  it('多领域 both 型打卡 +1 / -1 后余额完全归零', () => {
    api.resetState({ domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }] });
    const log = {
      st: 'both', amtV: 10, amtP: 7,
      splits: [{ dom: 'd_default', amt: 4 }, { dom: 'd2', amt: 3 }],
      taskId: 't1', dom: 'd_default,d2',
    };
    api.applyCheckinGain(log, 1);
    let s = api.getState();
    expect(s.scores.vitality).toBe(10);
    expect(s.scores.progress).toEqual({ d_default: 4, d2: 3 });

    api.applyCheckinGain(log, -1);
    s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.scores.progress).toEqual({ d_default: 0, d2: 0 });
    expect(s.logs).toHaveLength(0);
    expect(s.ext.stats.invisible.vitality).toBe(0);
    expect(Object.values(s.ext.stats.invisible.progress).every(v => v === 0)).toBe(true);
  });

  it('没有 splits 的旧流水回退到领域均分，仍按分守恒', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }, { id: 'd3', name: '三' }],
      tasks: [{ id: 't1', name: '任务', domainIds: ['d_default', 'd2', 'd3'] }],
    });
    api.applyCheckinGain({ st: 'progress', amt: 10, taskId: 't1' }, 1);
    const s = api.getState();
    expect(s.scores.progress).toEqual({ d_default: 3.34, d2: 3.33, d3: 3.33 });
  });
});

describe('recalcTaskHistory：改参数后重放历史打卡', () => {
  const task = {
    id: 't1', name: '读英语', domainIds: ['d_default'], scoreTypes: ['vitality'],
    initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
    checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
  };

  it('初始值 10 → 20：余额、流水、任务累计同步到新值，且对账无残影', () => {
    api.resetState({ tasks: [task] });
    api.checkIn('t1');
    let s = api.getState();
    expect(s.scores.vitality).toBe(10);
    expect(s.logs[0].amt).toBe(10);

    const live = api.getLive();
    api.recalcTaskHistory(live.tasks[0], {
      name: '读英语', initialValue: 20, interestRate: 0, debtRate: 0, vitalityCost: 0,
      domainIds: ['d_default'], scoreTypes: ['vitality'],
    });
    s = api.getState();
    expect(s.scores.vitality).toBe(20);
    expect(s.logs[0].amt).toBe(20);
    expect(s.tasks[0].totalEarned).toBe(20);
    expect(s.ext.stats.lifetimeVitalityIn).toBe(20);
    expect(s.ext.stats.invisible.vitality).toBe(0);
    expect(s.ext.stats.evicted.vitality).toBe(0);
  });

  it('改为双领域进度：分摊逐分守恒，统计与流水一致', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }, { id: 'd3', name: '三' }],
      tasks: [Object.assign({}, task, { scoreTypes: ['vitality'] })],
    });
    api.checkIn('t1');
    const live = api.getLive();
    api.recalcTaskHistory(live.tasks[0], {
      name: '读英语', initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
      domainIds: ['d_default', 'd2', 'd3'], scoreTypes: ['progress'],
    });
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.scores.progress).toEqual({ d_default: 3.34, d2: 3.33, d3: 3.33 });
    expect(s.logs[0].st).toBe('progress');
    expect(Math.round(s.logs[0].splits.reduce((a, x) => a + x.amt, 0) * 100)).toBe(1000);
    expect(s.ext.stats.lifetimeProgressIn).toBe(10);
    expect(s.ext.stats.lifetimeVitalityIn).toBe(0);
  });
});

describe('Ledger.rebuildStats：从流水重建统计', () => {
  it('生命周期/日桶/总次数全部重建，隐形差额由余额残差补齐', () => {
    api.resetState();
    api.Ledger.txn(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'checkin', taskId: '' } });
      api.Ledger.post({ op: 'grant', account: 'achievement', delta: 5, reason: { src: 'reward' } });
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 3, visible: false, reason: { src: 'loan-draw' } });
    }, opts);

    api.patchState(s => {
      s.ext.stats.lifetimeVitalityIn = 999;
      s.ext.stats.lifetimeAchievementIn = 999;
      s.ext.stats.daily = {};
      s.ext.stats.totalCheckins = 0;
    });
    api.Ledger.rebuildStats();
    const s = api.getState();
    expect(s.ext.stats.lifetimeVitalityIn).toBe(10);
    expect(s.ext.stats.lifetimeAchievementIn).toBe(5);
    expect(s.ext.stats.totalCheckins).toBe(1);
    expect(s.ext.stats.invisible.vitality).toBe(3);
    const today = s.ext.stats.daily[api.dayKey(Date.now())];
    expect(today.v).toBe(10);
    expect(today.a).toBe(5);
  });
});

describe('computeEntryAgg：一条流水对统计的贡献', () => {
  it('打卡（both + splits）', () => {
    const agg = api.computeEntryAgg({
      time: Date.now(), st: 'both', amt: 10, amtV: 10, amtP: 6,
      splits: [{ dom: 'd_default', amt: 3 }, { dom: 'd2', amt: 3 }],
      src: 'checkin', dom: '', taskId: 't1',
    });
    expect(agg).toMatchObject({ v: 10, p: 6, a: 0, ck: 1, prod: 10, buy: 0 });
    expect(agg.pd).toEqual({ d_default: 3, d2: 3 });
    expect(agg.pt).toEqual({ t1: 6 });
    expect(agg.vt).toEqual({ t1: 10 });
    expect(agg.ct).toEqual({ t1: 1 });
  });

  it('购买 / 成本 / 成果', () => {
    const buy = api.computeEntryAgg({ time: Date.now(), st: 'vitality', amt: -30, src: 'purchase', dom: '' });
    expect(buy).toMatchObject({ v: -30, buy: 1, cons: 30, inv: 0 });
    const cost = api.computeEntryAgg({ time: Date.now(), st: 'vitality', amt: -5, src: 'cost', dom: '' });
    expect(cost).toMatchObject({ inv: 5, cons: 0 });
    const ach = api.computeEntryAgg({ time: Date.now(), st: 'achievement', amt: 50, src: 'reward', dom: '' });
    expect(ach).toMatchObject({ a: 50, v: 0, p: 0 });
  });
});

describe('archiveIdleEntities：dry-run 与真实归档', () => {
  function seedIdle() {
    api.resetState({
      tasks: [
        { id: 't1', name: '长期没动', lastCheckIn: Date.now() - 20 * DAY, archived: false },
        { id: 't2', name: '昨天打过', lastCheckIn: Date.now() - 1 * DAY, archived: false },
        { id: 't3', name: '从没打过', lastCheckIn: null, archived: false },
      ],
    });
  }

  it('dry-run 只计数，不修改实体、不写流水', () => {
    seedIdle();
    const n = api.archiveIdleEntities('task', 14, Date.now(), '测试活动', true);
    expect(n).toBe(1);
    const s = api.getState();
    expect(s.tasks.every(t => t.archived === false)).toBe(true);
    expect(s.logs).toHaveLength(0);
  });

  it('真实归档只命中超过阈值的实体，并留下可追溯事件', () => {
    seedIdle();
    const n = api.archiveIdleEntities('task', 14, Date.now(), '测试活动', false);
    expect(n).toBe(1);
    const s = api.getState();
    expect(s.tasks.find(t => t.id === 't1').archived).toBe(true);
    expect(s.tasks.find(t => t.id === 't2').archived).toBe(false);
    expect(s.tasks.find(t => t.id === 't3').archived).toBe(false);
    expect(s.logs[0]).toMatchObject({ src: 'archive', taskId: 't1' });
    expect(s.logs[0].desc).toContain('测试活动');
  });

  it('阈值至少为 1 天，避免一次把“今天活跃”的实体也归档', () => {
    api.resetState({ tasks: [{ id: 't1', name: 'a', lastCheckIn: Date.now(), archived: false }] });
    expect(api.archiveIdleEntities('task', 0, Date.now(), 'x', true)).toBe(0);
    expect(api.archiveIdleEntities('task', 0, Date.now(), 'x', false)).toBe(0);
  });

  it('项目按最后推进时间计算，已完成/已归档的不重复处理', () => {
    api.resetState({
      affairs: [
        { id: 'a1', name: '停滞项目', createdAt: Date.now() - 30 * DAY, steps: [{ text: 'x', doneAt: Date.now() - 20 * DAY }] },
        { id: 'a2', name: '活跃项目', createdAt: Date.now() - 30 * DAY, steps: [{ text: 'x', doneAt: Date.now() - 1 * DAY }] },
        { id: 'a3', name: '已完成', createdAt: Date.now() - 30 * DAY, doneAt: Date.now() - 1 * DAY },
        { id: 'a4', name: '已归档', createdAt: Date.now() - 30 * DAY, archived: true },
      ],
    });
    expect(api.archiveIdleEntities('affair', 14, Date.now(), 'x', true)).toBe(1);
    api.archiveIdleEntities('affair', 14, Date.now(), 'x', false);
    const s = api.getState();
    expect(s.affairs.map(a => !!a.archived)).toEqual([true, false, false, true]);
  });
});

describe('processActivities：结构动作与奖励共用事务', () => {
  it('“任务不活跃 14 天 → 归档”可由一条规则表达', () => {
    api.resetState({
      tasks: [{ id: 't1', name: '闲置任务', lastCheckIn: Date.now() - 30 * DAY, archived: false }],
      activities: [{
        id: 'act_archive', name: '自动归档', enabled: true, period: 'week', anchor: 1,
        condition: { mode: 'all', items: [] },
        result: { items: [{ type: 'archive', entity: 'task', idleDays: 14 }] },
        lastRun: null,
      }],
    });
    api.processActivities(true);
    const s = api.getState();
    expect(s.tasks[0].archived).toBe(true);
    expect(s.activities[0].lastRun).toBe(api.periodKey({ period: 'week', anchor: 1 }, Date.now()));
  });

  it('条件不满足时不归档，也不推进 lastRun 以外的东西', () => {
    api.resetState({
      tasks: [{ id: 't1', name: '活跃任务', lastCheckIn: Date.now() - DAY, archived: false }],
      activities: [{
        id: 'act_archive', name: '自动归档', enabled: true, period: 'week', anchor: 1,
        condition: { mode: 'all', items: [{ range: 'recent', days: 7, metric: 'checkins', op: '>=', value: 99 }] },
        result: { items: [{ type: 'archive', entity: 'task', idleDays: 14 }] },
        lastRun: null,
      }],
    });
    api.processActivities(true);
    const s = api.getState();
    expect(s.tasks[0].archived).toBe(false);
  });
});

describe('#debug 自检：不可见操作后仍全部通过', () => {
  it('贷款式隐形入账 + 撤销 + 截断后 checks 全绿', () => {
    api.resetState();
    api.Ledger.txn(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 100, visible: false, reason: { src: 'loan-draw', desc: '放款' } });
      for (let i = 0; i < api.LOG_MAX + 3; i++) {
        api.Ledger.post({ op: 'grant', account: 'vitality', delta: 1, reason: { src: 'test' } });
      }
    }, opts);
    const checks = api.runConsistencyChecks();
    expect(Array.isArray(checks)).toBe(true);
    const bad = checks.filter(c => c.status === 'bad');
    expect(bad.map(c => c.name + ':' + (c.detail || ''))).toEqual([]);
  });
});
