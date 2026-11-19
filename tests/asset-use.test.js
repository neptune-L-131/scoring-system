// 阶段 5 第一步：task.exempt 原子 + 资产使用配方（可见、可干跑、可撤销）
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);
const DAY = 864e5;

function setup(opts) {
  opts = opts || {};
  api.patchState(s => {
    s.cards.exemption = 2;
    const def = s.assetDefs.find(d => d.id === 'exemption');
    def.useRecipe = { v: 1, type: 'task-exempt', cost: 1 };
    s.tasks.push({
      id: 't1', name: '旧任务', lastCheckIn: T - 10 * DAY,
      pendingDebt: 5, lastDebtDate: T - 2 * DAY,
    });
  });
  if (opts.checked) {
    api.patchState(s => { s.tasks[0].lastCheckIn = T; });
  }
}

beforeEach(() => {
  api.resetState();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('资产使用配方（task-exempt）', () => {
  it('消耗 1 张资产并登记豁免：可见流水 + 待扣债清零', () => {
    setup();
    const r = api.runAssetUse('exemption', { taskId: 't1', ts: T });
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.cards.exemption).toBe(1);
    const t = s.tasks.find(x => x.id === 't1');
    expect(t.pendingDebt).toBe(0);
    expect(t.lastDebtDate).toBeUndefined();
    expect(t.lastExempt).toBeGreaterThanOrEqual(T);
    // 两条可见流水：资产消耗 + 豁免登记
    const cardLog = s.logs.find(l => l.src === 'flow-asset-spend' && l.card === 'exemption');
    const exemptLog = s.logs.find(l => l.src === 'flow-task-exempt');
    expect(cardLog).toBeTruthy();
    expect(exemptLog).toBeTruthy();
    expect(exemptLog.taskId).toBe('t1');
    // 资产流水三要素：类别=消耗、来源=动作流、去向=被豁免的任务
    expect(cardLog.assetCat).toBe('spend');
    expect(cardLog.assetFrom).toBe('动作流「使用「断更豁免卡」豁免」');
    expect(cardLog.assetTo).toBe('豁免任务「旧任务」');
  });

  it('整单撤销：资产、任务字段、流水一起回退', () => {
    setup();
    const r = api.runAssetUse('exemption', { taskId: 't1', ts: T });
    expect(r.ok).toBe(true);
    const u = api.undoFlowRun(r.runId, { ts: T });
    expect(u.ok).toBe(true);
    const s = api.getState();
    expect(s.cards.exemption).toBe(2);
    const t = s.tasks.find(x => x.id === 't1');
    expect(t.pendingDebt).toBe(5);
    expect(t.lastExempt).toBeUndefined();
    expect(s.logs.some(l => l.src === 'flow-task-exempt')).toBe(false);
  });

  it('干跑不改真实状态，并给出资产前后值', () => {
    setup();
    const before = api.getState();
    const rep = api.dryRunAssetUse('exemption', { taskId: 't1', ts: T });
    expect(rep.ok).toBe(true);
    expect(rep.dryRun).toBe(true);
    const acc = rep.accounts.find(a => a.key === 'card:exemption');
    expect(acc).toMatchObject({ before: 2, after: 1 });
    expect(api.getState()).toEqual(before);
  });

  it('今日已打卡时拒绝，并整单回滚（不扣资产）', () => {
    setup({ checked: true });
    const r = api.runAssetUse('exemption', { taskId: 't1', ts: T });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_TASK_CHECKED');
    expect(api.getState().cards.exemption).toBe(2);
  });

  it('未配置配方的资产不能执行任务豁免', () => {
    setup();
    api.patchState(s => {
      s.assetDefs.find(d => d.id === 'exemption').useRecipe = null;
    });
    const r = api.runAssetUse('exemption', { taskId: 't1', ts: T });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_NO_USE_RECIPE');
  });

  it('归一化保留内置资产的使用配方', () => {
    setup();
    const defs = api.normalizeAssetDefs(api.getState().assetDefs);
    const builtin = defs.find(d => d.id === 'exemption');
    expect(builtin.useRecipe).toEqual({ v: 1, type: 'task-exempt', cost: 1 });
  });
});
