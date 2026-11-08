import { idleDaysSince } from './pure.js';
import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { condLeafEntities, entityMetricValue, evalCondition, logDomainsOf, opSatisfied, rangeStats } from './conditions.js';
import { Ledger } from './ledger.js';
import { ensureMetabolismRule, processDailyTaskDebts, processLoansWithDecayReserve } from './library.js';
import { save, scheduleRender } from './persist.js';
import { isArchivedEntity, round4, condWindowByRange, dayKey, dayStartTs, periodKey, cardName, isAffairMetric, isChoreMetric, isPointMetric, validRange, affairLastAdvance, round2, effectiveLastTs, fmt, getTaskDomainIds, now } from './pure.js';
import { processChoreDecay } from './render-work.js';
import { render } from './render.js';
import { state } from './state.js';
import { activityCountForDomain, choreOverdueDays, domainName, totalProgress } from './utils.js';
// entities.js —— 阶段 1 指标与结构操作（不活跃归档）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 阶段 1：项目 / 杂事 / 不活跃指标 =====
// 不活跃天数按自然日计算；从未活跃（无基准时间）返回 null，由调用方决定是否跳过
function affairActive(a){return !!a&&!a.doneAt&&!a.archived;}
// 点态指标：只看“此刻”的实体状态，与时间范围无关（配置时强制 range='today'）
function pointMetricValue(metric,it,ts){
  const tt=it.targetType||'all';
  const target=it.target||'';
  if(metric==='task_idle'){
    let tasks=(state.tasks||[]).filter(t=>!t.archived);
    if(tt==='task'&&target)tasks=tasks.filter(t=>t.id===target);
    else if(tt==='domain'&&target)tasks=tasks.filter(t=>getTaskDomainIds(t).indexOf(target)>=0);
    let max=0;
    tasks.forEach(t=>{
      const d=idleDaysSince(effectiveLastTs(t),ts);
      if(d!==null&&d>max)max=d;
    });
    return max;
  }
  if(metric==='affair_stall'){
    let list=(state.affairs||[]).filter(affairActive);
    if(tt==='domain'&&target)list=list.filter(a=>a.domainId===target);
    let max=0;
    list.forEach(a=>{
      const d=idleDaysSince(affairLastAdvance(a)||a.createdAt,ts);
      if(d!==null&&d>max)max=d;
    });
    return max;
  }
  if(metric==='chore_overdue'){
    return (state.chores||[]).filter(c=>!c.done&&!c.archived&&choreOverdueDays(c,ts)>0).length;
  }
  if(metric==='chore_idle'){
    let max=0;
    (state.chores||[]).filter(c=>!c.archived).forEach(c=>{
      const d=idleDaysSince(c.doneAt||c.plannedAt||c.createdAt,ts);
      if(d!==null&&d>max)max=d;
    });
    return max;
  }
  // ===== 阶段 3：门槛条件用点态指标 =====
  if(metric==='lifetime_achievement'){
    return Math.max(0,Number(state.ext&&state.ext.stats&&state.ext.stats.lifetimeAchievementEarned)||0);
  }
  if(metric==='checkin_streak'){
    let list=(state.tasks||[]).filter(t=>!t.archived);
    if(tt==='task'&&target)list=list.filter(t=>t.id===target);
    else if(tt==='domain'&&target)list=list.filter(t=>getTaskDomainIds(t).indexOf(target)>=0);
    let max=0;
    list.forEach(t=>{const v=Math.max(0,Math.round(Number(t.streak)||0));if(v>max)max=v;});
    return max;
  }
  if(metric==='milestone_unlocked'){
    if(!target)return 0;
    const a=(state.achievements||[]).find(x=>x.id===target);
    return (a&&!isArchivedEntity(a)&&a.unlocked)?1:0;
  }
  if(metric==='budget_remaining'){
    if(!target)return 0;
    const cat=BudgetEngine.category(target);
    if(!cat||!cat.enabled||cat.archived)return 0;
    const p=BudgetEngine.readPeriod(cat,ts).period;
    // 剩余额度按“基础限额 + 本期扩容”计算，与超支惩罚同一口径
    return round4(BudgetEngine.effectiveLimit(cat,p)-(Number(p&&p.spent)||0));
  }
  return 0;
}
// 窗口求和：遍历可见流水；日志被截断后旧记录不再参与（窗口取最近时影响可控）
function sumLogsInWindow(w,pred,useAbs){
  let sum=0;
  (state.logs||[]).forEach(function(l){
    const t=Number(l.time)||0;
    if(t<w.start||t>=w.end)return;
    if(!pred(l))return;
    const v=Number(l.amt)||0;
    sum+=useAbs?Math.abs(v):v;
  });
  return round2(sum);
}
function countLogsInWindow(w,pred){
  let n=0;
  (state.logs||[]).forEach(function(l){
    const t=Number(l.time)||0;
    if(t<w.start||t>=w.end)return;
    if(pred(l))n++;
  });
  return n;
}
// 项目流水的领域归属：优先领域字段，缺失时经 affairId 反查项目
function logAffairDomain(l){
  const dids=logDomainsOf(l);
  if(dids.length)return dids[0];
  if(l.affairId){
    const a=(state.affairs||[]).find(function(x){return x.id===l.affairId;});
    if(a&&a.domainId)return a.domainId;
  }
  return '';
}
function affairWindowValue(metric,it,w,range){
  const tt=it.targetType||'all';
  const target=it.target||'';
  const domainOk=function(a){return tt!=='domain'||!target||a.domainId===target;};
  const inWin=function(ts){return ts&&ts>=w.start&&ts<w.end;};
  if(metric==='affair_completed'){
    return (state.affairs||[]).filter(function(a){
      return domainOk(a)&&(range==='total'?!!a.doneAt:inWin(a.doneAt));
    }).length;
  }
  if(metric==='affair_steps'){
    let n=0;
    (state.affairs||[]).filter(domainOk).forEach(function(a){
      (a.steps||[]).forEach(function(s){
        if(!s||!s.text)return;
        if(range==='total'?!!s.doneAt:inWin(s.doneAt))n++;
      });
    });
    return n;
  }
  const logDomainOk=function(l){return tt!=='domain'||!target||logAffairDomain(l)===target;};
  if(metric==='affair_progress'){
    // 累计口径读实体字段（不受日志截断影响）；窗口口径只能读流水
    if(range==='total'){
      return round2((state.affairs||[]).filter(function(a){return domainOk(a)&&a.domainId;}).reduce(function(s,a){return s+(Number(a.alreadyGiven)||0);},0));
    }
    return sumLogsInWindow(w,function(l){return l.src==='affair'&&l.st==='progress'&&logDomainOk(l);},true);
  }
  if(metric==='affair_achievement'){
    if(range==='total'){
      return round2((state.affairs||[]).filter(function(a){return domainOk(a)&&a.doneAt&&a.ach&&a.ach.enabled;}).reduce(function(s,a){return s+(Number(a.ach.amount)||0);},0));
    }
    return sumLogsInWindow(w,function(l){return l.src==='affair'&&l.st==='achievement'&&logDomainOk(l);},true);
  }
  return 0;
}
function choreWindowValue(metric,w,range){
  if(metric==='chore_completed'){
    return (state.chores||[]).filter(function(c){
      return c.doneAt&&(range==='total'?true:(c.doneAt>=w.start&&c.doneAt<w.end));
    }).length;
  }
  if(metric==='chore_decay')return sumLogsInWindow(w,function(l){return l.src==='chore-decay';},true);
  if(metric==='chore_batches')return countLogsInWindow(w,function(l){return l.src==='chore-batch';});
  return 0;
}
// 计数类指标：新增任务/新增领域数量（主体 all/domain）
function evalCountMetric(it,w){
  const v=Number(it.value)||0;
  const isDomain=(it.targetType==='domain');
  const target=it.target||'';
  let val;
  if(it.metric==='new_tasks'){
    if(isDomain)val=state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end&&getTaskDomainIds(t).indexOf(target)>=0).length;
    else val=state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end).length;
  }else{
    if(isDomain)val=state.domains.some(d=>d.id===target&&d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end)?1:0;
    else val=state.domains.filter(d=>d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end).length;
  }
  return opSatisfied(val,it.op,v);
}
function evalCondItem(it,act,ts){
  const v=Number(it.value)||0;
  const range=validRange(it.range)?it.range:'period';
  // 预算指标：只读当前预算周期上下文（由 BudgetEngine 注入 act.budgetCtx）
  // budget_remaining 是点态指标（读分类剩余额度），不走预算规则上下文
  if(it.metric.indexOf('budget_')===0&&it.metric!=='budget_remaining'){
    const bc=(act&&act.budgetCtx)||{};
    let val=0;
    if(it.metric==='budget_entry_amount')val=Number(bc.entryAmount)||0;
    else if(it.metric==='budget_period_spent')val=Number(bc.spent)||0;
    else if(it.metric==='budget_period_overspend')val=Number(bc.overspend)||0;
    else if(it.metric==='budget_entry_count')val=Number(bc.entryCount)||0;
    return opSatisfied(val,it.op,v);
  }
  const w=range==='total'?{start:0,end:ts+1}:condWindowByRange(range,act,ts,it.days);
  // 阶段 3：领域活跃度读活跃度索引（不遍历日志，不受日志截断影响）
  if(it.metric==='domain_activity'){
    const did=(it.targetType==='domain')?(it.target||''):'';
    if(!did)return false;
    const days=range==='recent'?Math.max(1,Math.round(Number(it.days)||7)):Math.max(1,Math.round((w.end-w.start)/864e5));
    return opSatisfied(activityCountForDomain(did,days),it.op,v);
  }
  // 阶段 1：点态指标（不活跃天数/超期件数）与项目、杂事指标
  if(isPointMetric(it.metric))return opSatisfied(pointMetricValue(it.metric,it,ts),it.op,v);
  if(isAffairMetric(it.metric))return opSatisfied(affairWindowValue(it.metric,it,w,range),it.op,v);
  if(isChoreMetric(it.metric))return opSatisfied(choreWindowValue(it.metric,w,range),it.op,v);
  // 成果点：全局累计，无主体/新增/聚合概念
  if(it.metric==='achievement'){
    const val=range==='total'?(state.scores.achievement||0):rangeStats(w.start,w.end).achievement;
    return opSatisfied(val,it.op,v);
  }
  // 计数类指标：新增任务/新增领域数量
  if(it.metric==='new_tasks'||it.metric==='new_domains')return evalCountMetric(it,w);
  // 值类指标：主体 × 新增筛选 × 聚合。全局累计总和用累计字段（vitality 含无任务归属的日志），避免遗漏
  const isGlobalAll=(it.targetType||'all')==='all'&&(it.newFilter||'none')==='none'&&it.aggregate!=='any';
  if(isGlobalAll){
    let val;
    if(range==='total'){
      if(it.metric==='checkins')val=state.tasks.reduce((s,t)=>s+(t.checkInCount||0),0);
      else if(it.metric==='progress')val=totalProgress();
      else val=state.scores.vitality||0;
    }else{
      const st=rangeStats(w.start,w.end);
      val=it.metric==='checkins'?st.checkins:it.metric==='progress'?st.progressTotal:st.vitality;
    }
    return opSatisfied(val,it.op,v);
  }
  const entities=condLeafEntities(it,w);
  if(!entities.length)return false;
  const vals=entities.map(e=>entityMetricValue(it.metric,e,w,range));
  if(it.aggregate==='any')return vals.some(mv=>opSatisfied(mv,it.op,v));
  return opSatisfied(vals.reduce((s,x)=>s+x,0),it.op,v);
}
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
// 周期活动的动作分发：奖励类发放资产，结构类修改实体状态；两者共用同一事务与回滚边界
const RESULT_ACTION_HANDLERS={
  card:function(act,it){
    const card=it.card||'exemption';
    const cap=Math.max(1,Math.round(it.cap||1));
    const amount=Math.max(0,Math.round(it.amount||0));
    const before=state.cards[card]||0;
    if(!(amount>0&&before<cap))return false;
    const granted=Math.min(cap,before+amount)-before;
    if(granted<=0)return false;
    Ledger.post({op:'grant',account:'card:'+card,delta:granted,entry:{st:'card',amt:granted,desc:'周期活动「'+act.name+'」发放 '+granted+' 张'+cardName(card),src:'card-grant',dom:'',card:card,actId:act.id,granted:granted},reason:{src:'card-grant'}});
    return true;
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
function processActivities(silent=false){
  if(!state.activities)state.activities=[];
  const ts=Date.now();
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
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  processChoreDecay(true);
  // 预算结算兜底：周期结束后惰性结算（记一笔/购买/打开预算页之外的最后防线）
  BudgetEngine.reconcileAll();
  save();
  scheduleRender();
}

export function setLastTickDay(v){_lastTickDay=v;}

export { affairActive, pointMetricValue, sumLogsInWindow, countLogsInWindow, logAffairDomain, affairWindowValue, choreWindowValue, evalCountMetric, evalCondItem, archiveIdleEntities, RESULT_ACTION_HANDLERS, applyResult, processActivities, _lastTickDay, schedulerTick };
