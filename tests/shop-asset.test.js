// 阶段 5 第一步：商店资产定价（assetPrice）与购买赠送（grants）
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12);

function addToken(state) {
  state.assetDefs.push(api.normalizeAssetDef({
    id: 'token', name: '令牌', maxBalance: 99, maxIssuedPerPeriod: 9,
    issuePeriod: { cycle: 'week', anchor: 1 }, enabled: true,
  }));
  state.cards.token = 5;
}
function addProduct(state, over) {
  const p = api.normalizeProduct({
    id: 'p1', name: '资产商品', desc: '', price: 0, stock: 2,
    categoryId: 'sc_default', tier: 'daily',
    assetPrice: { assetId: 'token', amount: 2 },
    grants: [{ kind: 'currency', account: 'vitality', amount: 5 }],
    sold: 0,
    ...(over || {}),
  });
  state.products.push(p);
  return p;
}

beforeEach(() => {
  api.resetState();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('商店资产定价与赠送', () => {
  it('纯资产购买：扣资产、发赠送、只记一条主腿', () => {
    api.patchState(s => { addToken(s); addProduct(s); });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.cards.token).toBe(3);
    expect(s.scores.vitality).toBe(5); // 赠送货币
    const legs = s.logs.filter(l => l.src === 'purchase');
    expect(legs).toHaveLength(1);
    expect(legs[0].st).toBe('card');
    expect(legs[0].primaryPurchase).toBe(true);
    expect(legs[0].orderId).toBeTruthy();
    // 资产流水三要素：类别/来源/去向
    expect(legs[0].assetCat).toBe('spend');
    expect(legs[0].assetFrom).toBe('手动操作');
    expect(legs[0].assetTo).toBe('兑换「资产商品」');
    expect(api.computeEntryAgg(legs[0]).buy).toBe(1);
    expect(s.products[0].stock).toBe(1);
    expect(s.products[0].sold).toBe(1);
  });

  it('混合定价 + 货币不足：拒绝贷款、整单回滚', () => {
    api.patchState(s => {
      addToken(s);
      addProduct(s, { price: 100 });
      s.scores.vitality = 10;
    });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.cards.token).toBe(5);
    expect(s.scores.vitality).toBe(10);
    expect(s.logs.filter(l => l.src === 'purchase')).toHaveLength(0);
    expect(s.loans).toHaveLength(0);
    expect(s.products[0].stock).toBe(2);
  });

  it('资产定价商品保存后不保留现实预算联动', () => {
    api.patchState(s => {
      addToken(s);
      s.assetDefs.push(api.normalizeAssetDef({
        id: 'token', name: '令牌', maxBalance: 99, maxIssuedPerPeriod: 9,
        issuePeriod: { cycle: 'week', anchor: 1 }, enabled: true,
      }));
    });
    const cats = api.BudgetEngine.categories();
    if (!cats.length) return; // 默认无预算分类时该断言不适用
    api.saveProdData({
      id: null, name: '预算商品', desc: '', price: 10, stock: -1, debtRate: 1,
      categoryId: 'sc_default', tier: 'daily', gate: api.defaultProductGate(),
      budget: { categoryId: cats[0].id, amount: 50 },
      assetPrice: { assetId: 'token', amount: 1 },
      grants: [],
    });
    const p = api.getState().products.find(x => x.name === '预算商品');
    expect(p.assetPrice).toEqual({ assetId: 'token', amount: 1 });
    expect(p.budget).toEqual({ categoryId: '', amount: 0 });
    expect(p.debtRate).toBe(0);
  });

  it('赠送同一资产覆盖定价：判定自循环并拒绝', () => {
    api.patchState(s => {
      addToken(s);
      addProduct(s, { grants: [{ kind: 'asset', assetId: 'token', amount: 3 }] });
    });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.cards.token).toBe(5);
    expect(s.logs.filter(l => l.src === 'purchase')).toHaveLength(0);
  });

  it('整单撤销：退回资产与赠送货币、恢复库存', () => {
    api.patchState(s => { addToken(s); addProduct(s); });
    api.buyProduct('p1');
    const s = api.getState();
    const leg = s.logs.find(l => l.src === 'purchase');
    const r = api.undoLog(leg.id, { ts: T });
    expect(r.ok).toBe(true);
    const after = api.getState();
    expect(after.cards.token).toBe(5);
    expect(after.scores.vitality).toBe(0);
    expect(after.products[0].stock).toBe(2);
    expect(after.logs.filter(l => l.orderId === leg.orderId)).toHaveLength(0);
  });

  it('赠送已被消耗时拒绝整单撤销，不产生半退', () => {
    api.patchState(s => {
      addToken(s);
      addProduct(s, { grants: [{ kind: 'asset', assetId: 'token', amount: 1 }] });
    });
    api.buyProduct('p1'); // token 5 -> 3, +1 赠 -> 4
    const grantLog = api.getState().logs.find(l => l.src === 'purchase-grant' && l.st === 'card');
    expect(grantLog.assetCat).toBe('issue');
    expect(grantLog.assetFrom).toBe('商品「资产商品」');
    expect(grantLog.assetTo).toBeUndefined();
    expect(api.assetLogMeta(grantLog)).toMatchObject({ catName: '发放', to: '未知' });
    api.patchState(s => { s.cards.token = 0; }); // 余额已不足应退的赠送数量
    const leg = api.getState().logs.find(l => l.src === 'purchase');
    const r = api.undoLog(leg.id, { ts: T });
    expect(r.ok).toBe(false);
    const after = api.getState();
    expect(after.cards.token).toBe(0);
    expect(after.products[0].stock).toBe(1);
    expect(after.logs.some(l => l.id === leg.id)).toBe(true);
  });
});
