import { normalizeActivity } from './normalize.js';
import { state } from './state.js';
// metabolism.js —— 首次载入/升级时播种“任务自动归档”周期活动
// 从 library.js 抽出，供 library/entities/startup 复用，避免 entities↔library 循环依赖，行为不变。

// ===== Metabolism（已迁移为周期活动）=====
// 自动归档不再有硬编码逻辑：首次载入/升级时播种一条可编辑、可停用、可删除的周期活动。
// 之后是否归档、归档阈值多少，全部由活动规则决定；本函数只负责播种。
function ensureMetabolismRule(){
  if(!state.ext||typeof state.ext!=='object')state.ext={};
  if(state.ext.metabolismSeeded)return false;
  state.ext.metabolismSeeded=true;
  if(!Array.isArray(state.activities))state.activities=[];
  if(state.activities.some(function(a){return a.id==='act_metabolism';}))return false;
  state.activities.push(normalizeActivity({
    id:'act_metabolism',
    name:'任务自动归档',
    enabled:true,
    period:'day',
    anchor:1,
    condition:{mode:'all',items:[{range:'today',metric:'task_idle',op:'>=',value:14,targetType:'all',target:'',newFilter:'none',aggregate:'sum'}]},
    result:{items:[{type:'archive',entity:'task',idleDays:14}]},
    lastRun:null
  }));
  return true;
}

export { ensureMetabolismRule };
