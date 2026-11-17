// flow-scheduler.js —— 动作流调度的注册表
// flow-engine 在加载时注册 processDue，entities 的定时器只通过这里触发，
// 避免 entities↔flow-engine 循环依赖，行为不变。
let dueProcessor = null;

function registerFlowDueProcessor(fn){
  if(typeof fn==='function')dueProcessor = fn;
}
function processDueFlows(ts, silent){
  return dueProcessor ? dueProcessor(ts, silent) : undefined;
}

export { registerFlowDueProcessor, processDueFlows };
