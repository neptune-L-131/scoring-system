import { normalizeCondition } from './cond-model.js';
import { gateConditionOf } from './cond-model.js';
import { ACTIVITY_MAX_DAYS, AUDIT_MAX, BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, BUDGET_RULE_KINDS, PROD_TIERS, SCHEMA_VERSION, SHADOW_MAX, STATS_ENTITY_MAPS, STATS_KEEP_DAYS, STATS_SCALARS, STATS_VERSION, COND_METRIC_KEYS } from './constants.js';
import { defaultBudgetsState, defaultChoreConfig, defaultProductGate, migrateChore, normalizeChoreConfig, tierCurrency, defaultActivities, defaults } from './defaults.js';
import { budgetBounds, dayKey, periodKey, migrateAffair, esc, now, uid, validRange, normOp, toNum, toTs, asArray, dateKeyOffset } from './pure.js';
import { emptyAccountSums } from './stats.js';
import { totalProgress } from './utils.js';
// normalize.js —— 存档结构归一、迁移、解析（loadIssue / _persistBlocked 归此处）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// 点态指标：不按时间窗口累计，取“此刻”的实体状态（任务/项目的最近活跃、杂事超期件数等）
// 项目类窗口指标：数据源是项目/步骤上的时间戳与 src='affair' 的流水
// 杂事类指标：数据源是杂事时间戳与 src='chore-batch' / 'chore-decay' 的流水
// 阶段 3：商品门槛专用指标（累计获得 / 领域活跃度 / 里程碑 / 连续打卡 / 预算剩余）
function normalizeRewardItem(it){
  if(!it)return null;
  // 结构操作：不发放资产，只改实体状态（归档任务/项目/杂事）
  if(it.type==='archive'){
    return {type:'archive',entity:(it.entity==='affair'||it.entity==='chore')?it.entity:'task',idleDays:Math.max(1,Math.round(Number(it.idleDays)||1))};
  }
  if(it.type==='card')return {type:'card',card:it.card||'exemption',amount:Math.max(0,Math.round(it.amount||0)),cap:Math.max(1,Math.round(it.cap||3))};
  if(it.type==='progress'){
    const r={type:'progress',amount:Number(it.amount)||0};
    if(it.domainId)r.domainId=it.domainId;
    return r;
  }
  if(it.type==='vitality'){
    const r={type:'vitality',amount:Number(it.amount)||0};
    if(it.taskId)r.taskId=it.taskId;
    return r;
  }
  if(it.type==='achievement')return {type:'achievement',amount:Number(it.amount)||0};
  return null;
}
function normalizeResult(r){
  r=r||{};
  if(Array.isArray(r.items))return {items:r.items.map(normalizeRewardItem).filter(Boolean)};
  return {items:[]};
}
function normalizeActivity(a){
  a=a||{};
  return{
    id:a.id||uid(),name:a.name||'未命名活动',enabled:a.enabled!==false,
    period:a.period||'week',anchor:a.anchor||1,
    condition:normalizeCondition(a.condition),
    result:normalizeResult(a.result),
    lastRun:a.lastRun||null
  };
}
function migrateActivities(p){
  const arr=asArray(p.activities).filter(Boolean).map(normalizeActivity);
  return arr.length?arr:defaultActivities().map(normalizeActivity);
}
// ===== Schema 版本与扩展区 =====
// v1 为原点：新装/归一后的存档均带 schema.ext；MIGRATIONS 表留给后续版本使用。
let loadIssue=null;
// 读档未成功（超时 / 读取失败）时暂停写盘：避免用空白默认库覆盖真实存档
let _persistBlocked=false;
// 尽力修复被截断/轻微损坏的 JSON（常见于 IndexedDB 写入中断）
function salvageJSON(raw){
  if(!raw||typeof raw!=='string')return null;
  try{return JSON.parse(raw);}catch(e){}
  try{return JSON.parse(raw.trim());}catch(e){}
  const s=raw.trim();
  if(s[0]==='{'){
    let depth=0,inStr=false,esc=false,end=-1;
    for(let i=0;i<s.length;i++){
      const ch=s[i];
      if(inStr){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inStr=false;continue;}
      if(ch==='"'){inStr=true;continue;}
      if(ch==='{')depth++;
      else if(ch==='}'){depth--;if(depth===0){end=i;break;}}
    }
    if(end>0){
      try{return JSON.parse(s.slice(0,end+1));}catch(e){}
    }
  }
  return null;
}
// ===== 存档数值归一（只强转已有字段，不新增字段，保证旧存档兼容）=====
function normalizeScores(s){
  const o={vitality:0,progress:{},achievement:0};
  if(!s||typeof s!=='object')return o;
  o.vitality=toNum(s.vitality);
  o.achievement=toNum(s.achievement);
  const pr=(s.progress&&typeof s.progress==='object'&&!Array.isArray(s.progress))?s.progress:{};
  Object.keys(pr).forEach(function(k){o.progress[k]=toNum(pr[k]);});
  return o;
}
function normalizeTaskNums(t){
  if(!t||typeof t!=='object')return t;
  t.initialValue=toNum(t.initialValue);
  t.interestRate=toNum(t.interestRate);
  t.debtRate=toNum(t.debtRate);
  t.vitalityCost=toNum(t.vitalityCost);
  t.checkInCount=Math.max(0,Math.round(toNum(t.checkInCount)));
  t.streak=Math.max(0,Math.round(toNum(t.streak)));
  t.totalEarned=toNum(t.totalEarned);
  t.pendingDebt=toNum(t.pendingDebt);
  t.lastCheckIn=toTs(t.lastCheckIn);
  if(t.lastExempt!==undefined)t.lastExempt=toTs(t.lastExempt);
  if(t.archivedAt!==undefined)t.archivedAt=toTs(t.archivedAt);
  if(t.lastDebtDate!==undefined)t.lastDebtDate=toTs(t.lastDebtDate);
  return t;
}
function normalizeAchNums(a){
  if(!a||typeof a!=='object')return a;
  a.threshold=toNum(a.threshold);
  a.points=toNum(a.points);
  a.unlocked=!!a.unlocked;
  if(a.unlockedAt!==undefined)a.unlockedAt=toTs(a.unlockedAt);
  return a;
}
function normalizeProdNums(p){
  if(!p||typeof p!=='object')return p;
  p.price=toNum(p.price);
  p.stock=toNum(p.stock,-1);
  p.sold=Math.max(0,Math.round(toNum(p.sold)));
  p.debtRate=toNum(p.debtRate);
  p.createdAt=toTs(p.createdAt);
  return p;
}
// 商品门槛归一：负数/非整数夹回合法区间；未知层级回落 daily；
// 引用不存在的领域/里程碑时清空对应引用（其余门槛字段保留，便于用户重新选择）
function normalizeProductGate(g,ctx){
  const out=defaultProductGate();
  if(!g||typeof g!=='object'||Array.isArray(g))return out;
  out.minLifetime=Math.max(0,Math.round(toNum(g.minLifetime)));
  const a=(g.activity&&typeof g.activity==='object'&&!Array.isArray(g.activity))?g.activity:{};
  const did=String(a.domainId||'');
  out.activity.domainId=(!ctx||!ctx.domainIds||ctx.domainIds.has(did))?did:'';
  out.activity.days=Math.max(0,Math.min(ACTIVITY_MAX_DAYS,Math.round(toNum(a.days))));
  out.activity.times=Math.max(0,Math.round(toNum(a.times)));
  const mid=String(g.milestoneId||'');
  out.milestoneId=(!ctx||!ctx.achIds||ctx.achIds.has(mid))?mid:'';
  // 通用条件树：新商品直接存这里；老商品为空时由三段式字段即时合成（见 gateConditionOf）
  out.condition=normalizeCondition(g.condition);
  return out;
}
function normalizeProduct(p,ctx){
  p=normalizeProdNums(p);
  if(!p||typeof p!=='object')return p;
  if(PROD_TIERS.indexOf(p.tier)<0)p.tier='daily';
  p.gate=normalizeProductGate(p.gate,ctx);
  p.budget=normalizeProductBudget(p.budget,ctx);
  // 支付币种由层级决定：日常级活力点，品质/专属级成果点
  p.currency=tierCurrency(p.tier);
  return p;
}
// 活跃度查询/写入都只读最近 N 个自然日的日期键（含今天），不遍历日志
function normalizeActivityIndex(raw){
  const out={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  const cutoff=dateKeyOffset(ACTIVITY_MAX_DAYS-1);
  Object.keys(raw).forEach(function(did){
    const bucket=raw[did];
    if(!bucket||typeof bucket!=='object'||Array.isArray(bucket))return;
    const b={};
    Object.keys(bucket).forEach(function(k){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(k)||k<cutoff)return;
      const v=Math.max(0,Math.round(toNum(bucket[k])));
      if(v>0)b[k]=v;
    });
    if(Object.keys(b).length)out[did]=b;
  });
  return out;
}
// 统计日桶：只保留合法日期键与有限数值，超出保留期的桶直接丢弃
function normalizeStatsDaily(raw){
  const out={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  const cutoff=dateKeyOffset(STATS_KEEP_DAYS);
  Object.keys(raw).forEach(function(key){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(key)||key<cutoff)return;
    const src=raw[key];
    if(!src||typeof src!=='object'||Array.isArray(src))return;
    const b={};
    STATS_SCALARS.forEach(function(k){const v=toNum(src[k]);if(v)b[k]=v;});
    STATS_ENTITY_MAPS.forEach(function(mk){
      const map=src[mk];
      if(!map||typeof map!=='object'||Array.isArray(map))return;
      const m={};
      Object.keys(map).forEach(function(id){const v=toNum(map[id]);if(v)m[id]=v;});
      if(Object.keys(m).length)b[mk]=m;
    });
    out[key]=b;
  });
  return out;
}
function normalizeAccountSums(raw){
  const out=emptyAccountSums();
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  out.vitality=toNum(raw.vitality);
  out.achievement=toNum(raw.achievement);
  ['progress','cards'].forEach(function(k){
    const src=raw[k];
    if(!src||typeof src!=='object'||Array.isArray(src))return;
    Object.keys(src).forEach(function(id){
      const v=toNum(src[id]);
      if(v)out[k][id]=v;
    });
  });
  return out;
}
function normalizeAchievementCounted(raw){
  const out={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  Object.keys(raw).forEach(function(k){
    const v=toNum(raw[k]);
    if(v>0)out[k]=v;
  });
  return out;
}
function normalizePresetNums(p){
  if(!p||typeof p!=='object')return p;
  p.totalReward=toNum(p.totalReward);
  if(p.curve&&Array.isArray(p.curve.values))p.curve.values=p.curve.values.map(function(v){return toNum(v);});
  if(p.ach&&typeof p.ach==='object'){
    p.ach.enabled=!!p.ach.enabled;
    p.ach.amount=toNum(p.ach.amount);
  }
  return p;
}
function normalizeLoanNums(l){
  if(!l||typeof l!=='object')return l;
  l.amount=toNum(l.amount);
  l.debtRate=toNum(l.debtRate);
  if(l.date!==undefined)l.date=toTs(l.date);
  if(l.lastInterestAt!==undefined)l.lastInterestAt=toTs(l.lastInterestAt);
  return l;
}
function normalizeLogNums(l){
  if(!l||typeof l!=='object')return l;
  l.time=toTs(l.time)||0;
  l.amt=toNum(l.amt);
  if(l.amtV!==undefined)l.amtV=toNum(l.amtV);
  if(l.amtP!==undefined)l.amtP=toNum(l.amtP);
  return l;
}
function normalizeCards(c){
  const o={exemption:0};
  if(c&&typeof c==='object')Object.keys(c).forEach(function(k){o[k]=toNum(c[k]);});
  return o;
}
function normalizeWatermark(w){
  w=w&&typeof w==='object'?w:{};
  return{best:toNum(w.best),at:toTs(w.at)};
}
// ===== 现实预算归一（非法值守卫）=====
function normalizeBudgetSettings(s){
  s=s&&typeof s==='object'&&!Array.isArray(s)?s:{};
  const pk=(s.periodKeep&&typeof s.periodKeep==='object'&&!Array.isArray(s.periodKeep))?s.periodKeep:{};
  const an=(s.anchorNotice&&typeof s.anchorNotice==='object'&&!Array.isArray(s.anchorNotice))?s.anchorNotice:null;
  return{
    ledgerMax:Math.max(1,Math.round(toNum(s.ledgerMax,BUDGET_LEDGER_MAX))),
    periodKeep:{
      week:Math.max(1,Math.round(toNum(pk.week,BUDGET_PERIOD_KEEP.week))),
      month:Math.max(1,Math.round(toNum(pk.month,BUDGET_PERIOD_KEEP.month)))
    },
    anchorNotice:an?{
      categoryId:String(an.categoryId||''),
      name:String(an.name||''),
      from:Math.min(7,Math.max(1,Math.round(toNum(an.from,1)))),
      to:Math.min(7,Math.max(1,Math.round(toNum(an.to,1)))),
      at:toTs(an.at)||0
    }:null
  };
}
function normalizeBudgetRule(r,ctx){
  if(!r||typeof r!=='object'||Array.isArray(r))return null;
  const kind=BUDGET_RULE_KINDS.indexOf(r.kind)>=0?r.kind:'penalty';
  const t=(r.target&&typeof r.target==='object'&&!Array.isArray(r.target))?r.target:{};
  const account=['vitality','achievement','progress'].indexOf(t.account)>=0?t.account:(kind==='feedback'?'progress':'vitality');
  let domainId=String(t.domainId||'');
  if(!ctx||!ctx.domainIds||!ctx.domainIds.has(domainId))domainId='';
  const p=(r.params&&typeof r.params==='object'&&!Array.isArray(r.params))?r.params:{};
  return{
    id:String(r.id||uid()),
    kind:kind,
    enabled:r.enabled!==false,
    priority:Math.round(toNum(r.priority,0)),
    when:normalizeCondition(r.when),
    target:{account:account,domainId:domainId},
    params:{
      mode:p.mode==='ratio'?'ratio':'fixed',
      value:Math.max(0,toNum(p.value,0)),
      rate:Math.max(0,toNum(p.rate,0)),
      capPerPeriod:(p.capPerPeriod===null||p.capPerPeriod===undefined||p.capPerPeriod==='')?null:Math.max(0,toNum(p.capPerPeriod,0)),
      minAmount:Math.max(0,toNum(p.minAmount,0)),
      per:p.per==='entry'?'entry':'episode'
    }
  };
}
function normalizeBudgetCategory(c,ctx){
  if(!c||typeof c!=='object'||Array.isArray(c))return null;
  const cycle=c.cycle==='month'?'month':'week';
  let did=String(c.defaultProgressDomainId||'');
  if(!ctx||!ctx.domainIds||!ctx.domainIds.has(did))did='';
  const od=(c.overdraft&&typeof c.overdraft==='object'&&!Array.isArray(c.overdraft))?c.overdraft:{};
  const rules=asArray(c.rules).map(function(r){return normalizeBudgetRule(r,ctx);}).filter(Boolean);
  rules.sort(function(a,b){return a.priority-b.priority;});
  return{
    id:String(c.id||uid()),
    name:String(c.name||'未命名分类').slice(0,40),
    enabled:c.enabled!==false,
    archived:!!c.archived,
    cycle:cycle,
    anchor:Math.min(7,Math.max(1,Math.round(toNum(c.anchor,1)))),
    limit:Math.max(0,toNum(c.limit,0)),
    defaultProgressDomainId:did,
    rules:rules,
    overdraft:{
      enabled:od.enabled===true,
      currency:(od.currency==='vitality'||od.currency==='achievement')?od.currency:'achievement',
      rate:Math.max(0.0001,toNum(od.rate,2)),
      maxRealityPerPeriod:Math.max(0,toNum(od.maxRealityPerPeriod,300)),
      maxCostPerPeriod:Math.max(0,toNum(od.maxCostPerPeriod,150))
    },
    createdAt:toTs(c.createdAt)||now(),
    updatedAt:toTs(c.updatedAt)||null
  };
}
function normalizeBudgetPeriod(p,key,cycle,anchor){
  if(!p||typeof p!=='object'||Array.isArray(p))return null;
  const b=budgetBounds(cycle,toNum(p.start,now()),anchor);
  const totals={};
  if(p.ruleTotals&&typeof p.ruleTotals==='object'&&!Array.isArray(p.ruleTotals)){
    Object.keys(p.ruleTotals).forEach(function(k){totals[k]=Math.max(0,toNum(p.ruleTotals[k],0));});
  }
  return{
    key:String(p.key||key),
    start:toNum(p.start,0)||b.start,
    end:toNum(p.end,0)||b.end,
    spent:Math.max(0,toNum(p.spent,0)),
    entryCount:Math.max(0,Math.round(toNum(p.entryCount,0))),
    topupAmount:Math.max(0,toNum(p.topupAmount,0)),
    topupCost:Math.max(0,toNum(p.topupCost,0)),
    penalizedOverspend:Math.max(0,toNum(p.penalizedOverspend,0)),
    penaltyCharged:Math.max(0,toNum(p.penaltyCharged,0)),
    feedbackGranted:Math.max(0,toNum(p.feedbackGranted,0)),
    ruleTotals:totals,
    rewardSettled:!!p.rewardSettled,
    rewardAmount:Math.max(0,toNum(p.rewardAmount,0)),
    settlementSnapshot:(p.settlementSnapshot&&typeof p.settlementSnapshot==='object')?p.settlementSnapshot:null,
    closedAt:toTs(p.closedAt),
    settledAt:toTs(p.settledAt)
  };
}
function normalizeBudgetLedgerEntry(e,ctx){
  if(!e||typeof e!=='object'||Array.isArray(e))return null;
  const catId=String(e.categoryId||'');
  if(ctx&&ctx.catIds&&!ctx.catIds.has(catId))return null;
  const links=(e.links&&typeof e.links==='object'&&!Array.isArray(e.links))?e.links:{};
  const snap=(e.snapshot&&typeof e.snapshot==='object'&&!Array.isArray(e.snapshot))?e.snapshot:{};
  return{
    id:String(e.id||uid()),
    ts:toTs(e.ts)||now(),
    txnId:String(e.txnId||''),
    categoryId:catId,
    amount:Math.max(0,toNum(e.amount,0)),
    source:e.source==='product'?'product':'manual',
    productId:String(e.productId||''),
    note:String(e.note||'').slice(0,80),
    periodKey:String(e.periodKey||''),
    status:e.status==='reversed'?'reversed':'active',
    reversedAt:toTs(e.reversedAt),
    topupAdded:Math.max(0,toNum(e.topupAdded,0)),
    topupCost:Math.max(0,toNum(e.topupCost,0)),
    penaltyOverspendDelta:Math.max(0,toNum(e.penaltyOverspendDelta,0)),
    links:{
      purchaseLogId:String(links.purchaseLogId||''),
      topupLogId:String(links.topupLogId||''),
      penaltyLogIds:asArray(links.penaltyLogIds).map(String).filter(Boolean),
      feedbackLogIds:asArray(links.feedbackLogIds).map(String).filter(Boolean)
    },
    snapshot:{
      limit:Math.max(0,toNum(snap.limit,0)),
      topupAmount:Math.max(0,toNum(snap.topupAmount,0)),
      overspendAfter:Math.max(0,toNum(snap.overspendAfter,0)),
      penaltyAfter:Math.max(0,toNum(snap.penaltyAfter,0))
    }
  };
}
function normalizeBudgets(x,ctx){
  const out=defaultBudgetsState();
  if(!x||typeof x!=='object'||Array.isArray(x))return out;
  out.categories=asArray(x.categories).map(function(c){return normalizeBudgetCategory(c,ctx);}).filter(Boolean);
  const ids=new Set(out.categories.map(function(c){return c.id;}));
  const byId={};
  out.categories.forEach(function(c){byId[c.id]=c;});
  out.settings=normalizeBudgetSettings(x.settings);
  // 周期实例：只保留仍存在的分类；键与周期边界一致
  const rawPeriods=(x.periods&&typeof x.periods==='object'&&!Array.isArray(x.periods))?x.periods:{};
  Object.keys(rawPeriods).forEach(function(cid){
    if(!ids.has(cid))return;
    const src=rawPeriods[cid];
    if(!src||typeof src!=='object'||Array.isArray(src))return;
    const dst={};
    Object.keys(src).forEach(function(k){
      const p=normalizeBudgetPeriod(src[k],k,byId[cid].cycle,byId[cid].anchor);
      if(p)dst[k]=p;
    });
    out.periods[cid]=dst;
  });
  Object.keys(x.current||{}).forEach(function(cid){
    const key=String((x.current||{})[cid]||'');
    if(ids.has(cid)&&key&&out.periods[cid]&&out.periods[cid][key])out.current[cid]=key;
  });
  if(ctx&&ctx.catIds)ctx.catIds=ids;
  out.ledger=asArray(x.ledger).map(function(e){return normalizeBudgetLedgerEntry(e,{catIds:ids});}).filter(Boolean);
  return out;
}
function normalizeProductBudget(b,ctx){
  b=b&&typeof b==='object'&&!Array.isArray(b)?b:{};
  const catId=String(b.categoryId||'');
  const ok=(!ctx||!ctx.catIds||ctx.catIds.has(catId));
  return{categoryId:ok?catId:'',amount:ok?Math.max(0,toNum(b.amount,0)):0};
}
function normalizeExt(x,ctx){
  x=x&&typeof x==='object'?x:{};
  const s=x.stats&&typeof x.stats==='object'?x.stats:{};
  const wm=x.watermarks&&typeof x.watermarks==='object'?x.watermarks:{};
  const out={
    stats:{
      lifetimeVitalityIn:toNum(s.lifetimeVitalityIn),
      lifetimeVitalityOut:toNum(s.lifetimeVitalityOut),
      lifetimeProgressIn:toNum(s.lifetimeProgressIn),
      lifetimeProgressOut:toNum(s.lifetimeProgressOut),
      lifetimeAchievementIn:toNum(s.lifetimeAchievementIn),
      lifetimeAchievementOut:toNum(s.lifetimeAchievementOut),
      totalCheckins:Math.max(0,Math.round(toNum(s.totalCheckins))),
      totalPurchases:Math.max(0,Math.round(toNum(s.totalPurchases))),
      lifetimeAchievementEarned:Math.max(0,toNum(s.lifetimeAchievementEarned)),
      version:Math.max(0,Math.round(toNum(s.version))),
      lastDay:(typeof s.lastDay==='string'&&s.lastDay)?s.lastDay:null,
      daily:normalizeStatsDaily(s.daily),
      invisible:normalizeAccountSums(s.invisible),
      evicted:normalizeAccountSums(s.evicted),
      updatedAt:toTs(s.updatedAt)
    },
    watermarks:{
      vitality:normalizeWatermark(wm.vitality),
      achievement:normalizeWatermark(wm.achievement),
      totalProgress:normalizeWatermark(wm.totalProgress),
      progress:{}
    },
    budgets:normalizeBudgets(x.budgets,ctx),
    investment:{window:Math.max(1,Math.round(toNum((x.investment||{}).window,30)))},
    reports:asArray(x.reports).filter(Boolean),
    audit:asArray(x.audit).filter(Boolean).slice(-AUDIT_MAX),
    activity:normalizeActivityIndex(x.activity),
    achievementCounted:normalizeAchievementCounted(x.achievementCounted),
    shadow:asArray(x.shadow).filter(Boolean).slice(0,SHADOW_MAX),
    metabolismSeeded:x.metabolismSeeded===true,
    features:{audit:(x.features&&x.features.audit!==false)}
  };
  const pr=wm.progress&&typeof wm.progress==='object'?wm.progress:{};
  Object.keys(pr).forEach(function(k){out.watermarks.progress[k]=normalizeWatermark(pr[k]);});
  return out;
}
// 只接受当前 schema：低版本存档不再逐版本迁移，统一交给 normalizeXxx 的形状守卫补默认值；
// 高于当前版本视为不可信（可能来自更新版本），走 salvage 保留原始内容。
function applyMigrations(p){
  const from=(p.schema&&typeof p.schema.v==='number')?p.schema.v:0;
  if(from>SCHEMA_VERSION){loadIssue={type:'salvaged'};return;}
  p.schema={v:SCHEMA_VERSION,migratedAt:now()};
}
function parseState(raw){
  if(!raw)return defaults();
  let p;
  try{
    p=JSON.parse(raw);
  }catch(e1){
    p=salvageJSON(raw);
    if(!p){loadIssue={type:'corrupt'};return defaults();}
    loadIssue={type:'salvaged'};
  }
  try{
    if(!p||typeof p!=='object'||Array.isArray(p)){loadIssue={type:'corrupt'};return defaults();}
    applyMigrations(p);
    const tasks=asArray(p.tasks).filter(Boolean).map(function(t){
      if(!Array.isArray(t.domainIds)||!t.domainIds.length)t.domainIds=['d_default'];
      if(!Array.isArray(t.scoreTypes)||!t.scoreTypes.length)t.scoreTypes=['vitality'];
      if(t.description===undefined)t.description='';
      if(t.archived===undefined)t.archived=false;
      return normalizeTaskNums(t);
    });
    const domains=asArray(p.domains).filter(Boolean);
    if(!domains.length)domains.push({id:'d_default',name:'默认'});
    const collections=asArray(p.collections).filter(Boolean);
    if(!collections.length)collections.push({id:'c_default',name:'默认'});
    const shopCategories=asArray(p.shopCategories).filter(Boolean);
    if(!shopCategories.length)shopCategories.push({id:'sc_default',name:'默认'});
    const achievements=asArray(p.achievements).filter(Boolean).map(normalizeAchNums);
    const prodCtx={
      domainIds:new Set(domains.map(function(d){return d.id;})),
      achIds:new Set(achievements.map(function(a){return a.id;}))
    };
    // 先归一 ext：预算分类决定商品绑定分类是否有效，再归一商品
    const extNorm=normalizeExt(p.ext,prodCtx);
    if(!prodCtx.catIds)prodCtx.catIds=new Set((extNorm.budgets.categories||[]).map(function(c){return c.id;}));
    return{
      schema:{v:SCHEMA_VERSION,migratedAt:toTs(p.schema&&p.schema.migratedAt)},
      scores:normalizeScores(p.scores),
      domains:domains,
      collections:collections,
      shopCategories:shopCategories,
      collapsedColls:asArray(p.collapsedColls),
      collapsedAchDoms:asArray(p.collapsedAchDoms),
      collapsedShopCats:asArray(p.collapsedShopCats),
      majorCollapsed:asArray(p.majorCollapsed),
      tasks:tasks,
      achievements:achievements,
      affairs:asArray(p.affairs).filter(Boolean).map(migrateAffair),
      chores:asArray(p.chores).filter(Boolean).map(migrateChore),
      choreConfig:normalizeChoreConfig(p.choreConfig),
      affairPresets:asArray(p.affairPresets).filter(Boolean).map(normalizePresetNums),
      affairCollapsed:asArray(p.affairCollapsed),
      affairUndo:(p.affairUndo&&typeof p.affairUndo==='object'&&!Array.isArray(p.affairUndo))?p.affairUndo:{},
      products:asArray(p.products).filter(Boolean).map(function(prod){return normalizeProduct(prod,prodCtx);}),
      logs:asArray(p.logs).filter(Boolean).map(normalizeLogNums),
      loans:asArray(p.loans).filter(Boolean).map(normalizeLoanNums),
      lastDebtDate:toTs(p.lastDebtDate),
      filterDomain:p.filterDomain||null,
      metrics:asArray(p.metrics).filter(Boolean),
      cards:normalizeCards(p.cards),
      activities:migrateActivities(p),
      ext:extNorm
    };
  }catch(e){loadIssue={type:'corrupt'};return defaults();}
}

export function setPersistBlocked(v){_persistBlocked=!!v;}
export function setLoadIssue(v){loadIssue=v;}

export { normalizeRewardItem, normalizeResult, normalizeActivity, migrateActivities, loadIssue, _persistBlocked, salvageJSON, normalizeScores, normalizeTaskNums, normalizeAchNums, normalizeProdNums, normalizeProductGate, normalizeProduct, normalizeActivityIndex, normalizeStatsDaily, normalizeAccountSums, normalizeAchievementCounted, normalizePresetNums, normalizeLoanNums, normalizeLogNums, normalizeCards, normalizeWatermark, normalizeBudgetSettings, normalizeBudgetRule, normalizeBudgetCategory, normalizeBudgetPeriod, normalizeBudgetLedgerEntry, normalizeBudgets, normalizeProductBudget, normalizeExt, applyMigrations, parseState };
