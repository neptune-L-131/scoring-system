// 条件求值：evalNode / evalCondItem / 指标取值 / 商品门槛翻译。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const DAY = 864e5;
// 固定在“今天 23:59:59.999”：测试期间新建的流水（time=now）一定落在窗口内，
// 同时日期窗口仍是今天，避免跑到午夜附近时出现假失败。
const T = api.dayStartTs(Date.now() + DAY) - 1;
const week = { period: 'week', anchor: 1 };
const item = (over) => Object.assign({ range: 'total', metric: 'checkins', op: '>=', value: 0, targetType: 'all', target: '', newFilter: 'none', aggregate: 'sum' }, over);
const leafPass = item({ value: 0 });
const leafFail = item({ value: 999 });

describe('evalNode：条件树组合', () => {
  it('空组恒为真', () => {
    expect(api.evalNode({ group: true, mode: 'all', items: [] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'any', items: [] }, week, T)).toBe(true);
  });

  it('all / any 语义', () => {
    expect(api.evalNode({ group: true, mode: 'all', items: [leafPass, leafPass] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'all', items: [leafPass, leafFail] }, week, T)).toBe(false);
    expect(api.evalNode({ group: true, mode: 'any', items: [leafPass, leafFail] }, week, T)).toBe(true);
    expect(api.evalNode({ group: true, mode: 'any', items: [leafFail, leafFail] }, week, T)).toBe(false);
  });

  it('嵌套组按层求值', () => {
    const node = {
      group: true, mode: 'any', items: [
        { group: true, mode: 'all', items: [leafFail, leafPass] },
        leafPass,
      ],
    };
    expect(api.evalNode(node, week, T)).toBe(true);
  });

  it('未知 mode 回落 all', () => {
    expect(api.evalNode({ group: true, mode: 'weird', items: [leafPass, leafFail] }, week, T)).toBe(false);
  });
});

describe('opSatisfied：比较符', () => {
  it('默认按 >= 处理未知比较符', () => {
    expect(api.opSatisfied(3, '>', 2)).toBe(true);
    expect(api.opSatisfied(2, '>', 2)).toBe(false);
    expect(api.opSatisfied(2, '<', 3)).toBe(true);
    expect(api.opSatisfied(3, '<=', 3)).toBe(true);
    expect(api.opSatisfied(3, '>=', 3)).toBe(true);
    expect(api.opSatisfied(3, 'bogus', 3)).toBe(true);
  });
});

describe('evalCondItem：累计与窗口', () => {
  it('累计打卡次数 = 各任务 checkInCount 之和', () => {
    api.resetState({ tasks: [{ id: 't1', checkInCount: 2 }, { id: 't2', checkInCount: 3 }] });
    expect(api.evalCondItem(item({ metric: 'checkins', value: 5 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ metric: 'checkins', value: 6 }), week, T)).toBe(false);
  });

  it('今日/最近 N 天读统计日桶', () => {
    api.resetState();
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test' } });
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', value: 10 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', value: 11 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'vitality', value: 10 }), week, T)).toBe(true);
  });

  it('主体筛选：按任务与按领域', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
      tasks: [{ id: 't1', name: '任务一', domainIds: ['d2'] }],
    });
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 6, reason: { src: 'test', taskId: 't1' } });
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'task', target: 't1', value: 6 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'task', target: 't1', value: 7 }), week, T)).toBe(false);
    // 流水没有 dom 时按任务领域归属 d2
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'domain', target: 'd2', value: 6 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'vitality', targetType: 'domain', target: 'd_default', value: 1 }), week, T)).toBe(false);
  });

  it('aggreggate=any：任一实体满足即可', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
      tasks: [
        { id: 't1', name: 'a', domainIds: ['d_default'] },
        { id: 't2', name: 'b', domainIds: ['d2'] },
      ],
    });
    api.Ledger.post({ op: 'grant', account: 'vitality', delta: 5, reason: { src: 'test', taskId: 't2' } });
    const base = { range: 'today', metric: 'vitality', targetType: 'task', aggregate: 'any', value: 5 };
    // 未指定 target 时“任一任务”仍成立（t2 今天 +5）
    expect(api.evalCondItem(item(Object.assign({}, base, { target: '' })), week, T)).toBe(true);
    expect(api.evalCondItem(item(Object.assign({}, base, { target: 't2' })), week, T)).toBe(true);
    expect(api.evalCondItem(item(Object.assign({}, base, { target: 't1' })), week, T)).toBe(false);
  });

  it('新增任务 / 新增领域按 createdAt 计窗口', () => {
    api.resetState({
      tasks: [{ id: 't1', createdAt: T - DAY }, { id: 't0', createdAt: T - 30 * DAY }],
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二', createdAt: T - DAY }],
    });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_tasks', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_tasks', value: 2 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_domains', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'new_domains', value: 2 }), week, T)).toBe(false);
  });
});

describe('evalCondItem：预算指标走 BudgetEngine 注入的上下文', () => {
  const act = { period: 'week', anchor: 1, budgetCtx: { entryAmount: 30, spent: 120, overspend: 20, entryCount: 3 } };
  it('四个预算指标只读上下文', () => {
    const q = (metric, value) => api.evalCondItem(item({ range: 'period', metric, value }), act, T);
    expect(q('budget_entry_amount', 30)).toBe(true);
    expect(q('budget_entry_amount', 31)).toBe(false);
    expect(q('budget_period_spent', 120)).toBe(true);
    expect(q('budget_period_overspend', 20)).toBe(true);
    expect(q('budget_entry_count', 3)).toBe(true);
  });

  it('没有上下文时预算指标按 0 处理', () => {
    expect(api.evalCondItem(item({ range: 'period', metric: 'budget_entry_amount', value: 1 }), week, T)).toBe(false);
  });

  it('混合币种：金额指标 fail-closed，笔数照常可用', () => {
    const mixed = {
      period: 'week', anchor: 1,
      budgetCtx: { entryAmount: 30, spent: 120, overspend: 20, entryCount: 3, currency: null, mixed: true },
    };
    const q = (metric, value) => api.evalCondItem(item({ range: 'period', metric, value }), mixed, T);
    expect(q('budget_entry_amount', 0)).toBe(false);
    expect(q('budget_period_spent', 0)).toBe(false);
    expect(q('budget_period_overspend', 0)).toBe(false);
    expect(q('budget_entry_count', 3)).toBe(true);
  });
});

describe('evalCondItem：阶段 1 指标（项目 / 杂事 / 不活跃）', () => {
  it('task_idle 取未归档任务的最大不活跃天数', () => {
    api.resetState({
      tasks: [
        { id: 't1', lastCheckIn: T - 20 * DAY },
        { id: 't2', lastCheckIn: T - 3 * DAY },
        { id: 't3', lastCheckIn: T - 50 * DAY, archived: true },
      ],
    });
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', value: 20 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', value: 21 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'today', metric: 'task_idle', targetType: 'task', target: 't2', value: 3 }), week, T)).toBe(true);
  });

  it('chore_overdue 数未完成且超期的杂事', () => {
    api.resetState({
      chores: [
        { id: 'c1', done: false, createdAt: T - 10 * DAY, freshDays: 0 },
        { id: 'c2', done: true, createdAt: T - 10 * DAY, freshDays: 0 },
        { id: 'c3', done: false, createdAt: T - DAY, freshDays: 7 },
      ],
    });
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_overdue', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_overdue', value: 2 }), week, T)).toBe(false);
  });

  it('affair_completed / affair_steps 窗口统计', () => {
    api.resetState({
      affairs: [
        { id: 'a1', doneAt: T - 3600e3, steps: [{ text: 'x', doneAt: T - 3600e3 }, { text: 'y' }] },
        { id: 'a2', doneAt: T - 30 * DAY, steps: [] },
      ],
    });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_completed', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_completed', value: 2 }), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_completed', value: 2 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'affair_steps', value: 1 }), week, T)).toBe(true);
  });

  it('chore_completed / chore_decay / chore_batches', () => {
    api.resetState({
      chores: [{ id: 'c1', done: true, doneAt: T - 3600e3 }, { id: 'c2', done: true, doneAt: T - 20 * DAY }],
    });
    api.Ledger.event('杂事腐化', 'chore-decay', { amt: -5 });
    api.Ledger.event('批量结算', 'chore-batch', { amt: 0 });
    api.Ledger.event('批量结算', 'chore-batch', { amt: 0 });
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_completed', value: 1 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'total', metric: 'chore_completed', value: 2 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_decay', value: 5 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_batches', value: 2 }), week, T)).toBe(true);
  });

  it('chore_completed 循环杂事按完成记录逐条计数（不被 doneAt 覆盖）', () => {
    api.resetState({
      chores: [{
        id: 'c1', done: true, doneAt: T - 3600e3,
        cycle: { unit: 'day', interval: 1, anchor: T - 10 * DAY, nextDue: T + DAY, lastDue: T - 8 * DAY },
        history: [
          { ts: T - 8 * DAY, due: T - 8 * DAY, settled: true },
          { ts: T - 6 * DAY, due: T - 6 * DAY, settled: true },
          { ts: T - 3600e3, due: T - 2 * DAY, settled: false },
        ],
      }, { id: 'c2', done: true, doneAt: T - 20 * DAY }],
    });
    // 最近 7 天：循环 2 条（T-8 天那条在窗口外）+ 一次性 0 条
    expect(api.evalCondItem(item({ range: 'recent', days: 7, metric: 'chore_completed', value: 2 }), week, T)).toBe(true);
    // 累计：循环 3 条 + 一次性 1 条
    expect(api.evalCondItem(item({ range: 'total', metric: 'chore_completed', value: 4 }), week, T)).toBe(true);
  });

  it('affair_progress 累计口径读实体字段（不受日志截断影响）', () => {
    api.resetState({
      affairs: [
        { id: 'a1', domainId: 'd_default', alreadyGiven: 12 },
        { id: 'a2', domainId: 'd_default', alreadyGiven: 8 },
      ],
    });
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_progress', value: 20 }), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'total', metric: 'affair_progress', value: 21 }), week, T)).toBe(false);
  });
});

describe('evalCondItem：情境指标', () => {
  it('chore_tag_overdue 只数当前超期且带该情境的未归档杂事', () => {
    api.resetState({
      chores: [
        { id: 'c1', done: false, createdAt: T - 10 * DAY, freshDays: 0, tags: ['@电脑'] },
        { id: 'c2', done: false, createdAt: T - 10 * DAY, freshDays: 0, tags: ['电话'] },
        { id: 'c3', done: false, createdAt: T - DAY, freshDays: 7, tags: ['电脑'] },
        { id: 'c4', done: false, createdAt: T - 10 * DAY, freshDays: 0, tags: ['电脑'], archived: true },
      ],
    });
    const q = (target) => item({ range: 'today', metric: 'chore_tag_overdue', targetType: 'tag', target, value: 1 });
    expect(api.evalCondItem(q('电脑'), week, T)).toBe(true);
    expect(api.evalCondItem(q('PC'), week, T)).toBe(false);
    expect(api.evalCondItem(item({ range: 'today', metric: 'chore_tag_overdue', targetType: 'tag', target: '电脑', value: 2 }), week, T)).toBe(false);
    expect(api.evalCondItem(q(''), week, T)).toBe(false);
  });

  it('chore_tag_completed 按每条完成记录的标签快照分别归因', () => {
    api.resetState({
      chores: [{
        id: 'c1', tags: ['电话'], done: false,
        cycle: { unit: 'day', interval: 1, anchor: T - 10 * DAY },
        history: [
          { ts: T - 3 * DAY, due: T - 3 * DAY, settled: true, tags: ['电脑'] },
          { ts: T - 2 * DAY, due: T - 2 * DAY, settled: true, tags: ['电话'] },
        ],
      }],
    });
    const q = (target, range, days) => item({ range, days, metric: 'chore_tag_completed', targetType: 'tag', target, value: 1 });
    expect(api.evalCondItem(q('电脑', 'total'), week, T)).toBe(true);
    expect(api.evalCondItem(q('电话', 'total'), week, T)).toBe(true);
    expect(api.evalCondItem(q('电脑', 'recent', 7), week, T)).toBe(true);
    expect(api.evalCondItem(item({ range: 'recent', days: 1, metric: 'chore_tag_completed', targetType: 'tag', target: '电脑', value: 1 }), week, T)).toBe(false);
  });

  it('一次性杂事优先用最近完成记录的标签快照', () => {
    api.resetState({
      chores: [{
        id: 'c1', done: true, doneAt: T - 2 * DAY, tags: ['电话'],
        history: [{ ts: T - 2 * DAY, due: 0, settled: false, tags: ['电脑'] }],
      }],
    });
    const q = (target) => item({ range: 'recent', days: 7, metric: 'chore_tag_completed', targetType: 'tag', target, value: 1 });
    expect(api.evalCondItem(q('电脑'), week, T)).toBe(true);
    expect(api.evalCondItem(q('电话'), week, T)).toBe(false);
  });

  it('旧记录两条归因路径：迁移快照（当前行为）冻结；快照缺失时回落当前标签', () => {
    api.resetState({
      chores: [{
        id: 'c1', name: '旧循环', tags: ['电脑'],
        cycle: { unit: 'day', interval: 1, anchor: T - 10 * DAY },
        history: [{ ts: T - 2 * DAY, due: T - 2 * DAY, settled: false }],
      }],
    });
    // 走真实读档路径：升级前无 tags 键的旧条目，迁移时按当时标签反填快照
    const loaded = api.parseState(JSON.stringify(api.getState()));
    api.setState(loaded);
    const c = api.getLive().chores[0];
    expect(c.history[0].tags).toEqual(['电脑']);
    // 当前行为：之后改标签不回溯历史，完成数仍归到升级时的「电脑」
    c.tags = ['电话'];
    const q = (target) => item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target, value: 1 });
    expect(api.evalCondItem(q('电脑'), week, T)).toBe(true);
    expect(api.evalCondItem(q('电话'), week, T)).toBe(false);
    // 异常路径：快照缺失（未经历迁移）时，求值层按当前标签归因，不会静默计 0
    c.history = [{ ts: T - 2 * DAY, due: T - 2 * DAY, settled: false }];
    expect(api.evalCondItem(q('电话'), week, T)).toBe(true);
    expect(api.evalCondItem(q('电脑'), week, T)).toBe(false);
  });

  it('条件项归一化保留 tag 主体；文案显示情境名与失效提示', () => {
    const it = api.normalizeCondItem(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '电脑' }));
    expect(it.targetType).toBe('tag');
    expect(it.target).toBe('电脑');
    api.resetState({ chores: [{ id: 'c1', tags: ['@电脑'] }] });
    expect(api.condItemLabel(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '电脑' }))).toContain('情境「@电脑」');
    expect(api.condItemLabel(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '不存在' }))).toContain('已不存在');
  });

  it('情境完成数的展示收短为「完成数」，主体与指标键不变', () => {
    api.resetState({ chores: [{ id: 'c1', tags: ['@电脑'] }] });
    const label = api.condItemLabel(item({ range: 'total', metric: 'chore_tag_completed', targetType: 'tag', target: '电脑', value: 2 }));
    expect(label).toContain('情境「@电脑」');
    expect(label).toContain('·完成数');
    expect(label).not.toContain('带情境的杂事完成数');
  });
});

describe('商品门槛：三段式兼容层', () => {
  it('日常级永远可买', () => {
    expect(api.evaluateProductGate({ tier: 'daily', gate: { minLifetime: 999 } })).toMatchObject({ ok: true, deny: false, tier: 'daily' });
  });

  it('品质级把 minLifetime 与领域活跃度翻译成两条叶子', () => {
    const gate = { minLifetime: 5, activity: { domainId: 'd_default', days: 7, times: 3 } };
    const cond = api.gateConditionOf(gate, 'quality');
    expect(cond.items).toHaveLength(2);
    expect(cond.items[0]).toMatchObject({ metric: 'lifetime_achievement', op: '>=', value: 5, range: 'total' });
    expect(cond.items[1]).toMatchObject({ metric: 'domain_activity', value: 3, days: 7, targetType: 'domain', target: 'd_default', range: 'recent' });
  });

  it('专属级即使没绑里程碑也保留一条必失败叶子', () => {
    const cond = api.gateConditionOf({ milestoneId: '' }, 'exclusive');
    expect(cond.items).toHaveLength(1);
    expect(cond.items[0]).toMatchObject({ metric: 'milestone_unlocked', target: '' });
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: {} }).deny).toBe(true);
  });

  it('条件树存在时优先于三段式字段', () => {
    const gate = {
      minLifetime: 999,
      condition: { mode: 'all', items: [{ range: 'total', metric: 'checkins', op: '>=', value: 0 }] },
    };
    expect(api.evaluateProductGate({ tier: 'quality', gate }).ok).toBe(true);
  });

  it('里程碑已解锁时可购买；引用不存在的里程碑则拒绝', () => {
    api.resetState({ achievements: [{ id: 'a1', name: '里程碑', unlocked: true, threshold: 0, points: 1 }] });
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: { milestoneId: 'a1' } }).ok).toBe(true);
    expect(api.evaluateProductGate({ tier: 'exclusive', gate: { milestoneId: 'nope' } }).deny).toBe(true);
  });

  it('领域活跃度读活跃度索引，不受日志截断影响', () => {
    api.resetState();
    api.noteCheckinActivity(['d_default'], 1, T);
    const gate = { activity: { domainId: 'd_default', days: 7, times: 1 } };
    expect(api.evaluateProductGate({ tier: 'quality', gate }).ok).toBe(true);
    const need3 = { activity: { domainId: 'd_default', days: 7, times: 3 } };
    const r = api.evaluateProductGate({ tier: 'quality', gate: need3 });
    expect(r.deny).toBe(true);
    expect(r.reasons.join('')).toContain('领域');
  });

  it('any 组整体失败时合并成一条原因', () => {
    api.resetState();
    const gate = {
      condition: {
        mode: 'any',
        items: [
          { range: 'total', metric: 'checkins', op: '>=', value: 5 },
          { range: 'total', metric: 'achievement', op: '>=', value: 5 },
        ],
      },
    };
    const r = api.evaluateProductGate({ tier: 'quality', gate });
    expect(r.deny).toBe(true);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('满足任一');
  });
});

describe('门槛点态指标', () => {
  it('lifetime_achievement 读单调累计字段', () => {
    api.resetState();
    api.patchState(s => { s.ext.stats.lifetimeAchievementEarned = 42; });
    expect(api.pointMetricValue('lifetime_achievement', { targetType: 'all' }, T)).toBe(42);
  });

  it('checkin_streak 取未归档任务最大连胜', () => {
    api.resetState({
      tasks: [
        { id: 't1', streak: 4 },
        { id: 't2', streak: 9 },
        { id: 't3', streak: 99, archived: true },
      ],
    });
    expect(api.pointMetricValue('checkin_streak', { targetType: 'all' }, T)).toBe(9);
  });
});

describe('资产类指标', () => {
  const at = (m, d, h) => new Date(2026, m, d, h || 12, 0, 0, 0).getTime();
  const T0 = at(4, 10); // 2026-05-10 周日；周锚点 1 的上一周期是 04-27 ~ 05-04
  const inPrev = at(3, 30);
  const assetItem = (over) => Object.assign({ range: 'total', metric: 'asset_hold', op: '>=', value: 1, targetType: 'asset', target: 'star', newFilter: 'none', aggregate: 'sum' }, over);

  function seed() {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      cards: { star: 4, old: 2 },
      assetDefs: [
        api.normalizeAssetDef({ id: 'star', name: '星星', unit: '颗', enabled: true }),
        api.normalizeAssetDef({ id: 'old', name: '旧券', unit: '张', enabled: false, archived: true }),
      ],
    });
    api.patchState(s => {
      s.logs.unshift(
        { id: 'g1', time: inPrev, st: 'card', amt: 2, desc: '发 2', src: 'flow-asset-grant', card: 'star' },
        { id: 'g2', time: inPrev + 1000, st: 'card', amt: 1, desc: '发 1', src: 'flow-asset-grant', card: 'star' },
        { id: 's1', time: inPrev + 2000, st: 'card', amt: -1, desc: '耗 1', src: 'flow-asset-spend', card: 'star' },
        { id: 'x1', time: inPrev + 3000, st: 'card', amt: 9, desc: '别的资产', src: 'flow-asset-grant', card: 'other' },
        { id: 'v1', time: inPrev + 4000, st: 'vitality', amt: 5, desc: '活力', src: 'flow-currency-grant' }
      );
      // 旧版豁免：不可见消耗，只留隐形调整记录
      s.ext.shadow.unshift({ id: 'sh1', ts: inPrev + 5000, acct: 'card:star', delta: -1, before: 5, after: 4, src: 'exempt-use', label: '旧版豁免' });
    });
  }

  it('持有数量读余额；停用/归档仍可取值', () => {
    seed();
    expect(api.evalCondItem(assetItem({ value: 4 }), week, T0)).toBe(true);
    expect(api.evalCondItem(assetItem({ value: 5 }), week, T0)).toBe(false);
    expect(api.evalCondItem(assetItem({ target: 'old', value: 2 }), week, T0)).toBe(true);
  });

  it('发放/消耗按窗口汇总，只统计目标资产', () => {
    seed();
    expect(api.evalCondItem(assetItem({ metric: 'asset_issued', range: 'period', value: 3 }), week, T0)).toBe(true);
    expect(api.evalCondItem(assetItem({ metric: 'asset_issued', range: 'period', value: 4 }), week, T0)).toBe(false);
    // 可见消耗 1 + 旧版豁免隐形消耗 1
    expect(api.evalCondItem(assetItem({ metric: 'asset_spent', range: 'period', value: 2 }), week, T0)).toBe(true);
    expect(api.evalCondItem(assetItem({ metric: 'asset_spent', range: 'period', value: 3 }), week, T0)).toBe(false);
  });

  it('撤销补账（手动调整）不计入发放/消耗', () => {
    seed();
    api.patchState(s => {
      s.ext.shadow.unshift({ id: 'sh2', ts: inPrev + 6000, acct: 'card:star', delta: 3, before: 4, after: 7, src: 'undo-flow', label: '撤销发放' });
    });
    expect(api.evalCondItem(assetItem({ metric: 'asset_issued', range: 'period', value: 3 }), week, T0)).toBe(true);
    expect(api.evalCondItem(assetItem({ metric: 'asset_spent', range: 'period', value: 2 }), week, T0)).toBe(true);
  });

  it('未选择资产返回 NaN，条件恒假（不冒充 0）', () => {
    seed();
    expect(Number.isNaN(api.assetMetricValue('asset_hold', { target: '' }, { start: 0, end: T0 }))).toBe(true);
    expect(api.evalCondItem(assetItem({ target: '', value: 0 }), week, T0)).toBe(false);
  });

  it('文案：持有数量按点态展示，发放/消耗带范围前缀', () => {
    expect(api.condItemLabel(assetItem({ range: 'today', value: 2 }))).toBe('星星·持有数量 ≥ 2');
    expect(api.condItemLabel(assetItem({ range: 'period', metric: 'asset_issued', value: 3 }))).toContain('星星·已发放数量');
    expect(api.condItemLabel(assetItem({ target: 'gone' }))).toContain('（资产已删除）');
  });

  it('归一化保留资产主体；事件触发可编译（持有数量）', () => {
    seed();
    const cond = api.normalizeCondNode({ group: true, mode: 'all', items: [assetItem({ range: 'today' })] });
    expect(cond.items[0].targetType).toBe('asset');
    expect(cond.items[0].target).toBe('star');
    api.patchState(s => {
      s.flows.push(api.normalizeFlow({
        id: 'f_evt', name: '事件流', trigger: { type: 'event', event: { kind: 'checkin' } },
        condition: { mode: 'all', items: [assetItem({ range: 'today', value: 1 })] },
        steps: [{ id: 's', atom: 'log.note', params: { desc: 'ok' } }],
      }));
    });
    const r = api.FlowEngine.runFlow('f_evt', { trigger: 'event', ts: T0, event: { key: 'evt1' } });
    expect(r.ok).toBe(true);
  });
});

