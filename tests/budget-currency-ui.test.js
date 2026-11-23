// M2 币种最小界面：徽标 / 账本 / 预算页分组 / 分类卡 chip 的显示口径。
// 只验证展示，不改任何金额公式（经济口径由 budget.test.js 与 baseline 守）。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

// shim 的 createElement 只存 textContent、不更新 innerHTML，会让 esc() 输出空串。
// 与 dump-render 同样处理：把 textContent 落到转义后的 innerHTML，才能断言真实渲染文本。
const realCreateElement = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.createElement = function (tag) {
  const el = realCreateElement(tag);
  let text = '';
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() { return text; },
    set(v) {
      text = String(v == null ? '' : v);
      el.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return el;
};

const BASE_CAT = {
  id: 'bc1', name: '餐饮', cycle: 'week', anchor: 1, limit: 1000,
  defaultProgressDomainId: 'd_default',
};

function seed(cats) {
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 100, progress: {}, achievement: 100 },
  });
  api.patchState(s => {
    (cats || [BASE_CAT]).forEach(c => {
      s.ext.budgets.categories.push(api.normalizeBudgetCategory(c, { domainIds: new Set(['d_default']) }));
    });
  });
}

function commit(catId, amount) {
  return api.Ledger.txn(tx => {
    const plan = api.BudgetEngine.prepareEntry(catId, amount, { ts: Date.now() });
    return api.BudgetEngine.commitEntry(tx, plan, {});
  }, { save: 'none', render: false });
}

function el(id) { return globalThis.document.getElementById(id); }

describe('徽标：按分类币种显示', () => {
  it('全 CNY 与今天一致；USD 用符号；分类失效不误标 ¥', () => {
    seed();
    expect(api.budgetBadgeHTML({ budget: { categoryId: 'bc1', mode: 'fixed', amount: 120 } }))
      .toBe('<span class="bud-badge" title="现实预算">¥120 · 餐饮</span>');

    api.patchState(s => { s.ext.budgets.categories[0].currency = 'USD'; });
    expect(api.budgetBadgeHTML({ budget: { categoryId: 'bc1', mode: 'fixed', amount: 120 } }))
      .toContain('US$120 · 餐饮');

    expect(api.budgetBadgeHTML({ budget: { categoryId: 'gone', mode: 'fixed', amount: 50 } }))
      .toContain('?50 · 预算分类已失效');
  });
});

describe('账本：每条按自身币种快照显示', () => {
  it('改分类币种不改写旧账目', () => {
    seed();
    commit('bc1', 320);
    api.patchState(s => { s.ext.budgets.categories[0].currency = 'USD'; });
    expect(api.budgetLedgerHTML()).toContain('¥320');
    expect(api.budgetLedgerHTML()).not.toContain('US$320');
  });

  it('USD 分类的新账目显示 US$', () => {
    seed([Object.assign({}, BASE_CAT, { currency: 'USD', limit: 100 })]);
    commit('bc1', 12);
    expect(api.budgetLedgerHTML()).toContain('US$12');
  });
});

describe('预算页顶部：按币种分组，不显示跨币种总额', () => {
  it('单币种保留原布局，金额补符号', () => {
    seed();
    commit('bc1', 320);
    api.renderBudget();
    expect(el('bPeriod').textContent).toBe('¥320 / ¥1000');
    expect(el('bPeriodSub').textContent).toBe('1 个启用分类');
  });

  it('多币种分组平铺，无合计', () => {
    seed([BASE_CAT, Object.assign({}, BASE_CAT, { id: 'bc2', name: '订阅', currency: 'USD', limit: 100 })]);
    commit('bc1', 320);
    commit('bc2', 12);
    api.renderBudget();
    expect(el('bPeriod').textContent).toBe('¥320 / ¥1000 · US$12 / US$100');
    expect(el('bPeriodSub').textContent).toBe('2 个启用分类 · 2 种币种');
  });
});

describe('M3b：方向展示', () => {
  function refund(catId, amount) {
    return api.Ledger.txn(tx => {
      const plan = api.BudgetEngine.prepareRefund(catId, amount, Date.now());
      return api.BudgetEngine.commitRefund(tx, plan);
    }, { save: 'none', render: false });
  }

  it('退回徽标带方向前缀；支出徽标保持原样', () => {
    seed();
    expect(api.budgetBadgeHTML({ budget: { categoryId: 'bc1', mode: 'fixed', amount: 50, direction: 'refund' } }))
      .toBe('<span class="bud-badge" title="现实预算">退回 ¥50 · 餐饮</span>');
    expect(api.budgetBadgeHTML({ budget: { categoryId: 'bc1', mode: 'fixed', amount: 50 } }))
      .toBe('<span class="bud-badge" title="现实预算">¥50 · 餐饮</span>');
  });

  it('账本把退回显示为“退回 +”，而不是来源不明的 0 元支出', () => {
    seed([Object.assign({}, BASE_CAT, { currency: 'USD', limit: 100 })]);
    commit('bc1', 30);
    refund('bc1', 10);
    const html = api.budgetLedgerHTML();
    expect(html).toContain('退回 +US$10');
    expect(html).toContain('<span class="tag">退款</span>');
    expect(html).not.toContain('US$0');
  });

  it('分类卡净额分别标出退回与冲正', () => {
    seed();
    commit('bc1', 50);
    refund('bc1', 10);
    const card = api.budgetCatCardHTML(api.BudgetEngine.category('bc1'), Date.now());
    expect(card).toContain('已花 <b>40</b>（退回 -10）');
    expect(card).toContain('本期退回 10');
    expect(card).not.toContain('本期冲正');
  });
});

describe('分类卡：仅非 CNY 显示币种 chip', () => {
  it('CNY 无 chip；USD 有代码 chip；金额仍为裸数字', () => {
    seed([BASE_CAT, Object.assign({}, BASE_CAT, { id: 'bc2', name: '订阅', currency: 'USD', limit: 100 })]);
    const cny = api.budgetCatCardHTML(api.BudgetEngine.category('bc1'), Date.now());
    const usd = api.budgetCatCardHTML(api.BudgetEngine.category('bc2'), Date.now());
    expect(cny).not.toContain('<span class="tag">USD</span>');
    expect(usd).toContain('<span class="tag">USD</span>');
    expect(usd).toContain('额度 <b>100</b>');
  });
});
