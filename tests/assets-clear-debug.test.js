// S2：导入导出 / 清空数据 / 资产自检 的兼容面。
// 约束：定义（assetDefs/flows）是用户配置，余额与运行记录（cards/assetMeters/flowRuns）是运行时状态。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

function stubReader(raw) {
  globalThis.FileReader = function FileReaderStub() {
    this.readAsText = function () { if (this.onload) this.onload({ target: { result: raw } }); };
  };
}

function importRaw(raw) {
  stubReader(raw);
  api.importData({ target: { files: [{}], value: '' } });
}

function withAssets() {
  return api.patchState(s => {
    s.scores.vitality = 5;
    s.cards = { exemption: 2, star: 7 };
    s.assetDefs.push(api.normalizeAssetDef({
      id: 'star', name: '星星', unit: '颗', maxBalance: 10, origin: 'user',
    }));
    s.flows.push(api.normalizeFlow({
      id: 'f_ok', name: '周结流', v: 1, steps: [{ id: 's1', atom: 'log.note' }],
      lastRun: { key: '2026-W20', at: 1 },
    }));
    s.ext.assetMeters = { v: 1, byAsset: { star: { p1: { issued: 2, spent: 1, runs: 1 } } }, idem: { k1: { flowId: 'f_ok', runId: 'r1', at: 1 } } };
    s.ext.flowRuns = {
      v: 1, seq: 1,
      byId: { r1: { id: 'r1', flowId: 'f_ok', status: 'active', childLogIds: [], deltas: {} } },
      recent: ['r1'],
    };
  });
}

beforeEach(() => {
  api.setLoadIssue(null);
  api.setPersistBlocked(false);
  api.resetState();
});

describe('清空数据：定义保留，余额归零', () => {
  it('clearDataResults 保留资产/流定义，清空余额、计量与运行记录', () => {
    withAssets();
    api.clearDataResults();
    const s = api.getState();

    expect(s.assetDefs.map(d => d.id)).toEqual(['exemption', 'star']);
    expect(s.flows.map(f => f.id)).toEqual(['f_ok']);
    expect(s.flows[0].lastRun).toBe(null);

    expect(s.cards).toEqual({ exemption: 0, star: 0 });
    expect(s.ext.assetMeters).toEqual({ v: 1, byAsset: {}, idem: {} });
    expect(s.ext.flowRuns).toEqual({ v: 1, seq: 0, byId: {}, recent: [] });
    expect(s.scores.vitality).toBe(0);
  });

  it('clearDataResults 也给没有定义的遗留卡键补 0，不丢键', () => {
    api.patchState(s => { s.cards = { exemption: 1, legacy_card: 3 }; });
    api.clearDataResults();
    expect(api.getState().cards).toEqual({ exemption: 0, legacy_card: 0 });
  });

  it('clearEverything 连定义一起重置为出厂状态', () => {
    withAssets();
    api.clearEverything();
    const s = api.getState();
    expect(s.assetDefs.map(d => d.id)).toEqual(['exemption']);
    expect(s.flows).toEqual([]);
    expect(s.cards).toEqual({ exemption: 0 });
    expect(s.ext.assetMeters.byAsset).toEqual({});
    expect(s.ext.flowRuns.recent).toEqual([]);
  });
});

describe('导入：3 <= v <= 4 兼容', () => {
  it('v4 导出（含新字段）可原样导入', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.scores.vitality = 6;
    base.cards = { exemption: 0, star: 4 };
    base.assetDefs.push(api.normalizeAssetDef({ id: 'star', name: '星星', maxBalance: 9, origin: 'user' }));
    base.flows = [api.normalizeFlow({ id: 'f1', name: '流', v: 1, steps: [] })];
    base.ext.assetMeters = { v: 1, byAsset: { star: { p1: { issued: 4, spent: 0, runs: 1 } } }, idem: {} };

    importRaw(JSON.stringify(base));
    const s = api.getState();
    expect(s.schema.v).toBe(4);
    expect(s.scores.vitality).toBe(6);
    expect(s.cards.star).toBe(4);
    expect(s.assetDefs.some(d => d.id === 'star')).toBe(true);
    expect(s.flows.map(f => f.id)).toEqual(['f1']);
    expect(s.ext.assetMeters.byAsset.star.p1.issued).toBe(4);
  });

  it('v3 导出可导入并补出定义（回归）', () => {
    importRaw(JSON.stringify({
      schema: { v: 3 }, scores: { vitality: 7, progress: {}, achievement: 0 },
      domains: [{ id: 'd_default', name: '默认' }], cards: { exemption: 0, star: 4 }, logs: [], tasks: [],
    }));
    const s = api.getState();
    expect(s.schema.v).toBe(4);
    expect(s.cards.star).toBe(4);
    expect(s.assetDefs.find(d => d.id === 'star').name).toBe('star');
  });

  it('v2 / v5 拒绝导入，且不改动现有数据', () => {
    withAssets();
    const before = api.getState();
    importRaw(JSON.stringify({ schema: { v: 2 }, scores: { vitality: 99 }, tasks: [] }));
    importRaw(JSON.stringify({ schema: { v: 5 }, scores: { vitality: 88 }, cards: { exemption: 9 }, tasks: [] }));
    expect(api.getState()).toEqual(before);
  });
});

describe('清空数据：撤销与事件运行时集合一并归零', () => {
  it('conversions / affairDeleteUndo / ext.events 清空后不存在可撤销项', () => {
    api.patchState(s => {
      s.conversions = [{ id: 'cv1', at: 1, dir: 'chore->affair', entityId: 'x', snapshot: {}, affairUndo: {} }];
      s.affairDeleteUndo = [{ v: 1, id: 'du1', at: 1, mode: 'pool', affair: { id: 'a1', name: '旧项目' }, chores: [] }];
      s.choreDeleteUndo = [{ v: 1, id: 'cu1', at: 1, chore: { id: 'c1', name: '旧杂事' }, index: 0, orderIndex: 0 }];
      s.assetDeleteUndo = [{ v: 1, id: 'au1', at: 1, def: { id: 'star', name: '星星' }, index: 1 }];
      s.ext.events = { v: 1, recent: [{ key: 'ev1', kind: 'flow-event-error' }] };
    });
    expect(api.lastConversion()).not.toBe(null);

    api.clearDataResults();
    const s = api.getState();

    expect(s.conversions).toEqual([]);
    expect(s.affairDeleteUndo).toEqual([]);
    expect(s.choreDeleteUndo).toEqual([]);
    expect(s.assetDeleteUndo).toEqual([]);
    expect(s.ext.events).toEqual({ v: 1, recent: [] });
    expect(api.lastConversion()).toBe(null);
    expect(api.canUndoConversion()).toBe(false);
    expect(api.restoreAffairDeletion('du1').ok).toBe(false);
  });
});

describe('资产自检：只报告、不修复、不误报', () => {
  const labels = ['资产定义 vs 卡片余额', '资产计量 vs 资产定义', '动作流运行记录完整性'];

  it('默认状态与新字段齐全时三项全过', () => {
    const report = api.runConsistencyChecks();
    expect(report.filter(r => !r.ok)).toEqual([]);
    labels.forEach(label => {
      const item = report.find(r => r.label === label);
      expect(item, label).toBeTruthy();
      expect(item.ok, label).toBe(true);
    });
  });

  it('新字段整体缺失时跳过，不产生误报', () => {
    api.patchState(s => {
      delete s.assetDefs;
      delete s.flows;
      delete s.ext.assetMeters;
      delete s.ext.flowRuns;
    });
    const report = api.runConsistencyChecks();
    expect(report.filter(r => !r.ok)).toEqual([]);
    const items = report.filter(r => labels.includes(r.label));
    expect(items).toHaveLength(3);
    expect(items.every(r => r.ok)).toBe(true);
  });

  it('孤立卡键、无定义计量、断裂的运行记录都会被报出且不改状态', () => {
    api.patchState(s => {
      s.cards = { exemption: 0, ghost: 2 };
      s.ext.assetMeters = {
        v: 1,
        byAsset: {
          ghost: { p1: { issued: 1, spent: 0, runs: 1 } },
          nope: { p1: { issued: 0, spent: 0, runs: 1 } },
        },
        idem: {},
      };
      s.ext.flowRuns = {
        v: 1, seq: 2,
        byId: { r1: { id: 'r1', flowId: 'f1', status: 'active', journalLogId: 'missing', childLogIds: ['gone'] } },
        recent: ['r1', 'r2'],
      };
    });
    const before = api.getState();
    const report = api.runConsistencyChecks();
    const by = Object.fromEntries(report.map(r => [r.label, r]));
    expect(by['资产定义 vs 卡片余额'].ok).toBe(false);
    expect(by['资产定义 vs 卡片余额'].detail).toContain('ghost');
    expect(by['资产计量 vs 资产定义'].ok).toBe(false);
    expect(by['资产计量 vs 资产定义'].detail).toContain('nope');
    expect(by['动作流运行记录完整性'].ok).toBe(false);
    expect(by['动作流运行记录完整性'].detail).toContain('r2');
    // 只报告，不自动修复
    expect(api.getState()).toEqual(before);
  });
});
