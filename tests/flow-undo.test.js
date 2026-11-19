// S6：流级 journal、原子反转器、整单撤销。
// 覆盖：完全回退、资产已消耗/缺实体/日志被裁剪被拒、逆序删日志顺序、每个 child index 故障注入。
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);
const DAY = 864e5;
const TRUE_COND = () => ({ mode: 'all', items: [{ metric: 'lifetime_achievement', op: '>=', value: 0, range: 'total' }] });

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
function grant(id, amount) {
  return { id: id, atom: 'currency.grant', params: { account: 'vitality', amount: amount } };
}
function setupTask() {
  api.patchState(s => {
    s.tasks.push({ id: 't1', name: '旧任务', lastCheckIn: T - 10 * DAY });
  });
}
function setupFlow() {
  addAsset();
  setupTask();
  addFlow({
    condition: TRUE_COND(),
    steps: [
      grant('s1', 3),
      { id: 's2', atom: 'currency.spend', params: { account: 'vitality', amount: 1 } },
      { id: 's3', atom: 'asset.grant', params: { assetId: 'star', amount: 2 } },
      { id: 's4', atom: 'log.note', params: { desc: '备注' } },
      { id: 's5', atom: 'entity.archiveIdle', params: { kind: 'task', idleDays: 7 } },
    ],
  });
}
const live = () => api.getLive();
function run() {
  const r = api.FlowEngine.runFlow('f1', { ts: T });
  expect(r.ok).toBe(true);
  return r.runId;
}
// 用户可见账本投影：余额/流水/实体归档/成就/资产计量（不含 lastRun、idem、运行记录与审计/影子账）
function businessSnap() {
  const s = api.getState();
  const cards = {};
  Object.keys(s.cards || {}).forEach(k => { if (Number(s.cards[k])) cards[k] = Number(s.cards[k]); });
  return JSON.stringify({
    scores: s.scores,
    cards: cards,
    logs: (s.logs || []).map(l => l.id),
    tasks: (s.tasks || []).map(t => ({ id: t.id, archived: !!t.archived, archivedAt: t.archivedAt || null })),
    achievements: (s.achievements || []).map(a => ({ id: a.id, unlocked: !!a.unlocked, unlockedAt: a.unlockedAt || null })),
    meters: s.ext.assetMeters.byAsset,
  });
}
// 故障注入比较用：全量状态，但排除只追加的审计（失败事务会保留尝试痕迹）
function fullSnap() {
  const s = api.getState();
  if (s.ext) delete s.ext.audit;
  return JSON.stringify(s);
}
function record(runId) { return live().ext.flowRuns.byId[runId]; }

beforeEach(() => {
  api.resetState();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('journal：随运行落地的撤销证据', () => {
  it('记录步骤输入/输出/产生的日志，以及账户与资产前后值', () => {
    setupFlow();
    const before = businessSnap();
    const runId = run();
    const rec = record(runId);

    expect(Object.keys(api.FLOW_REVERSERS)).toHaveLength(9);
    expect(rec.journal.v).toBe(1);
    expect(rec.journal.steps).toHaveLength(5);
    const s3 = rec.journal.steps.find(x => x.stepId === 's3');
    expect(s3.input).toMatchObject({ assetId: 'star', amount: 2 });
    expect(s3.output.granted).toBe(2);
    expect(s3.logIds).toHaveLength(1);
    expect(rec.journal.logIds).toEqual(rec.childLogIds);
    expect(rec.journal.accounts.find(a => a.key === 'vitality')).toMatchObject({ before: 0, after: 2, delta: 2 });
    const star = rec.journal.assets.find(a => a.assetId === 'star');
    expect(star).toMatchObject({ before: 0, after: 2, delta: 2, issuedBefore: 0, meterExisted: false });
    expect(star.periodKey).toBeTruthy();
    expect(before).not.toBe(businessSnap());
  });

  it('按最近 50 次运行裁剪：journal 随运行记录一起被裁掉', () => {
    setupFlow();
    const runId = run();
    api.patchState(s => {
      for (let i = 0; i < api.FLOW_RUN_KEEP; i++) s.ext.flowRuns.recent.unshift('fake' + i);
      s.ext.flowRuns.recent.length = api.FLOW_RUN_KEEP;
      // 走一次归一化（导入/加载路径）：byId 只保留 recent 引用的记录
      s.ext.flowRuns = api.normalizeFlowRuns(s.ext.flowRuns);
    });
    expect(live().ext.flowRuns.byId[runId]).toBeUndefined();
  });
});

describe('整单撤销：完全回退', () => {
  it('一次撤销回滚账户、资产、流水、归档实体与资产计量', () => {
    setupFlow();
    const before = businessSnap();
    const runId = run();
    expect(live().tasks.find(t => t.id === 't1').archived).toBe(true);
    expect(live().scores.vitality).toBe(2);
    expect(live().cards.star).toBe(2);

    const r = api.FlowEngine.undoFlowRun(runId, { save: false });

    expect(r.ok).toBe(true);
    expect(r.removedLogs).toBe(record(runId).journal.logIds.length + 1);
    expect(businessSnap()).toBe(before);
    expect(live().tasks.find(t => t.id === 't1').archived).toBeFalsy();
    expect(live().tasks.find(t => t.id === 't1').archivedAt).toBeUndefined();
    expect(live().ext.assetMeters.byAsset.star).toBeUndefined();
    expect(record(runId).status).toBe('reversed');
    expect(record(runId).reversedAt).toBeTruthy();
    // 撤销后不得再触发收尾逻辑新增流水
    expect(live().logs).toHaveLength(0);
  });

  it('逆序反转：先删子日志（步骤逆序、步骤内逆序），最后删主日志，status 最后写', () => {
    setupFlow();
    const runId = run();
    const rec = record(runId);
    const expected = rec.journal.logIds.slice().reverse().concat([rec.journalLogId]);

    const orig = api.Ledger.removeLogs;
    const removed = [];
    api.Ledger.removeLogs = function (pred) {
      const beforeIds = api.getLive().logs.map(l => l.id);
      const out = orig.call(api.Ledger, pred);
      const afterSet = new Set(api.getLive().logs.map(l => l.id));
      beforeIds.forEach(id => { if (!afterSet.has(id)) removed.push(id); });
      return out;
    };
    let r;
    try {
      r = api.FlowEngine.undoFlowRun(runId, { save: false });
    } finally {
      api.Ledger.removeLogs = orig;
    }

    expect(r.ok).toBe(true);
    expect(removed).toEqual(expected);
    // status 在删完主日志之后才写：撤销完成时 run 记录仍可读且已标记 reversed
    expect(record(runId).status).toBe('reversed');
  });

  it('重复撤销被拒绝', () => {
    setupFlow();
    const runId = run();
    expect(api.FlowEngine.undoFlowRun(runId, { save: false }).ok).toBe(true);
    const again = api.FlowEngine.undoFlowRun(runId, { save: false });
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('FLOW_UNDO_ALREADY');
  });
});

describe('整单撤销：前置扫描拒绝（Fail-Closed，不写一笔）', () => {
  it('资产已被消耗：拒绝，不夹 0、不部分撤销', () => {
    setupFlow();
    const runId = run();
    api.patchState(s => { s.cards.star = 1; }); // 发放 2，已被消耗 1
    const before = fullSnap();

    const r = api.FlowEngine.undoFlowRun(runId, { save: false });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_UNDO_ASSET_CONSUMED');
    expect(fullSnap()).toBe(before);
    expect(record(runId).status).toBe('active');
  });

  it('实体不存在：拒绝', () => {
    setupFlow();
    const runId = run();
    api.patchState(s => { s.tasks = s.tasks.filter(t => t.id !== 't1'); });
    const before = fullSnap();

    const r = api.FlowEngine.undoFlowRun(runId, { save: false });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_UNDO_ENTITY_MISSING');
    expect(fullSnap()).toBe(before);
  });

  it('日志已被裁剪：拒绝', () => {
    setupFlow();
    const runId = run();
    const childId = record(runId).childLogIds[0];
    api.patchState(s => { s.logs = s.logs.filter(l => l.id !== childId); });
    const before = fullSnap();

    const r = api.FlowEngine.undoFlowRun(runId, { save: false });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_UNDO_LOG_TRIMMED');
    expect(fullSnap()).toBe(before);
  });

  it('跨期：资产计量周期已变化时拒绝', () => {
    setupFlow();
    const runId = run();
    api.__setClockForTest(() => T + 60 * DAY);
    const before = fullSnap();

    const r = api.FlowEngine.undoFlowRun(runId, { save: false });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_UNDO_CROSS_PERIOD');
    expect(fullSnap()).toBe(before);
  });
});

describe('整单撤销：故障注入', () => {
  it('对每个 child index 注入一次失败，撤销后状态与撤销前完全一致', () => {
    setupFlow();
    const runId = run();
    const childCount = record(runId).childLogIds.length;
    expect(childCount).toBeGreaterThan(0);

    for (let k = 1; k <= childCount; k++) {
      const before = fullSnap();
      const orig = api.Ledger.removeLogs;
      let calls = 0;
      api.Ledger.removeLogs = function (pred) {
        calls++;
        if (calls === k) {
          const e = new Error('INJECTED_FAILURE');
          e.__txn = true;
          e.code = 'INJECTED_FAILURE';
          throw e;
        }
        return orig.call(api.Ledger, pred);
      };
      let r;
      try {
        r = api.FlowEngine.undoFlowRun(runId, { save: false });
      } finally {
        api.Ledger.removeLogs = orig;
      }
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INJECTED_FAILURE');
      expect(fullSnap()).toBe(before);
      expect(record(runId).status).toBe('active');
    }

    // 故障全部回滚后，正式撤销仍然成功且完全回退
    const finalBefore = fullSnap();
    expect(api.FlowEngine.undoFlowRun(runId, { save: false }).ok).toBe(true);
    expect(fullSnap()).not.toBe(finalBefore);
    expect(record(runId).status).toBe('reversed');
  });
});
