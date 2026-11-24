// 杂事循环重复 + 完成历史 + 判定内核（本步不含界面）
// 覆盖：形状守卫、周期键、到期日重现、四口径（腐化债 / 批量结算 / 超期天数 / 预算绑定）。
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api } from './shim.js';

const at = (d, h = 0) => new Date(2026, 4, d, h, 0, 0, 0).getTime();

function seed(chores, extra) {
  api.__setClockForTest(() => at(10, 12));
  api.resetState(Object.assign({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 100, progress: {}, achievement: 100 },
    chores: chores || [],
    logs: [],
  }, extra || {}));
}

const chore = id => api.getState().chores.find(c => c.id === id);

beforeEach(() => seed([]));
afterAll(() => api.__setClockForTest(null));

describe('完成历史的情境快照', () => {
  it('完成时写入当时情境；之后改标签不回溯改写历史', () => {
    seed([{ id: 't1', name: '循环', tags: ['电脑'], cycle: { unit: 'day', interval: 1, anchor: at(9) }, history: [] }]);
    const c = api.getLive().chores[0];
    expect(api.choreMarkCompletion(c, at(10, 12))).toBe(true);
    expect(c.history[0].tags).toEqual(['电脑']);
    c.tags = ['电话'];
    expect(c.history[0].tags).toEqual(['电脑']);
  });

  it('取消完成时快照随末条一起弹出', () => {
    seed([{ id: 't2', name: '循环', tags: ['电脑'], cycle: { unit: 'day', interval: 1, anchor: at(9) }, history: [] }]);
    const c = api.getLive().chores[0];
    api.choreMarkCompletion(c, at(10, 12));
    expect(api.choreUndoCompletion(c)).toBe(true);
    expect(c.history).toEqual([]);
  });

  it('migrateChore 只对缺失 tags 键的旧条目反填，且幂等', () => {
    const raw = {
      id: 'legacy', name: '旧循环', tags: ['电脑'],
      history: [{ ts: at(1, 10), due: at(1), settled: false }],
    };
    const once = api.migrateChore(JSON.parse(JSON.stringify(raw)));
    expect(once.history[0].tags).toEqual(['电脑']);
    const twice = api.migrateChore(JSON.parse(JSON.stringify(once)));
    expect(twice.history).toEqual(once.history);
  });

  it('读档路径反填一次即可：parseState 往返两次不再变化', () => {
    seed([{ id: 'p1', name: '循环', tags: ['电脑'], cycle: { unit: 'day', interval: 1, anchor: at(9) }, history: [{ ts: at(1, 10), due: at(1), settled: false }] }]);
    const raw = JSON.parse(JSON.stringify(api.getState()));
    delete raw.chores[0].history[0].tags;
    const once = api.parseState(JSON.stringify(raw));
    const onceHist = once.chores.find(c => c.id === 'p1').history;
    expect(onceHist[0].tags).toEqual(['电脑']);
    const twice = api.parseState(JSON.stringify(once));
    expect(twice.chores.find(c => c.id === 'p1').history).toEqual(onceHist);
  });

  it('键存在但为空数组视为有效快照，不被反填', () => {
    const c = api.migrateChore({
      id: 'blank', name: '旧循环', tags: ['电脑'],
      history: [{ ts: at(1, 10), due: at(1), settled: false, tags: [] }],
    });
    expect(c.history[0].tags).toEqual([]);
  });

  it('当前情境为空时反填为空数组，仍然幂等', () => {
    const raw = {
      id: 'empty', name: '旧循环', tags: [],
      history: [{ ts: at(1, 10), due: at(1), settled: false }],
    };
    const once = api.migrateChore(JSON.parse(JSON.stringify(raw)));
    expect(once.history[0].tags).toEqual([]);
    const twice = api.migrateChore(JSON.parse(JSON.stringify(once)));
    expect(twice.history).toEqual(once.history);
  });
});

describe('形状守卫：缺字段按一次性读入', () => {
  it('旧杂事没有 cycle/history 时不补字段、不报错', () => {
    const c = api.migrateChore({ id: 'x', name: '旧杂事', done: false });
    expect(c.cycle).toBeUndefined();
    expect(c.history).toBeUndefined();
    expect(api.choreIsCyclic(c)).toBe(false);
    expect(api.choreDoneNow(c)).toBe(false);
  });

  it('非法循环配置被删除，回落为一次性', () => {
    const c = api.migrateChore({ id: 'y', name: '坏配置', cycle: { unit: 'bogus', interval: 1, anchor: at(1) } });
    expect(c.cycle).toBeUndefined();
    expect(api.choreIsCyclic(c)).toBe(false);
  });

  it('合法的周期与完成历史被规范化（due 归一到本地零点，坏条目丢弃）', () => {
    const c = api.migrateChore({
      id: 'z', name: '循环',
      cycle: { unit: 'day', interval: 2, anchor: at(1, 9), nextDue: at(5, 9) },
      history: [{ ts: at(1, 10), due: at(1, 9), settled: false }, null, { ts: 0 }],
    });
    expect(c.cycle).toMatchObject({ unit: 'day', interval: 2, anchor: at(1), nextDue: at(5), lastDue: 0 });
    expect(c.history).toEqual([{ ts: at(1, 10), due: at(1), settled: false, tags: [] }]);
  });

  it('一次性杂事完成/取消沿用原 done 标记', () => {
    seed([{ id: 'c1', name: '一次性', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null }]);
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(false);
    api.toggleChoreDone('c1');
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(true);
    api.toggleChoreDone('c1');
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(false);
  });
});

describe('周期键：天 / 周 / 月', () => {
  it('addMonths 按日历钳到月末', () => {
    const jan31 = new Date(2026, 0, 31).getTime();
    expect(api.addMonths(jan31, 1)).toBe(new Date(2026, 1, 28).getTime());
    expect(api.addMonths(jan31, 2)).toBe(new Date(2026, 2, 31).getTime());
  });

  it('下一到期日严格晚于完成日（晚交多期只跳到未来第一期）', () => {
    const daily = { unit: 'day', interval: 3, anchor: at(1), nextDue: at(1), lastDue: 0 };
    expect(api.choreCycleDueAfter(daily, at(10))).toBe(at(13));

    const weekly = { unit: 'week', interval: 2, anchor: at(4), nextDue: at(4), lastDue: 0 };
    expect(api.choreCycleDueAfter(weekly, at(6))).toBe(at(18));

    const monthly = { unit: 'month', interval: 1, anchor: new Date(2026, 0, 31).getTime(), nextDue: new Date(2026, 0, 31).getTime(), lastDue: 0 };
    expect(api.choreCycleDueAfter(monthly, new Date(2026, 1, 20).getTime())).toBe(new Date(2026, 1, 28).getTime());
  });
});

describe('到期那天才重新出现 + 今天做没做', () => {
  it('完成后隐藏，nextDue 当天重新待办，历史保留每次完成', () => {
    seed([{ id: 'c1', name: '每日', done: false, doneAt: null, plannedAt: null, createdAt: at(10), settled: false, freshDays: null, decayKey: null, cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 } }]);

    api.toggleChoreDone('c1');
    let c = chore('c1');
    expect(api.choreDoneNow(c)).toBe(true);
    expect(c.cycle.nextDue).toBe(at(11));
    expect(c.history).toHaveLength(1);
    expect(c.history[0]).toMatchObject({ due: at(10), settled: false });

    // 到期日之前（同一天晚些时候）仍是完成态
    api.__setClockForTest(() => at(10, 23));
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(true);

    // 到了 nextDue 当天：重新待办，且到期当天不产生腐化债
    api.__setClockForTest(() => at(11));
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(false);
    expect(api.choreOverdueDays(api.getLive().chores[0])).toBe(0);
    expect(api.computeChoreDecay().total).toBe(0);

    api.toggleChoreDone('c1');
    c = chore('c1');
    expect(c.history).toHaveLength(2);
    expect(c.history[1].due).toBe(at(11));
    expect(c.cycle.nextDue).toBe(at(12));
  });

  it('取消完成会弹出最近一条历史并退回 nextDue', () => {
    seed([{ id: 'c1', name: '每日', done: false, doneAt: null, plannedAt: null, createdAt: at(10), settled: false, freshDays: null, decayKey: null, cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 } }]);
    api.toggleChoreDone('c1');
    api.toggleChoreDone('c1');
    const c = chore('c1');
    expect(c.history).toHaveLength(0);
    expect(c.cycle.nextDue).toBe(at(10));
    expect(api.choreDoneNow(c)).toBe(false);
  });

  it('错过多个周期只留一件待办（不累积成多张）', () => {
    seed([{ id: 'c1', name: '已错过 9 天', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null, cycle: { unit: 'day', interval: 2, anchor: at(1), nextDue: at(1), lastDue: 0 } }]);
    expect(api.choreDoneNow(api.getLive().chores[0])).toBe(false);
    expect(api.choreOverdueDays(api.getLive().chores[0])).toBe(9);
    expect(api.pointMetricValue('chore_overdue', {}, at(10))).toBe(1);
  });
});

describe('口径 1 + 3：腐化债与超期天数以到期日为基准', () => {
  it('不到期零债；到期后从次日开始逐日累积', () => {
    seed([{ id: 'c1', name: '循环', done: false, doneAt: null, plannedAt: null, createdAt: at(1), settled: false, freshDays: 99, decayKey: null, cycle: { unit: 'day', interval: 3, anchor: at(10), nextDue: at(10), lastDue: 0 } }]);
    expect(api.choreOverdueDays(api.getLive().chores[0])).toBe(0);
    expect(api.computeChoreDecay().total).toBe(0);

    api.__setClockForTest(() => at(13));
    const c = api.getLive().chores[0];
    expect(api.choreOverdueDays(c)).toBe(3);
    const r = api.computeChoreDecay();
    expect(r.charged).toBe(1);
    expect(r.dueDays).toBe(3);
    expect(r.total).toBe(0.6); // 1 件超期 · 第一档 0.2/天 × 3 天
  });

  it('循环杂事忽略 freshDays，一次性杂事仍按 base + freshDays', () => {
    const cyclic = { id: 'a', cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 }, freshDays: 99, createdAt: at(1) };
    const oneOff = { id: 'b', freshDays: 3, createdAt: at(1), plannedAt: null, done: false };
    expect(api.choreOverdueDays(cyclic)).toBe(0);
    expect(api.choreOverdueDays(oneOff)).toBe(6);
  });
});

describe('口径 2：批量结算每个周期只贡献一件', () => {
  it('同一 due 的多条完成记录只算一件；不同周期各算一件', () => {
    seed([{
      id: 'c1', name: '循环', done: true, doneAt: at(3), plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null,
      cycle: { unit: 'day', interval: 1, anchor: at(1), nextDue: at(4), lastDue: at(3) },
      history: [
        { ts: at(1), due: at(1), settled: false },
        { ts: at(2), due: at(2), settled: false },
        { ts: at(2, 13), due: at(2), settled: false },
      ],
    }]);
    const pool = api.choreSettlePool();
    expect(pool).toHaveLength(2);
    expect(pool.map(x => x.entry.due)).toEqual([at(1), at(2)]);
  });

  it('结算后写回历史条目；下一周期的新完成重新进入批次', () => {
    seed([{
      id: 'c1', name: '循环', done: true, doneAt: at(2), plannedAt: null, createdAt: at(1), settled: false, freshDays: null, decayKey: null,
      cycle: { unit: 'day', interval: 1, anchor: at(1), nextDue: at(3), lastDue: at(2) },
      history: [{ ts: at(1), due: at(1), settled: false }, { ts: at(2), due: at(2), settled: false }],
    }]);
    api.patchState(s => { s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 2, batchY: 4 }); });
    api.settleChoreBatches(true);
    let c = chore('c1');
    expect(api.getState().scores.vitality).toBe(104);
    expect(c.history.map(e => e.settled)).toEqual([true, true]);
    expect(c.settled).toBe(true);
    expect(api.choreSettlePool()).toHaveLength(0);

    // 下一周期完成：settled=false 的新条目重新可结算
    api.__setClockForTest(() => at(3));
    api.toggleChoreDone('c1');
    c = chore('c1');
    expect(c.history).toHaveLength(3);
    expect(c.history[2]).toMatchObject({ due: at(3), settled: false });
    expect(api.choreSettlePool()).toHaveLength(1);
  });
});

describe('口径 4：预算绑定按每次完成各记一笔', () => {
  it('两个周期各完成一次 => 两笔现实账目', () => {
    seed([{
      id: 'c1', name: '循环', done: false, doneAt: null, plannedAt: null, createdAt: at(10), settled: false, freshDays: null, decayKey: null,
      cycle: { unit: 'day', interval: 1, anchor: at(10), nextDue: at(10), lastDue: 0 },
      budget: { categoryId: 'bc1', mode: 'fixed', amount: 12 }, budgetRef: null,
    }]);
    api.patchState(s => {
      s.ext.budgets.categories.push(api.normalizeBudgetCategory({
        id: 'bc1', name: '餐饮', cycle: 'month', anchor: 1, limit: 1000, defaultProgressDomainId: 'd_default',
      }, { domainIds: new Set(['d_default']) }));
      s.choreConfig = Object.assign({}, s.choreConfig, { batchN: 10 });
    });

    api.toggleChoreDone('c1');
    api.__setClockForTest(() => at(11));
    api.toggleChoreDone('c1');

    const entries = api.getState().ext.budgets.ledger.filter(e => e.txnId === 'chore-check');
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.amount)).toEqual([12, 12]);
  });
});

describe('旧存档：不回头重算', () => {
  it('旧完成记录与腐化键保持原值', () => {
    const oldDone = at(2);
    const c = api.migrateChore({ id: 'old', name: '旧', done: true, doneAt: oldDone, settled: false, decayKey: '2026-05-03', freshDays: 3, createdAt: at(1) });
    expect(c.doneAt).toBe(oldDone);
    expect(c.decayKey).toBe('2026-05-03');
    expect(c.cycle).toBeUndefined();
    expect(c.history).toBeUndefined();
    // 一次性杂事完成态仍是完成，不会因缺少 history 被判成未完成
    expect(api.choreDoneNow(c)).toBe(true);
  });
});
