// D5：chore.completed 事件 + 流水撤销留痕 + 流列表最近运行显示
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);

function choreFlow(over) {
  return api.normalizeFlow(Object.assign({
    id: 'cf1', name: '杂事完成发活力', enabled: true,
    trigger: { type: 'event', event: { kind: 'chore.completed' } },
    condition: { mode: 'all', items: [] },
    steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: 3 } }],
  }, over || {}));
}
function seed(flows) {
  api.resetState({
    scores: { vitality: 100, progress: {}, achievement: 0 },
    chores: [],
    flows: flows || [],
  });
}
function oneOffChore() {
  return { id: 'c1', name: '洗碗', done: false, doneAt: null, history: [] };
}
function cyclicChore() {
  const d = api.dayStart(T);
  return {
    id: 'c2', name: '浇花', done: false, doneAt: null, history: [],
    cycle: { unit: 'day', interval: 1, anchor: d, nextDue: d, lastDue: 0 },
  };
}

beforeEach(() => { api.__setClockForTest(() => T); });
afterEach(() => { api.__setClockForTest(null); });

describe('chore.completed 事件', () => {
  it('手工完成派一次；同一事件重放不再派发', () => {
    seed([choreFlow()]);
    const c = oneOffChore();
    expect(api.choreMarkCompletion(c, T)).toBe(true);
    const ev = api.makeChoreCompletedEvent(c, c.history[c.history.length - 1]);
    expect(ev.key).toBe('chore.completed:c1:done:' + T);

    api.handlePostCommitEvents([ev], { nested: false });
    let s = api.getState();
    expect(s.scores.vitality).toBe(103);
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    expect(s.ext.events.recent[0].results[0]).toMatchObject({ flowId: 'cf1', ok: true });

    const vitality = s.scores.vitality;
    // 同一次完成重复投递（模拟重放）：幂等表命中，不再执行
    api.handlePostCommitEvents([ev], { nested: false });
    s = api.getState();
    expect(s.scores.vitality).toBe(vitality);
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    expect(s.ext.events.recent[0].results.some(r => r.code === 'EVENT_ALREADY_RUN')).toBe(true);
  });

  it('循环杂事同一周期只算一次：防重 + 到期日作事件键', () => {
    seed([choreFlow()]);
    const c = cyclicChore();
    expect(api.choreMarkCompletion(c, T)).toBe(true);
    expect(api.choreMarkCompletion(c, T)).toBe(false); // 同周期重复勾选被拒
    const due = api.dayStart(T);
    const first = api.makeChoreCompletedEvent(c, c.history[0]);
    const replay = api.makeChoreCompletedEvent(c, { ts: T + 5000, due: due });
    expect(first.key).toBe('chore.completed:c2:due:' + due);
    expect(replay.key).toBe(first.key); // 同周期 → 同键 → 只会派一次
  });

  it('撤销完成不产生完成事件；重新勾选是新完成、键随之更新', () => {
    seed([choreFlow()]);
    const c = oneOffChore();
    api.choreMarkCompletion(c, T);
    expect(api.makeChoreCompletedEvent(c, c.history[c.history.length - 1])).toBeTruthy();

    expect(api.choreUndoCompletion(c)).toBe(true);
    expect(c.history).toHaveLength(0);
    expect(api.makeChoreCompletedEvent(c, c.history[c.history.length - 1] || null)).toBeNull();

    api.choreMarkCompletion(c, T + 1000);
    expect(api.makeChoreCompletedEvent(c, c.history[c.history.length - 1]).key)
      .toBe('chore.completed:c1:done:' + (T + 1000));
  });

  it('手工勾选走真实提交路径：提交后派发一次；取消勾选不派发', () => {
    seed([choreFlow()]);
    api.patchState(s => { s.chores = [oneOffChore()]; });

    api.toggleChoreDone('c1');
    let s = api.getState();
    expect(s.chores[0].done).toBe(true);
    expect(s.scores.vitality).toBe(103); // 事件流发放 3
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    expect(s.ext.events.recent[0].key).toBe('chore.completed:c1:done:' + T);

    // 取消勾选：不是完成，不派事件；已派发的一次性副作用不回滚
    api.toggleChoreDone('c1');
    s = api.getState();
    expect(s.chores[0].done).toBe(false);
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    expect(s.scores.vitality).toBe(103);
  });
});

describe('流水撤销留痕', () => {
  function seedPurchase() {
    api.resetState({
      scores: { vitality: 100, progress: {}, achievement: 0 },
      products: [api.normalizeProduct({
        id: 'p1', name: '商品', desc: '', price: 10, stock: 5,
        categoryId: 'sc_default', tier: 'daily', sold: 0,
      })],
    });
    api.buyProduct('p1');
    return api.getState().logs.find(l => l.src === 'purchase');
  }

  it('撤销后主账本删除、旁挂副本保留并置灰，副本不影响账务', () => {
    const leg = seedPurchase();
    const afterBuy = api.getState();
    expect(afterBuy.scores.vitality).toBe(90);

    const r = api.undoLog(leg.id);
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.logs.some(l => l.id === leg.id)).toBe(false);
    const rev = (s.ext.reversedLogs || []).find(l => l.id === leg.id);
    expect(rev).toMatchObject({ id: leg.id, src: 'purchase', reversedAt: T });
    expect(s.scores.vitality).toBe(100); // 退款回到购买前，与原来删除式撤销一致
    // 原有撤销语义：被删流水的账户贡献挪进 evicted 供对账（本次不改）；旁挂副本不参与账务
    expect(s.ext.stats.evicted.vitality).toBe(-10);
    expect(rev.agg).toBeFalsy();

    api.renderBank();
    const html = document.getElementById('logList').innerHTML;
    expect(html).toContain('ledger-row reversed');
    expect(html).toContain('已撤销');
    // 撤销按钮直接消失（不是禁用），锁定为不可操作
    expect(html).not.toContain('undoLog(');
  });

  it('同一条反复撤销不会产生第二份副本', () => {
    const leg = seedPurchase();
    api.undoLog(leg.id);
    const again = api.undoLog(leg.id);
    expect(again.ok).toBe(false);
    expect(api.getState().ext.reversedLogs.filter(l => l.id === leg.id)).toHaveLength(1);
  });

  it('副本上限固定且远小于主账本上限，不会变相扩容', () => {
    const leg = seedPurchase();
    api.patchState(s => {
      s.ext.reversedLogs = [];
      for (let i = 0; i < api.REVERSED_LOG_KEEP; i += 1) {
        s.ext.reversedLogs.push({ id: 'old' + i, src: 'purchase', time: T, amt: 1 });
      }
    });
    api.undoLog(leg.id);
    const list = api.getState().ext.reversedLogs;
    expect(list).toHaveLength(api.REVERSED_LOG_KEEP);
    expect(list[0].id).toBe(leg.id); // 新的在前，旧的被尾部裁掉
    expect(api.REVERSED_LOG_KEEP).toBeLessThan(api.LOG_MAX);
  });

  it('清除数据成果会一并清空撤销留痕', () => {
    const leg = seedPurchase();
    api.undoLog(leg.id);
    expect(api.getState().ext.reversedLogs.length).toBeGreaterThan(0);
    api.clearDataResults();
    expect(api.getState().ext.reversedLogs).toEqual([]);
    expect(api.getState().logs).toEqual([]);
  });
});

describe('流列表最近运行显示', () => {
  it('没跑过显示「从未运行」；跑过取运行历史最近一次且不改 lastRun', () => {
    seed([choreFlow()]);
    // 渲染 HTML 里的文字经 esc() 转义，而测试 DOM 桩的 esc 恒为空串，
    // 因此「上次运行」文案直接测导出函数，渲染只锁结构位置。
    expect(api.flowRunLine('cf1')).toBe('运行：从未运行');
    api.renderFlowPanel();
    let html = document.getElementById('flowList').innerHTML;
    expect(html).toContain('flow-run-meta');
    expect(api.getState().flows[0].lastRun).toBeFalsy();

    api.patchState(s => {
      s.ext.flowRuns = {
        recent: ['r1'],
        byId: { r1: { id: 'r1', flowId: 'cf1', startedAt: T, trigger: 'manual', status: 'done' } },
      };
    });
    expect(api.flowRunLine('cf1')).toMatch(/^上次运行：手动 · \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    api.renderFlowPanel();
    html = document.getElementById('flowList').innerHTML;
    expect(html).toContain('flow-run-meta');
    expect(api.getState().flows[0].lastRun).toBeFalsy();
  });
});
