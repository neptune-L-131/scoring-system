// 执行权商品限购计数：不依赖会被裁剪的购买流水（LOG_MAX）。
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12); // 周一
const TRUE_COND = () => ({ mode: 'all', items: [{ metric: 'lifetime_achievement', op: '>=', value: 0, range: 'total' }] });

function setup(exec) {
  api.patchState(s => {
    s.flows.push(api.normalizeFlow({
      id: 'f1', name: '限购流', condition: TRUE_COND(),
      steps: [{ id: 'c1', atom: 'entity.create', params: { kind: 'chore', name: '限购杂事' } }],
    }));
    s.products.push(api.normalizeProduct({
      id: 'p1', name: '执行权商品', desc: '', price: 3, stock: -1,
      categoryId: 'sc_default', tier: 'daily', sold: 0, exec: exec,
    }));
    s.scores.vitality = 100;
  });
}
const live = () => api.getLive();
const purchases = () => (live().logs || []).filter(l => l.src === 'purchase');
const buy = () => api.buyProduct('p1');

beforeEach(() => {
  api.resetState();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('执行权限购计数与日志窗口解耦', () => {
  it('日志被裁到远小于窗口后，同周期内买满 N 次仍被拒', () => {
    setup({ flowId: 'f1', maxPerPeriod: 3, period: 'day' });
    buy(); buy(); buy();
    expect(purchases()).toHaveLength(3);
    expect(live().scores.vitality).toBe(91);

    // 模拟日志裁剪：只留最近 1 条，旧购买流水全部消失
    api.patchState(s => { s.logs = s.logs.slice(-1); });
    expect(purchases().length).toBeLessThan(3);

    const before = live().scores.vitality;
    buy();
    expect(live().scores.vitality).toBe(before);
    expect(live().chores).toHaveLength(3);
    expect(live().products[0].sold).toBe(3);
  });

  it('序列化 → parseState 往返后计数不丢', () => {
    setup({ flowId: 'f1', maxPerPeriod: 3, period: 'day' });
    buy(); buy();
    const saved = JSON.parse(JSON.stringify(api.getState()));
    expect(saved.ext.execBuys.byProduct.p1).toEqual({ key: api.rangeOf('day', T, 1).key, n: 2 });

    const loaded = api.parseState(JSON.stringify(saved));
    expect(loaded.ext.execBuys.byProduct.p1).toEqual({ key: api.rangeOf('day', T, 1).key, n: 2 });
    api.setState(loaded);

    buy(); // 第 3 次允许
    buy(); // 第 4 次拒绝
    expect(live().scores.vitality).toBe(91);
    expect(purchases()).toHaveLength(3);
  });

  it('跨周期后计数归零，可以重新买满 N 次', () => {
    setup({ flowId: 'f1', maxPerPeriod: 2, period: 'day' });
    buy(); buy();
    buy(); // 拒绝
    expect(purchases()).toHaveLength(2);

    api.__setClockForTest(() => api.rangeOf('day', T, 1).end);
    buy(); buy();
    buy(); // 新周期买满后再拒绝
    expect(purchases()).toHaveLength(4);
    expect(live().scores.vitality).toBe(88);
  });

  it('导出 JSON → 导入（parseState 同一口径）后计数仍正确', () => {
    setup({ flowId: 'f1', maxPerPeriod: 2, period: 'day' });
    buy(); buy();
    const exported = JSON.stringify(api.getState());
    globalThis.FileReader = function FileReaderStub() {
      this.readAsText = function () { if (this.onload) this.onload({ target: { result: exported } }); };
    };
    api.importData({ target: { files: [{}], value: '' } });
    expect(live().ext.execBuys.byProduct.p1.n).toBe(2);
    buy(); // 导入后仍处于同周期，拒绝
    expect(purchases()).toHaveLength(2);
  });

  it('旧存档没有 execBuys：读入为空结构，计数从 0 起步且不报错', () => {
    setup({ flowId: 'f1', maxPerPeriod: 1, period: 'day' });
    const saved = JSON.parse(JSON.stringify(api.getState()));
    delete saved.ext.execBuys;
    const loaded = api.parseState(JSON.stringify(saved));
    expect(loaded.ext.execBuys).toEqual({ v: 1, byProduct: {} });
    api.setState(loaded);
    buy();
    expect(purchases()).toHaveLength(1);
  });

  it('撤销购买后同周期退回一次额度', () => {
    setup({ flowId: 'f1', maxPerPeriod: 1, period: 'day' });
    buy();
    buy(); // 拒绝
    expect(purchases()).toHaveLength(1);
    const r = api.undoLog(purchases()[0].id, { ts: T });
    expect(r.ok).toBe(true);
    buy(); // 额度已退回
    expect(purchases()).toHaveLength(1);
  });

  it('清除数据成果后计数归零（与日志、运行记录同口径）', () => {
    setup({ flowId: 'f1', maxPerPeriod: 1, period: 'day' });
    buy();
    buy(); // 拒绝
    expect(purchases()).toHaveLength(1);
    api.clearDataResults();
    expect(live().ext.execBuys).toEqual({ v: 1, byProduct: {} });
    buy(); // 清空后可重新购买
    expect(purchases()).toHaveLength(1);
  });
});

describe('每天 / 每周 / 每月三种周期口径的边界', () => {
  ['day', 'week', 'month'].forEach(period => {
    it(period + '：边界前拒绝，边界后重新计数', () => {
      setup({ flowId: 'f1', maxPerPeriod: 2, period: period });
      buy(); buy();
      const end = api.rangeOf(period, T, 1).end;

      api.__setClockForTest(() => end - 1);
      buy(); // 仍在旧周期：拒绝
      expect(purchases()).toHaveLength(2);

      api.__setClockForTest(() => end);
      buy(); buy();
      buy(); // 新周期买满后再拒绝
      expect(purchases()).toHaveLength(4);
    });
  });
});
