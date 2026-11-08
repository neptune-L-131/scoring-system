// 账务引擎 Ledger：记账、拆分、隐形增减、事务回滚、截断对账、撤销适配器。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const opts = { save: 'none', render: false };
const run = fn => {
  const r = api.Ledger.txn(fn, opts);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r;
};

const sums = s => ({
  visible: s.logs.filter(l => l.st === 'vitality').reduce((a, l) => a + l.amt, 0),
  invisible: s.ext.stats.invisible.vitality,
  evicted: s.ext.stats.evicted.vitality,
});

function checkinTask(extra) {
  return Object.assign({
    id: 't1', name: '读英语', description: '', collectionId: 'c_default',
    domainIds: ['d_default'], scoreTypes: ['vitality'],
    initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
    checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null,
    pendingDebt: 0, archived: false,
  }, extra || {});
}

describe('Ledger.post：可见记账', () => {
  it('发放/消费分别累计收入与支出，流水最新在前', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test', desc: '测试入账' } });
      api.Ledger.spend('vitality', 3, { src: 'cost', desc: '消耗' });
    });
    const s = api.getState();
    expect(s.scores.vitality).toBe(7);
    expect(s.logs).toHaveLength(2);
    expect(s.logs[0]).toMatchObject({ st: 'vitality', amt: -3, desc: '消耗', src: 'cost' });
    expect(s.logs[1]).toMatchObject({ st: 'vitality', amt: 10, desc: '测试入账' });
    expect(s.ext.stats.lifetimeVitalityIn).toBe(10);
    expect(s.ext.stats.lifetimeVitalityOut).toBe(3);
  });

  it('adjust 以目标值为准，而不是增量', () => {
    api.resetState();
    run(() => { api.Ledger.adjust('vitality', 42, { src: 'manual' }); });
    expect(api.getState().scores.vitality).toBe(42);
    run(() => { api.Ledger.adjust('vitality', 5, { src: 'manual' }); });
    expect(api.getState().scores.vitality).toBe(5);
  });

  it('idemKey 在同一事务内去重', () => {
    api.resetState();
    let second = null;
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'achievement', delta: 5, idemKey: 'k1', reason: { src: 'test' } });
      second = api.Ledger.post({ op: 'grant', account: 'achievement', delta: 5, idemKey: 'k1', reason: { src: 'test' } });
    });
    expect(second.deduped).toBe(true);
    expect(api.getState().scores.achievement).toBe(5);
    expect(api.getState().logs).toHaveLength(1);
  });

  it('非法账户抛事务错误并整体回滚', () => {
    api.resetState();
    const r = api.Ledger.txn(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test' } });
      api.Ledger.post({ op: 'grant', account: 'no_such_account', delta: 5, reason: { src: 'test' } });
    }, opts);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_ACCOUNT');
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
  });
});

describe('Ledger.postSplits：多领域按分均摊', () => {
  it('10 元分 3 个领域，账面无浮点尾巴且流水明细逐分守恒', () => {
    api.resetState({
      domains: [
        { id: 'd_default', name: '默认' },
        { id: 'd2', name: '领域二' },
        { id: 'd3', name: '领域三' },
      ],
    });
    run(() => {
      api.Ledger.postSplits({
        splits: [{ domainIds: ['d_default', 'd2', 'd3'], delta: 10 }],
        entry: { st: 'progress', amt: 10, desc: '分摊', src: 'checkin', dom: 'd_default,d2,d3' },
        reason: { src: 'checkin' },
      });
    });
    const s = api.getState();
    expect(s.scores.progress).toEqual({ d_default: 3.34, d2: 3.33, d3: 3.33 });
    expect(s.logs[0].splits).toEqual([
      { dom: 'd_default', amt: 3.34 },
      { dom: 'd2', amt: 3.33 },
      { dom: 'd3', amt: 3.33 },
    ]);
    expect(Math.round(s.logs[0].splits.reduce((a, x) => a + x.amt, 0) * 100)).toBe(1000);
    expect(s.ext.stats.lifetimeProgressIn).toBe(10);
  });

  it('隐形拆分不写流水，但计入 invisible 且逐领域精确', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }, { id: 'd3', name: '三' }],
    });
    run(() => {
      api.Ledger.postSplits({
        splits: [{ domainIds: ['d_default', 'd2', 'd3'], delta: 1 }],
        visible: false,
        reason: { src: 'checkin-replay' },
      });
    });
    const s = api.getState();
    expect(s.logs).toHaveLength(0);
    expect(s.ext.stats.invisible.progress).toEqual({ d_default: 0.34, d2: 0.33, d3: 0.33 });
    expect(s.ext.shadow).toHaveLength(3);
  });
});

describe('Ledger 隐形操作：余额变了但流水没有对应行', () => {
  it('visible:false 只改余额、写差额累计与余额调整记录', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 50, visible: false, reason: { src: 'loan-draw', desc: '贷款放款' } });
    });
    const s = api.getState();
    expect(s.scores.vitality).toBe(50);
    expect(s.logs).toHaveLength(0);
    expect(s.ext.stats.invisible.vitality).toBe(50);
    expect(s.ext.shadow).toHaveLength(1);
    expect(s.ext.shadow[0]).toMatchObject({ acct: 'vitality', delta: 50, before: 0, after: 50, label: '贷款放款' });
    expect(sums(s)).toEqual({ visible: 0, invisible: 50, evicted: 0 });
  });

  it('隐形 transfer 两端都留痕，且对账等式成立', () => {
    api.resetState();
    run(() => { api.Ledger.grant('achievement', 100, { src: 'test' }); });
    run(() => {
      api.Ledger.transfer('achievement', 'vitality', 30, { src: 'loan-draw', desc: '放款' }, { visible: false });
    });
    const s = api.getState();
    expect(s.scores.achievement).toBe(70);
    expect(s.scores.vitality).toBe(30);
    expect(s.ext.stats.invisible.achievement).toBe(-30);
    expect(s.ext.stats.invisible.vitality).toBe(30);
    expect(s.ext.shadow).toHaveLength(2);
  });
});

describe('LOG_MAX 截断与对账等式', () => {
  it('超过上限的旧流水转入 evicted，余额 == 可见 + 隐形 + evicted', () => {
    api.resetState();
    run(() => {
      for (let i = 0; i < api.LOG_MAX + 5; i++) {
        api.Ledger.post({ op: 'grant', account: 'vitality', delta: 1, reason: { src: 'test' } });
      }
    });
    const s = api.getState();
    expect(api.LOG_MAX).toBe(300);
    expect(s.logs).toHaveLength(300);
    expect(s.scores.vitality).toBe(305);
    expect(s.ext.stats.evicted.vitality).toBe(5);
    expect(s.ext.stats.lifetimeVitalityIn).toBe(305); // 生命周期计数不受截断影响
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(305);
  });

  it('撤销（移除流水）后仍精确对账', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 8, reason: { src: 'test' } });
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 2, reason: { src: 'test' } });
    });
    const id = api.getState().logs[0].id;
    run(() => { api.Ledger.removeLogs(l => l.id !== id); });
    const s = api.getState();
    // 移除流水只是剪枝：余额不变，被移除的 +2 从可见口径转入 evicted
    expect(s.scores.vitality).toBe(10);
    expect(s.logs).toHaveLength(1);
    expect(s.ext.stats.evicted.vitality).toBe(2);
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(10);
  });
});

describe('撤销适配器（Ledger.reverse）', () => {
  it('打卡 → 撤销：余额、流水、任务计数/连胜/累计收益全部回到打卡前', () => {
    api.resetState({ tasks: [checkinTask()] });
    api.checkIn('t1');
    let s = api.getState();
    expect(s.scores.vitality).toBe(10);
    expect(s.tasks[0]).toMatchObject({ checkInCount: 1, streak: 1, totalEarned: 10 });
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({ src: 'checkin', st: 'vitality', amt: 10, prevStreak: 0, prevLastCheckIn: null });

    api.Ledger.reverse(s.logs[0].id);
    s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
    expect(s.tasks[0]).toMatchObject({ checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0 });
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(0);
  });

  it('带消耗的打卡撤销会连带退回消耗的活力点', () => {
    api.resetState({
      scores: { vitality: 20, progress: {}, achievement: 0 },
      tasks: [checkinTask({ vitalityCost: 4 })],
    });
    api.checkIn('t1');
    let s = api.getState();
    expect(s.scores.vitality).toBe(26); // -4 成本 +10 收益
    expect(s.logs).toHaveLength(2);
    const checkinId = s.logs.find(l => l.src === 'checkin').id;
    api.Ledger.reverse(checkinId);
    s = api.getState();
    expect(s.scores.vitality).toBe(20);
    expect(s.logs).toHaveLength(0);
  });
});

describe('Ledger.liability：负债生命周期', () => {
  it('open / mutate / close 都留在审计里', () => {
    api.resetState();
    let id = '';
    run(() => {
      const loan = api.Ledger.liability.open({ amount: 100, debtRate: 10, currency: 'vitality', reason: { src: 'loan' } });
      id = loan.id;
      api.Ledger.liability.mutate(id, 120, { src: 'loan-interest' });
      expect(api.Ledger.liability.close(id, { src: 'loan-repay' })).toBe(true);
    });
    const s = api.getState();
    expect(s.loans).toHaveLength(0);
    const ops = s.ext.audit.map(a => a.op);
    expect(ops).toEqual(expect.arrayContaining(['liability-open', 'liability-mutate', 'liability-close']));
    const mutate = s.ext.audit.find(a => a.op === 'liability-mutate');
    expect(mutate).toMatchObject({ before: 100, after: 120, delta: 20 });
  });
});
