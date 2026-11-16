// S3：7 个动作原子 + Ledger 接入。
// 覆盖每个原子的成功 / 失败 / 上限三类路径；所有写入都必须能由 Ledger 流水解释。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const opts = { save: 'none', render: false };
const DAY = 864e5;

function okRun(fn) {
  const r = api.Ledger.txn(fn, opts);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
}
function errCode(fn) {
  const r = api.Ledger.txn(fn, opts);
  expect(r.ok).toBe(false);
  return r.error.code;
}
function addAsset(extra) {
  api.patchState(s => {
    s.assetDefs.push(api.normalizeAssetDef(Object.assign({
      id: 'star', name: '星星', unit: '颗', maxBalance: 10, origin: 'user',
    }, extra || {})));
  });
}
function toastCount() {
  return globalThis.document.getElementById('toastWrap').children.length;
}

beforeEach(() => {
  api.resetState();
  globalThis.document.getElementById('toastWrap').children.length = 0;
});

describe('公共契约：事务断言 / 参数白名单 / 未知原子', () => {
  it('事务外调用抛 FLOW_NO_TXN，不自动开事务', () => {
    expect(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 1 }, {})).toThrow('FLOW_NO_TXN');
    expect(api.getState().scores.vitality).toBe(0);
  });

  it('未知原子抛 FLOW_UNKNOWN_ATOM', () => {
    expect(errCode(() => api.runFlowAtom('entity.patch', {}, {}))).toBe('FLOW_UNKNOWN_ATOM');
  });

  it('参数白名单：注入底层字段被拒绝', () => {
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 1, visible: false }, {})))
      .toBe('FLOW_BAD_PARAMS');
    expect(errCode(() => api.runFlowAtom('log.note', { desc: 'x', src: 'hack' }, {}))).toBe('FLOW_BAD_PARAMS');
  });

  it('步骤数上限：超过 limits.maxSteps 抛 FLOW_STEP_LIMIT', () => {
    const ctx = { limits: { maxSteps: 1 } };
    okRun(() => api.runFlowAtom('log.note', { desc: 'a' }, ctx));
    expect(errCode(() => api.runFlowAtom('log.note', { desc: 'b' }, ctx))).toBe('FLOW_STEP_LIMIT');
  });

  it('前一步成功、后一步失败时整单回滚，不产生半截流水', () => {
    const r = api.Ledger.txn(() => {
      api.runFlowAtom('currency.grant', { account: 'vitality', amount: 5 }, {});
      api.runFlowAtom('asset.grant', { assetId: 'nope', amount: 1 }, {});
    }, opts);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FLOW_ASSET_UNKNOWN');
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
  });
});

describe('A. currency.grant', () => {
  it('成功：写 vitality 流水，余额与流水一致', () => {
    const r = okRun(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 6, desc: '周奖励' }, {}));
    expect(r).toMatchObject({ ok: true, amount: 6 });
    const s = api.getState();
    expect(s.scores.vitality).toBe(6);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({
      st: 'vitality', amt: 6, desc: '周奖励', src: 'flow-currency-grant',
    });
    const flowSum = s.logs.reduce((a, l) => a + l.amt, 0);
    expect(flowSum).toBe(s.scores.vitality);
  });

  it('progress 账户：dom 落到流水，领域必须已存在', () => {
    okRun(() => api.runFlowAtom('currency.grant', { account: 'progress:d_default', amount: 2.5 }, {}));
    const s = api.getState();
    expect(s.scores.progress.d_default).toBe(2.5);
    expect(s.logs[0]).toMatchObject({ st: 'progress', amt: 2.5, dom: 'd_default' });
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'progress:d_missing', amount: 1 }, {})))
      .toBe('FLOW_INVALID_ACCOUNT');
  });

  it('失败：非白名单账户 / 0 或负数 / 超过 2 位小数 / NaN', () => {
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'cards', amount: 1 }, {}))).toBe('FLOW_INVALID_ACCOUNT');
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 0 }, {}))).toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: -1 }, {}))).toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 1.234 }, {}))).toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 'abc' }, {}))).toBe('FLOW_INVALID_AMOUNT');
  });

  it('上限：单步 ≤ 100；流级累计 ≤ maxGrantPerRun', () => {
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 100.01 }, {}))).toBe('FLOW_AMOUNT_LIMIT');
    const ctx = { limits: { maxGrantPerRun: 10 } };
    okRun(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 10 }, ctx));
    expect(errCode(() => api.runFlowAtom('currency.grant', { account: 'achievement', amount: 1 }, ctx)))
      .toBe('FLOW_RUN_LIMIT');
  });
});

describe('B. currency.spend', () => {
  it('成功：扣减余额并写负数流水', () => {
    okRun(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 5 }, {}));
    okRun(() => api.runFlowAtom('currency.spend', { account: 'vitality', amount: 3 }, {}));
    const s = api.getState();
    expect(s.scores.vitality).toBe(2);
    expect(s.logs[0]).toMatchObject({ st: 'vitality', amt: -3, src: 'flow-currency-spend' });
  });

  it('失败：余额不足抛 FLOW_INSUFFICIENT，余额不变', () => {
    okRun(() => api.runFlowAtom('currency.grant', { account: 'achievement', amount: 2 }, {}));
    expect(errCode(() => api.runFlowAtom('currency.spend', { account: 'achievement', amount: 3 }, {})))
      .toBe('FLOW_INSUFFICIENT');
    expect(api.getState().scores.achievement).toBe(2);
  });

  it('上限：单步 ≤ 100；流级累计 ≤ maxSpendPerRun', () => {
    expect(errCode(() => api.runFlowAtom('currency.spend', { account: 'vitality', amount: 101 }, {}))).toBe('FLOW_AMOUNT_LIMIT');
    const ctx = { limits: { maxSpendPerRun: 2 } };
    okRun(() => api.runFlowAtom('currency.grant', { account: 'vitality', amount: 5 }, {}));
    expect(errCode(() => api.runFlowAtom('currency.spend', { account: 'vitality', amount: 3 }, ctx)))
      .toBe('FLOW_RUN_LIMIT');
  });
});

describe('C. asset.grant', () => {
  it('成功：写 card 流水，余额与流水一致', () => {
    addAsset();
    const r = okRun(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 2, desc: '周达标' }, {}));
    expect(r).toMatchObject({ ok: true, granted: 2, amount: 2 });
    const s = api.getState();
    expect(s.cards.star).toBe(2);
    expect(s.logs[0]).toMatchObject({
      st: 'card', amt: 2, desc: '周达标', src: 'flow-asset-grant', card: 'star', granted: 2,
    });
  });

  it('内置豁免卡：未配周期上限时不拦截', () => {
    const r = okRun(() => api.runFlowAtom('asset.grant', { assetId: 'exemption', amount: 3 }, {}));
    expect(r.granted).toBe(3);
    expect(api.getState().cards.exemption).toBe(3);
  });

  it('失败：未定义 / 停用 / 归档资产', () => {
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'nope', amount: 1 }, {}))).toBe('FLOW_ASSET_UNKNOWN');
    addAsset({ id: 'off', enabled: false });
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'off', amount: 1 }, {}))).toBe('FLOW_ASSET_DISABLED');
    addAsset({ id: 'old', archived: true });
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'old', amount: 1 }, {}))).toBe('FLOW_ASSET_ARCHIVED');
  });

  it('失败：非整数 / 0 / 超过单步 10', () => {
    addAsset();
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 1.5 }, {}))).toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 0 }, {}))).toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 11 }, {}))).toBe('FLOW_AMOUNT_LIMIT');
  });

  it('上限：余额硬顶（maxBalance）整步失败，不静默裁剪', () => {
    addAsset({ maxBalance: 2 });
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 3 }, {}))).toBe('FLOW_ASSET_CAP');
    const s = api.getState();
    expect(s.cards.star || 0).toBe(0);
    expect(s.logs).toHaveLength(0);
  });

  it('上限：单步受 maxIssuedPerPeriod 收窄', () => {
    addAsset({ maxIssuedPerPeriod: 2 });
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 3 }, {}))).toBe('FLOW_AMOUNT_LIMIT');
  });

  it('上限：周期额度（assetMeters.issued）用满后失败', () => {
    addAsset({ maxIssuedPerPeriod: 5 });
    const ts = Date.now();
    const pk = api.periodKeyOf({ period: 'week', anchor: 1 }, ts);
    api.patchState(s => { s.ext.assetMeters.byAsset.star = { [pk]: { issued: 4, spent: 0, runs: 1 } }; });
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 2 }, { ts })))
      .toBe('FLOW_ASSET_PERIOD_CAP');
    // 恰好用满仍允许
    okRun(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 1 }, { ts }));
    expect(api.getState().cards.star).toBe(1);
  });

  it('上限：流级累计 ≤ maxAssetGrantPerRun', () => {
    addAsset();
    const ctx = { limits: { maxAssetGrantPerRun: 1 } };
    expect(errCode(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 2 }, ctx)))
      .toBe('FLOW_RUN_LIMIT');
  });
});

describe('D. asset.spend', () => {
  it('成功：写负数 card 流水，余额回退', () => {
    addAsset();
    okRun(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 3 }, {}));
    const r = okRun(() => api.runFlowAtom('asset.spend', { assetId: 'star', amount: 2 }, {}));
    expect(r).toMatchObject({ ok: true, spent: 2 });
    const s = api.getState();
    expect(s.cards.star).toBe(1);
    expect(s.logs[0]).toMatchObject({ st: 'card', amt: -2, src: 'flow-asset-spend', card: 'star', spent: 2 });
  });

  it('失败：余额不足 / 未定义 / 非整数', () => {
    addAsset();
    okRun(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 1 }, {}));
    expect(errCode(() => api.runFlowAtom('asset.spend', { assetId: 'star', amount: 2 }, {}))).toBe('FLOW_INSUFFICIENT');
    expect(errCode(() => api.runFlowAtom('asset.spend', { assetId: 'nope', amount: 1 }, {}))).toBe('FLOW_ASSET_UNKNOWN');
    expect(errCode(() => api.runFlowAtom('asset.spend', { assetId: 'star', amount: 0.5 }, {}))).toBe('FLOW_INVALID_AMOUNT');
  });

  it('上限：单步 ≤ 10；流级累计 ≤ maxAssetSpendPerRun', () => {
    addAsset();
    expect(errCode(() => api.runFlowAtom('asset.spend', { assetId: 'star', amount: 11 }, {}))).toBe('FLOW_AMOUNT_LIMIT');
    const ctx = { limits: { maxAssetSpendPerRun: 1 } };
    okRun(() => api.runFlowAtom('asset.grant', { assetId: 'star', amount: 3 }, {}));
    expect(errCode(() => api.runFlowAtom('asset.spend', { assetId: 'star', amount: 2 }, ctx))).toBe('FLOW_RUN_LIMIT');
  });
});

describe('E. entity.archiveIdle', () => {
  function seedTasks(n, idleDays) {
    api.patchState(s => {
      s.tasks = Array.from({ length: n }, (_, i) => ({
        id: 't' + i, name: '任务' + i, archived: false,
        lastCheckIn: Date.now() - idleDays * DAY,
      }));
    });
  }

  it('成功：归档命中实体，每个实体一条 event 流水', () => {
    seedTasks(2, 40);
    const r = okRun(() => api.runFlowAtom('entity.archiveIdle', { kind: 'task', idleDays: 30 }, { ts: Date.now() }));
    expect(r).toMatchObject({ ok: true, count: 2 });
    const s = api.getState();
    expect(s.tasks.every(t => t.archived)).toBe(true);
    expect(s.logs).toHaveLength(2);
    expect(s.logs[0]).toMatchObject({ st: '', amt: 0, src: 'archive' });
  });

  it('成功：命中 0 个时不写流水', () => {
    seedTasks(1, 1);
    const r = okRun(() => api.runFlowAtom('entity.archiveIdle', { kind: 'task', idleDays: 30 }, { ts: Date.now() }));
    expect(r.count).toBe(0);
    expect(api.getState().logs).toHaveLength(0);
  });

  it('上限：命中 > 20 个整步失败，一个都不归档', () => {
    seedTasks(21, 40);
    expect(errCode(() => api.runFlowAtom('entity.archiveIdle', { kind: 'task', idleDays: 30 }, { ts: Date.now() })))
      .toBe('FLOW_ARCHIVE_TOO_MANY');
    expect(api.getState().tasks.every(t => !t.archived)).toBe(true);
  });

  it('失败：非法实体类型 / 非法天数', () => {
    expect(errCode(() => api.runFlowAtom('entity.archiveIdle', { kind: 'product', idleDays: 30 }, {})))
      .toBe('FLOW_INVALID_ENTITY');
    expect(errCode(() => api.runFlowAtom('entity.archiveIdle', { kind: 'task', idleDays: 0 }, {})))
      .toBe('FLOW_INVALID_AMOUNT');
    expect(errCode(() => api.runFlowAtom('entity.archiveIdle', { kind: 'task', idleDays: 400 }, {})))
      .toBe('FLOW_AMOUNT_LIMIT');
  });
});

describe('F. log.note', () => {
  it('成功：写 0 元 flow-note 流水，不碰账户', () => {
    const r = okRun(() => api.runFlowAtom('log.note', { desc: '本周已达标' }, {}));
    expect(typeof r.entryId).toBe('string');
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs[0]).toMatchObject({ st: '', amt: 0, desc: '本周已达标', src: 'flow-note' });
  });

  it('失败：空备注 / 超过 120 字符', () => {
    expect(errCode(() => api.runFlowAtom('log.note', { desc: '   ' }, {}))).toBe('FLOW_BAD_PARAMS');
    expect(errCode(() => api.runFlowAtom('log.note', { desc: 'x'.repeat(121) }, {}))).toBe('FLOW_NOTE_TOO_LONG');
  });

  it('上限：单条流最多 10 条 note', () => {
    const ctx = {};
    for (let i = 0; i < 10; i++) okRun(() => api.runFlowAtom('log.note', { desc: 'n' + i }, ctx));
    expect(errCode(() => api.runFlowAtom('log.note', { desc: 'n10' }, ctx))).toBe('FLOW_NOTE_LIMIT');
  });
});

describe('G. engine.recheckAchievements', () => {
  function seedAchievement() {
    api.patchState(s => {
      s.domains = [{ id: 'd_default', name: '默认' }];
      s.scores.progress = { d_default: 10 };
      s.achievements = [{ id: 'ach1', name: '十点', domainId: 'd_default', threshold: 10, points: 5, unlocked: false }];
    });
  }

  it('成功：返回本次新增的 achievement 流水 ID，成果点只发一次', () => {
    seedAchievement();
    const r = okRun(() => api.runFlowAtom('engine.recheckAchievements', {}, {}));
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(r.entryIds).toHaveLength(1);
    const s = api.getState();
    expect(s.scores.achievement).toBe(5);
    expect(s.logs[0]).toMatchObject({ st: 'achievement', amt: 5, src: 'achievement' });
    expect(s.logs[0].id).toBe(r.entryIds[0]);
    expect(toastCount()).toBe(1);
    // 新的运行上下文再复核：已解锁，不再发点
    const again = okRun(() => api.runFlowAtom('engine.recheckAchievements', {}, {}));
    expect(again.count).toBe(0);
    expect(api.getState().logs).toHaveLength(1);
  });

  it('silent：不弹 toast（干跑/静默执行）', () => {
    seedAchievement();
    okRun(() => api.runFlowAtom('engine.recheckAchievements', {}, { silent: true }));
    expect(api.getState().scores.achievement).toBe(5);
    expect(toastCount()).toBe(0);
  });

  it('上限：同一运行上下文最多 1 次', () => {
    seedAchievement();
    const ctx = {};
    okRun(() => api.runFlowAtom('engine.recheckAchievements', {}, ctx));
    expect(errCode(() => api.runFlowAtom('engine.recheckAchievements', {}, ctx))).toBe('FLOW_REACHECK_DUPLICATE');
  });

  it('失败：该原子不接受任何参数', () => {
    expect(errCode(() => api.runFlowAtom('engine.recheckAchievements', { amount: 1 }, {}))).toBe('FLOW_BAD_PARAMS');
  });
});
