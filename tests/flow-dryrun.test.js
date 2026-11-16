// S5：干跑（克隆态 + 真实执行器）与结果模型。
// 覆盖：零副作用（含 lastRun / idem / flowRuns / 计量 / 流水）、报告与真实执行一致、事务内拒绝。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12); // 2026-01-05（周一）
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
function stateJson() { return JSON.stringify(api.getState()); }
function live() { return api.getLive(); }

beforeEach(() => {
  api.resetState();
  globalThis.document.getElementById('toastWrap').children.length = 0;
});

describe('干跑：零副作用', () => {
  it('干跑前后 state 序列化完全一致（含 lastRun / idem / flowRuns / 计量 / 流水）', () => {
    addAsset();
    addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 2),
        { id: 's2', atom: 'asset.grant', params: { assetId: 'star', amount: 1 } },
      ],
    });
    const before = stateJson();
    const toastBefore = globalThis.document.getElementById('toastWrap').children.length;

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.wouldRun).toBe(true);
    expect(stateJson()).toBe(before);
    expect(api.Persist.isPending()).toBe(false);
    expect(globalThis.document.getElementById('toastWrap').children.length).toBe(toastBefore);

    const s = live();
    expect(s.flows[0].lastRun).toBeFalsy();
    expect(Object.keys(s.ext.assetMeters.idem)).toHaveLength(0);
    expect(s.ext.flowRuns.recent).toHaveLength(0);
    expect(s.logs).toHaveLength(0);
    expect(s.ext.assetMeters.byAsset.star).toBeUndefined();
  });

  it('报告：逐账户前后值 / 将要写入的流水 / 资产额度消耗', () => {
    addAsset();
    addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 2),
        { id: 's2', atom: 'asset.grant', params: { assetId: 'star', amount: 1 } },
        { id: 's3', atom: 'log.note', params: { desc: '本周小结' } },
      ],
    });

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    expect(r.flowName).toBe('周常流');
    expect(r.trigger).toBe('period');
    expect(r.periodKey).toBeTruthy();
    const vit = r.accounts.find(a => a.key === 'vitality');
    expect(vit).toMatchObject({ kind: 'vitality', before: 0, after: 2, delta: 2 });
    // 2 条发奖流水 + 1 条备注 + 1 条执行日志
    expect(r.entries).toHaveLength(4);
    expect(r.entries.every(e => e.id && Number.isFinite(e.time))).toBe(true);
    expect(r.entries.some(e => e.src === 'flow-run')).toBe(true);

    const star = r.assets.find(a => a.assetId === 'star');
    expect(star).toMatchObject({
      name: '星星', balanceBefore: 0, balanceAfter: 1, balanceDelta: 1,
      issued: 1, spent: 0, runs: 1, deltaIssued: 1, deltaRuns: 1, maxBalance: 10,
    });
    expect(star.periodKey).toBeTruthy();
    expect(r.totals).toMatchObject({ granted: 2, assetGranted: 1, steps: 3 });
    expect(r.warnings).toHaveLength(0);
  });
});

describe('干跑：与真实执行一致', () => {
  it('同一状态下先干跑、再真跑，账户增量与流水条数一致', () => {
    addAsset();
    addFlow({
      condition: TRUE_COND(),
      steps: [
        grant('s1', 3),
        { id: 's2', atom: 'currency.spend', params: { account: 'vitality', amount: 1 } },
        { id: 's3', atom: 'asset.grant', params: { assetId: 'star', amount: 2 } },
      ],
    });
    const before = api.getState();
    const beforeIds = new Set(before.logs.map(l => l.id));
    const beforeStar = Number(before.cards.star) || 0;

    const dry = api.FlowEngine.dryRun('f1', { ts: T });
    expect(dry.wouldRun).toBe(true);
    const dryVitality = dry.accounts.find(a => a.key === 'vitality');
    const dryStar = dry.assets.find(a => a.assetId === 'star');

    const real = api.FlowEngine.runFlow('f1', { ts: T });
    expect(real.ok).toBe(true);

    const after = api.getState();
    const newLogs = after.logs.filter(l => !beforeIds.has(l.id));
    expect(dryVitality.delta).toBe(after.scores.vitality - before.scores.vitality);
    expect(dryStar.balanceDelta).toBe((Number(after.cards.star) || 0) - beforeStar);
    expect(dry.entries).toHaveLength(newLogs.length);
    expect(dry.totals).toMatchObject({ granted: 3, spent: 1, assetGranted: 2 });

    const meter = after.ext.assetMeters.byAsset.star[dryStar.periodKey];
    expect(dryStar.issued).toBe(meter.issued);
    expect(dryStar.runs).toBe(meter.runs);
  });

  it('事务内调用干跑被拒绝，且不产生任何状态变化', () => {
    addFlow({ condition: TRUE_COND(), steps: [grant('s1', 1)] });

    let inner = null;
    let insideBefore = '';
    let insideAfter = '';
    const tx = api.Ledger.txn(() => {
      // 事务提交本身会刷新 stats.updatedAt，所以只比较回调内部干跑前后的状态
      insideBefore = stateJson();
      inner = api.FlowEngine.dryRun('f1', { ts: T });
      insideAfter = stateJson();
      return 'done';
    }, { save: 'none', render: false });

    expect(tx.ok).toBe(true);
    expect(inner.ok).toBe(false);
    expect(inner.error.code).toBe('FLOW_DRY_RUN_IN_TXN');
    expect(insideAfter).toBe(insideBefore);
    expect(live().scores.vitality).toBe(0);
    expect(live().logs).toHaveLength(0);
  });
});

describe('干跑：不执行的分支', () => {
  it('条件不成立：标记 condition-false，不产生账户与流水', () => {
    addFlow({ condition: FALSE_COND(), steps: [grant('s1', 1)] });
    const before = stateJson();

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    expect(r.ok).toBe(true);
    expect(r.wouldRun).toBe(false);
    expect(r.skipped).toBe('condition-false');
    expect(r.condition).toBe(false);
    expect(r.accounts).toHaveLength(0);
    expect(r.entries).toHaveLength(0);
    expect(r.assets).toHaveLength(0);
    expect(stateJson()).toBe(before);
  });

  it('同周期已执行：标记 already-run，不产生任何账户与流水', () => {
    addFlow({ condition: TRUE_COND(), steps: [grant('s1', 1)] });
    expect(api.FlowEngine.runFlow('f1', { ts: T }).ok).toBe(true);
    const before = stateJson();

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    expect(r.wouldRun).toBe(false);
    expect(r.skipped).toBe('already-run');
    expect(r.accounts).toHaveLength(0);
    expect(r.entries).toHaveLength(0);
    expect(stateJson()).toBe(before);
  });

  it('执行失败：报告携带错误码，克隆回滚后真实状态不变', () => {
    addFlow({
      condition: TRUE_COND(),
      steps: [{ id: 's1', atom: 'currency.spend', params: { account: 'vitality', amount: 5 } }],
    });
    const before = stateJson();

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    expect(r.ok).toBe(true);
    expect(r.wouldRun).toBe(false);
    expect(r.error.code).toBe('FLOW_INSUFFICIENT');
    expect(r.accounts).toHaveLength(0);
    expect(r.entries).toHaveLength(0);
    expect(stateJson()).toBe(before);
  });

  it('手动流默认按 manual 干跑，不占用周期闸门', () => {
    addFlow({ trigger: { type: 'manual' }, condition: TRUE_COND(), steps: [grant('s1', 1)] });

    const r = api.FlowEngine.dryRun('f1');

    expect(r.trigger).toBe('manual');
    expect(r.periodKey).toBe('');
    expect(r.wouldRun).toBe(true);
  });
});

describe('干跑：告警', () => {
  it('负余额告警：执行后账户仍为负', () => {
    api.patchState(s => { s.scores.vitality = -5; });
    addFlow({ condition: TRUE_COND(), steps: [grant('s1', 1)] });

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    const acc = r.accounts.find(a => a.key === 'vitality');
    expect(acc).toMatchObject({ before: -5, after: -4, delta: 1 });
    const w = r.warnings.find(x => x.code === 'NEGATIVE_BALANCE');
    expect(w).toMatchObject({ account: 'vitality', before: -5, after: -4 });
  });

  it('资产越界告警：执行后余额超过 maxBalance', () => {
    addAsset({ maxBalance: 10 });
    api.patchState(s => { s.cards.star = 50; });
    addFlow({
      condition: TRUE_COND(),
      steps: [{ id: 's1', atom: 'asset.spend', params: { assetId: 'star', amount: 1 } }],
    });

    const r = api.FlowEngine.dryRun('f1', { ts: T });

    const star = r.assets.find(a => a.assetId === 'star');
    expect(star).toMatchObject({ balanceBefore: 50, balanceAfter: 49, balanceDelta: -1, deltaSpent: 1 });
    const w = r.warnings.find(x => x.code === 'ASSET_OVER_CAP');
    expect(w).toMatchObject({ assetId: 'star', after: 49, maxBalance: 10 });
  });
});
