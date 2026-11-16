// S4：动作流编译、静态校验、单事务执行与周期调度。
// 覆盖：分支、步数上限、引用非法、回滚、幂等、条件不成立后重触发。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const opts = { save: 'none', render: false, label: 'flow-test' };
const T = Date.UTC(2026, 0, 5, 12); // 2026-01-05（周一）
const WEEK = 7 * 864e5;

const TRUE_COND = () => ({ mode: 'all', items: [{ metric: 'lifetime_achievement', op: '>=', value: 0, range: 'total' }] });
const FALSE_COND = () => ({ mode: 'all', items: [{ metric: 'lifetime_achievement', op: '>=', value: 1, range: 'total' }] });

function addFlow(raw) {
  const f = api.normalizeFlow(Object.assign({ id: 'f1', name: '周常流' }, raw));
  api.patchState(s => { s.flows.push(f); });
  return f;
}
function addAsset(extra) {
  api.patchState(s => {
    s.assetDefs.push(api.normalizeAssetDef(Object.assign({
      id: 'star', name: '星星', unit: '颗', maxBalance: 10, origin: 'user',
    }, extra || {})));
  });
}
function grant(id, amount, extra) {
  return Object.assign({ id: id, atom: 'currency.grant', params: { account: 'vitality', amount: amount } }, extra || {});
}
function codes(flow) {
  const c = api.FlowEngine.compile(flow);
  return c.errors.map(e => e.code);
}
function live() { return api.getLive(); }

beforeEach(() => {
  api.resetState();
  globalThis.document.getElementById('toastWrap').children.length = 0;
});

describe('编译：结构 / 步数 / 深度 / 原子 / 引用', () => {
  it('合法流编译通过，并统计总步数', () => {
    addAsset();
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 2, { as: 'v' }),
        { id: 's2', atom: 'asset.grant', params: { assetId: 'star', amount: 1 } },
        { id: 's3', atom: 'currency.grant', params: { account: 'achievement', amount: { ref: 'v.amount' } } },
      ],
    });
    const c = api.FlowEngine.compile(f);
    expect(c.ok).toBe(true);
    expect(c.plan.totalSteps).toBe(3);
  });

  it('拒绝：空步骤 / 超过步数上限', () => {
    expect(codes(addFlow({ steps: [] }))).toContain('FLOW_NO_STEPS');
    const f = addFlow({ limits: { maxSteps: 2 }, steps: [grant('s1', 1), grant('s2', 1), grant('s3', 1)] });
    expect(codes(f)).toContain('FLOW_STEP_LIMIT');
  });

  it('拒绝：分支深度超过 3', () => {
    const leaf = { id: 'a0', atom: 'log.note', params: { desc: 'x' } };
    let node = { id: 'b3', kind: 'branch', when: TRUE_COND(), then: [leaf] };
    node = { id: 'b2', kind: 'branch', when: TRUE_COND(), then: [node] };
    node = { id: 'b1', kind: 'branch', when: TRUE_COND(), then: [node] };
    node = { id: 'b0', kind: 'branch', when: TRUE_COND(), then: [node] };
    expect(codes(addFlow({ steps: [node] }))).toContain('FLOW_DEPTH_LIMIT');
  });

  it('拒绝：未知原子 / 未知步骤字段 / 重复 id', () => {
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'entity.patch', params: {} }] }))).toContain('FLOW_UNKNOWN_ATOM');
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'log.note', params: { desc: 'x' }, foo: 1 }] }))).toContain('FLOW_BAD_STEP');
    expect(codes(addFlow({ steps: [grant('s1', 1), grant('s1', 2)] }))).toContain('FLOW_BAD_STEP');
  });

  it('拒绝：前向引用 / 自引用 / 引用无输出字段的步骤', () => {
    // 前向引用
    expect(codes(addFlow({
      steps: [
        { id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 's2.amount' } }, as: 'x' },
        grant('s2', 2),
      ],
    }))).toContain('FLOW_BAD_REF');
    // 自引用
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 's1.amount' } } }] })))
      .toContain('FLOW_BAD_REF');
    // log.note 没有数值输出
    expect(codes(addFlow({
      steps: [
        { id: 'n1', atom: 'log.note', params: { desc: 'x' }, as: 'n' },
        { id: 's2', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 'n.count' } } },
      ],
    }))).toContain('FLOW_BAD_REF');
  });

  it('拒绝：分支内输出被引用但未带默认值', () => {
    expect(codes(addFlow({
      steps: [
        { id: 'b1', kind: 'branch', when: TRUE_COND(), then: [grant('in1', 2, { as: 'iv' })] },
        { id: 's2', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 'iv.amount' } } },
      ],
    }))).toContain('FLOW_REF_DEFAULT_REQUIRED');
  });

  it('拒绝：资产未定义 / 停用 / 单步超限', () => {
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'nope', amount: 1 } }] })))
      .toContain('FLOW_ASSET_UNKNOWN');
    addAsset({ id: 'off', enabled: false });
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'off', amount: 1 } }] })))
      .toContain('FLOW_ASSET_DISABLED');
    addAsset();
    expect(codes(addFlow({ steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'star', amount: 11 } }] })))
      .toContain('FLOW_AMOUNT_LIMIT');
  });

  it('拒绝：recheckAchievements 不是最后一个顶层步骤', () => {
    expect(codes(addFlow({
      steps: [{ id: 'r1', atom: 'engine.recheckAchievements', params: {} }, grant('s2', 1)],
    }))).toContain('FLOW_REACHECK_ORDER');
  });

  it('拒绝：as 与步骤 id 冲突', () => {
    expect(codes(addFlow({ steps: [grant('s1', 1, { as: 's2' }), grant('s2', 1)] }))).toContain('FLOW_REF_NAME_CONFLICT');
  });
});

describe('执行：单事务 / 分支 / 引用', () => {
  it('分支命中 then，并可用前序步骤输出作为参数', () => {
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 6, { as: 'v' }),
        {
          id: 'b1', kind: 'branch', when: TRUE_COND(),
          then: [grant('s2', 2)],
          else: [grant('s3', 99)],
        },
        { id: 's4', atom: 'currency.grant', params: { account: 'achievement', amount: { ref: 'v.amount' } } },
      ],
    });
    const r = api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T });
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.scores.vitality).toBe(8);      // 6 + then 分支 2
    expect(s.scores.achievement).toBe(6);   // 引用 s1.amount
    expect(s.logs.filter(l => l.src === 'flow-run')).toHaveLength(1);
    expect(live().ext.flowRuns.recent).toHaveLength(1);
    expect(live().ext.flowRuns.byId[r.runId].deltas)
      .toMatchObject({ vitality: 8, achievement: 6 });
  });

  it('分支未命中时走 else', () => {
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [{
        id: 'b1', kind: 'branch', when: FALSE_COND(),
        then: [grant('s1', 5, { as: 'x' })],
        else: [grant('s2', 3)],
      }],
    });
    expect(api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T }).ok).toBe(true);
    expect(api.getState().scores.vitality).toBe(3);
  });

  it('任一步失败：整条回滚，不留流水 / 运行记录 / lastRun', () => {
    addAsset();
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 5),
        { id: 's2', atom: 'asset.spend', params: { assetId: 'star', amount: 1 } },
      ],
    });
    const r = api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_INSUFFICIENT');
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
    expect(live().ext.flowRuns.recent).toHaveLength(0);
    expect(live().flows[0].lastRun).toBeNull();
    expect(Object.keys(live().ext.assetMeters.idem)).toHaveLength(0);
  });

  it('引用目标被 when 跳过且无默认值：FLOW_REF_SKIPPED 整单回滚', () => {
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 5, { as: 'v', when: FALSE_COND() }),
        { id: 's2', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 'v.amount' } } },
      ],
    });
    const r = api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_REF_SKIPPED');
    expect(api.getState().scores.vitality).toBe(0);
  });

  it('引用目标被跳过但带默认值：用默认值继续执行', () => {
    const f = addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 5, { as: 'v', when: FALSE_COND() }),
        { id: 's2', atom: 'currency.grant', params: { account: 'vitality', amount: { ref: 'v.amount', default: 2 } } },
      ],
    });
    expect(api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T }).ok).toBe(true);
    expect(api.getState().scores.vitality).toBe(2);
  });

  it('资产计量由执行器写入：issued / runs 与流水一致', () => {
    addAsset();
    const f = addFlow({ condition: TRUE_COND(), steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'star', amount: 2 } }] });
    expect(api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T }).ok).toBe(true);
    const pk = api.periodKeyOf({ period: 'week', anchor: 1 }, T);
    const m = live().ext.assetMeters.byAsset.star[pk];
    expect(m).toMatchObject({ issued: 2, spent: 0, runs: 1 });
    expect(api.getState().cards.star).toBe(2);
  });

  it('事务内调用被拒绝：FLOW_BUSY', () => {
    const f = addFlow({ condition: TRUE_COND(), steps: [grant('s1', 1)] });
    const r = api.Ledger.txn(() => api.FlowEngine.runFlow(f.id, { trigger: 'period', ts: T }), opts);
    expect(r.ok).toBe(true);
    expect(r.value.error.code).toBe('FLOW_BUSY');
  });

  it('停用 / 无效流不执行', () => {
    const f = addFlow({ enabled: false, condition: TRUE_COND(), steps: [grant('s1', 1)] });
    expect(api.FlowEngine.runFlow(f.id, { ts: T }).error.code).toBe('FLOW_DISABLED');
  });
});

describe('调度与幂等', () => {
  it('同一周期重复求值不重复发奖', () => {
    const f = addFlow({ condition: TRUE_COND(), steps: [grant('s1', 6)] });
    const first = api.FlowEngine.processDue(T, true);
    expect(first[0].ok).toBe(true);
    expect(first[0].skipped).toBeUndefined();
    expect(api.getState().scores.vitality).toBe(6);

    const second = api.FlowEngine.processDue(T, true);
    expect(second[0]).toMatchObject({ ok: true, skipped: 'already-run' });
    expect(api.getState().scores.vitality).toBe(6);
    expect(api.getState().logs).toHaveLength(2); // 1 条发奖 + 1 条 journal
    expect(live().ext.flowRuns.recent).toHaveLength(1);
    expect(Object.keys(live().ext.assetMeters.idem)).toHaveLength(1);
    expect(live().flows[0].lastRun).toBe('f1@' + api.periodKey(f.trigger, T));

    // 下一个周期可再次执行
    const next = api.FlowEngine.processDue(T + WEEK, true);
    expect(next[0].ok).toBe(true);
    expect(next[0].skipped).toBeUndefined();
    expect(api.getState().scores.vitality).toBe(12);
    expect(live().ext.flowRuns.recent).toHaveLength(2);
  });

  it('条件不成立：不推进 lastRun、不落流水；同周期条件满足后可再次触发', () => {
    const f = addFlow({ condition: FALSE_COND(), steps: [grant('s1', 6)] });
    const before = api.getState();
    const r1 = api.FlowEngine.processDue(T, true)[0];
    expect(r1).toMatchObject({ ok: true, skipped: 'condition-false' });
    const mid = api.getState();
    expect(mid.scores.vitality).toBe(0);
    expect(mid.logs).toHaveLength(0);
    expect(live().ext.flowRuns.recent).toHaveLength(0);
    expect(live().flows[0].lastRun).toBeNull();
    expect(Object.keys(live().ext.assetMeters.idem)).toHaveLength(0);
    expect(mid.scores).toEqual(before.scores);

    // 同一周期内条件变为成立：仍可触发
    api.patchState(s => { s.flows[0].condition = api.normalizeCondition(TRUE_COND()); });
    const r2 = api.FlowEngine.processDue(T, true)[0];
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBeUndefined();
    expect(api.getState().scores.vitality).toBe(6);
    expect(live().flows[0].lastRun).toBe('f1@' + api.periodKey(f.trigger, T));

    // 已执行后同周期不再重复
    expect(api.FlowEngine.processDue(T, true)[0].skipped).toBe('already-run');
    expect(api.getState().scores.vitality).toBe(6);
  });

  it('调度只求值周期流：manual 流与停用流被跳过', () => {
    addFlow({ id: 'm1', trigger: { type: 'manual' }, condition: TRUE_COND(), steps: [grant('s1', 4)] });
    addFlow({ id: 'd1', enabled: false, condition: TRUE_COND(), steps: [grant('s2', 5)] });
    const results = api.FlowEngine.processDue(T, true);
    expect(results).toHaveLength(0);
    expect(api.getState().scores.vitality).toBe(0);
  });

  it('maxRunsPerPeriod > 1：同周期按次数上限执行', () => {
    addFlow({ limits: { maxRunsPerPeriod: 2, maxGrantPerRun: 20 }, condition: TRUE_COND(), steps: [grant('s1', 1)] });
    api.FlowEngine.processDue(T, true);
    api.FlowEngine.processDue(T, true);
    expect(api.getState().scores.vitality).toBe(2);
    expect(api.FlowEngine.processDue(T, true)[0].skipped).toBe('already-run');
    expect(api.getState().scores.vitality).toBe(2);
  });
});
