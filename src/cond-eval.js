// cond-eval.js —— 条件求值的状态适配层
// 把「条件树 → 指标取值」中依赖全局 state 的叶子求值集中在这里；
// 结构递归与比较在内核 cond-kernel.js，本文件不 import entities / ledger / render，
// 也不被 conditions.js 之外的业务模块反向依赖（budget 通过 provider 注册注入）。
import { choreCycleOf, choreIsCyclic } from './chore-cycle.js';
import { choreTagIncludes, choreTagKey } from './chore-list.js';
import { evalNode as evalTreeNode, opSatisfied } from './cond-kernel.js';
import { affairLastAdvance, affairSteps, condWindowByRange, dayKey, dayStart, effectiveLastTs, getTaskDomainIds, idleDaysSince, isAffairMetric, isAssetMetric, isChoreMetric, isEntityMetricFor, isEntityOnlyMetric, isPointMetric, isArchivedEntity, parseEntityTarget, round2, validRange } from './pure.js';
import { state } from './state.js';
import { dayDiff } from './time.js';
import { activityCountForDomain, choreOverdueDays, domainProgress, totalProgress } from './utils.js';

// 点态指标的外部取值器：由预算引擎等状态所有者注册，避免条件层反向 import 账务模块。
const POINT_METRIC_PROVIDERS=Object.create(null);
function registerPointMetricProvider(metric,fn){
  if(metric&&typeof fn==='function')POINT_METRIC_PROVIDERS[metric]=fn;
}
// 情境键是否「仍然存在」：现存标签或任一历史快照里出现过即算存在。
// 历史快照也要算，否则「改标签不回溯历史」的既有归因（见 chore_tag_completed 用例）会被误判为情境已删除。
function choreTagKnown(key){
  if(!key)return false;
  return (state.chores||[]).some(function(c){
    if(choreTagIncludes(c&&c.tags,key))return true;
    const hist=Array.isArray(c&&c.history)?c.history:[];
    return hist.some(function(e){return e&&choreTagIncludes(e.tags,key);});
  });
}
function pointMetricValue(metric,it,ts){  const tt=it.targetType||'all';
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
    // 超期件数只由“到期日 + 是否本周期已完成”决定（choreOverdueDays 内部已处理完成态）
    return (state.chores||[]).filter(c=>!c.archived&&choreOverdueDays(c,ts)>0).length;
  }
  if(metric==='chore_tag_overdue'){
    // 点态：当前仍超期且带该情境的件数。事件触发模式会在编译期拒绝点态指标。
    // 情境键缺失（没有任何现存标签或历史快照）时返回 NaN，由比较层判不成立；
    // 不复刻 0 兜底 —— 0 在 < / <= 下可能为真，会让「情境已删除」被误判为满足。
    const key=choreTagKey(target);
    if(!key||!choreTagKnown(key))return NaN;
    return (state.chores||[]).filter(c=>!c.archived&&choreOverdueDays(c,ts)>0&&choreTagIncludes(c.tags,key)).length;
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
    const fn=POINT_METRIC_PROVIDERS[metric];
    return fn?(Number(fn(it,ts))||0):0;
  }
  return 0;
}
// ===== 资产类指标 =====
// 余额直接读 state.cards：资产停用/归档只是冻结语义，余额仍在，照常取值。
// 发放/消耗按窗口汇总「可见资产流水 + 隐形余额调整记录」：
//   - 可见流水优先看 assetCat；旧流水没有类别时按金额正负归档（阶段 2 之前的兼容口径）
//   - 隐形记录（撤销补账、旧版豁免消耗）按 src 归类：exempt-use 记消耗，其余记手动调整不吃掉计量
// 流水/调整记录受 LOG_MAX / SHADOW_MAX 截断，超出保留范围的历史不计入（与其它窗口指标同一约定）。
function assetShadowCat(r){
  if(r&&r.assetCat)return r.assetCat;
  if(r&&r.src==='exempt-use')return 'spend';
  return 'adjust';
}
function assetMovementInWindow(assetId,w){
  let issued=0,spent=0;
  const consider=function(amt,cat){
    amt=Number(amt)||0;
    if(!amt)return;
    if(cat==='issue'||(!cat&&amt>0))issued+=amt;
    else if(cat==='spend'||cat==='expire'||(!cat&&amt<0))spent+=Math.abs(amt);
  };
  (state.logs||[]).forEach(function(l){
    if(!l||l.st!=='card'||l.card!==assetId)return;
    const t=Number(l.time)||0;
    if(!(t>=w.start&&t<w.end))return;
    consider(l.amt,l.assetCat||'');
  });
  const sh=(state.ext&&state.ext.shadow)||[];
  sh.forEach(function(r){
    if(!r||r.acct!=='card:'+assetId)return;
    const t=Number(r.ts)||0;
    if(!(t>=w.start&&t<w.end))return;
    consider(r.delta,assetShadowCat(r));
  });
  return {issued:issued,spent:spent};
}
// 无法取值（未选择资产）时返回 NaN：任何比较都为假，不把「取不到」伪装成 0。
function assetMetricValue(metric,it,w){
  const id=String((it&&it.target)||'');
  if(!id)return NaN;
  if(metric==='asset_hold')return Number((state.cards||{})[id])||0;
  const m=assetMovementInWindow(id,w);
  return metric==='asset_issued'?m.issued:m.spent;
}
// 不活跃项目：未完成且未归档
function affairActive(a){return !!a&&!a.doneAt&&!a.archived;}
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
function choreWindowValue(metric,it,w,range){
  if(metric==='chore_completed'){
    // 循环杂事按完成记录逐条计：doneAt 会被最新一次完成覆盖，不能作为计数口径。
    // 一次性杂事沿用 doneAt 判定。
    let n=0;
    (state.chores||[]).forEach(function(c){
      const inWindow=function(ts){return range==='total'||(ts>=w.start&&ts<w.end);};
      if(choreIsCyclic(c)){
        const hist=Array.isArray(c.history)?c.history:[];
        hist.forEach(function(e){
          if(!e||!Number(e.due))return;
          const ts=Number(e.ts)||0;
          if(ts>0&&inWindow(ts))n++;
        });
        return;
      }
      if(c.doneAt&&inWindow(c.doneAt))n++;
    });
    return n;
  }
  if(metric==='chore_tag_completed'){
    // 与 chore_completed 共用窗口口径；只多一层情境过滤。
    // 循环杂事按每条完成记录的 tags 快照归因；快照缺失时回落当前标签（不静默计 0）。
    const key=choreTagKey(it&&it.target);
    // 与点态口径一致：情境键不存在（现存标签与历史快照都没有）→ NaN（判不成立）。
    // 情境仍存在但窗口内没有完成记录时仍是 0，语义不变。
    if(!key||!choreTagKnown(key))return NaN;
    let n=0;
    (state.chores||[]).forEach(function(c){
      const inWindow=function(ts){return range==='total'||(ts>=w.start&&ts<w.end);};
      if(choreIsCyclic(c)){
        (Array.isArray(c.history)?c.history:[]).forEach(function(e){
          if(!e||!Number(e.due))return;
          const ts=Number(e.ts)||0;
          if(!(ts>0&&inWindow(ts)))return;
          const tags=Array.isArray(e.tags)?e.tags:(Array.isArray(c.tags)?c.tags:[]);
          if(choreTagIncludes(tags,key))n++;
        });
        return;
      }
      if(c.doneAt&&inWindow(c.doneAt)){
        // 一次性杂事：优先取最近一条完成记录的标签快照，缺失时按当前标签归因
        const hist=Array.isArray(c.history)?c.history:[];
        const last=hist.length?hist[hist.length-1]:null;
        const tags=(last&&Array.isArray(last.tags))?last.tags:(Array.isArray(c.tags)?c.tags:[]);
        if(choreTagIncludes(tags,key))n++;
      }
    });
    return n;
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
// ===== 单实体条件（D1）=====
// 一次 evalCondition 内只建一次索引；findEntity 是线性扫描，逐叶子调用会退化成 O(n·叶子数)。
function entityIndex(ctx){
  if(ctx&&ctx.entityIndex)return ctx.entityIndex;
  const idx={task:new Map(),affair:new Map(),chore:new Map()};
  (state.tasks||[]).forEach(function(e){if(e&&e.id!=null)idx.task.set(String(e.id),e);});
  (state.affairs||[]).forEach(function(e){if(e&&e.id!=null)idx.affair.set(String(e.id),e);});
  (state.chores||[]).forEach(function(e){if(e&&e.id!=null)idx.chore.set(String(e.id),e);});
  if(ctx)ctx.entityIndex=idx;
  return idx;
}
// 单实体取值：只读实体自身字段/当刻状态，或对该实体做窗口计数。
// 取不到（非循环杂事问循环指标）返回 NaN，由调用方判不成立。
function entityMetricValueFor(kind,metric,e,w,range,ts){
  if(kind==='affair'){
    if(metric==='affair_cell')return Math.max(0,Math.round(Number(e.currentCell)||0));
    if(metric==='affair_steps'){
      let n=0;
      affairSteps(e).forEach(function(s){
        if(range==='total'?!!s.doneAt:(s.doneAt>=w.start&&s.doneAt<w.end))n++;
      });
      return n;
    }
    if(metric==='affair_stall'){
      const d=idleDaysSince(affairLastAdvance(e)||e.createdAt,ts);
      return d===null?NaN:d;
    }
    if(metric==='affair_progress')return Number(e.alreadyGiven)||0;
    if(metric==='affair_completed')return (range==='total'?!!e.doneAt:!!(e.doneAt&&e.doneAt>=w.start&&e.doneAt<w.end))?1:0;
    return NaN;
  }
  if(kind==='chore'){
    if(metric==='chore_completed'){
      // 与 choreWindowValue 同口径：循环杂事按 history 逐条计，一次性用 doneAt。
      let n=0;
      const inWindow=function(t){return range==='total'||(t>=w.start&&t<w.end);};
      if(choreIsCyclic(e)){
        (Array.isArray(e.history)?e.history:[]).forEach(function(r){
          if(!r||!Number(r.due))return;
          const t=Number(r.ts)||0;
          if(t>0&&inWindow(t))n++;
        });
        return n;
      }
      if(e.doneAt&&inWindow(e.doneAt))n++;
      return n;
    }
    if(metric==='chore_overdue_days')return choreOverdueDays(e,ts);
    if(metric==='chore_idle'){
      const d=idleDaysSince(e.doneAt||e.plannedAt||e.createdAt,ts);
      return d===null?NaN:d;
    }
    if(metric==='chore_cycle_due_in'){
      const cy=choreCycleOf(e);
      if(!cy||!cy.nextDue)return NaN;
      return dayDiff(dayStart(cy.nextDue),dayStart(ts));
    }
    return NaN;
  }
  return NaN;
}
function evalEntityItem(it,w,range,ts,ctx){
  const ref=parseEntityTarget(it.target);
  if(!ref||!isEntityMetricFor(ref.kind,it.metric))return false;
  const e=entityIndex(ctx)[ref.kind].get(ref.id);
  // 不存在（含转换后原 kind 已无此 id）→ 不成立；归档实体仍在索引里，照常求值。
  if(!e)return false;
  const val=entityMetricValueFor(ref.kind,it.metric,e,w,range,ts);
  if(!Number.isFinite(val))return false;
  return opSatisfied(val,it.op,Number(it.value)||0);
}
function evalCondItem(it,act,ts,ctx){
  const v=Number(it.value)||0;
  const range=validRange(it.range)?it.range:'period';
  // 预算指标：只读当前预算周期上下文（由 BudgetEngine 注入 act.budgetCtx）
  // budget_remaining 是点态指标（读分类剩余额度），不走预算规则上下文
  if(it.metric.indexOf('budget_')===0&&it.metric!=='budget_remaining'){
    const bc=(act&&act.budgetCtx)||{};
    // 混合币种：跨分类金额不可加总，金额指标 fail-closed（条件不成立）；
    // 笔数是纯计数，不受币种影响。
    if(bc.mixed===true&&it.metric!=='budget_entry_count')return false;
    let val=0;
    if(it.metric==='budget_entry_amount')val=Number(bc.entryAmount)||0;
    else if(it.metric==='budget_period_spent')val=Number(bc.spent)||0;
    else if(it.metric==='budget_period_overspend')val=Number(bc.overspend)||0;
    else if(it.metric==='budget_entry_count')val=Number(bc.entryCount)||0;
    return opSatisfied(val,it.op,v);
  }
  const w=range==='total'?{start:0,end:ts+1}:condWindowByRange(range,act,ts,it.days);
  // 单实体条件：目标不存在 / 指标与 kind 不匹配 / 取不到值 一律判不成立（fail-closed）。
  if((it.targetType||'all')==='entity')return evalEntityItem(it,w,range,ts,ctx);
  // 实体专属指标配非实体目标属于非法组合：宁可判不成立，也不套用聚合读法给出 0。
  if(isEntityOnlyMetric(it.metric))return false;
  // 自定义资产：持有数量是点态值（事件发生时刻即确定），发放/消耗按窗口汇总
  if(isAssetMetric(it.metric))return opSatisfied(assetMetricValue(it.metric,it,w),it.op,v);
  // 阶段 3：领域活跃度读活跃度索引（不遍历日志，不受日志截断影响）
  if(it.metric==='domain_activity'){
    const did=(it.targetType==='domain')?(it.target||''):'';
    if(!did)return false;
    const days=range==='recent'?Math.max(1,Math.round(Number(it.days)||7)):Math.max(1,dayDiff(w.end,w.start));
    return opSatisfied(activityCountForDomain(did,days),it.op,v);
  }
  // 阶段 1：点态指标（不活跃天数/超期件数）与项目、杂事指标
  if(isPointMetric(it.metric))return opSatisfied(pointMetricValue(it.metric,it,ts),it.op,v);
  if(isAffairMetric(it.metric))return opSatisfied(affairWindowValue(it.metric,it,w,range),it.op,v);
  if(isChoreMetric(it.metric))return opSatisfied(choreWindowValue(it.metric,it,w,range),it.op,v);
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
function evalCondition(act,ts){
  const c=act.condition||{mode:'all',items:[]};
  const ctx={entityIndex:null};
  return evalTreeNode({group:true,mode:c.mode==='any'?'any':'all',items:c.items||[]},{evalLeaf:function(n){return evalCondItem(n,act,ts,ctx);}});
}

export { weekScore, evalCondition, logDomainsOf, logMatchesTarget, taskMatchesTarget, domainMatchesTarget, eachStatsBucket, rangeStats, taskMetricValue, domainMetricValue, condLeafEntities, entityMetricValue, affairActive, pointMetricValue, sumLogsInWindow, countLogsInWindow, logAffairDomain, affairWindowValue, choreWindowValue, evalCountMetric, evalCondItem, assetMetricValue, assetMovementInWindow, registerPointMetricProvider };
