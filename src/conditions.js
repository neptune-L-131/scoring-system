import { evalCondItem } from './entities.js';
import { getTaskDomainIds, dayKey, weekStartTs } from './pure.js';
import { state } from './state.js';
import { domainProgress } from './utils.js';
// conditions.js —— 条件求值（evalNode/evalCondItem）与日期/周期工具（dayKey/weekStartTs/budgetBounds）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

function weekScore(start,end){
  let vit=0,prog=0,ach=0,checkins=0,invest=0,consume=0;
  eachStatsBucket(start,end,function(b){
    vit+=Number(b.v)||0;
    prog+=Number(b.p)||0;
    ach+=Number(b.a)||0;
    checkins+=Number(b.ck)||0;
    invest+=Number(b.inv)||0;
    consume+=Number(b.cons)||0;
  });
  const spend=invest+consume;
  const investRate=spend>0?invest/spend*100:0;
  const score=prog + vit*0.5 + ach*10 + checkins*2;
  return {vit:vit,prog:prog,ach:ach,checkins:checkins,invest:invest,consume:consume,investRate:investRate,score:score};
}
function exemptionActivity(){
  return (state.activities||[]).find(a=>a.enabled&&(a.result&&a.result.items||[]).some(it=>it.type==='card'&&it.card==='exemption'));
}
function evalCondition(act,ts){
  const c=act.condition||{mode:'all',items:[]};
  return evalNode({group:true,mode:c.mode==='any'?'any':'all',items:c.items||[]},act,ts);
}
function evalNode(node,act,ts){
  if(node&&node.group&&Array.isArray(node.items)){
    const items=node.items;
    if(!items.length)return true;
    const res=items.map(n=>evalNode(n,act,ts));
    return node.mode==='any'?res.some(Boolean):res.every(Boolean);
  }
  return evalCondItem(node,act,ts);
}
// 日志所属领域 id（缺省时回退到其任务的领域）
function logDomainsOf(l){
  let dids=(l.dom||'').split(',').filter(Boolean);
  if(!dids.length&&l.taskId){
    const t=state.tasks.find(x=>x.id===l.taskId);
    if(t)dids=getTaskDomainIds(t);
  }
  return dids;
}
// 日志是否命中某主体（全部/领域/任务）
function logMatchesTarget(l,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='task')return l.taskId===target;
  if(targetType==='domain')return logDomainsOf(l).indexOf(target)>=0;
  return true;
}
// 任务/领域对象是否命中某主体
function taskMatchesTarget(t,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='task')return t.id===target;
  if(targetType==='domain')return getTaskDomainIds(t).indexOf(target)>=0;
  return true;
}
function domainMatchesTarget(d,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='domain')return d.id===target;
  return true;
}
// 遍历 [start,end) 命中的统计日桶（按自然日粒度；end 独占，取 end-1 的日期键）
function eachStatsBucket(start,end,fn){
  const s=state.ext&&state.ext.stats;
  if(!s||!s.daily)return;
  const sk=dayKey(start),ek=dayKey(end-1);
  Object.keys(s.daily).forEach(function(k){
    if(k<sk||k>ek)return;
    const b=s.daily[k];
    if(b)fn(b,k);
  });
}
function rangeStats(start,end,targetType,target){
  let vitality=0,achievement=0,progressTotal=0,checkins=0,newTasks=0,newDomains=0;
  const progressByDomain={};
  const progressByTask={};
  eachStatsBucket(start,end,function(b){
    if(targetType==='task'&&target){
      vitality+=Number(b.vt&&b.vt[target])||0;
      const p=Number(b.pt&&b.pt[target])||0;
      progressTotal+=p;progressByTask[target]=(progressByTask[target]||0)+p;
      checkins+=Number(b.ct&&b.ct[target])||0;
      return;
    }
    if(targetType==='domain'&&target){
      vitality+=Number(b.vd&&b.vd[target])||0;
      const p=Number(b.pd&&b.pd[target])||0;
      progressTotal+=p;progressByDomain[target]=(progressByDomain[target]||0)+p;
      checkins+=Number(b.cd&&b.cd[target])||0;
      return;
    }
    vitality+=Number(b.v)||0;
    achievement+=Number(b.a)||0;
    progressTotal+=Number(b.p)||0;
    checkins+=Number(b.ck)||0;
    Object.keys(b.pd||{}).forEach(function(d){progressByDomain[d]=(progressByDomain[d]||0)+b.pd[d];});
    Object.keys(b.pt||{}).forEach(function(t){progressByTask[t]=(progressByTask[t]||0)+b.pt[t];});
  });
  state.tasks.forEach(t=>{
    if(t.createdAt&&t.createdAt>=start&&t.createdAt<end&&taskMatchesTarget(t,targetType,target))newTasks++;
  });
  state.domains.forEach(d=>{
    if(d.createdAt&&d.createdAt>=start&&d.createdAt<end&&domainMatchesTarget(d,targetType,target))newDomains++;
  });
  return {vitality:vitality,achievement:achievement,progressTotal:progressTotal,progressByDomain:progressByDomain,progressByTask:progressByTask,checkins:checkins,newTasks:newTasks,newDomains:newDomains};
}
function opSatisfied(val,op,v){
  if(op==='>')return val>v;
  if(op==='<')return val<v;
  if(op==='<=')return val<=v;
  return val>=v;
}
// 单个任务在 [w.start,w.end) 窗口内的指标取值
function taskMetricValue(metric,taskId,w,range){
  if(metric==='checkins'&&range==='total'){
    const t=state.tasks.find(x=>x.id===taskId);
    return t?(t.checkInCount||0):0;
  }
  const st=rangeStats(w.start,w.end,'task',taskId);
  if(metric==='checkins')return st.checkins;
  if(metric==='progress')return st.progressByTask[taskId]||0;
  if(metric==='vitality')return st.vitality;
  return 0;
}
// 单个领域在 [w.start,w.end) 窗口内的指标取值
function domainMetricValue(metric,domainId,w,range){
  if(range==='total'){
    if(metric==='progress')return domainProgress(domainId);
    if(metric==='checkins')return state.tasks.filter(t=>getTaskDomainIds(t).indexOf(domainId)>=0).reduce((s,t)=>s+(t.checkInCount||0),0);
  }
  const st=rangeStats(w.start,w.end,'domain',domainId);
  if(metric==='checkins')return st.checkins;
  if(metric==='progress')return st.progressByDomain[domainId]||0;
  if(metric==='vitality')return st.vitality;
  return 0;
}
// 值类指标（打卡/活力/进度）的可组合最小实体集合：主体 × 新增筛选
function condLeafEntities(it,w){
  const tt=it.targetType||'all';
  const target=it.target||'';
  const nf=it.newFilter||'none';
  if(nf==='new_domain'){
    let ds=state.domains.filter(d=>d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end);
    if(tt==='domain'&&target)ds=ds.filter(d=>d.id===target);
    return ds.map(d=>({kind:'domain',id:d.id}));
  }
  let tasks=nf==='new_task'
    ?state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end)
    :state.tasks.slice();
  if(tt==='task'&&target)tasks=tasks.filter(t=>t.id===target);
  else if(tt==='domain'&&target)tasks=tasks.filter(t=>getTaskDomainIds(t).indexOf(target)>=0);
  return tasks.map(t=>({kind:'task',id:t.id}));
}
function entityMetricValue(metric,entity,w,range){
  if(entity.kind==='task')return taskMetricValue(metric,entity.id,w,range);
  if(entity.kind==='domain')return domainMetricValue(metric,entity.id,w,range);
  return 0;
}

export { weekScore, exemptionActivity, evalCondition, evalNode, logDomainsOf, logMatchesTarget, taskMatchesTarget, domainMatchesTarget, eachStatsBucket, rangeStats, opSatisfied, taskMetricValue, domainMetricValue, condLeafEntities, entityMetricValue };
