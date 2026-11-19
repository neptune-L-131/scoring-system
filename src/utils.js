import { choreCycleOf, choreDoneInCycle, choreIsCyclic } from './chore-cycle.js';
import { normalizeChoreConfig } from './defaults.js';
import { round2, splitCents } from './pure.js';
import { state } from './state.js';
import { addDays, dayDiff, dayStart, keyOffset, now } from './time.js';
import { toast } from './toast.js';
// utils.js —— 读取全局 state 的选择器 + 重命名输入
// 由 app.js 按功能拆分（第五轮可维护性重构），第六轮把纯函数与 Ledger 回放下沉，行为不变。

function totalProgress(){return Object.values(state.scores.progress||{}).reduce((s,v)=>s+v,0)}
function domainName(id){const d=state.domains.find(x=>x.id===id);return d?d.name:'未知'}
function taskNameLabel(id){const t=state.tasks.find(x=>x.id===id);return t?t.name:'未知'}
function collectionName(id){const c=state.collections.find(x=>x.id===id);return c?c.name:'未分类'}
function domainProgress(id){return(state.scores.progress[id])||(0)}
function metricValue(m){return (m.domainIds||[]).reduce((s,did)=>s+domainProgress(did),0)}
// 统一的重命名输入：空值 / 长度 / 重名校验；用户取消返回 null
function promptName(msg,current,maxLen,taken){
  const raw=window.prompt(msg,current||'');
  if(raw===null)return null;
  const name=String(raw).trim();
  if(!name){toast('名称不能为空','err');return null;}
  if(maxLen&&name.length>maxLen){toast('名称最多 '+maxLen+' 个字符','err');return null;}
  if(taken&&taken(name)){toast('「'+name+'」已存在','err');return null;}
  return name;
}

export { totalProgress, domainName, taskNameLabel, collectionName, domainProgress, metricValue, promptName };

function choreCfg(){return normalizeChoreConfig(state.choreConfig);}
function choreFreshDays(c){
  if(c&&typeof c.freshDays==='number'&&isFinite(c.freshDays)&&c.freshDays>=0)return c.freshDays;
  return choreCfg().freshDays;
}
function choreBaseTs(c){
  const base=(c&&c.plannedAt)?c.plannedAt:((c&&c.createdAt)?c.createdAt:now());
  return dayStart(base);
}
// 到期日（本地零点）：循环杂事以 nextDue 为唯一基准；一次性杂事维持 base+freshDays。
function choreDeadlineTs(c){
  const cy=choreCycleOf(c);
  if(cy)return dayStart(cy.nextDue);
  return addDays(choreBaseTs(c),Math.round(choreFreshDays(c)));
}
// 「今天做没做」：本周期内有没有完成（一次性杂事等价于 done 标记）。
function choreDoneNow(c,ts){
  return choreDoneInCycle(c,ts);
}
function choreOverdueDays(c,ts){
  if(!c)return 0;
  const today=dayStart(ts||now());
  if(choreDoneNow(c,today))return 0;
  const deadline=choreDeadlineTs(c);
  const d=dayDiff(today,deadline);
  return d>0?d:0;
}
function choreTierRate(count,cfg){
  cfg=cfg||choreCfg();
  if(count<=0)return 0;
  if(count<=cfg.tier1Max)return cfg.tier1Rate;
  if(count<=cfg.tier2Max)return cfg.tier2Rate;
  return cfg.tier3Rate;
}
function choreDailyDecay(count,cfg){return round2(count*choreTierRate(count,cfg));}
// 批量结算池：每件「可结算的完成」一项。
// 一次性杂事沿用 done && !settled；循环杂事按完成历史逐条计，同一 due 只算一件，
// 因此同一循环杂事每个周期最多贡献一件，不会被重复计入批次。
function choreSettlePool(){
  const out=[];
  (state.chores||[]).forEach(function(c){
    if(!c||c.archived)return;
    if(choreIsCyclic(c)){
      const hist=Array.isArray(c.history)?c.history:[];
      const seen=Object.create(null);
      hist.forEach(function(e){
        if(!e||e.settled===true)return;
        const key=String(Number(e.due)||0);
        if(seen[key])return;
        seen[key]=1;
        out.push({chore:c,entry:e,at:Number(e.ts)||0});
      });
      return;
    }
    if(c.done&&!c.settled)out.push({chore:c,entry:null,at:Number(c.doneAt)||0});
  });
  return out;
}
function choreUnsettled(){
  const ids=Object.create(null);
  const out=[];
  choreSettlePool().forEach(function(it){
    if(!it||!it.chore||ids[it.chore.id])return;
    ids[it.chore.id]=1;
    out.push(it.chore);
  });
  return out;
}
// 结算落账后标记：一次性写 chore.settled；循环写 history 条目的 settled，
// 并同步 settled 镜像（全部完成记录已结算才为 true）。
function choreMarkSettled(items){
  (items||[]).forEach(function(it){
    if(!it)return;
    if(it.entry)it.entry.settled=true;
    else if(it.chore)it.chore.settled=true;
  });
  (state.chores||[]).forEach(function(c){
    if(!c||!choreIsCyclic(c))return;
    const hist=Array.isArray(c.history)?c.history:[];
    c.settled=hist.length>0&&hist.every(function(e){return !e||e.settled===true;});
  });
}
// 杂事产出进度：未配置的实体按懒写入口径读取默认值（0 / 默认领域），不改 state
function choreProgressOf(c){
  const n=Number(c&&c.progressAmount);
  const amount=(isFinite(n)&&n>0)?round2(n):0;
  let dids=(c&&Array.isArray(c.progressDomainIds))?c.progressDomainIds.map(String).filter(Boolean):[];
  if(!dids.length)dids=['d_default'];
  return {amount:amount,domainIds:dids};
}
// 按分精确分摊到各领域（复用 splitCents）；amount<=0 时不产出
function choreProgressParts(c){
  const p=choreProgressOf(c);
  if(p.amount<=0)return [];
  const parts=splitCents(p.amount,p.domainIds.length);
  const out=[];
  p.domainIds.forEach(function(did,i){
    const amt=parts[i];
    if(amt)out.push({did:did,amt:amt});
  });
  return out;
}
function activityCountForDomain(did,days){
  const bucket=(state.ext&&state.ext.activity&&state.ext.activity[did])||{};
  let n=0;
  const d=Math.max(0,Math.round(Number(days)||0));
  for(let i=0;i<d;i++)n+=Math.max(0,Math.round(Number(bucket[keyOffset(i)])||0));
  return n;
}

export { choreCfg, choreFreshDays, choreBaseTs, choreDeadlineTs, choreDoneNow, choreOverdueDays, choreTierRate, choreDailyDecay, choreSettlePool, choreUnsettled, choreMarkSettled, choreProgressOf, choreProgressParts, activityCountForDomain };
