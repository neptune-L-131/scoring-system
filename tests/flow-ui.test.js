// S9：动作流编辑器、干跑面板、运行历史与整单撤销 UI。
// 覆盖：建流不执行、非法输入拒绝、7 原子限制、分支条件形态、干跑不写盘、
// 显式执行落流水、撤销成功/重复撤销、各类不可撤销原因文案、刷新归一化保留配置与历史。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);

function setVal(id, v) { document.getElementById(id).value = v; }
function setChk(id, v) { document.getElementById(id).checked = v; }
function builtinDef() { return api.defaultAssetDefs()[0]; }
function starDef(over) {
  return Object.assign({
    v: 1, id: 'star', name: '星星', unit: '颗',
    maxBalance: 10, maxIssuedPerPeriod: 3,
    issuePeriod: { cycle: 'week', anchor: 1 },
    enabled: true, archived: false, origin: 'user', createdAt: 1, updatedAt: 1,
  }, over || {});
}
function seed(patch) {
  api.resetState(Object.assign({
    cards: { exemption: 0, star: 0 },
    assetDefs: [builtinDef(), starDef()],
    flows: [],
    activities: [],
  }, patch || {}));
}
function createFlow(over) {
  const o = over || {};
  api.openFlowModal();
  setVal('flowName', o.name === undefined ? '测试动作流' : o.name);
  setVal('flowTriggerType', o.trigger || 'manual');
  api.flowTriggerChanged();
  setChk('flowEnabled', !!o.enabled);
  if (o.amount !== undefined) api.flowStepParamChanged('0', 'amount', String(o.amount));
  return api.handleFlowSave();
}
function runIdOf() {
  return api.getState().ext.flowRuns.recent[0];
}
function runRec(id) {
  return api.getState().ext.flowRuns.byId[id];
}

beforeEach(() => {
  seed();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('S9 流编辑器：保存只落配置', () => {
  it('通过表单建流：默认停用、不执行、不写流水', () => {
    const logsBefore = api.getState().logs.length;
    const r = createFlow({ name: '每周活力', amount: 5 });
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.flows).toHaveLength(1);
    expect(s.flows[0]).toMatchObject({ name: '每周活力', enabled: false });
    expect(s.flows[0].steps[0].params).toMatchObject({ account: 'vitality', amount: 5 });
    expect(s.logs).toHaveLength(logsBefore);
    expect(s.scores.vitality).toBe(0);
    expect(document.getElementById('flowList').innerHTML).toContain('已停用');
  });

  it('编辑器只暴露 7 个已开放原子，未知原子写不进去', () => {
    api.openFlowModal();
    setVal('flowName', '原子白名单');
    api.renderFlowSteps();
    const html = document.getElementById('flowStepList').innerHTML;
    expect(api.FLOW_ATOM_IDS).toHaveLength(7);
    expect((html.match(/flowStepAtomChanged\(/g) || []).length).toBe(1);
    api.flowStepAtomChanged('0', 'evil.arbitrary');
    api.flowStepAtomChanged('0', 'asset.grant');
    api.flowStepParamChanged('0', 'assetId', 'star');
    const r = api.handleFlowSave();
    expect(r.ok).toBe(true);
    expect(api.FLOW_ATOM_IDS).toContain(api.getState().flows[0].steps[0].atom);
  });

  it('非法金额被拒绝并显示原因，state 不变', () => {
    const before = api.getState();
    const r = createFlow({ name: '非法流', amount: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('金额必须大于 0');
    expect(document.getElementById('flowFormHint').textContent).toContain('金额必须大于 0');
    expect(api.getState().flows).toEqual(before.flows);
  });

  it('缺少名称被拒绝', () => {
    const r = createFlow({ name: '', amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('请填写动作流名称');
  });

  it('引用已停用资产被拒绝', () => {
    seed({ assetDefs: [builtinDef(), starDef({ enabled: false })] });
    api.openFlowModal();
    setVal('flowName', '资产流');
    api.flowStepAtomChanged('0', 'asset.grant');
    api.flowStepParamChanged('0', 'assetId', 'star');
    const r = api.handleFlowSave();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已停用');
  });

  it('分支保存为完整条件对象，且分支内步骤 id 不冲突', () => {
    api.openFlowModal();
    setVal('flowName', '分支流');
    api.flowAddBranch('');
    expect(api.getState().flows).toHaveLength(0);
    const r = api.handleFlowSave();
    expect(r.ok).toBe(true);
    const flow = api.getState().flows[0];
    const b = flow.steps.find(function (s) { return s.kind === 'branch'; });
    expect(b).toBeTruthy();
    expect(b.when).toMatchObject({ mode: 'all' });
    expect(b.when.items).toHaveLength(1);
    expect(b.when.items[0]).toMatchObject({ metric: 'checkins', targetType: 'all' });
    const ids = [];
    (function walk(list) {
      (list || []).forEach(function (s) {
        ids.push(s.id);
        walk(s.then);
        walk(s.else);
      });
    })(flow.steps);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('S9 干跑：同一执行器、不写盘', () => {
  it('逐账户前后值、将写流水、资产额度与告警都可见，且真实 state 不变', () => {
    api.openFlowModal();
    setVal('flowName', '双原子流');
    setVal('flowTriggerType', 'manual');
    api.flowTriggerChanged();
    setChk('flowEnabled', true);
    api.flowStepParamChanged('0', 'amount', '5');
    api.flowAddStep('');
    api.flowStepAtomChanged('1', 'asset.grant');
    api.flowStepParamChanged('1', 'assetId', 'star');
    api.flowStepParamChanged('1', 'amount', '2');
    const saved = api.handleFlowSave();
    expect(saved.ok).toBe(true);
    const id = saved.flow.id;
    const before = api.getState();

    const rep = api.dryRunFlow(id);
    expect(rep.ok).toBe(true);
    expect(rep.wouldRun).toBe(true);
    expect(rep.accounts.find(function (a) { return a.key === 'vitality'; })).toMatchObject({ before: 0, after: 5, delta: 5 });
    expect(rep.entries.length).toBeGreaterThan(0);
    expect(rep.assets.find(function (a) { return a.assetId === 'star'; })).toMatchObject({ balanceBefore: 0, balanceAfter: 2 });
    expect(Array.isArray(rep.warnings)).toBe(true);

    const after = api.getState();
    expect(after.scores).toEqual(before.scores);
    expect(after.cards).toEqual(before.cards);
    expect(after.logs).toHaveLength(0);
    expect(after.ext.flowRuns.recent).toHaveLength(0);

    const html = document.getElementById('flowDryPanel').innerHTML;
    expect(html).toContain('试跑结果');
    expect(html).toContain('账户前后值');
    expect(html).toContain('将写入流水');
    expect(html).toContain('资产额度消耗');
    expect(html).toContain('告警');
  });
});

describe('S9 执行、运行历史与整单撤销', () => {
  it('显式执行后落流水，历史可见逐步明细，撤销回滚并标记已撤销', () => {
    const created = createFlow({ name: '可撤销流', amount: 5, enabled: true });
    expect(created.ok).toBe(true);
    const r = api.executeFlow(created.flow.id);
    expect(r.ok).toBe(true);
    expect(api.getState().scores.vitality).toBe(5);
    // 一条步骤流水 + 一条运行主日志
    expect(api.getState().logs).toHaveLength(2);
    expect(api.getState().logs.some(function (l) { return l.src === 'flow-currency-grant'; })).toBe(true);

    const html = document.getElementById('flowRunList').innerHTML;
    expect(html).toContain('flow-run-step');
    expect(html).toContain('整单撤销');

    const id = runIdOf();
    const rec = runRec(id);
    expect(rec.journal).toBeTruthy();
    const undo = api.undoFlowRunUI(id);
    expect(undo.ok).toBe(true);
    expect(api.getState().scores.vitality).toBe(0);
    expect(api.getState().logs).toHaveLength(0);
    expect(runRec(id).status).toBe('reversed');
    expect(document.getElementById('flowRunList').innerHTML).toContain('已撤销');
  });

  it('重复撤销显示“已经撤销过”而不是静默无反应', () => {
    const created = createFlow({ name: '重复撤销流', amount: 2, enabled: true });
    const r = api.executeFlow(created.flow.id);
    const id = runIdOf();
    expect(api.undoFlowRunUI(id).ok).toBe(true);
    const again = api.undoFlowRunUI(id);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('已经撤销过');
    expect(r.ok).toBe(true);
  });

  it('停用的流不能直接执行，按钮与原因可见', () => {
    const created = createFlow({ name: '停用流', amount: 1, enabled: false });
    const r = api.executeFlow(created.flow.id);
    expect(r.ok).toBe(false);
    expect(api.getState().logs).toHaveLength(0);
    expect(document.getElementById('flowList').innerHTML).toContain('已停用');
  });

  it('启用后 toggleFlowEnabled 生效，编译不过的流拒绝启用', () => {
    const created = createFlow({ name: '启停流', amount: 1, enabled: false });
    const ok = api.toggleFlowEnabled(created.flow.id);
    expect(ok.ok).toBe(true);
    expect(api.getState().flows[0].enabled).toBe(true);
    expect(document.getElementById('flowList').innerHTML).toContain('运行中');
  });
});

describe('S9 不可撤销原因：每种都有可见文案', () => {
  const log = { id: 'l1', ts: T, desc: '流水', amt: 1 };
  function rec(over) {
    return Object.assign({
      id: 'r1', flowId: 'f1', flowName: '流', startedAt: T, status: 'active',
      journalLogId: 'l1',
      journal: { v: 1, steps: [], logIds: [], accounts: [], assets: [] },
    }, over || {});
  }

  it('已撤销 / 无凭证 / 日志被裁剪', () => {
    api.patchState(function (s) { s.logs = [log]; });
    expect(api.flowUndoBlockReason(rec({ status: 'reversed' }))).toContain('已经撤销过');
    expect(api.flowUndoBlockReason(rec({ journal: null }))).toContain('缺少撤销凭证');
    expect(api.flowUndoBlockReason(rec({ journal: { v: 1, steps: [], logIds: ['gone'] } }))).toContain('已被裁剪');
  });

  it('资产定义缺失 / 已跨周期 / 已被消耗', () => {
    api.patchState(function (s) {
      s.logs = [log];
      s.assetDefs = s.assetDefs.filter(function (d) { return d.id !== 'star'; });
    });
    const base = { v: 1, steps: [], logIds: [], accounts: [], assets: [{ assetId: 'star', periodKey: '2000-W01', delta: 2 }] };
    expect(api.flowUndoBlockReason(rec({ journal: base }))).toContain('定义已被删除');
    seed();
    api.patchState(function (s) { s.logs = [log]; });
    expect(api.flowUndoBlockReason(rec({ journal: base }))).toContain('跨发放周期');
    const def = api.getState().assetDefs.find(function (d) { return d.id === 'star'; });
    const pk = api.assetPeriodKeyOf(def, T);
    const consumed = { v: 1, steps: [], logIds: [], accounts: [], assets: [{ assetId: 'star', periodKey: pk, delta: 2 }] };
    expect(api.flowUndoBlockReason(rec({ journal: consumed }))).toContain('已被消耗');
  });

  it('被归档实体缺失 / 成就缺失', () => {
    api.patchState(function (s) { s.logs = [log]; });
    const ent = {
      v: 1, logIds: [], accounts: [], assets: [],
      steps: [{ stepId: 's1', atom: 'entity.archiveIdle', input: { kind: 'task' }, output: { ids: ['gone'] } }],
    };
    expect(api.flowUndoBlockReason(rec({ journal: ent }))).toContain('被归档的实体已被删除');
    api.patchState(function (s) {
      s.logs = [{ id: 'l1', ts: T, achId: 'a_gone', desc: '成就' }];
      s.achievements = [];
    });
    const ach = { v: 1, logIds: ['l1'], accounts: [], assets: [], steps: [] };
    expect(api.flowUndoBlockReason(rec({ journal: ach }))).toContain('实体或成就已被删除');
  });

  it('执行器拒绝码都有中文文案', () => {
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_ALREADY' })).toContain('已经撤销过');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_NOT_FOUND' })).toContain('找不到');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_NO_JOURNAL' })).toContain('缺少撤销凭证');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_LOG_TRIMMED' })).toContain('已被裁剪');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_NO_REVERSER', info: { atom: 'x' } })).toContain('没有撤销实现');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_ASSET_MISSING', info: { assetId: 'star' } })).toContain('定义已被删除');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_CROSS_PERIOD', info: { assetId: 'star', periodKey: 'p1', current: 'p2' } })).toContain('跨发放周期');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_ASSET_CONSUMED', info: { assetId: 'star', granted: 2, balance: 0 } })).toContain('已被消耗');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_ENTITY_MISSING' })).toContain('实体或成就');
    expect(api.flowUndoErrorText({ code: 'FLOW_UNDO_BUSY' })).toContain('稍后再试');
    expect(api.flowUndoErrorText({ code: 'WHATEVER', message: '底层原因' })).toContain('底层原因');
  });
});

describe('S9 刷新归一化：配置与历史都在', () => {
  it('normalizeFlows / normalizeFlowRuns 保留流配置、运行记录与 journal', () => {
    const created = createFlow({ name: '持久流', amount: 3, enabled: true });
    api.executeFlow(created.flow.id);
    const s = api.getState();
    const flows = api.normalizeFlows(s.flows);
    expect(flows).toHaveLength(1);
    expect(flows[0].steps[0].params.amount).toBe(3);
    const runs = api.normalizeFlowRuns(JSON.parse(JSON.stringify(s.ext.flowRuns)));
    expect(runs.recent).toHaveLength(1);
    const rec = runs.byId[runs.recent[0]];
    expect(rec.journal).toBeTruthy();
    expect(rec.journal.v).toBe(1);
    expect(rec.status).toBe('active');
  });
});
