// 单实体条件（D1）：归一化 / 求值 / 失联与归档 / 情境缺失的 fail-closed。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
const T = api.dayStartTs(Date.now() + DAY) - 1;
const week = { period: 'week', anchor: 1 };
const item = (over) => Object.assign({
  range: 'total', metric: 'checkins', op: '>=', value: 0,
  targetType: 'all', target: '', newFilter: 'none', aggregate: 'sum',
}, over);
const ent = (kind, id) => kind + ':' + id;

describe('normalizeCondItem：entity 目标', () => {
  it('保留合法 kind:id；非法 kind / 形状不降级成 all，而是 entity + 空目标', () => {
    const ok = api.normalizeCondItem(item({ metric: 'affair_cell', targetType: 'entity', target: 'affair:a1' }));
    expect(ok.targetType).toBe('entity');
    expect(ok.target).toBe('affair:a1');
    expect(ok.newFilter).toBe('none');

    const badKind = api.normalizeCondItem(item({ metric: 'affair_cell', targetType: 'entity', target: 'task:t1' }));
    expect(badKind.targetType).toBe('entity');
    expect(badKind.target).toBe('');

    const badShape = api.normalizeCondItem(item({ metric: 'chore_idle', targetType: 'entity', target: 'a1' }));
    expect(badShape.targetType).toBe('entity');
    expect(badShape.target).toBe('');
  });
});

describe('evalCondItem：项目单实体', () => {
  const affair = () => ({
    id: 'a1', domainId: 'd_default', currentCell: 5, createdAt: T - 20 * DAY,
    alreadyGiven: 12, doneAt: null,
    steps: [
      { id: 's1', text: '一', doneAt: T - 2 * DAY },
      { id: 's2', text: '二', doneAt: null },
    ],
  });

  it('affair_cell 读当前格数（点态）', () => {
    api.resetState({ affairs: [affair()] });
    const q = (v, op) => item({ range: 'today', metric: 'affair_cell', targetType: 'entity', target: ent('affair', 'a1'), op: op || '>=', value: v });
    expect(api.evalCondItem(q(5), week, T)).toBe(true);
    expect(api.evalCondItem(q(6), week, T)).toBe(false);
    expect(api.evalCondItem(q(4, '>'), week, T)).toBe(true);
  });

  it('affair_steps 窗口 / 累计', () => {
    api.resetState({ affairs: [affair()] });
    const q = (range) => item({ range, days: 7, metric: 'affair_steps', targetType: 'entity', target: ent('affair', 'a1'), value: 1 });
    expect(api.evalCondItem(q('recent'), week, T)).toBe(true);
    expect(api.evalCondItem(q('total'), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 1, metric: 'affair_steps', targetType: 'entity', target: ent('affair', 'a1'), value: 1 }), week, T)).toBe(false);
  });

  it('affair_stall 读实体停滞天数', () => {
    const a = affair();
    a.steps = [];
    api.resetState({ affairs: [a] });
    const q = (v) => item({ range: 'today', metric: 'affair_stall', targetType: 'entity', target: ent('affair', 'a1'), value: v });
    expect(api.evalCondItem(q(20), week, T)).toBe(true);
    expect(api.evalCondItem(q(21), week, T)).toBe(false);
  });

  it('affair_progress 读累计字段', () => {
    api.resetState({ affairs: [affair()] });
    const q = (v) => item({ range: 'total', metric: 'affair_progress', targetType: 'entity', target: ent('affair', 'a1'), value: v });
    expect(api.evalCondItem(q(12), week, T)).toBe(true);
    expect(api.evalCondItem(q(13), week, T)).toBe(false);
  });

  it('affair_completed 窗口内完成记 1', () => {
    const a = affair();
    a.doneAt = T - 2 * DAY;
    api.resetState({ affairs: [a] });
    const q = (range, days) => item({ range, days, metric: 'affair_completed', targetType: 'entity', target: ent('affair', 'a1'), value: 1 });
    expect(api.evalCondItem(q('recent', 7), week, T)).toBe(true);
    expect(api.evalCondItem(q('recent', 1), week, T)).toBe(false);
    expect(api.evalCondItem(q('total'), week, T)).toBe(true);
  });
});

describe('evalCondItem：杂事单实体', () => {
  const cyclic = () => ({
    id: 'c1', tags: ['电脑'], done: false,
    cycle: { unit: 'day', interval: 1, anchor: T - 10 * DAY },
    history: [{ ts: T - 2 * DAY, due: T - 2 * DAY, settled: false, tags: ['电脑'] }],
  });

  it('chore_completed 循环按 history 逐条、一次性按 doneAt', () => {
    api.resetState({
      chores: [
        cyclic(),
        { id: 'c2', done: true, doneAt: T - 3 * DAY, tags: [] },
      ],
    });
    const q = (id, range, days) => item({ range, days, metric: 'chore_completed', targetType: 'entity', target: ent('chore', id), value: 1 });
    expect(api.evalCondItem(q('c1', 'recent', 7), week, T)).toBe(true);
    expect(api.evalCondItem(q('c1', 'recent', 1), week, T)).toBe(false);
    expect(api.evalCondItem(q('c2', 'recent', 7), week, T)).toBe(true);
  });

  it('chore_overdue_days 读该杂事超期天数', () => {
    api.resetState({ chores: [{ id: 'c3', done: false, plannedAt: T - 5 * DAY, createdAt: T - 10 * DAY, freshDays: 0 }] });
    const q = (v) => item({ range: 'today', metric: 'chore_overdue_days', targetType: 'entity', target: ent('chore', 'c3'), value: v });
    expect(api.evalCondItem(q(5), week, T)).toBe(true);
    expect(api.evalCondItem(q(6), week, T)).toBe(false);
  });

  it('chore_idle 读该杂事不活跃天数', () => {
    api.resetState({ chores: [{ id: 'c4', done: false, createdAt: T - 10 * DAY }] });
    const q = (v) => item({ range: 'today', metric: 'chore_idle', targetType: 'entity', target: ent('chore', 'c4'), value: v });
    expect(api.evalCondItem(q(10), week, T)).toBe(true);
    expect(api.evalCondItem(q(11), week, T)).toBe(false);
  });

  it('chore_cycle_due_in 读距下次到期天数（过期可为负）', () => {
    api.resetState({ chores: [{ id: 'c5', done: false, cycle: { unit: 'day', interval: 1, anchor: T - 5 * DAY } }] });
    const q = (op, v) => item({ range: 'today', metric: 'chore_cycle_due_in', targetType: 'entity', target: ent('chore', 'c5'), op, value: v });
    expect(api.evalCondItem(q('<', 0), week, T)).toBe(true);
    expect(api.evalCondItem(q('>=', 0), week, T)).toBe(false);
  });
});

describe('实体不存在 / 归档 / 转换', () => {
  it('不存在：无论运算符都判不成立，不用 0 兜底', () => {
    api.resetState({});
    const q = (op, v) => item({ range: 'today', metric: 'affair_cell', targetType: 'entity', target: ent('affair', 'nope'), op, value: v });
    expect(api.evalCondItem(q('>=', 0), week, T)).toBe(false);
    expect(api.evalCondItem(q('<=', 999), week, T)).toBe(false);
    expect(api.evalCondItem(q('<', 1), week, T)).toBe(false);
  });

  it('非法 target 形状同样 fail-closed', () => {
    api.resetState({ affairs: [{ id: 'a1', currentCell: 5, createdAt: T - DAY }] });
    expect(api.evalCondItem(item({ range: 'today', metric: 'affair_cell', targetType: 'entity', target: 'a1', value: 0 }), week, T)).toBe(false);
  });

  it('实体专属指标配非实体目标也 fail-closed（不套聚合读法给 0）', () => {
    api.resetState({ affairs: [{ id: 'a1', currentCell: 5, createdAt: T - DAY }] });
    expect(api.evalCondItem(item({ range: 'today', metric: 'affair_cell', targetType: 'all', target: '', op: '>=', value: 0 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_cycle_due_in', targetType: 'all', target: '', op: '<=', value: 999 }), week, T)).toBe(false);
  });

  it('归档实体照常求值', () => {
    api.resetState({ affairs: [{ id: 'a1', currentCell: 5, createdAt: T - DAY, archived: true }] });
    expect(api.evalCondItem(item({ range: 'today', metric: 'affair_cell', targetType: 'entity', target: ent('affair', 'a1'), value: 5 }), week, T)).toBe(true);
  });

  it('转换后原 kind 不跟随同 id', () => {
    api.resetState({ chores: [{ id: 'x1', done: false, createdAt: T - 3 * DAY }] });
    // 模拟同一 id 已从项目转到杂事：affair:x1 不存在，chore:x1 存在
    expect(api.evalCondItem(item({ range: 'today', metric: 'affair_cell', targetType: 'entity', target: ent('affair', 'x1'), value: 0 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_idle', targetType: 'entity', target: ent('chore', 'x1'), value: 3 }), week, T)).toBe(true);
  });
});

describe('情境缺失：与实体一致的 fail-closed', () => {
  const chores = () => [
    { id: 'c1', tags: ['电脑'], done: true, doneAt: T - 2 * DAY, history: [{ ts: T - 2 * DAY, due: 0, settled: false, tags: ['电脑'] }] },
    { id: 'c2', tags: ['电话'], done: false, createdAt: T - 3 * DAY },
    { id: 'c3', tags: ['新'], cycle: { unit: 'day', interval: 1, anchor: T - 10 * DAY }, history: [{ ts: T - 2 * DAY, due: T - 2 * DAY, settled: false, tags: ['旧'] }] },
  ];

  it('缺失情境不再用 0 兜底：< / <= 也不会为真', () => {
    api.resetState({ chores: chores() });
    const q = (metric, op, v) => item({ range: 'total', metric, targetType: 'tag', target: '不存在', op, value: v });
    expect(api.evalCondItem(q('chore_tag_completed', '<=', 0), week, T)).toBe(false);
    expect(api.evalCondItem(q('chore_tag_completed', '<', 1), week, T)).toBe(false);
    expect(api.evalCondItem(q('chore_tag_overdue', '<=', 0), week, T)).toBe(false);
  });

  it('情境仍存在但窗口内无完成时仍是 0', () => {
    api.resetState({ chores: chores() });
    expect(api.evalCondItem(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '电话', op: '<=', value: 0 }), week, T)).toBe(true);
  });

  it('只存在于历史快照的情境仍算存在并保留归因', () => {
    api.resetState({ chores: chores() });
    expect(api.evalCondItem(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '旧', value: 1 }), week, T)).toBe(true);
  });
});

describe('事件触发编译期：实体点态指标被拒', () => {
  const noteStep = { id: 's1', atom: 'log.note', params: { desc: '事件流记录' } };
  function compile(condition) {
    const flow = api.normalizeFlow({
      id: 'x1', name: '事件流', enabled: true,
      trigger: { type: 'event', event: { kind: 'checkin' } },
      condition: condition,
      steps: [noteStep],
    });
    return api.FlowEngine.compile(flow);
  }

  it('affair_cell（点态）被拒，affair_steps（窗口）可编译', () => {
    const point = compile({ mode: 'all', items: [
      { metric: 'affair_cell', range: 'today', op: '>=', value: 5, targetType: 'entity', target: 'affair:a1' },
    ] });
    expect(point.ok).toBe(false);
    expect(point.errors.map(e => e.code)).toContain('FLOW_EVENT_POINT_METRIC');

    const windowed = compile({ mode: 'all', items: [
      { metric: 'affair_steps', range: 'today', op: '>=', value: 1, targetType: 'entity', target: 'affair:a1' },
    ] });
    expect(windowed.ok).toBe(true);
  });
});
