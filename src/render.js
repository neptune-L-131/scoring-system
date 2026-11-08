// render.js —— 渲染调度：按固定顺序调用各渲染器（注册表，避免 shell ↔ render-* 循环）
// 由 shell.js 抽离（第六轮循环依赖治理），调用顺序与原先逐字一致。
const R = {};
function registerRenderer(name, fn) { R[name] = fn; }
// 顺序即原 render() 的调用顺序，不可随意调整
const ORDER = ['work', 'bank', 'shop', 'budget', 'cycle', 'exempt', 'stageBars', 'affairAxes'];
function render() {
  for (const n of ORDER) {
    const f = R[n];
    if (f) f();
  }
}
export { registerRenderer, render };
