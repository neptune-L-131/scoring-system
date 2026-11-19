import { BudgetEngine } from './budget.js';
import { COND_RANGES } from './constants.js';
import { isAffairMetric, isAssetHoldMetric, isAssetMetric, isChoreMetric, isPointMetric, fmt } from './pure.js';
import { state } from './state.js';
import { relativeDay } from './time.js';
import { domainName, taskNameLabel } from './utils.js';
// cycle.js —— 周期页与条件文案
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 通用折叠面板 =====
function toggleAcc(id){const el=document.getElementById(id);if(el)el.classList.toggle('open');}
// ===== Cycle Settings =====
function fmtDate(ts){
  if(!ts)return '—';
  const d=new Date(ts);
  const diffDays=relativeDay(ts);
  if(diffDays===0)return '今天';
  if(diffDays===1)return '明天';
  if(diffDays===2)return '后天';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function periodLabel(p){return p==='day'?'每天':p==='month'?'每月':'每周';}
const COND_METRICS=[
  {v:'checkins',n:'打卡次数'},
  {v:'vitality',n:'活力点'},
  {v:'progress',n:'进度值'},
  {v:'achievement',n:'成果点'},
  {v:'new_tasks',n:'新增任务'},
  {v:'new_domains',n:'新增领域'},
  {v:'budget_entry_amount',n:'本笔金额'},
  {v:'budget_period_spent',n:'本周期已花'},
  {v:'budget_period_overspend',n:'本周期超支'},
  {v:'budget_entry_count',n:'本周期笔数'},
  {v:'task_idle',n:'任务不活跃天数'},
  {v:'affair_completed',n:'项目完成数'},
  {v:'affair_steps',n:'项目推进步数'},
  {v:'affair_stall',n:'项目停滞天数'},
  {v:'affair_progress',n:'项目进度值'},
  {v:'affair_achievement',n:'项目成果点'},
  {v:'chore_completed',n:'杂事完成数'},
  {v:'chore_overdue',n:'杂事超期件数'},
  {v:'chore_decay',n:'杂事腐化值'},
  {v:'chore_batches',n:'杂事结算次数'},
  {v:'chore_idle',n:'杂事不活跃天数'},
  {v:'lifetime_achievement',n:'累计获得成果点'},
  {v:'domain_activity',n:'领域活跃次数'},
  {v:'milestone_unlocked',n:'里程碑已解锁'},
  {v:'checkin_streak',n:'连续打卡天数'},
  {v:'budget_remaining',n:'预算剩余'},
  {v:'asset_hold',n:'持有数量'},
  {v:'asset_issued',n:'已发放数量'},
  {v:'asset_spent',n:'已消耗数量'}
];
const COND_TARGET_TYPES=[{v:'all',n:'全部'},{v:'domain',n:'按领域'},{v:'task',n:'按任务'},{v:'milestone',n:'按里程碑'},{v:'budget',n:'按预算分类'},{v:'asset',n:'按资产'}];
const COND_NEW_FILTERS=[{v:'none',n:'当前'},{v:'new_task',n:'本周期新增任务'},{v:'new_domain',n:'本周期新增领域'}];
const COND_AGGREGATES=[{v:'sum',n:'总计'},{v:'any',n:'任意单个'}];
// 主体类型：成果点仅全部；计数类(新增任务/新增领域)支持全部+领域；值类(打卡/活力/进度)支持全部+领域+任务
// 阶段 1：项目类支持全部+领域；杂事类仅全部；任务不活跃支持全部+领域+任务
function condTargetTypesFor(metric){
  if(metric==='achievement'||metric==='lifetime_achievement')return ['all'];
  if(metric==='milestone_unlocked')return ['milestone'];
  if(metric==='budget_remaining')return ['budget'];
  if(isAssetMetric(metric))return ['asset'];
  if(metric==='domain_activity')return ['domain'];
  if(metric.indexOf('budget_')===0)return ['all'];
  if(metric==='new_tasks'||metric==='new_domains')return ['all','domain'];
  if(isChoreMetric(metric))return ['all'];
  if(isAffairMetric(metric))return ['all','domain'];
  return ['all','domain','task'];
}
// 新增筛选选项（仅值类指标；按主体限制可用项）
function condNewFilterOptions(targetType){
  if(targetType==='all')return ['none','new_task','new_domain'];
  if(targetType==='domain')return ['none','new_task'];
  return ['none'];
}
function rangeLabel(range,days){
  if(range==='recent')return '最近'+(days||7)+'天';
  const r=COND_RANGES.find(x=>x.v===range);
  return r?r.n:'本周期';
}
function metricNameLabel(it){
  return (COND_METRICS.find(m=>m.v===it.metric)||{}).n||it.metric;
}
function condEntityWord(it){
  return it.newFilter==='new_domain'?'领域':'任务';
}
// 是否多实体语境（需要展示「总计/任意单个」聚合方式）
function condIsMulti(it){
  if(it.newFilter==='new_task'||it.newFilter==='new_domain')return true;
  if(it.targetType==='all'&&it.aggregate==='any')return true;
  return false;
}
// 主体+新增短语（不含范围与聚合）
function condScopePhrase(it){
  const t=it.target||'';
  if(it.newFilter==='new_task'){
    if(it.targetType==='domain'&&t)return domainName(t)+'新增任务';
    return '新增任务';
  }
  if(it.newFilter==='new_domain')return '新增领域';
  if(it.targetType==='domain'&&t)return domainName(t);
  if(it.targetType==='task'&&t)return taskNameLabel(t);
  if(it.targetType==='milestone'&&t){
    const a=(state.achievements||[]).find(x=>x.id===t);
    return a?a.name:'（里程碑已删除）';
  }
  if(it.targetType==='budget'&&t){
    const c=BudgetEngine.category(t);
    return c?c.name:'（预算分类已删除）';
  }
  if(it.targetType==='asset'){
    if(!t)return '（未选择资产）';
    const d=(state.assetDefs||[]).find(x=>x&&x.id===t);
    return d?d.name:'（资产已删除）';
  }
  return '';
}
function metricLabel(it){
  const mn=metricNameLabel(it);
  let s=condScopePhrase(it);
  if(condIsMulti(it))s+=(it.aggregate==='any'?'·任一'+condEntityWord(it):'·总计');
  return (s?s+'·':'')+mn;
}
function opLabel(op){return {'<=':'≤','>=':'≥','>':'>','<':'<'}[op]||'≥';}
function rangeTimeWord(it,act){
  if(it.range==='today')return '今天';
  if(it.range==='recent')return '最近'+(it.days||7)+'天';
  if(it.range==='total')return '累计';
  if(act&&act._budget)return '本周期';
  if(act.period==='day')return '昨日';
  if(act.period==='month')return '上月';
  return '上周';
}
function condItemLabel(it){
  if(!it)return '';
  if(isPointMetric(it.metric)||isAssetHoldMetric(it.metric))return metricLabel(it)+' '+opLabel(it.op)+' '+fmt(it.value);
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it)+' '+opLabel(it.op)+' '+fmt(it.value);
}
function condNodeLabel(node){
  if(node&&node.group)return '（'+((node.items||[]).map(condNodeLabel).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condItemLabel(node);
}
function condNLLeaf(it,act){
  const rw=rangeTimeWord(it,act);
  const mn=metricNameLabel(it);
  const tail=' '+opLabel(it.op)+' '+fmt(it.value);
  // 点态指标没有时间窗口：直接“主体·指标 ≥ N”
  if(isPointMetric(it.metric)||isAssetHoldMetric(it.metric))return (condScopePhrase(it)?condScopePhrase(it)+'·':'')+mn+tail;
  if(it.metric==='achievement')return rw+mn+tail;
  const scope=condScopePhrase(it);
  const ew=condEntityWord(it);
  const anyAgg=it.aggregate==='any';
  if(it.newFilter==='new_task'||it.newFilter==='new_domain'){
    if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
    return rw+scope+'总计'+mn+tail;
  }
  if(it.targetType==='all'){
    if(anyAgg)return rw+'任意单个'+ew+mn+tail;
    return rw+mn+tail;
  }
  if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
  return rw+scope+mn+tail;
}
function condNLNode(node,act){
  if(node&&node.group)return '（'+((node.items||[]).map(n=>condNLNode(n,act)).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condNLLeaf(node,act);
}






export { toggleAcc, fmtDate, periodLabel, COND_METRICS, COND_TARGET_TYPES, COND_NEW_FILTERS, COND_AGGREGATES, condTargetTypesFor, condNewFilterOptions, rangeLabel, metricNameLabel, condEntityWord, condIsMulti, condScopePhrase, metricLabel, opLabel, rangeTimeWord, condItemLabel, condNodeLabel, condNLLeaf, condNLNode };

