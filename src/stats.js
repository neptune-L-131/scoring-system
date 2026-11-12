import { logDomainsOf } from './conditions.js';
import { SHADOW_MAX, STATS_ENTITY_MAPS, STATS_KEEP_DAYS, STATS_SCALARS, STATS_VERSION, LOG_MAX } from './constants.js';
import { dayKey, cardName, logAmt, round2, getTaskDomainIds, logHasType, now, uid } from './pure.js';
import { state } from './state.js';
import { keyOffset } from './time.js';
import { domainName } from './utils.js';
// stats.js —— 账户差额累计、隐形痕迹、统计聚合（唯一累加点）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 账户差额累计（让“余额 vs 流水”可精确对账）=====
// invisible：所有 visible:false 的账户增减累计；evicted：被 LOG_MAX 截断掉的历史可见流水累计。
// 两者都按账户键折叠，口径与账面完全一致，因此 余额 == 可见流水 + invisible + evicted 恒成立。
function emptyAccountSums(){return {vitality:0,achievement:0,progress:{},cards:{}};}
function accountSumsAdd(sums,account,delta){
  delta=Number(delta)||0;
  if(!sums||!account||!delta)return;
  if(account==='vitality'||account==='achievement')sums[account]=(Number(sums[account])||0)+delta;
  else if(account.indexOf('progress:')===0){const id=account.slice(9);sums.progress[id]=(Number(sums.progress[id])||0)+delta;}
  else if(account.indexOf('card:')===0){const id=account.slice(5);sums.cards[id]=(Number(sums.cards[id])||0)+delta;}
}
function statsDiffs(){
  const s=state.ext&&state.ext.stats;
  if(!s)return null;
  if(!s.invisible||typeof s.invisible!=='object')s.invisible=emptyAccountSums();
  if(!s.evicted||typeof s.evicted!=='object')s.evicted=emptyAccountSums();
  ['vitality','achievement'].forEach(function(k){s.invisible[k]=Number(s.invisible[k])||0;s.evicted[k]=Number(s.evicted[k])||0;});
  if(!s.invisible.progress||typeof s.invisible.progress!=='object')s.invisible.progress={};
  if(!s.evicted.progress||typeof s.evicted.progress!=='object')s.evicted.progress={};
  if(!s.invisible.cards||typeof s.invisible.cards!=='object')s.invisible.cards={};
  if(!s.evicted.cards||typeof s.evicted.cards!=='object')s.evicted.cards={};
  return s;
}
// 隐形账户增减：只累计、不写日志；真正的“可追溯痕迹”由 shadowPush 记录
function noteInvisible(account,delta){
  const s=statsDiffs();
  if(s)accountSumsAdd(s.invisible,account,delta);
}
// 被 pushLog 截断掉的可见流水：把它的账户贡献挪进 evicted，保证余额等式不因裁剪而失真
function noteEvicted(entry){
  const s=statsDiffs();
  if(!s||!entry)return;
  const vis=entry.st==='achievement'?(Number(entry.amt)||0):0;
  const v=logHasType(entry,'vitality')?(Number(logAmt(entry,'vitality'))||0):0;
  const p=logHasType(entry,'progress')?(Number(logAmt(entry,'progress'))||0):0;
  if(v)accountSumsAdd(s.evicted,'vitality',v);
  if(vis)accountSumsAdd(s.evicted,'achievement',vis);
  if(p){
    if(entry.splits&&entry.splits.length){
      entry.splits.forEach(function(sp){accountSumsAdd(s.evicted,'progress:'+(sp.dom||'d_default'),Number(sp.amt)||0);});
    }else{
      const dids=(entry.dom||'').split(',').filter(Boolean);
      (dids.length?dids:['d_default']).forEach(function(d){accountSumsAdd(s.evicted,'progress:'+d,p/(dids.length||1));});
    }
  }
}
// ===== 隐形操作的可追溯痕迹（余额调整记录）=====
const SHADOW_SRC_NAMES={
  'loan-draw':'贷款放款','checkin-replay':'打卡流水重放','recalc':'历史重算','recalc-cost':'历史重算退款',
  'delete-domain':'删除领域搬运','undo-delete-domain':'撤销删除领域','delete-task':'删除任务搬运',
  'undo-delete-task':'撤销删除任务','task-domain-migrate':'任务领域迁移','activity-revoke':'活动奖励回收',
  'exempt-use':'使用断更豁免卡','undo-exempt':'撤销豁免卡使用','undo-card-grant':'撤销卡券发放',
  'undo-cost':'撤销成本','undo-purchase':'撤销购买','undo-achievement':'撤销里程碑解锁',
  'undo-loan-repay':'撤销还贷','undo-manual-adjust':'撤销手动修正','undo-unlock':'撤销解锁',
  'undo-budget-penalty':'撤销预算惩罚','undo-budget-feedback':'撤销预算反哺','undo-budget-reward':'撤销结余奖励',
  'budget-topup':'预算扩容','budget-overdraft':'预算透支','calibrate':'历史隐形变动校准'
};
function shadowLabel(src,desc){
  if(desc)return desc;
  return SHADOW_SRC_NAMES[src]||src||'余额调整';
}
function shadowPush(rec){
  if(!state.ext)return;
  if(!Array.isArray(state.ext.shadow))state.ext.shadow=[];
  state.ext.shadow.unshift(rec);
  if(state.ext.shadow.length>SHADOW_MAX)state.ext.shadow.length=SHADOW_MAX;
}
// 旧存档没有 invisible 明细：按账户残差补一条“历史隐形变动校准”记录，让痕迹从升级那一刻起可读
function seedCalibrationShadow(){
  const inv=(state.ext&&state.ext.stats&&state.ext.stats.invisible)||{};
  const recs=[];
  const push=function(acct,v){
    v=Number(v)||0;
    if(Math.abs(v)<0.005)return;
    recs.push({id:uid(),ts:now(),acct:acct,delta:v,before:null,after:null,src:'calibrate',label:SHADOW_SRC_NAMES.calibrate});
  };
  push('vitality',inv.vitality);
  push('achievement',inv.achievement);
  Object.keys(inv.progress||{}).forEach(function(id){push('progress:'+id,inv.progress[id]);});
  Object.keys(inv.cards||{}).forEach(function(id){push('card:'+id,inv.cards[id]);});
  recs.forEach(function(r){shadowPush(r);});
}
function accountLabel(acct){
  if(acct==='vitality')return '活力点';
  if(acct==='achievement')return '成果点';
  if(acct.indexOf('progress:')===0)return '进度·'+domainName(acct.slice(9));
  if(acct.indexOf('card:')===0)return cardName(acct.slice(5));
  return acct;
}

// ===== 统计聚合（唯一累加点）=====
// 口径：可见流水写入时把“对统计的贡献”折叠进 ext.stats（生命周期计数）与 ext.stats.daily（日桶），
// 撤销/移除流水时按同一份贡献反向扣减；LOG_MAX 截断不扣减，因此计数器等价于“假如日志不裁剪”。
function statsDailyEnsure(key){
  const s=state.ext.stats;
  if(!s.daily||typeof s.daily!=='object')s.daily={};
  let b=s.daily[key];
  if(!b||typeof b!=='object')b=s.daily[key]={};
  STATS_SCALARS.forEach(function(k){b[k]=Number(b[k])||0;});
  STATS_ENTITY_MAPS.forEach(function(k){if(!b[k]||typeof b[k]!=='object')b[k]={};});
  return b;
}
function statsPrune(){
  const s=state.ext&&state.ext.stats;
  if(!s||!s.daily)return;
  const cutoff=keyOffset(STATS_KEEP_DAYS);
  Object.keys(s.daily).forEach(function(k){if(k<cutoff)delete s.daily[k];});
}
// 从一条可见流水推导它对统计的贡献；不依赖写入时的上下文，撤销旧流水也能重算
function computeEntryAgg(entry){
  const agg={key:'',v:0,p:0,a:0,ck:0,buy:0,inv:0,cons:0,prod:0,vd:{},pd:{},vt:{},pt:{},ct:{},cd:{}};
  if(!entry)return agg;
  agg.key=dayKey(Number(entry.time)||Date.now());
  const st=entry.st;
  const v=logHasType(entry,'vitality')?(Number(logAmt(entry,'vitality'))||0):0;
  const p=logHasType(entry,'progress')?(Number(logAmt(entry,'progress'))||0):0;
  const a=(st==='achievement')?(Number(entry.amt)||0):0;
  agg.v=v;agg.p=p;agg.a=a;
  if(entry.src==='checkin')agg.ck=1;
  if(entry.src==='purchase')agg.buy=1;
  if(entry.src==='cost'&&Number(entry.amt)<0)agg.inv=-Number(entry.amt)||0;
  if(entry.src==='purchase'&&st==='vitality'&&Number(entry.amt)<0)agg.cons=-Number(entry.amt)||0;
  if(entry.src==='checkin'&&v>0)agg.prod=v;
  // 归属领域：优先流水自身 dom，其次任务领域（与 logDomainsOf 一致）
  let dids=(entry.dom||'').split(',').filter(Boolean);
  if(!dids.length&&entry.taskId){
    const t=(state.tasks||[]).find(function(x){return x.id===entry.taskId;});
    if(t)dids=getTaskDomainIds(t);
  }
  if(v!==0)dids.forEach(function(d){agg.vd[d]=(agg.vd[d]||0)+v;});
  if(agg.ck)dids.forEach(function(d){agg.cd[d]=(agg.cd[d]||0)+1;});
  if(p!==0){
    if(Array.isArray(entry.splits)&&entry.splits.length){
      entry.splits.forEach(function(sp){
        const d=sp.dom||'d_default';
        agg.pd[d]=(agg.pd[d]||0)+(Number(sp.amt)||0);
      });
    }else{
      const list=dids.length?dids:['d_default'];
      const share=p/list.length;
      list.forEach(function(d){agg.pd[d]=(agg.pd[d]||0)+share;});
    }
  }
  if(entry.taskId){
    if(v!==0)agg.vt[entry.taskId]=v;
    if(p!==0)agg.pt[entry.taskId]=p;
    if(agg.ck)agg.ct[entry.taskId]=1;
  }
  return agg;
}
function applyAgg(agg,sign){
  if(!agg)return;
  const s=state.ext&&state.ext.stats;
  if(!s)return;
  const add=function(k,v){s[k]=Math.max(0,round2((Number(s[k])||0)+sign*(Number(v)||0)));};
  if(agg.v>0)add('lifetimeVitalityIn',agg.v);
  else if(agg.v<0)add('lifetimeVitalityOut',-agg.v);
  if(agg.p>0)add('lifetimeProgressIn',agg.p);
  else if(agg.p<0)add('lifetimeProgressOut',-agg.p);
  if(agg.a>0)add('lifetimeAchievementIn',agg.a);
  else if(agg.a<0)add('lifetimeAchievementOut',-agg.a);
  s.totalCheckins=Math.max(0,Math.round((Number(s.totalCheckins)||0)+sign*agg.ck));
  s.totalPurchases=Math.max(0,Math.round((Number(s.totalPurchases)||0)+sign*agg.buy));
  const b=statsDailyEnsure(agg.key||dayKey(Date.now()));
  STATS_SCALARS.forEach(function(k){
    const v=Number(agg[k])||0;
    if(!v)return;
    b[k]=round2((Number(b[k])||0)+sign*v);
  });
  STATS_ENTITY_MAPS.forEach(function(mk){
    const map=agg[mk]||{};
    Object.keys(map).forEach(function(id){
      const v=Number(map[id])||0;
      if(!v)return;
      b[mk][id]=round2((Number(b[mk][id])||0)+sign*v);
      if(!b[mk][id])delete b[mk][id];
    });
  });
  s.version=STATS_VERSION;
  s.updatedAt=now();
  if(s.lastDay!==agg.key){s.lastDay=agg.key;statsPrune();}
}
function attachAgg(entry){
  if(!entry)return;
  const agg=computeEntryAgg(entry);
  entry.agg=agg;
  applyAgg(agg,1);
}
function detachAgg(entry){
  if(!entry)return;
  const agg=entry.agg&&entry.agg.key?entry.agg:computeEntryAgg(entry);
  applyAgg(agg,-1);
  entry.agg=null;
}
function reaggEntry(entry){
  if(!entry)return;
  // 改写前的旧贡献必须取流水上已记录的 agg：调用方通常先把字段改掉再 reagg，
  // 此时从字段反推只会得到新值，统计会少扣一次。
  const oldAgg=(entry.agg&&entry.agg.key)?entry.agg:computeEntryAgg(entry);
  const oldV=Number(oldAgg.v)||0,oldA=Number(oldAgg.a)||0;
  const oldPd=Object.assign({},oldAgg.pd||{});
  detachAgg(entry);
  attachAgg(entry);
  const newAgg=entry.agg||computeEntryAgg(entry);
  // 可见流水被原地改写时，余额的同一变化已由随后的隐形补账记录；
  // 这里把“可见归属”的变化从 invisible 里抵消，避免同一笔钱在自检里被两边各记一次。
  const cmp=function(acct,ov,nv){
    const d=(Number(nv)||0)-(Number(ov)||0);
    if(d)noteInvisible(acct,-d);
  };
  cmp('vitality',oldV,newAgg.v);
  cmp('achievement',oldA,newAgg.a);
  const dids=new Set(Object.keys(oldPd).concat(Object.keys(newAgg.pd||{})));
  dids.forEach(function(d){cmp('progress:'+d,oldPd[d],(newAgg.pd||{})[d]);});
}
// 从当前日志重建计数器（兜底入口，只恢复现有日志能覆盖的部分）
// 同时重算 invisible/evicted：重建后 evicted 归零，invisible 取“余额 − 可见流水”的残差，
// 保证“余额 == 可见流水 + invisible + evicted”在重建后依然成立。
function rebuildStats(){
  if(!state.ext)return;
  const s=state.ext.stats;
  ['lifetimeVitalityIn','lifetimeVitalityOut','lifetimeProgressIn','lifetimeProgressOut',
   'lifetimeAchievementIn','lifetimeAchievementOut','totalCheckins','totalPurchases'
  ].forEach(function(k){s[k]=0;});
  s.daily={};
  s.lastDay=null;
  s.evicted=emptyAccountSums();
  const vis=emptyAccountSums();
  (state.logs||[]).forEach(function(l){
    const agg=computeEntryAgg(l);
    l.agg=agg;
    applyAgg(agg,1);
    accountSumsAdd(vis,'vitality',agg.v);
    accountSumsAdd(vis,'achievement',agg.a);
    Object.keys(agg.pd||{}).forEach(function(d){accountSumsAdd(vis,'progress:'+d,agg.pd[d]);});
  });
  s.invisible=emptyAccountSums();
  const residual=function(account,bal){return (Number(bal)||0)-(Number(account)||0);};
  s.invisible.vitality=round2(residual(vis.vitality,state.scores.vitality));
  s.invisible.achievement=round2(residual(vis.achievement,state.scores.achievement));
  Object.keys(state.scores.progress||{}).forEach(function(id){
    s.invisible.progress[id]=round2(residual(vis.progress[id],state.scores.progress[id]));
  });
  s.version=STATS_VERSION;
  s.updatedAt=now();
  return s;
}

export { emptyAccountSums, accountSumsAdd, statsDiffs, noteInvisible, noteEvicted, SHADOW_SRC_NAMES, shadowLabel, shadowPush, seedCalibrationShadow, accountLabel, statsDailyEnsure, statsPrune, computeEntryAgg, applyAgg, attachAgg, detachAgg, reaggEntry, rebuildStats };
