// work-ui-state.js —— 打工页 UI 状态的重置钩子
// 渲染层在加载时注册实现，业务层通过本模块触发，避免 library↔render-work 循环依赖。
let hooks = {
  reset: function(){},
  closeChoreDoneZone: function(){}
};

function registerWorkUiState(h){
  if(!h)return;
  if(typeof h.reset==='function')hooks.reset=h.reset;
  if(typeof h.closeChoreDoneZone==='function')hooks.closeChoreDoneZone=h.closeChoreDoneZone;
}
function resetWorkUiState(){return hooks.reset();}
function closeChoreDoneZone(){return hooks.closeChoreDoneZone();}

export { registerWorkUiState, resetWorkUiState, closeChoreDoneZone };
