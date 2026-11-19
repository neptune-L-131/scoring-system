// 阶段 5 第二步：打卡/购买事件的真实派发（提交后、幂等、失败隔离、深度 1、上限、编译期限制）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);

function seedTask(over) {
  const task = Object.assign({
    id: 't1', name: '任务', initialValue: 10, interestRate: 10, debtRate: 20,
    pendingDebt: 0, streak: 0, lastCheckIn: null, checkInCount: 0, totalEarned: 0,
    collectionId: 'c_default', domainIds: ['d_default'], scoreTypes: ['vitality'],
    stageRewards: { v: [10, 20, 30, 40, 50], p: [], last: 0 },
  }, over || {});
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 100, progress: {}, achievement: 0 },
    tasks: [task],
    flows: [],
  });
}

function checkinFlow(over) {
  return api.normalizeFlow(Object.assign({
    id: 'ef1',
    name: '打卡后发活力',
    enabled: true,
    trigger: { type: 'event', event: { kind: 'checkin' } },
    condition: { mode: 'all', items: [] },
    steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: 5 } }],
  }, over || {}));
}

function withFlows(list) {
  api.patchState(s => { s.flows = list; });
}

function patchRunFlow(wrap) {
  const orig = api.FlowEngine.runFlow;
  api.FlowEngine.runFlow = function (id, opts) { return wrap(orig, id, opts); };
  return orig;
}

let restoreRunFlow = null;
beforeEach(() => { api.__setClockForTest(() => T); });
afterEach(() => {
  api.__setClockForTest(null);
  if (restoreRunFlow) { api.FlowEngine.runFlow = restoreRunFlow; restoreRunFlow = null; }
});

describe('事件在事务提交后派发', () => {
  it('打卡：流执行时源事务已提交、打卡流水已存在', () => {
    seedTask();
    withFlows([checkinFlow()]);
    const seen = [];
    restoreRunFlow = patchRunFlow(function (orig, id, opts) {
      const snap = api.getState();
      seen.push({
        id,
        inTxn: api.Ledger.inTxn(),
        checkinLogs: snap.logs.filter(l => l.src === 'checkin').length,
        trigger: opts && opts.trigger,
        eventKey: opts && opts.event && opts.event.key,
      });
      return orig(id, opts);
    });
    const live = api.getLive().tasks[0];
    const preview = api.stageNetAt(live, 'vitality', 0, api.calcCheckIn(live));

    api.checkIn('t1', 0);

    expect(seen).toHaveLength(1);
    expect(seen[0].inTxn).toBe(false);
    expect(seen[0].checkinLogs).toBe(1);
    expect(seen[0].trigger).toBe('event');
    expect(seen[0].eventKey).toMatch(/^checkin:/);

    const s = api.getState();
    expect(s.scores.vitality).toBe(100 + preview + 5);
    const recId = s.ext.flowRuns.recent[0];
    expect(s.ext.flowRuns.byId[recId].trigger).toBe('event');
    expect(s.ext.flowRuns.byId[recId].deltas.vitality).toBe(5);
    const ev = s.ext.events.recent[0];
    expect(ev.key).toBe(seen[0].eventKey);
    expect(ev.results[0]).toMatchObject({ flowId: 'ef1', ok: true });
  });

  it('购买：购买成功提交后触发购买事件流', () => {
    api.resetState({
      scores: { vitality: 100, progress: {}, achievement: 0 },
      flows: [api.normalizeFlow({
        id: 'pf1', name: '购买后发活力', enabled: true,
        trigger: { type: 'event', event: { kind: 'purchase' } },
        condition: { mode: 'all', items: [] },
        steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: 1 } }],
      })],
      products: [api.normalizeProduct({
        id: 'p1', name: '商品', desc: '', price: 10, stock: 5,
        categoryId: 'sc_default', tier: 'daily', sold: 0,
      })],
    });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.scores.vitality).toBe(91); // 100 - 10 + 赠送 1
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    expect(s.ext.events.recent[0].kind).toBe('purchase');
    expect(s.ext.events.recent[0].results[0]).toMatchObject({ flowId: 'pf1', ok: true });
  });
});

describe('幂等：同一事件同一条流只执行一次', () => {
  it('重放同一事件不再次执行；序列化重载后也不重放', () => {
    seedTask();
    withFlows([checkinFlow()]);
    api.checkIn('t1', 0);
    const first = api.getState();
    const ev = first.ext.events.recent[0];
    const runsAfterFirst = first.ext.flowRuns.recent.length;
    const vitalityAfterFirst = first.scores.vitality;

    // 同一事件重复投递（模拟重复通知）：幂等表已命中
    api.handlePostCommitEvents([ev], { nested: false });
    let s = api.getState();
    expect(s.ext.flowRuns.recent).toHaveLength(runsAfterFirst);
    expect(s.scores.vitality).toBe(vitalityAfterFirst);

    // 模拟刷新：整份状态序列化后重新解析，幂等键与 lastEventKey 仍在
    const reloaded = api.parseState(JSON.stringify(api.getState()));
    api.setState(reloaded);
    s = api.getState();
    expect(s.flows[0].lastEventKey).toBe(ev.key);
    expect(s.ext.assetMeters.idem['ef1@event:' + ev.key]).toBeTruthy();

    api.handlePostCommitEvents([ev], { nested: false });
    s = api.getState();
    expect(s.ext.flowRuns.recent).toHaveLength(runsAfterFirst);
    expect(s.scores.vitality).toBe(vitalityAfterFirst);
    expect(s.ext.events.recent[0].results.some(r => r.code === 'EVENT_ALREADY_RUN')).toBe(true);
  });
});

describe('流失败不影响原始打卡/购买', () => {
  it('流编译失败：打卡照常提交，失败留痕可查', () => {
    seedTask();
    withFlows([checkinFlow({
      steps: [{ id: 's1', atom: 'no.such.atom', params: {} }],
    })]);
    api.checkIn('t1', 0);
    const s = api.getState();
    expect(s.logs.filter(l => l.src === 'checkin')).toHaveLength(1);
    expect(s.scores.vitality).toBeGreaterThan(100);
    expect(s.ext.flowRuns.recent).toHaveLength(0);
    const results = s.ext.events.recent[0].results;
    expect(results[0]).toMatchObject({ flowId: 'ef1', ok: false, code: 'FLOW_COMPILE_FAILED' });
    expect(s.logs.some(l => l.src === 'flow-event-error')).toBe(true);
  });

  it('流执行抛异常：打卡照常提交，异常被记录而非吞掉', () => {
    seedTask();
    withFlows([checkinFlow()]);
    restoreRunFlow = patchRunFlow(function () { throw new Error('boom'); });
    api.checkIn('t1', 0);
    const s = api.getState();
    expect(s.logs.filter(l => l.src === 'checkin')).toHaveLength(1);
    expect(s.ext.flowRuns.recent).toHaveLength(0);
    expect(s.ext.events.recent[0].results[0]).toMatchObject({ ok: false, code: 'FLOW_EVENT_EXCEPTION' });
    expect(s.logs.some(l => l.src === 'flow-event-error')).toBe(true);
  });
});

describe('重入与单事件上限', () => {
  it('派发中再次产生事件：深度仍为 1，只登记不递归执行', () => {
    seedTask();
    withFlows([checkinFlow()]);
    let nestedResult = null;
    restoreRunFlow = patchRunFlow(function (orig, id, opts) {
      const nested = api.makeEvent('checkin', 't_nested', T + 1, { taskId: 't_nested' });
      nestedResult = api.emitPostCommit([nested], { nested: false });
      return orig(id, opts);
    });
    api.checkIn('t1', 0);
    expect(nestedResult).toMatchObject({ ok: true, nested: true, handled: 0 });
    const s = api.getState();
    // 只有外层事件真正执行了流
    expect(s.ext.flowRuns.recent).toHaveLength(1);
    const nestedRec = s.ext.events.recent.find(e => e.key === 'checkin:t_nested');
    expect(nestedRec.results[0].code).toBe('EVENT_REENTRANT');
  });

  it('单事件最多触发 EVENT_MAX_FLOWS_PER_EVENT 条流，超出部分留痕', () => {
    seedTask();
    const flows = [];
    for (let i = 0; i < api.EVENT_MAX_FLOWS_PER_EVENT + 2; i += 1) {
      flows.push(api.normalizeFlow({
        id: 'f' + i, name: '流' + i, enabled: true,
        trigger: { type: 'event', event: { kind: 'checkin' } },
        condition: { mode: 'all', items: [] },
        steps: [{ id: 's1', atom: 'log.note', params: { desc: '事件流记录' } }],
      }));
    }
    withFlows(flows);
    api.handlePostCommitEvents([api.makeEvent('checkin', 't_bulk', T, { taskId: 't_bulk' })], { nested: false });
    const s = api.getState();
    expect(s.ext.flowRuns.recent).toHaveLength(api.EVENT_MAX_FLOWS_PER_EVENT);
    const results = s.ext.events.recent[0].results;
    expect(results.some(r => r.code === 'EVENT_OVERFLOW')).toBe(true);
  });
});

describe('编译期与编辑器限制', () => {
  const noteStep = { id: 's1', atom: 'log.note', params: { desc: '事件流记录' } };
  function compileEvent(condition, steps) {
    const flow = api.normalizeFlow({
      id: 'x1', name: '事件流', enabled: true,
      trigger: { type: 'event', event: { kind: 'checkin' } },
      condition: condition,
      steps: steps || [noteStep],
    });
    return api.FlowEngine.compile(flow);
  }
  function codes(r) { return r.errors.map(e => e.code); }

  it('拒绝点态指标与「本周期」范围（顶层条件与分支 when 都检查）', () => {
    const point = compileEvent({ mode: 'all', items: [{ metric: 'task_idle', range: 'today', op: '>=', value: 1 }] });
    expect(point.ok).toBe(false);
    expect(codes(point)).toContain('FLOW_EVENT_POINT_METRIC');

    const period = compileEvent({ mode: 'all', items: [{ metric: 'checkins', range: 'period', op: '>=', value: 1 }] });
    expect(period.ok).toBe(false);
    expect(codes(period)).toContain('FLOW_EVENT_PERIOD_RANGE');

    const branchPeriod = compileEvent({ mode: 'all', items: [] }, [{
      id: 'b1', kind: 'branch',
      when: { mode: 'all', items: [{ metric: 'checkins', range: 'period', op: '>=', value: 1 }] },
      then: [noteStep], else: [],
    }]);
    expect(branchPeriod.ok).toBe(false);
    expect(codes(branchPeriod)).toContain('FLOW_EVENT_PERIOD_RANGE');

    const branchPoint = compileEvent({ mode: 'all', items: [] }, [{
      id: 'b1', kind: 'branch',
      when: { mode: 'all', items: [{ metric: 'task_idle', range: 'today', op: '>=', value: 1 }] },
      then: [noteStep], else: [],
    }]);
    expect(branchPoint.ok).toBe(false);
    expect(codes(branchPoint)).toContain('FLOW_EVENT_POINT_METRIC');
  });

  it('合法事件条件（累计/今天 + 非点态指标）可以编译通过', () => {
    const ok = compileEvent({ mode: 'all', items: [{ metric: 'checkins', range: 'today', op: '>=', value: 1 }] });
    expect(ok.ok).toBe(true);
  });

  it('编辑器：事件触发模式提前禁用点态指标与「本周期」', () => {
    seedTask();
    withFlows([checkinFlow()]);
    const draft = api.openFlowModal('ef1');
    expect(draft).toBeTruthy();
    expect(document.getElementById('flowTriggerType').value).toBe('event-checkin');
    expect(api.isCondEventMode()).toBe(true);
    expect(document.getElementById('flowEventHint').style.display).toBe('');

    document.getElementById('flowTriggerType').value = 'period';
    api.flowTriggerChanged();
    expect(api.isCondEventMode()).toBe(false);
    expect(document.getElementById('flowEventHint').style.display).toBe('none');

    api.closeFlowModal();
  });

  it('编辑器保存：事件触发被拒绝时给出可读原因', () => {
    const bad = api.validateFlowDraft({
      name: '事件流',
      trigger: { type: 'event', event: { kind: 'checkin' } },
      condition: { mode: 'all', items: [{ metric: 'checkins', range: 'period', op: '>=', value: 1 }] },
      steps: [noteStep],
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('FLOW_EVENT_BAD_CONDITION');
    expect(bad.message).toContain('本周期');
  });

  it('事件模式下新增分支默认「今天」，保存不会被自己的默认值拒绝', () => {
    seedTask();
    api.openFlowModal();
    document.getElementById('flowName').value = '事件分支流';
    document.getElementById('flowTriggerType').value = 'event-checkin';
    api.flowTriggerChanged();
    api.flowAddBranch('');
    const r = api.handleFlowSave();
    expect(r.ok).toBe(true);
    const saved = api.getState().flows[0];
    expect(saved.trigger).toMatchObject({ type: 'event', event: { kind: 'checkin' } });
    const branch = saved.steps.find(st => st.kind === 'branch');
    expect(branch.when.items[0].range).toBe('today');
    api.closeFlowModal();
  });
});
