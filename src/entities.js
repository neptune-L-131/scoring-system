import { affairActive, evalCondition } from './cond-eval.js';
import { idleDaysSince, dayKey, periodKey, cardName, affairLastAdvance, effectiveLastTs, fmt, now } from './pure.js';
import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { FlowEngine } from './flow-engine.js';
import { Ledger } from './ledger.js';
import { ensureMetabolismRule, processDailyTaskDebts, processLoansWithDecayReserve } from './library.js';
import { save, scheduleRender } from './persist.js';
import { processChoreDecay } from './render-work.js';
import { state } from './state.js';
import { domainName } from './utils.js';
// entities.js —— 阶段 1 指标与结构操作（不活跃归档）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。
// 第五轮 S2-A：条件叶子求值已下沉到 cond-eval.js；本文件只保留结构操作与周期活动调度。

// ===== 结构操作：按“不活跃天数”归档实体 =====
// 动作自身携带阈值：条件只决定“何时执行”，动作决定“归档谁”。
// 从未活跃过的任务保持原样（与旧 processMetabolism 语义一致，交还用户处理）。
function archiveIdleEntities(entity,idleDays,ts,actName,dryRun){
  const days=Math.max(1,Math.round(Number(idleDays)||1));
  const label=actName||'周期活动';
  let n=0;
  function hit(d){return d!==null&&d>=days;}
  if(entity==='affair'){
    (state.affairs||[]).forEach(function(a){
      if(!affairActive(a))return;
      const d=idleDaysSince(affairLastAdvance(a)||a.createdAt,ts);
      if(!hit(d))return;
      n++;
      if(dryRun)return;
      a.archived=true;a.archivedAt=now();
      Ledger.event('项目「'+a.name+'」停滞 '+d+' 天，已由「'+label+'」归档','affair-archive',{affairId:a.id});
    });
    return n;
  }
  if(entity==='chore'){
    (state.chores||[]).forEach(function(c){
      if(c.archived)return;
      // 已完成但未结算的杂事不归档：否则会吞掉批量结算奖励
      if(c.done&&!c.settled)return;
      const d=idleDaysSince(c.doneAt||c.plannedAt||c.createdAt,ts);
      if(!hit(d))return;
      n++;
      if(dryRun)return;
      c.archived=true;c.archivedAt=now();
      Ledger.event('杂事「'+c.name+'」不活跃 '+d+' 天，已由「'+label+'」归档','chore-archive',{choreId:c.id});
    });
    return n;
  }
  (state.tasks||[]).forEach(function(t){
    if(t.archived)return;
    const d=idleDaysSince(effectiveLastTs(t),ts);
    if(!hit(d))return;
    n++;
    if(dryRun)return;
    t.archived=true;t.archivedAt=now();
    Ledger.event('任务「'+t.name+'」不活跃 '+d+' 天，已由「'+label+'」归档','archive',{taskId:t.id});
  });
  return n;
}
// ===== 资产发放核心：活动发卡与动作流 atom 共用的唯一上限/裁剪入口 =====
// mode='activity'：保留既有活动语义（单活动 cap 裁剪；余额已达上限返回 ok:false，不抛错）
// mode='flow'：严格失败语义（超出资产定义 maxBalance 返回 FLOW_ASSET_CAP，绝不静默裁剪）
// 只负责余额上限判断与写入；金额合法性（整数/单步上限）由调用方先行校验。
function assetGrantPlan(input){
  const mode=input.mode==='flow'?'flow':'activity';
  const raw=(state.cards&&state.cards[input.assetId])||0;
  const before=mode==='activity'?raw:(Number(raw)||0);
  const amount=Math.max(0,Math.round(Number(input.amount)||0));
  if(mode==='activity'){
    const cap=Math.max(1,Math.round(input.cap||1));
    if(!(amount>0&&before<cap))return{ok:false,granted:0,before:before,after:before,code:'CARD_AT_CAP'};
    const granted=Math.min(cap,before+amount)-before;
    if(granted<=0)return{ok:false,granted:0,before:before,after:before,code:'CARD_AT_CAP'};
    return{ok:true,granted:granted,before:before,after:before+granted};
  }
  if(!(amount>0))return{ok:false,granted:0,before:before,after:before,code:'FLOW_INVALID_AMOUNT'};
  const max=input.maxBalance;
  if(max!==null&&max!==undefined&&before+amount>Number(max)){
    return{ok:false,granted:0,before:before,after:before,code:'FLOW_ASSET_CAP'};
  }
  return{ok:true,granted:amount,before:before,after:before+amount};
}
function assetGrantCore(input){
  const plan=assetGrantPlan(input);
  if(!plan.ok)return plan;
  const r=Ledger.post({
    op:'grant',account:'card:'+input.assetId,delta:plan.granted,
    entry:input.entry?input.entry(plan.granted):undefined,
    reason:input.reason||{src:'card-grant'}
  });
  return Object.assign({},plan,{entryId:(r&&r.entryId)||null});
}
// 周期活动的动作分发：奖励类发放资产，结构类修改实体状态；两者共用同一事务与回滚边界
const RESULT_ACTION_HANDLERS={
  card:function(act,it){
    const card=it.card||'exemption';
    const cap=Math.max(1,Math.round(it.cap||1));
    const amount=Math.max(0,Math.round(it.amount||0));
    const r=assetGrantCore({
      mode:'activity',assetId:card,amount:amount,cap:cap,
      entry:function(granted){return {st:'card',amt:granted,desc:'周期活动「'+act.name+'」发放 '+granted+' 张'+cardName(card),src:'card-grant',dom:'',card:card,actId:act.id,granted:granted};},
      reason:{src:'card-grant'}
    });
    return r.ok;
  },
  progress:function(act,it){
    const amt=Number(it.amount)||0;
    if(amt<=0)return false;
    if(it.domainId){
      Ledger.post({op:'grant',account:'progress:'+it.domainId,delta:amt,entry:{st:'progress',amt:amt,desc:'「'+act.name+'」奖励 '+domainName(it.domainId)+' 进度',src:'reward',dom:it.domainId,actId:act.id},reason:{src:'reward'}});
    }else{
      const dids=state.domains.map(d=>d.id);
      Ledger.postSplits({splits:[{domainIds:dids,delta:amt}],entry:{st:'progress',amt:amt,desc:'「'+act.name+'」奖励 进度（全领域）',src:'reward',dom:'',actId:act.id},reason:{src:'reward'}});
    }
    return true;
  },
  vitality:function(act,it){
    const amt=Number(it.amount)||0;
    if(amt<=0)return false;
    const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
    const lbl=tName?('「'+tName+'」活力'):'活力';
    Ledger.post({op:'grant',account:'vitality',delta:amt,entry:{st:'vitality',amt:amt,desc:'「'+act.name+'」奖励 '+lbl+' +'+fmt(amt),src:'reward',dom:'',actId:act.id,taskId:it.taskId||''},reason:{src:'reward'}});
    return true;
  },
  achievement:function(act,it){
    const amt=Number(it.amount)||0;
    if(amt<=0)return false;
    Ledger.post({op:'grant',account:'achievement',delta:amt,entry:{st:'achievement',amt:amt,desc:'「'+act.name+'」奖励 成果 +'+fmt(amt),src:'reward',dom:'',actId:act.id},reason:{src:'reward'}});
    return true;
  },
  archive:function(act,it,ts){
    return archiveIdleEntities(it.entity,it.idleDays,ts,act.name,false)>0;
  }
};
function applyResult(act,ts){
  const items=(act.result&&act.result.items)||[];
  let grantedAny=false;
  const txr=Ledger.txn(function(){
    items.forEach(it=>{
      if(!it)return;
      const fn=RESULT_ACTION_HANDLERS[it.type];
      if(!fn)return;
      if(fn(act,it,ts)&&it.type!=='archive')grantedAny=true;
    });
    if(grantedAny)checkAchievements();
  },{label:'activity-reward',save:'none',render:false});
  return txr.ok;
}
// ===== 影子模式：只读预览（不发放、不写账目、不改 lastRun）=====
// 返回「若此刻触发各活动会发放什么」：金额与账户口径和真实 handler 保持一致，
// 但所有分支都是只读的；结构类动作走 dryRun 计数，绝不修改实体。
function previewResultItems(act,ts){
  const items=(act.result&&act.result.items)||[];
  const out=[];
  items.forEach(function(it){
    if(!it)return;
    if(it.type==='card'){
      const card=it.card||'exemption';
      const cap=Math.max(1,Math.round(it.cap||1));
      const amount=Math.max(0,Math.round(it.amount||0));
      const plan=assetGrantPlan({mode:'activity',assetId:card,amount:amount,cap:cap});
      if(plan.ok&&plan.granted>0)out.push({type:'card',account:'card:'+card,card:card,amount:plan.granted,cap:cap});
      return;
    }
    if(it.type==='progress'){
      const amt=Number(it.amount)||0;
      if(amt<=0)return;
      out.push({type:'progress',account:'progress:'+(it.domainId||'*'),domainId:it.domainId||'',amount:amt});
      return;
    }
    if(it.type==='vitality'){
      const amt=Number(it.amount)||0;
      if(amt<=0)return;
      out.push({type:'vitality',account:'vitality',taskId:it.taskId||'',amount:amt});
      return;
    }
    if(it.type==='achievement'){
      const amt=Number(it.amount)||0;
      if(amt<=0)return;
      out.push({type:'achievement',account:'achievement',amount:amt});
      return;
    }
    if(it.type==='archive'){
      const n=archiveIdleEntities(it.entity,it.idleDays,ts,act.name,true);
      if(n>0)out.push({type:'archive',entity:it.entity,idleDays:it.idleDays,count:n});
    }
  });
  return out;
}
// 只读预览所有启用活动：gateOpen 表示 lastRun 是否允许本期触发；
// matched 表示条件此刻是否成立；items 是条件成立时的假想发放明细。
function previewActivities(ts){
  ts=(ts===undefined||ts===null)?Date.now():(Number(ts)||0);
  const budgetCtx=BudgetEngine.activityContext(ts);
  return (state.activities||[]).filter(function(act){return act&&act.enabled;}).map(function(act){
    const key=periodKey(act,ts);
    const gateOpen=act.lastRun!==key;
    const matched=evalCondition(Object.assign({},act,{budgetCtx:budgetCtx}),ts);
    return{
      id:act.id,
      name:act.name,
      periodKey:key,
      gateOpen:gateOpen,
      matched:matched,
      items:matched?previewResultItems(act,ts):[]
    };
  });
}
function processActivities(silent=false,tsOverride){
  if(!state.activities)state.activities=[];
  const ts=(tsOverride===undefined||tsOverride===null)?Date.now():(Number(tsOverride)||0);
  // 预算类指标（budget_*）与预算规则共用同一套条件语法：
  // 活动侧同样注入预算上下文，避免“能配但永远为 0”的静默失效。
  const budgetCtx=BudgetEngine.activityContext(ts);
  let changed=false;
  state.activities.forEach(act=>{
    if(!act.enabled)return;
    const key=periodKey(act,ts);
    if(act.lastRun===key)return;
    if(evalCondition(Object.assign({},act,{budgetCtx:budgetCtx}),ts)){
      // 发放失败（事务回滚）时不推进 lastRun：否则本期奖励被永久吞掉，且无任何提示
      const ok=applyResult(act,ts);
      if(!ok)return;
    }
    act.lastRun=key;
    changed=true;
  });
  if(changed&&!silent)save();
}
var _lastTickDay=null;
function schedulerTick(){
  const d=dayKey(Date.now());
  if(_lastTickDay===null){_lastTickDay=d;return;}
  if(d===_lastTickDay)return;
  _lastTickDay=d;
  // 代谢规则只播种一次；真正的归档由 processActivities 按规则执行
  ensureMetabolismRule();
  // 统一以 silent 模式执行各处理器，最后只写盘一次
  processActivities(true);
  // 动作流与周期活动同位置求值；条件不成立时由引擎自行保持 lastRun 不变
  FlowEngine.processDue(undefined, true);
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  processChoreDecay(true);
  // 预算结算兜底：周期结束后惰性结算（记一笔/购买/打开预算页之外的最后防线）
  BudgetEngine.reconcileAll();
  save();
  scheduleRender();
}

export function setLastTickDay(v){_lastTickDay=v;}

export { affairActive, pointMetricValue, sumLogsInWindow, countLogsInWindow, logAffairDomain, affairWindowValue, choreWindowValue, evalCountMetric, evalCondItem } from './cond-eval.js';
export { archiveIdleEntities, assetGrantPlan, assetGrantCore, RESULT_ACTION_HANDLERS, applyResult, previewResultItems, previewActivities, processActivities, _lastTickDay, schedulerTick };
