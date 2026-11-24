// 阶段 5 事件触发的数据结构与派发计划（真实派发见 event-trigger.test.js）。
// 覆盖：事件对象与载荷白名单、事件环形记录去重/上限、事件触发流的归一化与禁用、
// 派发计划匹配（停用/已派发/超量/深度）、以及派发不执行流且不改任何账目。
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);

function checkinEvent(sourceId, payload) {
  return api.makeEvent('checkin', sourceId, T, payload);
}
function eventFlow(over) {
  return api.normalizeFlow(Object.assign({
    id: 'ef1',
    name: '打卡后发活力',
    trigger: { type: 'event', event: { kind: 'checkin' } },
    steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: 1 } }],
  }, over || {}));
}

beforeEach(() => {
  api.resetState();
});

describe('事件对象与载荷', () => {
  it('只接受打卡、购买与杂事完成三类事件，键由类型与来源 id 组成', () => {
    expect(api.EVENT_KINDS).toEqual(['checkin', 'purchase', 'chore.completed']);
    const ev = checkinEvent('t1', { taskId: 't1', streak: 3, cost: 0, foo: 'bar' });
    expect(ev).toMatchObject({ v: 1, kind: 'checkin', key: 'checkin:t1', sourceId: 't1', occurredAt: T });
    expect(ev.payload).toEqual({ taskId: 't1', streak: 3, cost: 0 });
    expect(api.makeEvent('budget_over', 'x', T, {})).toBeNull();
    expect(api.makeEvent('checkin', '', T, {})).toBeNull();
    expect(api.makeEvent('checkin', 't1', 0, {})).toBeNull();
    expect(api.eventKeyOf('purchase', 'o1')).toBe('purchase:o1');
  });

  it('杂事完成事件：一次性用完成时刻、循环用到期日作来源 id', () => {
    const oneOff = api.makeChoreCompletedEvent({ id: 'c1', name: '洗碗' }, { ts: T, due: 0 });
    expect(oneOff).toMatchObject({ kind: 'chore.completed', key: 'chore.completed:c1:done:' + T, occurredAt: T });
    expect(oneOff.payload).toEqual({ choreId: 'c1', name: '洗碗', doneAt: T, due: 0 });

    const due = T - 86400000;
    const cyc = api.makeChoreCompletedEvent({ id: 'c2', name: '浇花', cycle: { unit: 'week' } }, { ts: T, due: due });
    expect(cyc.key).toBe('chore.completed:c2:due:' + due);
    expect(cyc.payload).toMatchObject({ choreId: 'c2', cycleUnit: 'week', due: due });
    // 同一次循环完成重复构造，键稳定不变
    expect(api.makeChoreCompletedEvent({ id: 'c2' }, { ts: T + 1000, due: due }).key).toBe(cyc.key);
    expect(api.makeChoreCompletedEvent({ id: 'c3' }, { ts: 0, due: 0 })).toBeNull();
  });

  it('购买事件保留资产支付明细，非法金额被丢弃', () => {
    const ev = api.makeEvent('purchase', 'o1', T, {
      productId: 'p1', tier: 2, price: 30, paid: 20, orderId: 'o1', stockAfter: 4,
      assetPayments: [{ assetId: 'star', amount: 2 }, { assetId: '', amount: 3 }, { assetId: 'star', amount: 0 }],
    });
    expect(ev.payload).toMatchObject({ productId: 'p1', tier: 2, price: 30, paid: 20, orderId: 'o1', stockAfter: 4 });
    expect(ev.payload.assetPayments).toEqual([{ assetId: 'star', amount: 2 }]);
  });
});

describe('事件环形记录', () => {
  it('按事件键去重、新的在前、最多保留 EVENT_KEEP 条', () => {
    let store = api.normalizeEventStore(null);
    expect(store).toEqual({ v: 1, recent: [] });
    const first = api.rememberEvent(store, checkinEvent('t1'));
    expect(first.added).toBe(true);
    store = first.store;
    expect(store.recent[0].key).toBe('checkin:t1');

    const dup = api.rememberEvent(store, checkinEvent('t1'));
    expect(dup.added).toBe(false);
    expect(dup.reason).toBe('DUPLICATE');
    expect(dup.store.recent).toHaveLength(1);

    for (let i = 0; i < api.EVENT_KEEP + 5; i += 1) {
      store = api.rememberEvent(store, checkinEvent('t' + i)).store;
    }
    expect(store.recent).toHaveLength(api.EVENT_KEEP);
    expect(store.recent[0].key).toBe('checkin:t' + (api.EVENT_KEEP + 4));
    // 刷新归一化后仍是同一份结构，且去重
    const again = api.normalizeEventStore({ recent: store.recent.concat([checkinEvent('t0')]) });
    expect(again.recent).toHaveLength(api.EVENT_KEEP);
  });
});

describe('事件触发流的归一化（第二步起允许启用，但条件受编译期限制）', () => {
  it('保留 event 触发与 lastEventKey，并允许启用', () => {
    const f = eventFlow({ enabled: true, lastEventKey: 'checkin:t1' });
    expect(f.trigger).toEqual({ type: 'event', event: { kind: 'checkin' }, period: 'week', anchor: 1 });
    expect(f.enabled).toBe(true);
    expect(f.invalid).toBe(false);
    expect(f.lastEventKey).toBe('checkin:t1');
    expect(api.eventTriggersOf(f)).toEqual({ kind: 'checkin' });
    // 未知事件类型按周期触发处理，绝不静默生成事件触发流
    const bad = api.normalizeFlow({ id: 'x', trigger: { type: 'event', event: { kind: 'nope' } }, steps: [] });
    expect(bad.trigger.type).toBe('period');
    expect(api.eventTriggersOf(bad)).toBeNull();
  });

  it('parseState 保留事件记录，旧存档默认空结构', () => {
    const ev = checkinEvent('t1', { taskId: 't1' });
    const ext = api.normalizeExt({ events: { recent: [ev] } });
    expect(ext.events.recent).toHaveLength(1);
    expect(ext.events.recent[0].key).toBe('checkin:t1');
    expect(api.normalizeExt({}).events).toEqual({ v: 1, recent: [] });
  });
});

describe('派发计划与派发位', () => {
  it('只匹配启用且未见过的同类事件流，并给出跳过原因', () => {
    const flows = [
      eventFlow({ id: 'f1' }),
      eventFlow({ id: 'f2' }),
      eventFlow({ id: 'f3', trigger: { type: 'event', event: { kind: 'purchase' } } }),
      eventFlow({ id: 'f4', lastEventKey: 'checkin:t1' }),
    ];
    // 显式启用，模拟已由用户开启的事件流
    flows.forEach(f => { f.enabled = true; f.invalid = false; });
    const plan = api.planEventDispatch(checkinEvent('t1'), { flows: flows });
    expect(plan.ok).toBe(true);
    expect(plan.shadow).toBe(true);
    expect(plan.executed).toBe(0);
    expect(plan.matched.map(m => m.flowId)).toEqual(['f1', 'f2']);
    expect(plan.matched[0].runKey).toBe('f1@event:checkin:t1');
    expect(plan.skipped).toEqual([{ flowId: 'f4', reason: 'already-run', runKey: 'f4@event:checkin:t1' }]);
  });

  it('幂等表命中即跳过；停用的流不会被派发', () => {
    const flows = [eventFlow({ id: 'f1' }), eventFlow({ id: 'f2' })];
    flows.forEach(f => { f.enabled = true; f.invalid = false; });
    flows[1].enabled = false;
    const plan = api.planEventDispatch(checkinEvent('t2'), { flows: flows, idem: { 'f1@event:checkin:t2': 1 } });
    expect(plan.matched).toHaveLength(0);
    expect(plan.skipped.map(s => s.reason).sort()).toEqual(['already-run', 'disabled']);
  });

  it('单事件最多派发 EVENT_MAX_FLOWS_PER_EVENT 条，超出部分计入 overflow', () => {
    const flows = [];
    for (let i = 0; i < api.EVENT_MAX_FLOWS_PER_EVENT + 3; i += 1) {
      const f = eventFlow({ id: 'f' + i });
      f.enabled = true;
      f.invalid = false;
      flows.push(f);
    }
    const plan = api.planEventDispatch(checkinEvent('t3'), { flows: flows });
    expect(plan.matched).toHaveLength(api.EVENT_MAX_FLOWS_PER_EVENT);
    expect(plan.overflow).toBe(3);
  });

  it('超过事件链深度上限时拒绝派发；非法事件直接拒绝', () => {
    expect(api.planEventDispatch(checkinEvent('t4'), { depth: api.EVENT_DEPTH_MAX }).code).toBe('EVENT_DEPTH_LIMIT');
    expect(api.planEventDispatch(null).code).toBe('EVENT_BAD');
    // 收敛语义：events.js 不再导出“只算计划却叫派发”的别名入口
    expect(api.dispatchEvent).toBeUndefined();
  });

  it('派发位本期不执行流：账目、流水、运行记录都不变', () => {
    const flows = [eventFlow({ id: 'f1' })];
    flows[0].enabled = true;
    flows[0].invalid = false;
    api.patchState(function (s) { s.flows = flows; });
    const before = api.getState();
    const plan = api.planEventDispatch(checkinEvent('t5'), { flows: flows });
    expect(plan.ok).toBe(true);
    expect(plan.executed).toBe(0);
    expect(plan.matched).toHaveLength(1);
    const after = api.getState();
    expect(after.scores).toEqual(before.scores);
    expect(after.cards).toEqual(before.cards);
    expect(after.logs).toHaveLength(0);
    expect(after.ext.flowRuns.recent).toHaveLength(0);
    expect(after.ext.events.recent).toHaveLength(0);
  });
});
