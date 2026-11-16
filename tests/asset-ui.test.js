import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function builtinDef() {
  return api.defaultAssetDefs()[0];
}

function starDef() {
  return {
    v: 1, id: 'star', name: '星星', unit: '颗',
    maxBalance: 10, maxIssuedPerPeriod: 3,
    issuePeriod: { cycle: 'week', anchor: 1 },
    enabled: true, archived: false, origin: 'user', createdAt: 1, updatedAt: 1,
  };
}

function seed(patch) {
  api.resetState(Object.assign({
    cards: { exemption: 0, star: 0 },
    assetDefs: [builtinDef(), starDef()],
    flows: [],
    activities: [],
  }, patch || {}));
}

function draft(over) {
  return Object.assign({
    id: 'star2', name: '月亮', unit: '个',
    maxBalance: '', maxIssuedPerPeriod: '',
    cycle: 'week', anchor: '1',
  }, over || {});
}

function fillForm(over) {
  const v = Object.assign({
    originalId: '', id: 'star2', name: '月亮', unit: '个',
    maxBalance: '', maxIssued: '', cycle: 'week', anchor: '1',
  }, over || {});
  const set = (id, value) => { document.getElementById(id).value = value; };
  set('assetOriginalId', v.originalId);
  set('assetId', v.id);
  set('assetName', v.name);
  set('assetUnit', v.unit);
  set('assetMaxBalance', v.maxBalance);
  set('assetMaxIssued', v.maxIssued);
  set('assetCycle', v.cycle);
  set('assetAnchor', v.anchor);
  document.getElementById('assetFormHint').textContent = '';
}

function formHint() {
  return document.getElementById('assetFormHint').textContent;
}

describe('S8 资产定义校验', () => {
  beforeEach(() => seed());

  it('非法 id 被拒绝并给出格式说明', () => {
    const r = api.validateAssetDraft(draft({ id: 'Star-2' }), { defs: api.getState().assetDefs });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_ID_INVALID');
    expect(r.message).toContain('资产 ID 不合法');
  });

  it('保留 id exemption 被拒绝', () => {
    const r = api.validateAssetDraft(draft({ id: 'exemption' }), { defs: api.getState().assetDefs });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_ID_RESERVED');
  });

  it('重复 id 被拒绝', () => {
    const r = api.validateAssetDraft(draft({ id: 'star' }), { defs: api.getState().assetDefs });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_ID_DUP');
    expect(r.message).toContain('star');
  });

  it('重复名称被拒绝（忽略自身）', () => {
    const r = api.validateAssetDraft(draft({ name: '星星' }), { defs: api.getState().assetDefs });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_NAME_DUP');
    const self = api.validateAssetDraft(draft({ id: 'star', name: '星星' }), { defs: api.getState().assetDefs, originalId: 'star' });
    expect(self.ok).toBe(true);
  });

  it('余额上限低于当前余额被拒绝', () => {
    const r = api.validateAssetDraft(draft({ maxBalance: '4' }), { defs: api.getState().assetDefs, balance: 5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_MAX_BALANCE_BELOW_BALANCE');
    expect(r.message).toContain('当前余额 5');
  });

  it('单期发放上限低于本期已发被拒绝', () => {
    const r = api.validateAssetDraft(draft({ maxIssuedPerPeriod: '2' }), { defs: api.getState().assetDefs, periodIssued: 3 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_MAX_ISSUED_BELOW_METER');
    expect(r.message).toContain('本期已发 3');
  });

  it('内置资产不可被修改', () => {
    const r = api.validateAssetDraft(draft({ id: 'exemption', name: '新名字' }), { defs: api.getState().assetDefs, builtin: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_BUILTIN_LOCKED');
    expect(r.message).toContain('内置资产');
  });

  it('合法输入返回规范化值，空上限为 null', () => {
    const r = api.validateAssetDraft(draft(), { defs: api.getState().assetDefs });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ id: 'star2', name: '月亮', unit: '个', maxBalance: null, maxIssuedPerPeriod: null });
    expect(r.value.issuePeriod).toEqual({ cycle: 'week', anchor: 1 });
  });
});

describe('S8 资产定义处理器', () => {
  beforeEach(() => seed());

  it('非法输入在表单提示中可见且不写入 state', () => {
    const before = api.getState();
    fillForm({ id: 'BAD ID' });
    const r = api.handleAssetSave();
    expect(r.ok).toBe(false);
    expect(formHint()).toContain('资产 ID 不合法');
    const after = api.getState();
    expect(after.assetDefs).toEqual(before.assetDefs);
    expect(after.cards).toEqual(before.cards);
  });

  it('新建资产写入定义与零余额', () => {
    fillForm();
    const r = api.handleAssetSave();
    expect(r.ok).toBe(true);
    const def = api.getState().assetDefs.find(d => d.id === 'star2');
    expect(def).toMatchObject({ name: '月亮', unit: '个', origin: 'user', enabled: true, archived: false });
    expect(api.getState().cards.star2).toBe(0);
  });

  it('编辑内置资产被拒绝且定义不变', () => {
    api.openAssetModal('exemption');
    document.getElementById('assetName').value = '改名';
    const r = api.handleAssetSave();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_BUILTIN_LOCKED');
    expect(api.getState().assetDefs.find(d => d.id === 'exemption').name).toBe(builtinDef().name);
  });

  it('停用有余额的资产被拒绝', () => {
    seed({ cards: { exemption: 0, star: 5 } });
    const r = api.toggleAssetEnabled('star');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_BALANCE_NOT_ZERO');
    expect(r.message).toContain('仍有余额 5');
    expect(api.getState().assetDefs.find(d => d.id === 'star').enabled).toBe(true);
  });

  it('余额为 0 时可以停用并保留定义', () => {
    const r = api.toggleAssetEnabled('star');
    expect(r.ok).toBe(true);
    expect(api.getState().assetDefs.find(d => d.id === 'star').enabled).toBe(false);
  });

  it('归档同样要求余额为 0，恢复后回到原启用状态', () => {
    seed({ cards: { exemption: 0, star: 2 } });
    expect(api.archiveAssetDef('star').ok).toBe(false);
    seed();
    expect(api.archiveAssetDef('star').ok).toBe(true);
    expect(api.getState().assetDefs.find(d => d.id === 'star').archived).toBe(true);
    expect(api.unarchiveAssetDef('star').ok).toBe(true);
    const def = api.getState().assetDefs.find(d => d.id === 'star');
    expect(def.archived).toBe(false);
    expect(def.enabled).toBe(true);
  });

  it('内置资产不能删除或停用', () => {
    expect(api.delAssetDef('exemption')).toMatchObject({ ok: false, code: 'ASSET_BUILTIN_LOCKED' });
    expect(api.toggleAssetEnabled('exemption')).toMatchObject({ ok: false, code: 'ASSET_BUILTIN_LOCKED' });
  });

  it('被动作流引用的资产不能删除', () => {
    seed({
      flows: [{ id: 'f1', name: '周结流', steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'star', amount: 1 } }] }],
    });
    const r = api.delAssetDef('star');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ASSET_REFERENCED_BY_FLOW');
    expect(r.message).toContain('动作流');
    expect(api.getState().assetDefs.some(d => d.id === 'star')).toBe(true);
  });

  it('无余额且无引用时可以删除，并同步清理余额与计量桶', () => {
    seed({ cards: { exemption: 0, star: 0 } });
    api.patchState(s => {
      s.ext.assetMeters.byAsset.star = { '2026-W46': { issued: 2 } };
    });
    const r = api.delAssetDef('star');
    expect(r.ok).toBe(true);
    expect(api.getState().assetDefs.some(d => d.id === 'star')).toBe(false);
    expect('star' in api.getState().cards).toBe(false);
    expect(api.getState().ext.assetMeters.byAsset.star).toBeUndefined();
  });

  it('引用扫描同时覆盖动作流步骤与周期活动动作项', () => {
    seed({
      flows: [{ id: 'f1', name: '周结流', steps: [{ id: 's1', atom: 'asset.spend', params: { assetId: 'star', amount: 1 } }] }],
      activities: [{ id: 'a1', name: '每日奖励', result: { items: [{ type: 'card', card: 'star', amount: 1 }] } }],
    });
    const refs = api.assetReferencesOf('star');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ kind: 'flow', name: '周结流', stepLabel: 's1', action: '消耗' });
    expect(refs[1]).toMatchObject({ kind: 'activity', name: '每日奖励', action: '发放' });
  });
});

describe('S8 资产定义渲染与清空数据说明', () => {
  beforeEach(() => seed());

  it('列表渲染内置锁定说明与引用提示', () => {
    seed({
      flows: [{ id: 'f1', name: '周结流', steps: [{ id: 's1', atom: 'asset.grant', params: { assetId: 'star', amount: 1 } }] }],
    });
    api.renderAssetDefs();
    const html = document.getElementById('assetDefsList').innerHTML;
    expect(html).toContain('内置资产：名称、单位、上限与周期由系统固定，不可改名或删除');
    expect(html).toContain('引用：动作流');
    expect(html).toContain('执行到该步骤会失败');
    expect(html).toContain('余额 0 ');
  });

  it('清空数据弹窗明确“只清零余额、保留定义”', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('只把资产余额清零');
    expect(html).toContain('资产定义与动作流配置保留');
  });
});
