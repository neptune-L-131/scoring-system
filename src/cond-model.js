import { ACTIVITY_MAX_DAYS, COND_METRIC_KEYS } from './constants.js';
import { defaultProductGate } from './defaults.js';
import { isAffairMetric, isChoreMetric, isGateMetric, isPointMetric, isStage1Metric, normOp, toNum, validRange } from './pure.js';
// cond-model.js —— 条件模型底层：归一化、展示文案、门槛条件推导
// 由 normalize/cycle/gate 抽离（第六轮循环依赖治理），实现逐字未改。

function normalizeCondition(c){
  if(c&&Array.isArray(c.items))
    return {mode:c.mode==='any'?'any':'all',items:c.items.map(normalizeCondNode).filter(Boolean)};
  return {mode:'all',items:[]};
}
function normalizeCondItem(it){
  if(!it||!validRange(it.range)||COND_METRIC_KEYS.indexOf(it.metric)<0)return null;
  const o={range:it.range,metric:it.metric,op:normOp(it.op),value:Number(it.value)||0};
  if(it.range==='recent')o.days=Math.max(1,Math.round(Number(it.days)||7));
  o.targetType=(it.targetType==='task'||it.targetType==='domain'||it.targetType==='milestone'||it.targetType==='budget')?it.targetType:'all';
  o.target=(o.targetType==='all')?'':(it.target||'');
  o.newFilter=(it.newFilter==='new_task'||it.newFilter==='new_domain')?it.newFilter:'none';
  o.aggregate=(it.aggregate==='any')?'any':'sum';
  return o;
}
function normalizeCondNode(node){
  if(node&&node.group)return {group:true,mode:node.mode==='any'?'any':'all',items:(node.items||[]).map(normalizeCondNode).filter(Boolean)};
  return normalizeCondItem(node);
}
function legacyGateCondition(gate,tier){
  const g=gate||defaultProductGate();
  const items=[];
  if(tier==='quality'){
    const need=Math.max(0,Math.round(toNum(g.minLifetime)));
    if(need>0)items.push({range:'total',metric:'lifetime_achievement',op:'>=',value:need,targetType:'all',target:'',newFilter:'none',aggregate:'sum'});
    const act=(g.activity&&typeof g.activity==='object')?g.activity:{};
    const did=String(act.domainId||'');
    const days=Math.max(0,Math.min(ACTIVITY_MAX_DAYS,Math.round(toNum(act.days))));
    const times=Math.max(0,Math.round(toNum(act.times)));
    if(did&&days>0&&times>0)items.push({range:'recent',days:days,metric:'domain_activity',op:'>=',value:times,targetType:'domain',target:did,newFilter:'none',aggregate:'sum'});
  }else if(tier==='exclusive'){
    // 空 milestoneId 也要保留一条叶子：老逻辑在未绑定里程碑时明确拒绝
    items.push({range:'total',metric:'milestone_unlocked',op:'>=',value:1,targetType:'milestone',target:String(g.milestoneId||''),newFilter:'none',aggregate:'sum'});
  }
  return {mode:'all',items:items};
}
function gateConditionOf(gate,tier){
  const g=gate||defaultProductGate();
  const c=normalizeCondition(g.condition);
  if(c.items.length)return c;
  return normalizeCondition(legacyGateCondition(g,tier));
}
export { normalizeCondition, normalizeCondItem, normalizeCondNode, legacyGateCondition, gateConditionOf };
