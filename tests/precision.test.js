// 精度口径统一：核心计算（打卡、债务累积、复利）统一保留两位，且阶段预览与实际结算共用同一口径。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
const todayStart = () => api.dayStartTs(Date.now());
const daysAgo = n => todayStart() - n * DAY;
const twoDecimals = v => String(v).match(/^-?\d+(\.\d{1,2})?$/) !== null;

const baseTask = extra => Object.assign({
  id: 't1', name: '任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
  initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
  pendingDebt: 0, streak: 0, lastCheckIn: null, checkInCount: 0, totalEarned: 0, archived: false,
}, extra || {});

describe('打卡与债务：统一两位', () => {
  it('非整分利息：bonus/gross/net 都按两位取整', () => {
    const c = api.calcCheckIn(baseTask({ interestRate: 3.333, streak: 1, lastCheckIn: daysAgo(1) }));
    expect(c.bonus).toBe(0.33); // 10 × 3.333% × 1 = 0.333 → 0.33
    expect(c.gross).toBe(10.33);
    expect(c.net).toBe(10.33);
    expect(twoDecimals(c.bonus) && twoDecimals(c.gross) && twoDecimals(c.net)).toBe(true);
  });

  it('待扣债参与净额时同样先归到两位', () => {
    const c = api.calcCheckIn(baseTask({ pendingDebt: 0.127 }));
    expect(c.debt).toBe(0.13);
    expect(c.net).toBe(9.87);
  });

  it('跳过打卡的日债务与累计债务统一两位', () => {
    const r = api.calcSkip(baseTask({ initialValue: 10, debtRate: 3.333, pendingDebt: 1, lastCheckIn: daysAgo(2) }));
    expect(r.debt).toBe(0.33); // 10 × 3.333% = 0.333
    expect(r.desc).toBe('已断更1天，明日待扣债+0.33 (累计1.33)');
  });
});

describe('阶段预览 == 实际结算', () => {
  it('带利息与阶段档位时，预览净额与实际入账逐分一致', () => {
    const task = baseTask({
      streak: 1, lastCheckIn: daysAgo(1), checkInCount: 1, totalEarned: 10,
      interestRate: 3.333,
      stageRewards: { v: [12.3, 13, 14, 15, 16], p: [], last: 0 },
    });
    api.resetState({ tasks: [task] });
    const live = api.getLive().tasks[0];
    const cell = 3;
    const preview = api.stageNetAt(live, 'vitality', cell, api.calcCheckIn(live));
    expect(preview).toBe(13.83); // (13+14)/2 + 0.33

    const before = api.getState().scores.vitality;
    api.checkIn('t1', cell);
    const after = api.getState().scores.vitality;
    expect(after - before).toBe(preview);
  });
});

describe('重算历史：与 calcCheckIn 同一公式', () => {
  it('连胜第 2 天的复算金额沿用两位，不出现 10.333 尾巴', () => {
    const logs = [
      { id: 'l1', time: daysAgo(2) + 3600e3, st: 'vitality', amt: 10, src: 'checkin', taskId: 't1', dom: 'd_default' },
      { id: 'l2', time: daysAgo(1) + 3600e3, st: 'vitality', amt: 10, src: 'checkin', taskId: 't1', dom: 'd_default' },
    ];
    api.resetState({
      logs,
      scores: { vitality: 20, progress: {}, achievement: 0 },
      tasks: [baseTask({ streak: 2, lastCheckIn: daysAgo(1) + 3600e3, checkInCount: 2, totalEarned: 20, interestRate: 3.333 })],
    });

    api.recalcTaskHistory(api.getLive().tasks[0], {
      name: '任务', initialValue: 10, interestRate: 3.333, debtRate: 0, vitalityCost: 0,
      domainIds: ['d_default'], scoreTypes: ['vitality'],
    });

    const s = api.getState();
    expect(s.logs.find(l => l.id === 'l2').amt).toBe(10.33);
    expect(s.tasks[0].totalEarned).toBe(20.33);
    expect(s.scores.vitality).toBe(20.33);
  });
});

describe('复利：本金恒为两位', () => {
  it('多次幂计息后余额仍是两位小数', () => {
    api.resetState({ loans: [{ id: 'l1', name: '贷款', amount: 100.005, debtRate: 10 }] });
    api.Ledger.txn(() => api.Ledger.liability.mutate('l1', before => before * Math.pow(1.1, 7), { src: 'test' }));
    const l = api.getState().loans[0];
    expect(l.amount).toBeGreaterThan(0);
    expect(twoDecimals(l.amount)).toBe(true);
  });
});
