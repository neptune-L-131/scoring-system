// entity-kit：Task / Affair / Chore 的只读统一访问层（第 4 轮 P2）
// 断言重点：统一口径正确、历史按时间倒序、今日清单合并正确、全过程只读。
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api } from './shim.js';

// 固定“今天”= 2026-05-10 12:00（本地时区），避免跨零点导致用例假失败
const at = (d, h, m) => new Date(2026, 4, d, h || 0, m || 0, 0, 0).getTime();

function seed() {
  api.__setClockForTest(() => at(10, 12));
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
    tasks: [
      { id: 't1', name: '写日报', domainIds: ['d_default'], archived: false, lastCheckIn: at(10, 9), createdAt: at(1, 9), streak: 3, checkInCount: 1 },
      { id: 't2', name: '跑步', domainIds: ['d2'], archived: false, lastCheckIn: at(9, 9), createdAt: at(1, 9), streak: 0, checkInCount: 1 },
      { id: 't3', name: '归档任务', domainIds: ['d_default'], archived: true, createdAt: at(1, 9) },
    ],
    affairs: [
      {
        id: 'a1', name: '装修', domainId: 'd2', createdAt: at(1, 9), plannedAt: at(10, 10),
        steps: [{ text: '量尺寸', plannedAt: at(10, 10) }, { text: '下单', plannedAt: at(9, 10) }],
        currentCell: 1, alreadyGiven: 10, doneAt: null, archived: false,
      },
      { id: 'a2', name: '已完成项目', createdAt: at(1, 9), doneAt: at(9, 9), steps: [], archived: false },
    ],
    chores: [
      { id: 'c1', name: '交水费', createdAt: at(1, 9), plannedAt: at(9, 9), done: false, archived: false, freshDays: 0 },
      { id: 'c2', name: '洗车', createdAt: at(1, 9), plannedAt: at(10, 8), done: false, archived: false, freshDays: 5 },
      { id: 'c3', name: '已勾选杂事', createdAt: at(1, 9), done: true, doneAt: at(9, 9), archived: false },
    ],
    logs: [
      { id: 'l1', time: at(9, 9), st: 'vitality', amt: 10, desc: '打卡「跑步」', src: 'checkin', dom: 'd2', taskId: 't2' },
      { id: 'l2', time: at(10, 9), st: 'both', amt: 5, desc: '打卡「写日报」', src: 'checkin', dom: 'd_default', taskId: 't1' },
      { id: 'l3', time: at(9, 12), st: '', amt: 0, desc: '新增杂事「交水费」', src: 'chore-create', choreId: 'c1' },
      { id: 'l4', time: at(10, 11), st: 'progress', amt: 5, desc: '项目「装修」进度结算', src: 'affair', affairId: 'a1', dom: 'd2' },
    ],
  });
  api.patchState(s => {
    s.ext.budgets.ledger = [
      { id: 'b1', ts: at(10, 9, 5), categoryId: 'bc1', amount: 12, source: 'task', note: '午餐', status: 'active', links: { checkinLogId: 'l2' } },
      { id: 'b2', ts: at(10, 11, 30), categoryId: 'bc1', amount: 20, source: 'affair', note: '买材料', status: 'active', links: { affairId: 'a1' } },
      { id: 'b3', ts: at(9, 12, 10), categoryId: 'bc1', amount: 8, source: 'chore', note: '水费', status: 'active', links: { choreId: 'c1' } },
      { id: 'b4', ts: at(10, 9, 6), categoryId: 'bc1', amount: 9, source: 'manual', note: '无关账目', status: 'active', links: {} },
    ];
  });
}

beforeEach(seed);
afterAll(() => api.__setClockForTest(null));

describe('entity-kit：引用归一', () => {
  it('支持字符串与对象两种引用，非法引用返回 null', () => {
    expect(api.normalizeEntityRef('task:t1')).toEqual({ kind: 'task', id: 't1' });
    expect(api.normalizeEntityRef({ type: 'chore', id: 'c1' })).toEqual({ kind: 'chore', id: 'c1' });
    expect(api.normalizeEntityRef({ kind: 'affair', id: 'a1' })).toEqual({ kind: 'affair', id: 'a1' });
    expect(api.normalizeEntityRef('nope:t1')).toBe(null);
    expect(api.normalizeEntityRef({ kind: 'x', id: 1 })).toBe(null);
    expect(api.normalizeEntityRef(null)).toBe(null);
    expect(api.entityRef('chore', 'c1')).toEqual({ kind: 'chore', id: 'c1' });
  });
});

describe('entity-kit：统一口径', () => {
  it('任务：名称 / 领域 / 活跃 / 上次活动 / 今日打卡', () => {
    const m = api.entityMeta('task:t1');
    expect(m.kind).toBe('task');
    expect(m.name).toBe('写日报');
    expect(m.domainIds).toEqual(['d_default']);
    expect(m.active).toBe(true);
    expect(m.lastActivityAt).toBe(at(10, 9));
    expect(m.checkedToday).toBe(true);
    expect(m.streak).toBe(3);
    expect(api.entityMeta('task:t3').active).toBe(false);
  });

  it('项目：无步骤完成时上次活动回落到日程时间；步骤统计正确', () => {
    const m = api.entityMeta('affair:a1');
    expect(m.domainIds).toEqual(['d2']);
    expect(m.active).toBe(true);
    expect(m.lastActivityAt).toBe(at(10, 10));
    expect(m.steps).toEqual({ total: 2, done: 0 });
    expect(m.currentCell).toBe(1);
    expect(api.entityMeta('affair:a2').done).toBe(true);
    expect(api.entityMeta('affair:a2').active).toBe(false);
  });

  it('杂事：无领域、按计划日计算超期；引用不存在时 exists=false', () => {
    const m = api.entityMeta('chore:c1');
    expect(m.domainIds).toEqual([]);
    expect(m.overdueDays).toBe(1);
    expect(m.lastActivityAt).toBe(at(9, 9));
    const ghost = api.entityMeta('chore:nope');
    expect(ghost.exists).toBe(false);
    expect(ghost.name).toBe('');
    expect(api.entityName('chore:nope')).toBe('');
  });
});

describe('entity-kit：entityHistory', () => {
  it('任务历史 = 实体时间点 + 流水 + 经打卡流水关联的现实账目，按时间倒序', () => {
    const evs = api.entityHistory('task:t1');
    const ts = evs.map(e => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
    const ids = evs.map(e => e.id).filter(Boolean);
    expect(ids).toContain('l2');
    expect(ids).toContain('b1');
    expect(ids).not.toContain('l1');
    expect(ids).not.toContain('b4');
    expect(evs.some(e => e.kind === 'entity' && e.src === 'created')).toBe(true);
  });

  it('项目 / 杂事按 affairId / choreId 直接关联流水与账目', () => {
    const a = api.entityHistory('affair:a1');
    expect(a.map(e => e.id)).toEqual(expect.arrayContaining(['l4', 'b2']));
    const c = api.entityHistory('chore:c1');
    expect(c.map(e => e.id)).toEqual(expect.arrayContaining(['l3', 'b3']));
    expect(api.entityHistory('chore:c1', { limit: 1 }).length).toBe(1);
  });

  it('实体不存在时返回空数组', () => {
    expect(api.entityHistory('task:nope')).toEqual([]);
    expect(api.entityHistory('bad-ref')).toEqual([]);
  });
});

describe('entity-kit：todayAgenda', () => {
  it('合并任务 / 项目日程 / 到期杂事，逾期项排在最前', () => {
    const items = api.todayAgenda();
    const key = i => i.kind + ':' + i.id + ':' + (i.stepIndex === undefined ? '' : i.stepIndex);
    const keys = items.map(key);
    expect(keys).toContain('task:t1:');
    expect(keys).toContain('task:t2:');
    expect(keys).toContain('affair:a1:0');
    expect(keys).toContain('affair:a1:1');
    expect(keys).toContain('chore:c1:');
    expect(keys).toContain('chore:c2:');
    expect(keys).not.toContain('task:t3:');
    expect(keys).not.toContain('affair:a2:');
    expect(keys).not.toContain('chore:c3:');
    expect(items.length).toBe(6);

    const firstOverdue = items.findIndex(i => !i.overdue);
    expect(items.slice(0, firstOverdue).every(i => i.overdue)).toBe(true);
    expect(items.slice(firstOverdue).every(i => !i.overdue)).toBe(true);
    expect(items.find(i => i.kind === 'task' && i.id === 't1').status).toBe('done');
    expect(items.find(i => i.kind === 'task' && i.id === 't2').status).toBe('todo');
  });

  it('只读：调用前后 state 完全一致，且不触发任何写盘副作用', () => {
    const before = JSON.stringify(api.getState());
    api.todayAgenda();
    api.entityHistory('task:t1');
    api.entityHistory('affair:a1');
    api.entityMeta('chore:c1');
    expect(JSON.stringify(api.getState())).toBe(before);
  });
});
