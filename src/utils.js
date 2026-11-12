import { ACTIVITY_MAX_DAYS } from './constants.js';
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
function choreOverdueDays(c,ts){
  if(!c||c.done)return 0;
  const today=dayStart(ts||now());
  const deadline=addDays(choreBaseTs(c),Math.round(choreFreshDays(c)));
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
function choreUnsettled(){
  return (state.chores||[]).filter(function(c){return c.done&&!c.settled&&!c.archived;});
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

export { choreCfg, choreFreshDays, choreBaseTs, choreOverdueDays, choreTierRate, choreDailyDecay, choreUnsettled, choreProgressOf, choreProgressParts, activityCountForDomain };
