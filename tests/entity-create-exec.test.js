// 创建事项动作 + 商品「执行权」：同一事务内付款与执行同生共死。
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const T = Date.UTC(2026, 0, 5, 12); // 周一
const TRUE_COND = () => ({ mode: 'all', items: [{ metric: 'lifetime_achievement', op: '>=', value: 0, range: 'total' }] });

function addFlow(raw) {
  const f = api.normalizeFlow(Object.assign({ id: 'f1', name: '创建流', condition: TRUE_COND(), steps: [] }, raw));
  api.patchState(s => { s.flows.push(f); });
  return f;
}
function addExecProduct(over) {
  const p = api.normalizeProduct(Object.assign({
    id: 'p1', name: '执行权商品', desc: '', price: 3, stock: 5, categoryId: 'sc_default', tier: 'daily',
    exec: { flowId: 'f1', maxPerPeriod: 2, period: 'day' }, sold: 0,
  }, over || {}));
  api.patchState(s => { s.products.push(p); });
  return p;
}
const createStep = (params) => ({ id: 'c1', atom: 'entity.create', params: params });

beforeEach(() => {
  api.resetState();
  api.__setClockForTest(() => T);
});
afterEach(() => {
  api.__setClockForTest(null);
});

describe('创建事项动作原子', () => {
  it('按模板创建两个任务，撤销后实体与流水都不残留', () => {
    addFlow({ steps: [createStep({ kind: 'task', name: '模板任务', domainId: 'd_default', amount: 5, count: 2 })] });
    const r = api.FlowEngine.runFlow('f1', { ts: T });
    expect(r.ok).toBe(true);
    let s = api.getState();
    expect(s.tasks).toHaveLength(2);
    expect(s.tasks.map(t => t.name)).toEqual(['模板任务（1）', '模板任务（2）']);
    expect(s.tasks.every(t => t.vitalityCost === 5 && t.domainIds[0] === 'd_default')).toBe(true);
    expect(s.logs.filter(l => l.src === 'entity-create')).toHaveLength(2);
    expect(s.flows[0].steps).toHaveLength(1);
    const u = api.undoFlowRun(r.runId, { ts: T });
    expect(u.ok).toBe(true);
    s = api.getState();
    expect(s.tasks).toHaveLength(0);
    expect(s.logs.filter(l => l.src === 'entity-create')).toHaveLength(0);
  });

  it('单次创建数量超过上限时编译阶段就拒绝', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '杂事', count: String(api.FLOW_ATOM_MAX_CREATE + 1) })] });
    const compiled = api.compile(api.getLive().flows[0]);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some(e => e.code === 'FLOW_CREATE_LIMIT')).toBe(true);
  });

  it('创建的事项被使用后拒绝撤销，不留半截', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '会被完成' })] });
    const r = api.FlowEngine.runFlow('f1', { ts: T });
    expect(r.ok).toBe(true);
    api.patchState(s => { s.chores[0].done = true; s.chores[0].doneAt = T; });
    const u = api.undoFlowRun(r.runId, { ts: T });
    expect(u.ok).toBe(false);
    expect(api.getState().chores).toHaveLength(1);
  });
});

describe('创建事项：情境标签', () => {
  it('杂事按模板创建时写入归一后的标签（去空白、去重、超限截断）', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '带情境杂事', tags: [' @电脑 ', '@阅读', '@电脑'] })] });
    const r = api.FlowEngine.runFlow('f1', { ts: T });
    expect(r.ok).toBe(true);
    const c = api.getState().chores[0];
    expect(c.tags).toEqual(['@电脑', '@阅读']);
  });

  it('任务/项目不接受 tags，编译期拒绝', () => {
    addFlow({ steps: [createStep({ kind: 'task', name: '任务', domainId: 'd_default', amount: 0, tags: ['@电脑'] })] });
    const c = api.compile(api.getLive().flows[0]);
    expect(c.ok).toBe(false);
    expect(c.errors.some(e => e.code === 'FLOW_BAD_PARAMS' && e.detail === 'tags')).toBe(true);
  });

  it('tags 非数组 / 超条数 / 超长 / 空串在编译期拒绝', () => {
    const cases = ['@电脑', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['@超过十二个字符的情境标签很长'], ['  ']];
    cases.forEach(function (tags) {
      api.patchState(s => { s.flows = []; });
      addFlow({ steps: [createStep({ kind: 'chore', name: '杂事', tags: tags })] });
      const c = api.compile(api.getLive().flows[0]);
      expect(c.ok).toBe(false);
      expect(c.errors.some(e => e.code === 'FLOW_BAD_PARAMS' && e.detail === 'tags')).toBe(true);
    });
  });
});

describe('商品执行权：付款与执行同生共死', () => {
  it('购买成功：扣钱并执行一次，购买流水与运行记录互相可识别', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '买来的杂事' })] });
    addExecProduct();
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.scores.vitality).toBe(97);
    expect(s.chores.map(c => c.name)).toEqual(['买来的杂事']);
    const leg = s.logs.find(l => l.src === 'purchase');
    expect(leg.execFlowId).toBe('f1');
    expect(leg.execRunId).toBeTruthy();
    const rec = s.ext.flowRuns.byId[leg.execRunId];
    expect(rec.trigger).toBe('purchase');
    expect(rec.orderId).toBe(leg.orderId);
    // 执行产生的运行不允许单独撤销
    const direct = api.undoFlowRun(leg.execRunId, { ts: T });
    expect(direct.ok).toBe(false);
    expect(direct.error.code).toBe('FLOW_UNDO_PURCHASE_BOUND');
  });

  it('购买执行运行记录：存储→读入→再序列化后触发类型与购买来源不变', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '往返杂事' })] });
    addExecProduct();
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    const leg = api.getState().logs.find(l => l.src === 'purchase');
    const rec = api.getState().ext.flowRuns.byId[leg.execRunId];
    expect(rec.trigger).toBe('purchase');
    expect(rec.orderId).toBeTruthy();
    expect(rec.productId).toBe('p1');

    // 第一次读入：模拟刷新后从存储恢复
    const loaded = api.parseState(JSON.stringify(api.getState()));
    const rec1 = loaded.ext.flowRuns.byId[leg.execRunId];
    expect(rec1.trigger).toBe('purchase');
    expect(rec1.orderId).toBe(rec.orderId);
    expect(rec1.productId).toBe(rec.productId);

    // 再序列化并再次读入：三字段仍然保真
    const loaded2 = api.parseState(JSON.stringify(loaded));
    const rec2 = loaded2.ext.flowRuns.byId[leg.execRunId];
    expect(rec2.trigger).toBe('purchase');
    expect(rec2.orderId).toBe(rec.orderId);
    expect(rec2.productId).toBe(rec.productId);
  });

  it('执行失败：整单回滚，钱、库存、实体、流水都不变', () => {
    addFlow({ steps: [{ id: 'x1', atom: 'currency.spend', params: { account: 'vitality', amount: 100 } }] });
    addExecProduct();
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.scores.vitality).toBe(100);
    expect(s.chores).toHaveLength(0);
    expect(s.logs.filter(l => l.src === 'purchase')).toHaveLength(0);
    expect(s.products[0].stock).toBe(5);
    expect(s.products[0].sold).toBe(0);
    expect(s.ext.flowRuns.list || []).toHaveLength(0);
  });

  it('每周期购买次数上限生效，失败不扣钱', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '限购杂事' })] });
    addExecProduct({ exec: { flowId: 'f1', maxPerPeriod: 1, period: 'day' } });
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    api.buyProduct('p1');
    const s = api.getState();
    expect(s.scores.vitality).toBe(97);
    expect(s.chores).toHaveLength(1);
    expect(s.logs.filter(l => l.src === 'purchase')).toHaveLength(1);
  });

  it('撤销购买：连带撤销执行（删实体、退钱、删流水、运行记 reversed）', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '可撤杂事' })] });
    addExecProduct();
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    const leg = api.getState().logs.find(l => l.src === 'purchase');
    const r = api.undoLog(leg.id, { ts: T });
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.scores.vitality).toBe(100);
    expect(s.chores).toHaveLength(0);
    expect(s.logs.filter(l => l.src === 'purchase' || l.src === 'entity-create')).toHaveLength(0);
    expect(s.ext.flowRuns.byId[leg.execRunId].status).toBe('reversed');
    expect(s.products[0].stock).toBe(5);
  });

  it('执行创建的事项已被使用：拒绝撤销购买并说明原因，不退款', () => {
    addFlow({ steps: [createStep({ kind: 'chore', name: '已用杂事' })] });
    addExecProduct();
    api.patchState(s => { s.scores.vitality = 100; });
    api.buyProduct('p1');
    api.patchState(s => { s.chores[0].done = true; s.chores[0].doneAt = T; });
    const leg = api.getState().logs.find(l => l.src === 'purchase');
    const r = api.undoLog(leg.id, { ts: T });
    expect(r.ok).toBe(false);
    const s = api.getState();
    expect(s.scores.vitality).toBe(97);
    expect(s.chores).toHaveLength(1);
    expect(s.logs.some(l => l.id === leg.id)).toBe(true);
  });

  it('老商品缺省 exec：读入为 null，购买行为不变', () => {
    const p = api.normalizeProduct({ id: 'old', name: '旧商品', price: 2, categoryId: 'sc_default', tier: 'daily' });
    expect(p.exec).toBeNull();
    api.patchState(s => { s.products.push(p); s.scores.vitality = 10; });
    api.buyProduct('old');
    const s = api.getState();
    expect(s.scores.vitality).toBe(8);
    expect(s.logs.filter(l => l.src === 'purchase')).toHaveLength(1);
  });
});
