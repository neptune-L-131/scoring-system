// S1：Schema v4 —— 新增 assetDefs / flows / ext.assetMeters / ext.flowRuns 的归一化与版本闸门。
// 这一阶段只做“读得进来、缺字段不缺行为、高版本拒载且不写盘”，不含任何原子/执行器/UI。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';
import { KEY } from '../src/constants.js';
import { loadIssue, _persistBlocked } from '../src/normalize.js';

// 最小 IndexedDB 桩：只验证“写盘被阻断时不会覆盖原值”这一条路径
let store = new Map();
const fakeStore = {
  get(k) {
    const req = {};
    queueMicrotask(() => { req.result = store.get(k); if (req.onsuccess) req.onsuccess(); });
    return req;
  },
  put(v, k) { store.set(k, v); },
  delete(k) { store.delete(k); },
};
const fakeDB = {
  objectStoreNames: { contains: () => true },
  createObjectStore() {},
  transaction() {
    const tx = { objectStore: () => fakeStore };
    queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
    return tx;
  },
};
globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => { req.result = fakeDB; if (req.onsuccess) req.onsuccess({ target: req }); });
    return req;
  },
};

function rawV3(patch) {
  return JSON.stringify(Object.assign({
    schema: { v: 3 },
    scores: { vitality: 0, progress: {}, achievement: 0 },
    domains: [{ id: 'd_default', name: '默认' }],
    cards: { exemption: 0 },
    logs: [],
    tasks: [],
  }, patch || {}));
}

function stubReader(raw) {
  globalThis.FileReader = function FileReaderStub() {
    this.readAsText = function () { if (this.onload) this.onload({ target: { result: raw } }); };
  };
}

beforeEach(() => {
  store = new Map();
  api.setLoadIssue(null);
  api.setPersistBlocked(false);
  api.resetState();
});

describe('Schema v4 默认结构（懒安全）', () => {
  it('默认 state 带空的新结构，且内置豁免卡定义存在', () => {
    const s = api.defaults();
    expect(s.schema.v).toBe(4);
    expect(Array.isArray(s.flows)).toBe(true);
    expect(s.flows).toEqual([]);
    expect(s.ext.assetMeters).toEqual({ v: 1, byAsset: {}, idem: {} });
    expect(s.ext.flowRuns).toEqual({ v: 1, seq: 0, byId: {}, recent: [] });
    expect(s.assetDefs.map(d => d.id)).toEqual(['exemption']);
    expect(s.assetDefs[0]).toMatchObject({
      name: '断更豁免卡', unit: '张', maxBalance: null, origin: 'builtin', enabled: true,
    });
  });

  it('v4 存档完全缺失新字段时，读入后补出默认结构', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    delete base.assetDefs;
    delete base.flows;
    delete base.ext.assetMeters;
    delete base.ext.flowRuns;
    const s = api.parseState(JSON.stringify(base));
    expect(loadIssue).toBe(null);
    expect(s.assetDefs.map(d => d.id)).toEqual(['exemption']);
    expect(s.flows).toEqual([]);
    expect(s.ext.assetMeters).toEqual({ v: 1, byAsset: {}, idem: {} });
    expect(s.ext.flowRuns).toEqual({ v: 1, seq: 0, byId: {}, recent: [] });
  });
});

describe('v3 → v4 最小迁移', () => {
  it('保留旧余额，并把孤立卡键补成“id 即名称、余额即上限”的定义', () => {
    const s = api.parseState(rawV3({ cards: { exemption: 1, star: 5 } }));
    expect(loadIssue).toBe(null);
    expect(s.schema.v).toBe(4);
    expect(s.cards).toEqual({ exemption: 1, star: 5 });
    const star = s.assetDefs.find(d => d.id === 'star');
    expect(star).toMatchObject({
      name: 'star', unit: '张', maxBalance: 5, maxIssuedPerPeriod: null,
      origin: 'migrated', enabled: true, v: 1,
    });
    expect(star.issuePeriod).toEqual({ cycle: 'week', anchor: 1 });
  });

  it('孤立卡余额为 0 时上限也是 0，不凭空放大', () => {
    const s = api.parseState(rawV3({ cards: { exemption: 0, ghost: 0 } }));
    expect(s.assetDefs.find(d => d.id === 'ghost').maxBalance).toBe(0);
  });

  it('存档里的豁免卡定义按普通资产保留（不再强制覆盖语义字段）', () => {
    const s = api.parseState(rawV3({
      cards: { exemption: 2.5 },
      assetDefs: [{ id: 'exemption', name: '我的豁免', unit: '个', maxBalance: 99, origin: 'user' }],
    }));
    expect(s.cards.exemption).toBe(2.5);
    expect(s.assetDefs).toHaveLength(1);
    expect(s.assetDefs[0]).toMatchObject({
      id: 'exemption', name: '我的豁免', unit: '个', maxBalance: 99, origin: 'user',
    });
  });

  it('已存在的自定义定义不会被迁移逻辑重复覆盖', () => {
    const s = api.parseState(rawV3({
      cards: { exemption: 0, star: 3 },
      assetDefs: [{ id: 'star', name: '星星', unit: '颗', maxBalance: 10, origin: 'user' }],
    }));
    expect(s.assetDefs.filter(d => d.id === 'star')).toHaveLength(1);
    expect(s.assetDefs.find(d => d.id === 'star')).toMatchObject({
      name: '星星', unit: '颗', maxBalance: 10, origin: 'user',
    });
  });
});

describe('v5 存档：拒载且暂停写盘', () => {
  it('返回默认态、标记 future，并且 save 不覆盖原存档', async () => {
    const raw = JSON.stringify({
      schema: { v: 5 },
      scores: { vitality: 9, progress: {}, achievement: 0 },
      cards: { exemption: 3, star: 8 },
      tasks: [{ id: 't1', name: '未来任务' }],
    });
    store.set(KEY, raw);

    const s = api.parseState(raw);
    expect(loadIssue).toEqual({ type: 'future', from: 5 });
    expect(_persistBlocked).toBe(true);
    expect(s).toEqual(api.defaults());
    expect(s.cards).toEqual({ exemption: 0 });

    api.save();
    expect(api.Persist.isPending()).toBe(false);
    await api.Persist.flush();
    expect(store.get(KEY)).toBe(raw);
  });
});

describe('flows / 运行层归一', () => {
  it('高于当前流版本的定义保留但禁用，不静默删除', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.flows = [
      { id: 'f_future', name: '未来流', v: 99, steps: [{ id: 's1', atom: 'log.note' }] },
      { id: 'f_ok', name: '正常流', v: 1, steps: [{ id: 's1', atom: 'log.note' }] },
    ];
    const s = api.parseState(JSON.stringify(base));
    expect(s.flows).toHaveLength(2);
    expect(s.flows[0]).toMatchObject({ id: 'f_future', name: '未来流', enabled: false, invalid: true });
    expect(s.flows[0].steps).toHaveLength(1);
    expect(s.flows[1]).toMatchObject({ id: 'f_ok', enabled: true, invalid: false });
    expect(s.flows[1].limits.maxSteps).toBe(32);
    expect(s.flows[1].trigger).toEqual({ type: 'period', period: 'week', anchor: 1 });
    expect(s.flows[1].condition).toBeTruthy();
  });

  it('assetMeters 计数夹到非负并取整，idem 保留 flowId/runId/at', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.ext.assetMeters = {
      v: 1,
      byAsset: { star: { '2026-W20': { issued: -2, spent: 3, runs: '2.6' } } },
      idem: { k1: { flowId: 'f1', runId: 'r1', at: 123 } },
    };
    const s = api.parseState(JSON.stringify(base));
    expect(s.ext.assetMeters.byAsset.star['2026-W20']).toEqual({ issued: 0, spent: 3, runs: 3 });
    expect(s.ext.assetMeters.idem.k1).toEqual({ flowId: 'f1', runId: 'r1', at: 123 });
  });

  it('flowRuns 只保留最近 50 条，byId 同步裁剪，记录字段被归一', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    const recent = [];
    const byId = {};
    for (let i = 0; i < 60; i++) {
      const id = 'r' + i;
      recent.push(id);
      byId[id] = {
        id, flowId: 'f1', flowName: '流', status: 'active',
        childLogIds: ['l1', 'l2'], deltas: { vitality: 5 },
      };
    }
    base.ext.flowRuns = { v: 1, seq: 60, byId, recent };
    const s = api.parseState(JSON.stringify(base));
    expect(s.ext.flowRuns.recent).toHaveLength(50);
    expect(s.ext.flowRuns.recent[0]).toBe('r0');
    expect(s.ext.flowRuns.recent[49]).toBe('r49');
    expect(Object.keys(s.ext.flowRuns.byId)).toHaveLength(50);
    expect(s.ext.flowRuns.byId.r59).toBeUndefined();
    expect(s.ext.flowRuns.byId.r0).toMatchObject({
      flowId: 'f1', status: 'active', childLogIds: ['l1', 'l2'],
    });
    expect(s.ext.flowRuns.byId.r0.deltas).toMatchObject({ vitality: 5 });
  });
});

describe('资产流水三要素（阶段 6）', () => {
  it('旧流水缺字段可读，新字段缺省按「未知」呈现', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.logs = [{ id: 'old', time: 1, st: 'card', amt: 1, desc: '旧发放', card: 'star' }];
    const s = api.parseState(JSON.stringify(base));
    expect(s.logs[0].assetCat).toBeUndefined();
    expect(api.assetLogMeta(s.logs[0])).toEqual({ cat: '', catName: '未知', from: '未知', to: '未知' });
  });

  it('新字段随存档往返保留；非法类别按缺失处理', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.logs = [
      { id: 'a', time: 1, st: 'card', amt: -1, desc: '消耗', card: 'star', assetCat: 'spend', assetFrom: '动作流「A」', assetTo: '兑换「咖啡」' },
      { id: 'b', time: 2, st: 'card', amt: 1, desc: '坏类别', card: 'star', assetCat: 'bogus' },
    ];
    const s = api.parseState(JSON.stringify(base));
    expect(api.assetLogMeta(s.logs[0])).toEqual({ cat: 'spend', catName: '消耗', from: '动作流「A」', to: '兑换「咖啡」' });
    expect(s.logs[1].assetCat).toBeUndefined();
    expect(api.assetCatName('freeze')).toBe('冻结');
    expect(api.assetCatName('')).toBe('未知');
  });

  it('旧流水仍可撤销（card-grant 适配器不受新字段影响）', () => {
    api.resetState({ cards: { exemption: 1 } });
    api.patchState(s => {
      s.logs.unshift({ id: 'lg', time: Date.now(), st: 'card', amt: 1, desc: '旧发放 1 张', src: 'card-grant', card: 'exemption' });
    });
    const r = api.Ledger.reverse('lg');
    expect(r && r.ok).toBe(true);
    expect(api.getState().cards.exemption).toBe(0);
  });
});

describe('导入闸门 3 <= v <= 4', () => {
  it('v3 导出文件可导入并补出定义', () => {
    stubReader(rawV3({ scores: { vitality: 7, progress: {}, achievement: 0 }, cards: { exemption: 0, star: 4 } }));
    api.importData({ target: { files: [{}], value: '' } });
    const s = api.getState();
    expect(s.schema.v).toBe(4);
    expect(s.scores.vitality).toBe(7);
    expect(s.cards.star).toBe(4);
    expect(s.assetDefs.some(d => d.id === 'star')).toBe(true);
  });

  it('v5 导出文件被拒绝，现有状态不被改写', () => {
    stubReader(JSON.stringify({ schema: { v: 5 }, scores: { vitality: 9 }, tasks: [] }));
    api.importData({ target: { files: [{}], value: '' } });
    const s = api.getState();
    expect(s.schema.v).toBe(4);
    expect(s.scores.vitality).toBe(0);
  });
});
