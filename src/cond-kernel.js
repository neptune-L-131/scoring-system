// cond-kernel.js —— 条件树求值内核（纯逻辑）
// 只做条件组的结构递归与比较运算；不读全局 state、不 import 实体 / 账务 / 渲染模块。
// 叶子条件的取值由调用方通过显式上下文注入：ctx.evalLeaf(item) → boolean。
// 状态相关的叶子求值器见 cond-eval.js，调用方（conditions.js / gate.js / modals.js）只依赖本文件。
function opSatisfied(val,op,v){
  if(op==='>')return val>v;
  if(op==='<')return val<v;
  if(op==='<=')return val<=v;
  return val>=v;
}
function evalNode(node,ctx){
  if(node&&node.group&&Array.isArray(node.items)){
    const items=node.items;
    if(!items.length)return true;
    const res=items.map(n=>evalNode(n,ctx));
    return node.mode==='any'?res.some(Boolean):res.every(Boolean);
  }
  if(!ctx||typeof ctx.evalLeaf!=='function')throw new TypeError('evalNode: ctx.evalLeaf 必须是函数');
  return ctx.evalLeaf(node);
}
export { opSatisfied, evalNode };
