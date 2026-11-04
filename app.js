'use strict';

// ===== State =====
const KEY='score_sys_v3';
const THEME_KEY='score_sys_theme';
// Schema 版本与全局常量（必须在 defaults() 首次调用前初始化）
// v2：商品层级（tier）与门槛（gate）；ext 增加累计成果点与活跃度索引
const SCHEMA_VERSION=2;
const PROD_TIERS=['daily','quality','exclusive'];
const PROD_TIER_NAMES={daily:'日常级',quality:'品质级',exclusive:'专属级'};
const ACTIVITY_MAX_DAYS=90;
const ACH_EARN_SOURCES={achievement:true,reward:true,affair:true};
function defaultProductGate(){
  return{minLifetime:0,activity:{domainId:'',days:0,times:0},milestoneId:''};
}
function tierCurrency(tier){return tier==='daily'?'vitality':'achievement';}
const MIGRATIONS={
  // v1 → v2：旧商品补 tier/gate（旧成果点商品映射为品质级，保持原支付币种不变）
  // 旧存档的“累计获得成果点”按正向往期流水 + 当前余额 + 已解锁里程碑金额做一次性基线，
  // 并把历史上出现过的成就 id 记入已计入清单，避免升级后撤销/再解锁重复累计。
  2:function(p){
    const prods=Array.isArray(p.products)?p.products:[];
    prods.forEach(function(prod){
      if(!prod||typeof prod!=='object')return;
      if(PROD_TIERS.indexOf(prod.tier)<0)prod.tier=(prod.currency==='achievement')?'quality':'daily';
      if(!prod.gate||typeof prod.gate!=='object')prod.gate=defaultProductGate();
    });
    const ext=(p.ext&&typeof p.ext==='object')?p.ext:(p.ext={});
    if(!ext.stats||typeof ext.stats!=='object')ext.stats={};
    if(!ext.activity||typeof ext.activity!=='object')ext.activity={};
    if(typeof ext.stats.lifetimeAchievementEarned!=='number'){
      const logs=Array.isArray(p.logs)?p.logs:[];
      const counted={};
      let sum=0;
      logs.forEach(function(l){
        if(!l||l.st!=='achievement')return;
        const src=String(l.src||'');
        if(src.indexOf('undo')===0||src==='loan-draw'||src==='manual-adjust')return;
        const amt=Number(l.amt);
        if(!isFinite(amt)||amt<=0)return;
        sum+=amt;
        if(l.achId)counted[l.achId]=Math.max(Number(counted[l.achId])||0,amt);
      });
      (Array.isArray(p.achievements)?p.achievements:[]).forEach(function(a){
        if(a&&a.id&&a.unlocked)counted[a.id]=Math.max(Number(counted[a.id])||0,Number(a.points)||0);
      });
      let countedSum=0;
      Object.keys(counted).forEach(function(k){countedSum+=counted[k];});
      const base=Math.max(0,Number((p.scores||{}).achievement)||0);
      ext.stats.lifetimeAchievementEarned=Math.max(sum,base,countedSum);
      if(!ext.achievementCounted||typeof ext.achievementCounted!=='object')ext.achievementCounted=counted;
    }
  }
};
const AUDIT_MAX=50;
let state=defaults();
let editCurrency='vitality';
let editTypes=['vitality'];
let condDraft={mode:'all',items:[]};
let condPanel={visible:false,kind:'metric',path:'',step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};

// ===== 阶段奖励 =====
const STAGE_NAMES=['起步','训练','进步','突破','超常'];
const STAGE_PRESET_KEY='score_sys_stage_presets';
const BACKUP_KEY='score_sys_last_backup';
let stagePresets=loadStagePresets();
let editStage={enabled:false,v:[],p:[],dirtyV:false,dirtyP:false,last:0};
let affairView='list';
let affairCalCursor=null;
let affairCalSelected=null;
let affairDoneOpen=false;
let choreDoneOpen=false;
let editAffairSteps=[];
function loadStagePresets(){
  const p={stepPct:50,decreasePct:100};
  try{
    const raw=localStorage.getItem(STAGE_PRESET_KEY);
    if(raw){const o=JSON.parse(raw);if(typeof o.stepPct==='number')p.stepPct=o.stepPct;if(typeof o.decreasePct==='number')p.decreasePct=o.decreasePct;}
  }catch(e){}
  return p;
}
function saveStagePresets(){try{localStorage.setItem(STAGE_PRESET_KEY,JSON.stringify(stagePresets));}catch(e){}}
function stageRewards(t){const sr=t&&t.stageRewards;return sr&&(Array.isArray(sr.v)||Array.isArray(sr.p))?sr:null;}
function taskIsStaged(t){return !!stageRewards(t);}
function stageValues(t,type){const sr=stageRewards(t);if(!sr)return null;const arr=type==='vitality'?sr.v:sr.p;return Array.isArray(arr)&&arr.length===5?arr:null;}
function stageSel(t){const sr=stageRewards(t);const l=sr&&typeof sr.last==='number'?sr.last:0;return Math.max(0,Math.min(9,Math.round(l)));}
function stageValueAt(t,type,cell){const v=stageValues(t,type);if(!v)return 0;if(cell>=9)return v[4]+(v[4]-v[3])/2;const i=cell>>1,rem=cell&1;return rem?(v[i]+v[i+1])/2:v[i];}
function stageCellLabel(cell){if(cell<=8&&cell%2===0)return STAGE_NAMES[cell/2];return STAGE_NAMES[Math.min(4,(cell-1)>>1)]+'+';}
// 阶段任务结算：档位值 + 连胜利息(初始值×利率×(连胜-1)) - 待扣债，最低为 0
// 与普通任务同一债务口径：待扣债照常扣减，扣完清零、不因债务大于初始值而整体免除
function stageNetAt(t,type,cell,c){
  const base=stageValueAt(t,type,cell);
  const info=c||calcCheckIn(t);
  return Math.max(0,base+(info.bonus||0)-(info.debt||0));
}
function round2(v){return Math.round(v*100)/100;}
// 日志金额：both 型且两分值不同时用 amtV/amtP 分别表达，否则回退到单一 amt
function logAmt(l,type){
  if(type==='vitality'&&typeof l.amtV==='number')return l.amtV;
  if(type==='progress'&&typeof l.amtP==='number')return l.amtP;
  return l.amt;
}

// ===== Theme =====
function initTheme(){
  const saved=localStorage.getItem(THEME_KEY);
  const prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme=saved||(prefersDark?'dark':'light');
  applyTheme(theme);
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  const btn=document.getElementById('themeToggle');
  if(btn)btn.textContent=theme==='dark'?'☀️':'🌙';
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')||'light';
  const next=cur==='dark'?'light':'dark';
  localStorage.setItem(THEME_KEY,next);
  applyTheme(next);
  render();
}
initTheme();

function cardName(c){return c==='exemption'?'断更豁免卡':(c||'卡');}
const COND_METRIC_KEYS=['checkins','vitality','progress','achievement','new_tasks','new_domains'];
const COND_RANGES=[
  {v:'period',n:'本周期'},
  {v:'total',n:'累计'},
  {v:'recent',n:'最近N天'},
  {v:'today',n:'今天'}
];
function validRange(r){return r==='period'||r==='total'||r==='recent'||r==='today';}
function normOp(op){return ['>','<','<=','>='].indexOf(op)>=0?op:'>=';}
function defaultActivities(){
  return[
    {id:'act_exemption',name:'断更豁免卡',enabled:true,period:'week',anchor:1,
     condition:{mode:'all',items:[]},
     result:{items:[{type:'card',card:'exemption',amount:1,cap:3}]},lastRun:null},
    {id:'act_score_up',name:'进步奖励',enabled:false,period:'week',anchor:1,
     condition:{mode:'all',items:[{range:'period',metric:'checkins',op:'>=',value:3}]},
     result:{items:[{type:'vitality',amount:10}]},lastRun:null}
  ];
}
function normalizeCondItem(it){
  if(!it||!validRange(it.range)||COND_METRIC_KEYS.indexOf(it.metric)<0)return null;
  const o={range:it.range,metric:it.metric,op:normOp(it.op),value:Number(it.value)||0};
  if(it.range==='recent')o.days=Math.max(1,Math.round(Number(it.days)||7));
  o.targetType=(it.targetType==='task'||it.targetType==='domain')?it.targetType:'all';
  o.target=(o.targetType==='all')?'':(it.target||'');
  o.newFilter=(it.newFilter==='new_task'||it.newFilter==='new_domain')?it.newFilter:'none';
  o.aggregate=(it.aggregate==='any')?'any':'sum';
  return o;
}
function normalizeCondNode(node){
  if(node&&node.group)return {group:true,mode:node.mode==='any'?'any':'all',items:(node.items||[]).map(normalizeCondNode).filter(Boolean)};
  return normalizeCondItem(node);
}
function normalizeCondition(c){
  if(c&&Array.isArray(c.items))
    return {mode:c.mode==='any'?'any':'all',items:c.items.map(normalizeCondNode).filter(Boolean)};
  return {mode:'all',items:[]};
}
function normalizeRewardItem(it){
  if(!it)return null;
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
// ===== 杂事经济配置（统一默认，可被单件杂事覆盖保鲜期）=====
function defaultChoreConfig(){
  return{
    freshDays:7,
    batchN:5,
    batchY:5,
    tier1Max:3,
    tier1Rate:0.2,
    tier2Max:7,
    tier2Rate:1,
    tier3Rate:3
  };
}
function normalizeChoreConfig(c){
  const d=defaultChoreConfig();
  c=c||{};
  function n(v,def,min){v=Number(v);if(!isFinite(v))return def;return v<min?min:v;}
  const out={
    freshDays:Math.round(n(c.freshDays,d.freshDays,0)),
    batchN:Math.max(1,Math.round(n(c.batchN,d.batchN,1))),
    batchY:n(c.batchY,d.batchY,0),
    tier1Max:Math.max(1,Math.round(n(c.tier1Max,d.tier1Max,1))),
    tier1Rate:n(c.tier1Rate,d.tier1Rate,0),
    tier2Max:Math.max(1,Math.round(n(c.tier2Max,d.tier2Max,1))),
    tier2Rate:n(c.tier2Rate,d.tier2Rate,0),
    tier3Rate:n(c.tier3Rate,d.tier3Rate,0)
  };
  // 档位必须递增：第二档下限恒大于第一档
  if(out.tier2Max<=out.tier1Max)out.tier2Max=out.tier1Max+1;
  return out;
}
function migrateChore(c){
  if(!c)return c;
  if(!c.id)c.id=uid();
  if(typeof c.name!=='string')c.name=String(c.name||'');
  c.done=!!c.done;
  c.doneAt=c.doneAt||null;
  c.plannedAt=c.plannedAt||null;
  c.createdAt=c.createdAt||now();
  c.settled=!!c.settled;
  c.decayKey=c.decayKey||null;
  if(c.freshDays===undefined||c.freshDays===null||c.freshDays===''||isNaN(Number(c.freshDays)))c.freshDays=null;
  else c.freshDays=Math.max(0,Math.round(Number(c.freshDays)));
  return c;
}
// ===== Schema 版本与扩展区 =====
// v1 为原点：新装/归一后的存档均带 schema.ext；MIGRATIONS 表留给后续版本使用。
function defaultWatermark(){return {best:0,at:null};}
function newExtState(){
  return{
    stats:{totalAchievement:0,lifetimeVitalityIn:0,lifetimeVitalityOut:0,totalCheckins:0,lifetimeAchievementEarned:0,updatedAt:null},
    watermarks:{vitality:defaultWatermark(),achievement:defaultWatermark(),totalProgress:defaultWatermark(),progress:{}},
    budgets:{period:'week',items:[],records:[]},
    investment:{window:30},
    reports:[],
    audit:[],
    activity:{},
    achievementCounted:{},
    features:{audit:true}
  };
}
function defaults(){
  return{
    schema:{v:SCHEMA_VERSION,migratedAt:null},
    scores:{vitality:0,progress:{},achievement:0},
    domains:[{id:'d_default',name:'默认'}],
    collections:[{id:'c_default',name:'默认'}],
    shopCategories:[{id:'sc_default',name:'默认'}],
    collapsedColls:[],
    collapsedAchDoms:[],
    collapsedShopCats:[],
    majorCollapsed:[],
    tasks:[],achievements:[],products:[],logs:[],
    affairs:[],
    chores:[],
    choreConfig:defaultChoreConfig(),
    affairPresets:[],
    affairCollapsed:[],
    affairUndo:{},
    loans:[],
    cards:{exemption:0},
    activities:defaultActivities(),
    lastDebtDate:null,
    filterDomain:null,
    metrics:[],
    ext:newExtState()
  };
}
let loadIssue=null;
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
function toNum(v,def){const n=Number(v);return isFinite(n)?n:(def===undefined?0:def);}
function toTs(v){const n=Number(v);return (isFinite(n)&&n>0)?n:null;}
function asArray(v){return Array.isArray(v)?v:[];}
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
  return out;
}
function normalizeProduct(p,ctx){
  p=normalizeProdNums(p);
  if(!p||typeof p!=='object')return p;
  if(PROD_TIERS.indexOf(p.tier)<0)p.tier='daily';
  p.gate=normalizeProductGate(p.gate,ctx);
  // 支付币种由层级决定：日常级活力点，品质/专属级成果点
  p.currency=tierCurrency(p.tier);
  return p;
}
// 活跃度查询/写入都只读最近 N 个自然日的日期键（含今天），不遍历日志
function dateKeyOffset(daysAgo){
  const d=new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()-Math.max(0,Math.round(Number(daysAgo)||0)));
  return dayKey(d.getTime());
}
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
function normalizeExt(x){
  x=x&&typeof x==='object'?x:{};
  const s=x.stats&&typeof x.stats==='object'?x.stats:{};
  const wm=x.watermarks&&typeof x.watermarks==='object'?x.watermarks:{};
  const out={
    stats:{
      totalAchievement:toNum(s.totalAchievement),
      lifetimeVitalityIn:toNum(s.lifetimeVitalityIn),
      lifetimeVitalityOut:toNum(s.lifetimeVitalityOut),
      totalCheckins:Math.max(0,Math.round(toNum(s.totalCheckins))),
      lifetimeAchievementEarned:Math.max(0,toNum(s.lifetimeAchievementEarned)),
      updatedAt:toTs(s.updatedAt)
    },
    watermarks:{
      vitality:normalizeWatermark(wm.vitality),
      achievement:normalizeWatermark(wm.achievement),
      totalProgress:normalizeWatermark(wm.totalProgress),
      progress:{}
    },
    budgets:(x.budgets&&typeof x.budgets==='object'&&!Array.isArray(x.budgets))
      ?{period:x.budgets.period||'week',items:asArray(x.budgets.items),records:asArray(x.budgets.records)}
      :{period:'week',items:[],records:[]},
    investment:{window:Math.max(1,Math.round(toNum((x.investment||{}).window,30)))},
    reports:asArray(x.reports).filter(Boolean),
    audit:asArray(x.audit).filter(Boolean).slice(-AUDIT_MAX),
    activity:normalizeActivityIndex(x.activity),
    achievementCounted:normalizeAchievementCounted(x.achievementCounted),
    features:{audit:(x.features&&x.features.audit!==false)}
  };
  const pr=wm.progress&&typeof wm.progress==='object'?wm.progress:{};
  Object.keys(pr).forEach(function(k){out.watermarks.progress[k]=normalizeWatermark(pr[k]);});
  return out;
}
// 版本迁移：v1 为原点，MIGRATIONS 表留给后续版本；不推进版本号即表示迁移失败（下次启动重试）
function applyMigrations(p){
  const from=(p.schema&&typeof p.schema.v==='number')?p.schema.v:0;
  if(from>SCHEMA_VERSION){loadIssue={type:'salvaged'};return;}
  for(let v=from;v<SCHEMA_VERSION;v++){
    const step=MIGRATIONS[v+1];
    if(!step)continue;
    try{step(p);}
    catch(e){loadIssue={type:'salvaged'};return;}
    p.schema={v:v+1,migratedAt:now()};
  }
  if(!p.schema||typeof p.schema!=='object')p.schema={v:SCHEMA_VERSION,migratedAt:null};
  else p.schema.v=SCHEMA_VERSION;
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
      ext:normalizeExt(p.ext)
    };
  }catch(e){loadIssue={type:'corrupt'};return defaults();}
}

// ===== IndexedDB 持久化层 =====
const IDB_NAME='score_sys_db';
const IDB_VERSION=1;
const IDB_STORE='kv';
let _idbPromise=null;
function openIDB(){
  if(_idbPromise)return _idbPromise;
  _idbPromise=new Promise(function(resolve,reject){
    if(!window.indexedDB){reject(new Error('no-indexeddb'));return;}
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=function(e){
      const db=e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE);
    };
    req.onsuccess=function(e){resolve(e.target.result);};
    req.onerror=function(e){reject(e.target.error);};
  });
  return _idbPromise;
}
// 仅保留主数据键；其余历史 key 见 migrateLegacy()
// 读盘超时保护：IndexedDB 在部分环境下会长时间不回调，避免启动白屏
function withTimeout(p,ms,fallback){
  return new Promise(function(resolve){
    let done=false;
    const timer=setTimeout(function(){if(done)return;done=true;resolve(fallback);},ms);
    p.then(function(v){if(done)return;done=true;clearTimeout(timer);resolve(v);})
     .catch(function(){if(done)return;done=true;clearTimeout(timer);resolve(fallback);});
  });
}
function idbGet(key){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readonly');
      const rq=tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess=function(){resolve(rq.result);};
      rq.onerror=function(){reject(rq.error);};
    });
  });
}
function idbPut(key,val){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).put(val,key);
      tx.oncomplete=function(){resolve();};
      tx.onerror=function(){reject(tx.error);};
    });
  });
}

function idbDelete(key){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete=function(){resolve();};
      tx.onerror=function(){reject(tx.error);};
    });
  });
}

// ===== 持久化调度：合并写盘（200ms 尾随防抖）+ 强制 flush =====
// _saveChain 保持不变：所有写入仍串行；区别只在于「何时序列化/入链」。
let _saveChain=Promise.resolve();
const Persist=(function(){
  const SAVE_DELAY=200;
  let timer=null;
  let pending=false;
  function serialize(){return JSON.stringify(state);}
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(!pending)return _saveChain;
    pending=false;
    let json;
    try{json=serialize();}catch(e){console.warn('serialize failed',e);return _saveChain;}
    _saveChain=_saveChain.then(function(){return idbPut(KEY,json);})
      .catch(function(e){console.warn('IndexedDB save failed',e);/* 写失败不阻塞 UI */});
    return _saveChain;
  }
  function schedule(delay){
    pending=true;
    if(timer)clearTimeout(timer);
    timer=setTimeout(flush,delay===undefined?SAVE_DELAY:delay);
  }
  return {schedule:schedule,flush:flush,serialize:serialize,delay:SAVE_DELAY,isPending:function(){return pending;}};
})();
function save(){Persist.schedule();}
try{
  document.addEventListener('visibilitychange',function(){if(document.hidden)Persist.flush();});
  window.addEventListener('pagehide',function(){Persist.flush();});
}catch(e){}
// 一次提交：落盘 + 全量渲染 + 可选提示（仅用于原本 save()+render()(+toast) 的调用点）
function commit(msg,type){save();render();if(msg)toast(msg,type);}
// 合并渲染：同一帧内的多次请求只渲染一次（仅用于定时调度批量处理后的收尾）
let _renderRAF=null;
function scheduleRender(){
  if(_renderRAF!==null)return;
  _renderRAF=requestAnimationFrame(function(){_renderRAF=null;render();});
}

// ===== Utils =====
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,5)}
function fmt(n){
  if(n===null||n===undefined||isNaN(n))return'0';
  const r=Math.round(n*100000)/100000;
  if(r===0){
    // Non-zero but too small for 5 decimal places — show more precision
    if(n>0)return parseFloat(n.toFixed(10)).toString();
    if(n<0)return parseFloat(n.toFixed(10)).toString();
    return'0';
  }
  if(Number.isInteger(r))return''+r;
  // Show up to 5 decimal places, trim trailing zeros
  return parseFloat(r.toFixed(5)).toString();
}
function now(){return Date.now()}
function daysSince(ts){return ts?(Date.now()-ts)/864e5:0}
function effectiveLastTs(task){return Math.max(task.lastCheckIn||0,task.lastExempt||0)}
function fmtTime(ts){
  if(!ts)return '从未';
  const d=new Date(ts),n=new Date(),diff=(n-d)/864e5;
  if(diff<1&&d.getDate()===n.getDate()&&d.getMonth()===n.getMonth())
    return '今天 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  if(diff<2)return '昨天';
  if(diff<7)return Math.floor(diff)+'天前';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
// 用于 value="..." 等双引号属性：esc 不转义引号，需额外处理避免属性截断
function escAttr(s){return esc(String(s==null?'':s)).replace(/"/g,'&quot;');}
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
function totalProgress(){return Object.values(state.scores.progress||{}).reduce((s,v)=>s+v,0)}
function domainName(id){const d=state.domains.find(x=>x.id===id);return d?d.name:'未知'}
function taskNameLabel(id){const t=state.tasks.find(x=>x.id===id);return t?t.name:'未知'}
function collectionName(id){const c=state.collections.find(x=>x.id===id);return c?c.name:'未分类'}
function domainProgress(id){return(state.scores.progress[id])||(0)}
function metricValue(m){return (m.domainIds||[]).reduce((s,did)=>s+domainProgress(did),0)}

// 任务所属领域（新装/导入均由 parseState 归一为 domainIds 数组）
function getTaskDomainIds(t){
  if(t.domainIds&&Array.isArray(t.domainIds)&&t.domainIds.length>0)return t.domainIds;
  return['d_default'];
}
function taskScoreTypes(t){
  if(t.scoreTypes&&Array.isArray(t.scoreTypes)&&t.scoreTypes.length>0)return t.scoreTypes;
  return ['vitality'];
}
function taskHasType(t,type){return taskScoreTypes(t).indexOf(type)>=0;}
function logHasType(l,st){return l.st==='both'?(st==='vitality'||st==='progress'):l.st===st;}
function applyCheckinGain(log,mult){
  const types=log.st==='both'?['vitality','progress']:[log.st];
  types.forEach(st=>{
    const amt=logAmt(log,st);
    if(st==='vitality'){
      Ledger.post({op:'grant',account:'vitality',delta:mult*amt,visible:false,reason:{src:'checkin-replay'}});
    }else if(st==='progress'){
      // 优先按流水自带的分配明细精确反向；无明细时回退到按领域均分
      if(Array.isArray(log.splits)&&log.splits.length){
        log.splits.forEach(function(sp){
          Ledger.post({op:'grant',account:'progress:'+(sp.dom||'d_default'),delta:mult*(Number(sp.amt)||0),visible:false,reason:{src:'checkin-replay'}});
        });
      }else{
        let dids=(log.dom||'').split(',').filter(Boolean);
        if(dids.length===0&&log.taskId){const t=state.tasks.find(x=>x.id===log.taskId);if(t)dids=getTaskDomainIds(t);}
        if(dids.length===0)dids=['d_default'];
        Ledger.postSplits({splits:[{domainIds:dids,delta:mult*amt}],visible:false,reason:{src:'checkin-replay'}});
      }
    }
  });
}

const LOG_MAX=300;
// 银行页最多渲染的流水条数
const LOG_DISPLAY=100;
// 深拷贝（优先原生 structuredClone，旧环境回退 JSON 往返）
function clone(o){
  if(typeof structuredClone==='function'){
    try{return structuredClone(o);}catch(e){}
  }
  return JSON.parse(JSON.stringify(o));
}
// 按"分"为单位平均分摊：尾差按领域顺序逐个 +1 分，保证各份之和逐分等于原额
function splitCents(amount,n){
  if(!n||n<1)return[];
  const cents=Math.round((Number(amount)||0)*100);
  const sign=cents<0?-1:1;
  const abs=Math.abs(cents);
  const base=Math.floor(abs/n);
  const rem=abs-base*n;
  const out=[];
  for(let i=0;i<n;i++)out.push(sign*(base+(i<rem?1:0))/100);
  return out;
}

// ===== 账务引擎（唯一资产写入入口）=====
// 约定：账户键是运行时映射，不落盘；可见流水字段与事件流水完全一致。
// 精度口径由调用方决定，引擎不做 round2。
const Ledger=(function(){
  let tx=null;
  const policies={beforeSpend:[],beforePurchase:[],afterPost:[],onTxnEnd:[]};

  // 记录统一入栈（全文件唯一写入口）：最新的在最前，超过上限原地截断（不复制整表）
  function pushLog(entry){
    state.logs.unshift(entry);
    if(state.logs.length>LOG_MAX)state.logs.length=LOG_MAX;
    return entry;
  }
  // 业务事件（0 元）：业务层不再直接拼装流水
  function event(desc,src,extra){
    const entry={id:uid(),time:now(),st:'',amt:0,desc:desc,src:src||'',dom:''};
    if(extra)Object.assign(entry,extra);
    return pushLog(entry);
  }
  // 追加到末尾：历史重放需要保持时间顺序时不走 unshift
  function append(entry){state.logs.push(entry);return entry;}
  // 移除流水（撤销/回收统一入口）
  function removeLogs(pred){state.logs=state.logs.filter(pred);return state.logs;}
  // 事务快照：排除 ext.audit（审计只追加、不参与回滚）
  // 回滚时把原审计数组接回，并保留失败事务产生的审计记录（尝试痕迹）
  function snapshotState(){
    const copy=Object.assign({},state);
    if(copy.ext)copy.ext=Object.assign({},copy.ext,{audit:[]});
    return clone(copy);
  }
  function restoreState(snap,attemptedAudit){
    const aud=(state.ext&&state.ext.audit)?state.ext.audit:[];
    state=snap;
    if(!state.ext)return;
    state.ext.audit=aud;
    if(attemptedAudit&&attemptedAudit.length){
      state.ext.audit=(state.ext.audit||[]).concat(attemptedAudit).slice(-AUDIT_MAX);
    }
  }

  function fail(code,info){const e=new Error(code);e.__txn=true;e.code=code;e.info=info||{};throw e;}
  function accountInfo(key){
    if(key==='vitality')return{get:function(){return state.scores.vitality;},set:function(v){state.scores.vitality=v;},st:'vitality',dom:''};
    if(key==='achievement')return{get:function(){return state.scores.achievement;},set:function(v){state.scores.achievement=v;},st:'achievement',dom:''};
    if(key.indexOf('progress:')===0){
      const did=key.slice(9);
      return{get:function(){return state.scores.progress[did]||0;},set:function(v){state.scores.progress[did]=v;},st:'progress',dom:did};
    }
    if(key.indexOf('card:')===0){
      const cid=key.slice(5);
      return{get:function(){return state.cards[cid]||0;},set:function(v){state.cards[cid]=v;},st:'card',dom:''};
    }
    fail('INVALID_ACCOUNT',{account:key});
  }
  function audit(rec){
    if(!tx||!state.ext||state.ext.features&&state.ext.features.audit===false)return;
    tx.audit.push(rec);
  }
  function noteWatermark(key,after){
    if(!state.ext||!state.ext.watermarks)return;
    const w=state.ext.watermarks;
    if(key==='vitality'||key==='achievement'){
      if(after>w[key].best)w[key]={best:after,at:now()};
      return;
    }
    if(key.indexOf('progress:')===0){
      const did=key.slice(9);
      const cur=w.progress[did]||defaultWatermark();
      if(after>cur.best)w.progress[did]={best:after,at:now()};
    }
  }
  function pickExtra(reason){
    const o={};
    Object.keys(reason||{}).forEach(function(k){
      if(k!=='desc'&&k!=='src'&&k!=='dom'&&k!=='name')o[k]=reason[k];
    });
    return o;
  }
  function writeEntry(op,acct,delta,reason){
    if(op.visible===false)return null;
    let entry;
    if(op.entry){
      entry=Object.assign({id:uid(),time:now()},op.entry);
    }else{
      entry={id:uid(),time:now(),st:op.st||acct.st,amt:delta,desc:(reason&&reason.desc)||'',src:(reason&&reason.src)||'',dom:(reason&&reason.dom!==undefined)?reason.dom:(acct.dom||'')};
      Object.assign(entry,pickExtra(reason));
    }
    return pushLog(entry);
  }
  function post(op){
    if(!tx){
      const r=txn(function(){return post(op);},{save:'none',render:false,label:'auto'});
      return r.ok?r.value:{ok:false,error:r.error};
    }
    const reason=op.reason||{};
    if(op.op==='transfer'){
      const a=accountInfo(op.from),b=accountInfo(op.to);
      const amt=Number(op.delta)||0;
      const beforeA=Number(a.get())||0,beforeB=Number(b.get())||0;
      a.set(beforeA-amt);b.set(beforeB+amt);
      tx.accounts.add(op.from);tx.accounts.add(op.to);
      const entry=writeEntry(op,b,amt,reason);
      audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:'transfer',from:op.from,to:op.to,delta:amt,src:reason.src||''});
      noteWatermark(op.to,beforeB+amt);
      return {ok:true,entryId:entry?entry.id:null,before:beforeA,after:beforeA-amt};
    }
    const acct=accountInfo(op.account);
    const before=Number(acct.get())||0;
    let delta;
    if(op.op==='adjust')delta=(Number(op.target)||0)-before;
    else delta=Number(op.delta)||0;
    if(!isFinite(delta))fail('INVALID_AMOUNT',{account:op.account,delta:op.delta});
    if(op.idemKey){
      if(tx.idem[op.idemKey])return{ok:true,deduped:true,entryId:null,before:before,after:before};
      tx.idem[op.idemKey]=true;
    }
    const after=before+delta;
    acct.set(after);
    tx.accounts.add(op.account);
    if(acct.dom)tx.domains[acct.dom]=true;
    const entry=writeEntry(op,acct,delta,reason);
    audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:op.op,acct:op.account,delta:delta,before:before,after:after,visible:op.visible!==false,src:reason.src||''});
    noteWatermark(op.account,after);
    if(policies.afterPost.length){
      policies.afterPost.forEach(function(p){
        try{p.fn({entry:entry,account:op.account,before:before,after:after,txn:tx});}catch(e){console.warn('policy failed',p.name,e);}
      });
    }
    return {ok:true,entryId:entry?entry.id:null,before:before,after:after};
  }
  // 多科目拆分：一次可见流水（用于 checkin 的 both 型与多领域 progress 分摊）
  function postSplits(op){
    if(!tx){
      const r=txn(function(){return postSplits(op);},{save:'none',render:false,label:'auto'});
      return r.ok?r.value:{ok:false,error:r.error};
    }
    const reason=op.reason||{};
    const splits=op.splits||[];
    const beforeOf={};
    const domainSplits=[];
    let total=0;
    splits.forEach(function(s){
      if(s.account){
        const a=accountInfo(s.account);
        beforeOf[s.account]=Number(a.get())||0;
        const d=Number(s.delta)||0;
        a.set(beforeOf[s.account]+d);
        tx.accounts.add(s.account);
        if(a.dom)tx.domains[a.dom]=true;
        total+=d;
      }else if(s.domainIds&&s.domainIds.length){
        // 精确到分的平均分摊：各领域之和与原额逐分相等（尾差按顺序归前几个领域）
        const parts=splitCents(Number(s.delta)||0,s.domainIds.length);
        s.domainIds.forEach(function(did,i){
          const key='progress:'+did;
          const a=accountInfo(key);
          beforeOf[key]=Number(a.get())||0;
          const d=parts[i];
          a.set(beforeOf[key]+d);
          tx.accounts.add(key);
          tx.domains[did]=true;
          domainSplits.push({dom:did,amt:d});
        });
        total+=Number(s.delta)||0;
      }
    });
    const entry=writeEntry(op,{st:op.st||'vitality',dom:''},total,reason);
    // 分配明细落盘在流水自身，撤销时按原比例逐领域退回（不依赖 ext.audit）
    if(entry&&domainSplits.length)entry.splits=domainSplits;
    audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:'splits',accounts:Object.keys(beforeOf),delta:total,visible:op.visible!==false,src:reason.src||''});
    Object.keys(beforeOf).forEach(function(k){noteWatermark(k,Number(accountInfo(k).get())||0);});
    return {ok:true,entryId:entry?entry.id:null,accounts:Object.keys(beforeOf)};
  }
  function txn(fn,opts){
    opts=opts||{};
    if(tx){return {ok:true,value:fn(tx),nested:true};}
    const snap=(opts.snapshot===false)?null:snapshotState();
    tx={label:opts.label||'',accounts:new Set(),domains:{},audit:[],idem:{}};
    let value,error=null;
    try{value=fn(tx);}
    catch(e){
      if(e&&e.__txn){error={code:e.code||'ABORTED',message:e.message,info:e.info||{}};}
      else{const attempted=tx?tx.audit:null;if(snap)restoreState(snap,attempted);tx=null;throw e;}
    }
    if(error){
      if(snap)restoreState(snap,tx.audit);
      tx=null;
      return {ok:false,error:error};
    }
    const accounts=Array.from(tx.accounts);
    try{
      if(tx.audit.length){
        state.ext.audit=(state.ext.audit||[]).concat(tx.audit).slice(-AUDIT_MAX);
      }
      state.ext.stats.updatedAt=now();
      if(accounts.some(function(k){return k.indexOf('progress:')===0;})){
        const tp=totalProgress();
        if(tp>state.ext.watermarks.totalProgress.best)state.ext.watermarks.totalProgress={best:tp,at:now()};
      }
    }catch(e){}
    const domains=Object.keys(tx.domains);
    const entries=tx.audit.map(function(a){return a.id;});
    const label=tx.label;
    tx=null;
    if(policies.onTxnEnd.length){
      policies.onTxnEnd.forEach(function(p){try{p.fn({ok:true,label:label,accounts:accounts,entries:entries});}catch(e){console.warn('policy failed',p.name,e);}});
    }
    if(opts.save!=='none')save();
    if(opts.render!==false)render();
    return {ok:true,value:value,accounts:accounts,domains:domains,entries:entries};
  }
  function grant(account,amount,reason,opts){
    return post(Object.assign({op:'grant',account:account,delta:amount,reason:reason},opts||{}));
  }
  function spend(account,amount,reason,opts){
    return post(Object.assign({op:'spend',account:account,delta:-Math.abs(Number(amount)||0),reason:reason},opts||{}));
  }
  function transfer(from,to,amount,reason,opts){
    return post(Object.assign({op:'transfer',from:from,to:to,delta:Math.abs(Number(amount)||0),reason:reason},opts||{}));
  }
  function adjust(account,target,reason,opts){
    return post(Object.assign({op:'adjust',account:account,target:target,reason:reason},opts||{}));
  }
  const liability={
    open:function(o){
      o=o||{};
      const loan={id:o.id||uid(),amount:Number(o.amount)||0,debtRate:Number(o.debtRate)||0,currency:o.currency||'vitality',productId:o.productId||'',productName:o.productName||'',date:o.date||now()};
      state.loans.push(loan);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-open',liability:loan.id,delta:loan.amount,src:(o.reason&&o.reason.src)||''});
      return loan;
    },
    mutate:function(id,factor,reason){
      const l=state.loans.find(function(x){return x.id===id;});
      if(!l)return null;
      const before=l.amount;
      l.amount=typeof factor==='function'?factor(before):(Number(factor)||0);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-mutate',liability:id,delta:l.amount-before,before:before,after:l.amount,visible:false,src:(reason&&reason.src)||''});
      return l;
    },
    close:function(id,reason){
      const i=state.loans.findIndex(function(x){return x.id===id;});
      if(i<0)return false;
      const l=state.loans[i];
      state.loans.splice(i,1);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-close',liability:id,amount:l.amount,src:(reason&&reason.src)||''});
      return true;
    }
  };
  function registerPolicy(p){
    if(!p||!policies[p.phase])return;
    policies[p.phase].push(p);
    policies[p.phase].sort(function(a,b){return (a.priority||0)-(b.priority||0);});
  }
  // 购买前门槛：策略返回 {deny:true,code,reason} 时抛事务错误，由 txn 统一回滚
  function runPolicies(phase,ctx){
    const list=policies[phase]||[];
    for(let i=0;i<list.length;i++){
      const p=list[i];
      let r;
      try{r=p.fn(ctx);}
      catch(e){console.warn('policy failed',p.name,e);continue;}
      if(r&&r.deny)return r;
    }
    return null;
  }
  function checkPurchase(product){
    const r=runPolicies('beforePurchase',{product:product});
    if(r&&r.deny)fail('PURCHASE_DENIED',{code:r.code||'GATE',reason:r.reason||'购买条件未满足',reasons:r.reasons||[]});
    return true;
  }
  return{
    txn:txn,post:post,postSplits:postSplits,grant:grant,spend:spend,transfer:transfer,adjust:adjust,
    liability:liability,registerPolicy:registerPolicy,accountInfo:accountInfo,
    event:event,append:append,removeLogs:removeLogs,checkPurchase:checkPurchase,
    inTxn:function(){return !!tx;},
    balance:function(key){return Number(accountInfo(key).get())||0;},
    entries:function(){return state.logs;},
    // 复用撤销适配器注册表；业务层不直接触碰适配器实现
    reverse:function(logId){return undoLog(logId);}
  };
})();

// ===== 成果点：累计获得（单调累加）与已计入清单 =====
// 只有真实“获得”来源计入：里程碑解锁 / 周期活动奖励 / 项目奖励。
// 贷款、退款、撤销、手动修正都不计入；里程碑按 achId 记录已计入数额，撤销后再解锁不重复累计。
function noteAchievementEarned(delta,entry){
  if(!state.ext)return;
  if(!state.ext.stats)state.ext.stats=newExtState().stats;
  if(!state.ext.achievementCounted||typeof state.ext.achievementCounted!=='object')state.ext.achievementCounted={};
  const src=String((entry&&entry.src)||'');
  if(!ACH_EARN_SOURCES[src])return;
  let add=Math.max(0,Number(delta)||0);
  if(src==='achievement'&&entry&&entry.achId){
    const counted=Math.max(0,Number(state.ext.achievementCounted[entry.achId])||0);
    add=Math.max(0,add-counted);
    const points=Math.max(Number(entry.amt)||0,Number(delta)||0);
    state.ext.achievementCounted[entry.achId]=Math.max(counted,points);
  }
  if(add>0)state.ext.stats.lifetimeAchievementEarned=(Number(state.ext.stats.lifetimeAchievementEarned)||0)+add;
}
Ledger.registerPolicy({phase:'afterPost',priority:10,name:'achievement-lifetime',
  fn:function(ctx){
    if(ctx.account!=='achievement')return;
    const delta=(Number(ctx.after)||0)-(Number(ctx.before)||0);
    if(delta>0)noteAchievementEarned(delta,ctx.entry);
  }
});

// ===== 活跃度索引：ext.activity[did]['YYYY-MM-DD'] = 次数 =====
// 写入只发生在打卡路径（以及撤销打卡的反向扣减），查询只读最近 N 个日期键。
// 索引保留最近 ACTIVITY_MAX_DAYS 个自然日；归档不清空，恢复后按历史活跃度继续计算。
function pruneActivityBucket(bucket,cutoff){
  Object.keys(bucket).forEach(function(k){
    if(k<cutoff||!(Number(bucket[k])>0))delete bucket[k];
  });
}
function noteCheckinActivity(dids,delta,ts){
  if(!state.ext)return;
  if(!state.ext.activity||typeof state.ext.activity!=='object')state.ext.activity={};
  const key=dayKey(ts||now());
  const cutoff=dateKeyOffset(ACTIVITY_MAX_DAYS-1);
  const list=(Array.isArray(dids)&&dids.length)?dids:['d_default'];
  list.forEach(function(did){
    let bucket=state.ext.activity[did];
    if(!bucket||typeof bucket!=='object')bucket=state.ext.activity[did]={};
    const next=Math.max(0,Math.round((Number(bucket[key])||0)+delta));
    if(next>0)bucket[key]=next;else delete bucket[key];
    pruneActivityBucket(bucket,cutoff);
    if(!Object.keys(bucket).length)delete state.ext.activity[did];
  });
}
// 最近 days 个自然日（含今天）的打卡次数：逐日哈希读取，复杂度 O(days)
function activityCountForDomain(did,days){
  const bucket=(state.ext&&state.ext.activity&&state.ext.activity[did])||{};
  let n=0;
  const d=Math.max(0,Math.round(Number(days)||0));
  for(let i=0;i<d;i++)n+=Math.max(0,Math.round(Number(bucket[dateKeyOffset(i)])||0));
  return n;
}

// ===== 商品层级门槛 =====
// 只读 ext.stats / ext.activity / 领域与里程碑定义，不遍历 state.logs。
function validProductTier(tier){return PROD_TIERS.indexOf(tier)>=0?tier:'daily';}
function isArchivedEntity(o){return !!(o&&(o.archived||o.archivedAt));}
function evaluateProductGate(p){
  const tier=validProductTier(p&&p.tier);
  const out={ok:true,deny:false,tier:tier,code:null,reasons:[],reason:''};
  if(tier==='daily')return out;
  const gate=(p&&p.gate)||defaultProductGate();
  if(tier==='quality'){
    const need=Math.max(0,Math.round(toNum(gate.minLifetime)));
    const earned=Math.max(0,toNum(state.ext&&state.ext.stats&&state.ext.stats.lifetimeAchievementEarned));
    if(earned<need){
      out.ok=false;out.code=out.code||'GATE_LIFETIME';
      out.reasons.push('差 '+fmt(need-earned)+' 累计成果点');
    }
    const act=(gate.activity&&typeof gate.activity==='object')?gate.activity:{};
    const did=String(act.domainId||'');
    const days=Math.max(0,Math.min(ACTIVITY_MAX_DAYS,Math.round(toNum(act.days))));
    const times=Math.max(0,Math.round(toNum(act.times)));
    if(did&&days>0&&times>0){
      const d=state.domains.find(function(x){return x.id===did;});
      if(!d){
        out.ok=false;out.code=out.code||'GATE_DOMAIN';
        out.reasons.push('关联领域不存在');
      }else if(isArchivedEntity(d)){
        out.ok=false;out.code=out.code||'GATE_DOMAIN_ARCHIVED';
        out.reasons.push('关联领域已归档');
      }else{
        const cnt=activityCountForDomain(did,days);
        if(cnt<times){
          out.ok=false;out.code=out.code||'GATE_ACTIVITY';
          out.reasons.push('最近 '+days+' 天需打卡 '+times+' 次，当前 '+cnt+' 次');
        }
      }
    }
  }else{
    const mid=String(gate.milestoneId||'');
    const a=mid?state.achievements.find(function(x){return x.id===mid;}):null;
    if(!mid){
      out.ok=false;out.code='GATE_MILESTONE';
      out.reasons.push('未绑定里程碑');
    }else if(!a){
      out.ok=false;out.code='GATE_MILESTONE_MISSING';
      out.reasons.push('绑定的里程碑不存在');
    }else if(isArchivedEntity(a)){
      out.ok=false;out.code='GATE_MILESTONE_ARCHIVED';
      out.reasons.push('里程碑已归档');
    }else if(!a.unlocked){
      out.ok=false;out.code='GATE_MILESTONE_LOCKED';
      out.reasons.push('里程碑未解锁');
    }
  }
  if(!out.ok){
    out.deny=true;
    out.reason=out.reasons.join('；');
  }
  return out;
}
// 唯一门槛调用点由 buyProduct 触发；策略拒绝 → txn 回滚
Ledger.registerPolicy({phase:'beforePurchase',priority:10,name:'product-tier-gate',
  fn:function(ctx){return evaluateProductGate(ctx.product);}
});

function dayKey(ts){
  const d=new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function weekStartKey(ts,anchor){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1; // 1=Mon .. 7=Sun
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return dayKey(d.getTime()-diff*864e5);
}
function periodKey(cfg,ts){
  if(cfg.period==='day')return dayKey(ts);
  if(cfg.period==='month'){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  return weekStartKey(ts,cfg.anchor||1);
}
function weekStartTs(anchor,ts){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return d.getTime()-diff*864e5;
}
function weekScore(start,end){
  let vit=0,prog=0,ach=0,checkins=0,invest=0,consume=0;
  state.logs.forEach(l=>{
    if(l.time<start||l.time>=end)return;
    if(l.st==='both'){vit+=logAmt(l,'vitality');prog+=logAmt(l,'progress');}
    else if(l.st==='vitality')vit+=logAmt(l,'vitality');
    else if(l.st==='progress')prog+=logAmt(l,'progress');
    else if(l.st==='achievement')ach+=l.amt;
    if(l.src==='checkin')checkins++;
    if(l.src==='cost'&&l.amt<0)invest+=(-l.amt);
    else if(l.src==='purchase'&&l.st==='vitality'&&l.amt<0)consume+=(-l.amt);
  });
  const spend=invest+consume;
  const investRate=spend>0?invest/spend*100:0;
  const score=prog + vit*0.5 + ach*10 + checkins*2;
  return {vit:vit,prog:prog,ach:ach,checkins:checkins,invest:invest,consume:consume,investRate:investRate,score:score};
}
function exemptionActivity(){
  return (state.activities||[]).find(a=>a.enabled&&(a.result&&a.result.items||[]).some(it=>it.type==='card'&&it.card==='exemption'));
}
function dayStartTs(ts){const d=new Date(ts);d.setHours(0,0,0,0);return d.getTime();}
function prevPeriodRange(act,ts){
  if(act.period==='day'){const s=dayStartTs(ts);return {start:s-864e5,end:s};}
  if(act.period==='month'){const d=new Date(ts);const cur=new Date(d.getFullYear(),d.getMonth(),1).getTime();const prev=new Date(d.getFullYear(),d.getMonth()-1,1).getTime();return {start:prev,end:cur};}
  const cur=weekStartTs(act.anchor||1,ts);return {start:cur-7*864e5,end:cur};
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
function rangeStats(start,end,targetType,target){
  let vitality=0,achievement=0,progressTotal=0,checkins=0,newTasks=0,newDomains=0;
  const progressByDomain={};
  const progressByTask={};
  state.logs.forEach(l=>{
    if(l.time<start||l.time>=end)return;
    if(!logMatchesTarget(l,targetType,target))return;
    if(logHasType(l,'vitality'))vitality+=logAmt(l,'vitality');
    if(logHasType(l,'progress')){
      const pAmt=logAmt(l,'progress');
      progressTotal+=pAmt;
      const dids=logDomainsOf(l);
      if(dids.length){
        const share=pAmt/dids.length;
        dids.forEach(d=>{progressByDomain[d]=(progressByDomain[d]||0)+share;});
      }else{
        progressByDomain['d_default']=(progressByDomain['d_default']||0)+pAmt;
      }
      if(l.taskId)progressByTask[l.taskId]=(progressByTask[l.taskId]||0)+pAmt;
    }
    if(l.st==='achievement')achievement+=l.amt;
    if(l.src==='checkin')checkins++;
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
function condWindowByRange(range,act,ts,days){
  if(range==='today'){const s=dayStartTs(ts);return {start:s,end:s+864e5};}
  if(range==='recent'){const d=Math.max(1,Math.round(Number(days)||7));return {start:ts-d*864e5,end:ts};}
  return prevPeriodRange(act,ts);
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
  const w=range==='total'?{start:0,end:ts+1}:condWindowByRange(range,act,ts,it.days);
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
function applyResult(act,ts){
  const items=(act.result&&act.result.items)||[];
  let grantedAny=false;
  const txr=Ledger.txn(function(){
    items.forEach(it=>{
      if(!it)return;
      if(it.type==='card'){
        const card=it.card||'exemption';
        const cap=Math.max(1,Math.round(it.cap||1));
        const amount=Math.max(0,Math.round(it.amount||0));
        const before=state.cards[card]||0;
        if(amount>0&&before<cap){
          const granted=Math.min(cap,before+amount)-before;
          if(granted>0){
            Ledger.post({op:'grant',account:'card:'+card,delta:granted,entry:{st:'',amt:0,desc:'周期活动「'+act.name+'」发放 '+granted+' 张'+cardName(card),src:'card-grant',dom:'',actId:act.id,granted:granted},reason:{src:'card-grant'}});
            grantedAny=true;
          }
        }
      }else if(it.type==='progress'){
        const amt=Number(it.amount)||0;
        if(amt>0){
          if(it.domainId){
            Ledger.post({op:'grant',account:'progress:'+it.domainId,delta:amt,entry:{st:'progress',amt:amt,desc:'「'+act.name+'」奖励 '+domainName(it.domainId)+' 进度',src:'reward',dom:it.domainId,actId:act.id},reason:{src:'reward'}});
          }else{
            const dids=state.domains.map(d=>d.id);
            Ledger.postSplits({splits:[{domainIds:dids,delta:amt}],entry:{st:'progress',amt:amt,desc:'「'+act.name+'」奖励 进度（全领域）',src:'reward',dom:'',actId:act.id},reason:{src:'reward'}});
          }
          grantedAny=true;
        }
      }else if(it.type==='vitality'){
        const amt=Number(it.amount)||0;
        if(amt>0){
          const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
          const lbl=tName?('「'+tName+'」活力'):'活力';
          Ledger.post({op:'grant',account:'vitality',delta:amt,entry:{st:'vitality',amt:amt,desc:'「'+act.name+'」奖励 '+lbl+' +'+fmt(amt),src:'reward',dom:'',actId:act.id,taskId:it.taskId||''},reason:{src:'reward'}});
          grantedAny=true;
        }
      }else if(it.type==='achievement'){
        const amt=Number(it.amount)||0;
        if(amt>0){
          Ledger.post({op:'grant',account:'achievement',delta:amt,entry:{st:'achievement',amt:amt,desc:'「'+act.name+'」奖励 成果 +'+fmt(amt),src:'reward',dom:'',actId:act.id},reason:{src:'reward'}});
          grantedAny=true;
        }
      }
    });
    if(grantedAny)checkAchievements();
  },{label:'activity-reward',save:'none',render:false});
  return txr.ok;
}
function processActivities(silent=false){
  if(!state.activities)state.activities=[];
  const ts=Date.now();
  let changed=false;
  state.activities.forEach(act=>{
    if(!act.enabled)return;
    const key=periodKey(act,ts);
    if(act.lastRun===key)return;
    if(evalCondition(act,ts))applyResult(act,ts);
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
  // 统一以 silent 模式执行各处理器，最后只写盘一次
  processActivities(true);
  processDailyTaskDebts(true);
  processMetabolism(true);
  processLoansWithDecayReserve();
  processChoreDecay(true);
  save();
  scheduleRender();
}

// ===== Score Engine =====
function calcCheckIn(task){
  // Determine calendar-day gap since last check-in
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // Determine streak state
  let curStreak=task.streak||0;
  if(curStreak===0&&!isFirst)curStreak=1;
  
  let newStreak, broken=false;
  if(isFirst){
    newStreak=1;                       // first ever check-in
  }else if(gapDays<=0){
    newStreak=curStreak;               // same day — streak unchanged
  }else if(gapDays===1){
    newStreak=curStreak+1;             // consecutive next day — streak grows
  }else{
    newStreak=1; broken=true;          // gap ≥ 2 — streak resets
  }

  // Interest bonus: grows with consecutive-day streak
  const bonus=task.initialValue*(task.interestRate/100)*Math.max(0,newStreak-1);
  const gross=task.initialValue+bonus;

  // Debt: subtract accumulated pendingDebt from the earnable amount.
  // If net goes negative, the excess is deducted from total scores at check-in.
  const pendingDebt=task.pendingDebt||0;
  const net=gross-pendingDebt;

  return{gross:gross,bonus:bonus,debt:pendingDebt,net:net,gapDays:gapDays,newStreak:newStreak,broken:broken,isFirst:isFirst,curStreak:curStreak};
}

// Calculate what happens if the user does NOT check in today
// Shows the pending debt that will reduce next check-in's earnable amount
function calcSkip(task){
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // If first check-in or same day, skipping today has no penalty yet
  if(isFirst||gapDays<=0){
    return{debt:0,gapAfterSkip:1,desc:'今日未打卡，明日开始累积待扣债'};
  }

  const gapAfterSkip=gapDays+1;
  const dailyDebt=task.initialValue*(task.debtRate/100);
  const currentPending=task.pendingDebt||0;

  if(gapDays===1){
    // Checked in yesterday, skipping today → tomorrow gap=2, first debt day
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，连胜中断'};
    }
  }else{
    // Already in debt period (gap >= 2), another day adds more
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天'};
    }
  }
}

function checkIn(taskId,stageIdx){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  if(t.archived){toast('该任务已归档，请先解锁','err');return}
  const types=taskScoreTypes(t);
  const hasV=types.indexOf('vitality')>=0;
  const hasP=types.indexOf('progress')>=0;
  const name=hasV&&hasP?'活力点+进度值':(hasP?'进度值':'活力点');
  const st=hasV&&hasP?'both':(hasP?'progress':'vitality');
  const cost=t.vitalityCost||0;

  // streak 由 calcCheckIn 计算（各档位共享同一连击）
  const c=calcCheckIn(t);
  const staged=taskIsStaged(t);

  // 阶段任务按选中档位结算；否则保持单档结算（初始值 + 连胜 - 债务）
  // 记录打卡前的档位，便于撤销时恢复
  const prevStageLast=(staged&&t.stageRewards&&typeof t.stageRewards.last==='number')?t.stageRewards.last:null;

  let netV=0,netP=0,stageName=null;
  if(staged){
    const cell=(typeof stageIdx==='number')?Math.max(0,Math.min(9,Math.round(stageIdx))):stageSel(t);
    if(t.stageRewards)t.stageRewards.last=cell;
    netV=hasV?stageNetAt(t,'vitality',cell,c):0;
    netP=hasP?stageNetAt(t,'progress',cell,c):0;
    stageName=stageCellLabel(cell);
  }else{
    netV=hasV?c.net:0;
    netP=hasP?c.net:0;
  }

  // Allow check-in even with insufficient vitality (goes negative, consistent with loan system)
  if(cost>0&&state.scores.vitality<cost){
    toast('活力点不足，将进入负值（贷款）','warn');
  }

  const txr=Ledger.txn(function(){
    // Save previous state for undo
    const prevStreak=t.streak||0;
    const prevLastCheckIn=t.lastCheckIn||null;
    const prevLastDebtDate=t.lastDebtDate||null;
    const prevPendingDebt=t.pendingDebt||0;

    // Create the check-in log entry ID first so cost log can link to it
    const checkinLogId=uid();

    // Deduct vitality cost (linked to the check-in log for undo)
    if(cost>0){
      Ledger.spend('vitality',cost,{src:'cost',desc:'「'+t.name+'」消耗活力点',taskId:t.id,link:checkinLogId});
    }

    const dids=getTaskDomainIds(t);
    t.lastCheckIn=now();
    t.checkInCount=(t.checkInCount||0)+1;
    t.totalEarned=(t.totalEarned||0)+(hasP?netP:netV);
    t.streak=c.newStreak;
    delete t.lastDebtDate; // reset daily debt tracking after check-in
    t.pendingDebt=0; // clear accumulated debt after check-in

    let desc='「'+t.name+'」打卡';
    if(staged&&stageName){
      desc+=' · '+stageName;
      if(hasV&&hasP)desc+=' (活力+'+fmt(netV)+' / 进度+'+fmt(netP)+')';
      else desc+=' (+'+fmt(hasP?netP:netV)+')';
    }else{
      if(c.bonus>0)desc+=' (连胜'+c.newStreak+'天 +'+fmt(c.bonus)+')';
      if(c.debt>0)desc+=' (抵扣待扣债-'+fmt(c.debt)+')';
    }
    if(cost>0)desc+=' (消耗活力-'+fmt(cost)+')';

    // Manually insert with known ID for linking, plus undo metadata
    const entry={id:checkinLogId,time:now(),st:st,amt:0,desc:desc,src:'checkin',dom:dids.join(','),taskId:t.id,prevStreak:prevStreak,prevLastCheckIn:prevLastCheckIn,prevLastDebtDate:prevLastDebtDate,prevPendingDebt:prevPendingDebt,prevStageLast:prevStageLast};
    if(hasV&&hasP&&netV!==netP){
      entry.amtV=netV;entry.amtP=netP;entry.amt=netV;
    }else{
      entry.amt=hasP?netP:netV;
    }
    const splits=[];
    if(hasV)splits.push({account:'vitality',delta:netV});
    if(hasP)splits.push({domainIds:dids,delta:netP});
    Ledger.postSplits({splits:splits,entry:entry,reason:{src:'checkin',desc:desc,dom:dids.join(',')}});
    // 活跃度索引的唯一写入点：打卡流水写入之后（事务内，回滚由 Ledger 统一处理）
    noteCheckinActivity(dids,1);

    if(hasP){
      dids.forEach(did=>checkAchievements(did));
    }
    // 先跑各处理器（不各自写盘），最后统一保存一次
    processDailyTaskDebts(true);
    processLoansWithDecayReserve();
  },{label:'checkin',save:'none',render:false});
  if(!txr.ok)return;
  save();

  let toastMsg;
  if(staged&&stageName){
    if(hasV&&hasP)toastMsg=t.name+' '+stageName+' +'+fmt(netV)+'活力 / +'+fmt(netP)+'进度';
    else toastMsg=t.name+' '+stageName+' +'+fmt(hasP?netP:netV)+' '+name;
  }else{
    const sign=c.net>=0?'+':'';
    toastMsg=t.name+' '+sign+fmt(c.net)+' '+name;
  }
  if(c.newStreak>1)toastMsg+=' (连胜'+c.newStreak+'天)';
  if(c.broken)toastMsg+=' (连胜中断)';
  if(cost>0)toastMsg+=' (-'+fmt(cost)+' 活力)';
  toast(toastMsg);
  render();
}

function useExemption(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  const cfg=exemptionActivity();
  if(!cfg||!cfg.enabled){toast('断更豁免卡活动已停用','err');return;}
  if((state.cards.exemption||0)<=0){toast('没有可用豁免卡','err');return;}
  const today=new Date();today.setHours(0,0,0,0);
  const lastEff=effectiveLastTs(t);
  const prev=new Date(lastEff);prev.setHours(0,0,0,0);
  const gapDays=Math.round((today-prev)/864e5);
  // Already checked in today?
  if(t.lastCheckIn){
    const lc=new Date(t.lastCheckIn);lc.setHours(0,0,0,0);
    if(lc.getTime()>=today.getTime()){toast('今日已打卡，无需豁免','warn');return;}
  }
  // Already exempted today?
  if(t.lastExempt){
    const le=new Date(t.lastExempt);le.setHours(0,0,0,0);
    if(le.getTime()>=today.getTime()){toast('今日已豁免','warn');return;}
  }

  const prevLastExempt=t.lastExempt||null;
  const prevPendingDebt=t.pendingDebt||0;
  const prevLastDebtDate=t.lastDebtDate||null;
  const wasBroken=gapDays>=2;

  Ledger.post({op:'spend',account:'card:exemption',delta:-1,visible:false,reason:{src:'exempt-use'}});
  t.lastExempt=today.getTime()+864e5-1000; // end of today
  t.pendingDebt=0;
  delete t.lastDebtDate;

  Ledger.event('「'+t.name+'」使用断更豁免卡'+(wasBroken?'（补救）':'（请假）'),'exempt',{taskId:t.id,prevLastExempt:prevLastExempt,prevPendingDebt:prevPendingDebt,prevLastDebtDate:prevLastDebtDate});
  processDailyTaskDebts(true);
  save();
  toast('已使用断更豁免卡'+(wasBroken?'，待扣债已清零':''));
  render();
}

function checkAchievements(domId){
  state.achievements.forEach(a=>{
    if(domId&&a.domainId!==domId)return;
    const prog=domainProgress(a.domainId);
    if(!a.unlocked&&prog>=a.threshold){
      a.unlocked=true;
      a.unlockedAt=now();
      Ledger.grant('achievement',a.points,{src:'achievement',desc:'里程碑「'+a.name+'」解锁',dom:a.domainId,achId:a.id});
      toast('成就解锁：'+a.name+' (+'+a.points+' 成果点)','warn');
    }
  });
}

// ===== Collections =====
function addCollection(){
  const inp=document.getElementById('collAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入集合名称','err');return}
  state.collections.push({id:uid(),name:name});
  Ledger.event('创建集合「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('collAdd').style.display='none';
  toast('集合「'+name+'」已创建');
  render();
}
function delCollection(id){
  const c=state.collections.find(x=>x.id===id);
  if(!c)return;
  if(id==='c_default'){toast('默认集合不可删除','err');return}
  const inColl=state.tasks.filter(t=>t.collectionId===id).length;
  if(!confirm('删除集合「'+c.name+'」？'+(inColl?'其中 '+inColl+' 个任务将移至默认集合。':'')))return;
  // Save affected tasks for undo
  const affectedTasks=state.tasks.filter(t=>t.collectionId===id).map(t=>({id:t.id,prevCollectionId:id}));
  // reassign tasks to default
  state.tasks.forEach(t=>{if(t.collectionId===id)t.collectionId='c_default'});
  // Save collection position for undo
  const collIndex=state.collections.indexOf(c);
  const collCopy=clone(c);
  state.collections=state.collections.filter(x=>x.id!==id);
  Ledger.event('删除集合「'+c.name+'」','delete-coll',{collCopy:collCopy,collIndex:collIndex,affectedTasks:affectedTasks});
  commit('集合已删除，任务已移至默认');
}
function renameCollection(id){
  const c=state.collections.find(x=>x.id===id);
  if(!c)return;
  const name=promptName('重命名集合：',c.name,20,function(n){return state.collections.some(x=>x.id!==id&&x.name===n);});
  if(name===null)return;
  c.name=name;
  commit();
}

// ===== Domains =====
function addDomain(){
  const inp=document.getElementById('domAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入领域名称','err');return}
  const id=uid();
  state.domains.push({id:id,name:name,createdAt:now()});
  state.scores.progress[id]=0;
  Ledger.event('创建领域「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('domAddInline').style.display='none';
  toast('领域「'+name+'」已创建');
  render();
}
function delDomain(id){
  const d=state.domains.find(x=>x.id===id);
  if(!d)return;
  if(id==='d_default'){toast('默认领域不可删除','err');return}
  if(!confirm('删除领域「'+d.name+'」？\n（进度值将合并至默认领域，可在银行流水撤销此操作）'))return;
  const domIndex=state.domains.indexOf(d);
  const domCopy=clone(d);

  // Save affected tasks for undo
  const affectedTasks=[];
  state.tasks.forEach(t=>{
    const dids=getTaskDomainIds(t);
    if(dids.includes(id)){
      affectedTasks.push({id:t.id,prevDomainIds:clone(t.domainIds||[]),prevDomainId:t.domainId||null});
      const newDids=dids.filter(x=>x!==id);
      if(newDids.length===0)newDids.push('d_default');
      t.domainIds=newDids;
      delete t.domainId;
    }
  });

  // Save affected achievements for undo
  const affectedAchs=[];
  state.achievements.forEach(a=>{
    if(a.domainId===id){
      affectedAchs.push({id:a.id,prevDomainId:id});
      a.domainId='d_default';
    }
  });

  // merge progress into default
  const progressVal=state.scores.progress[id]||0;
  Ledger.post({op:'grant',account:'progress:d_default',delta:progressVal,visible:false,reason:{src:'delete-domain'}});
  // 账户按 0 归零后移除键，等价于原来的 delete
  if(id in state.scores.progress)Ledger.post({op:'adjust',account:'progress:'+id,target:0,visible:false,reason:{src:'delete-domain'}});
  delete state.scores.progress[id];

  state.domains=state.domains.filter(x=>x.id!==id);
  Ledger.event('删除领域「'+d.name+'」','delete-domain',{domCopy:domCopy,domIndex:domIndex,progressVal:progressVal,affectedTasks:affectedTasks,affectedAchs:affectedAchs});
  checkAchievements();
  save();
  toast('领域已删除，进度已合并至默认');
  render();
}
function renameDomain(id){
  const d=state.domains.find(x=>x.id===id);
  if(!d)return;
  const name=promptName('重命名领域：',d.name,20,function(n){return state.domains.some(x=>x.id!==id&&x.name===n);});
  if(name===null)return;
  d.name=name;
  commit();
}

// ===== Task CRUD =====
let pendingTaskSave=null;
function saveTaskData(data){
  const recalc=data.recalc;
  delete data.recalc; // don't store on task object
  
  if(data.id){
    const t=state.tasks.find(x=>x.id===data.id);
    if(!t)return;

    // 领域变更：让用户选择历史累计分数与流水的处理方式
    const oldDids=getTaskDomainIds(t);
    const newDids=data.domainIds||['d_default'];
    const oldSet=new Set(oldDids);
    const newSet=new Set(newDids);
    const domainChanged=oldDids.some(d=>!newSet.has(d))||newDids.some(d=>!oldSet.has(d));
    if(!recalc&&domainChanged){
      pendingTaskSave={taskId:t.id,data:data,oldDids:oldDids,newDids:newDids};
      const msg=document.getElementById('domainChangeMsg');
      if(msg){
        msg.textContent='任务「'+data.name+'」的领域由「'+oldDids.map(domainName).join('、')+'」变更为「'+newDids.map(domainName).join('、')+'」。请选择历史累计分数与流水的处理方式：';
      }
      openModal('domainChangeModal');
      return false;
    }

    finalizeTaskSave(t,data,{
      recalc:recalc,
      domainMode:(recalc&&domainChanged)?'recalc':null,
      oldDids:oldDids,
      newDids:newDids
    });
    return true;
  }else{
    const nt={
      id:uid(),name:data.name,description:data.description||'',scoreTypes:data.scoreTypes||['vitality'],
      domainIds:data.domainIds||['d_default'],collectionId:data.collectionId||'c_default',
      initialValue:data.initialValue,interestRate:data.interestRate,debtRate:data.debtRate,
      vitalityCost:data.vitalityCost||0,
      lastCheckIn:null,checkInCount:0,totalEarned:0,streak:0,createdAt:now(),archived:false
    };
    if(data.stageRewards)nt.stageRewards=data.stageRewards;
    state.tasks.push(nt);
    Ledger.event('创建任务「'+data.name+'」','create');
    save();
    return true;
  }
}

// 领域变更弹窗的两个选项
function resolveDomainChange(mode){
  const p=pendingTaskSave;
  pendingTaskSave=null;
  closeModal('domainChangeModal');
  if(!p)return;
  const t=state.tasks.find(x=>x.id===p.taskId);
  if(!t)return;
  finalizeTaskSave(t,p.data,{recalc:false,domainMode:mode,oldDids:p.oldDids,newDids:p.newDids});
  closeModal('taskModal');
  toast('任务已更新（'+(mode==='migrate'?'连同历史迁移':'仅影响未来')+'）');
  render();
}
function cancelDomainChange(){
  pendingTaskSave=null;
  closeModal('domainChangeModal');
}

function finalizeTaskSave(t,data,opts){
  if(opts.recalc){
    recalcTaskHistory(t,data);
  }else if(opts.domainMode==='migrate'){
    // 1) 该任务的全部打卡流水改到新领域
    state.logs.forEach(l=>{
      if(l.src==='checkin'&&l.taskId===t.id)l.dom=opts.newDids.join(',');
    });
    // 2) 累计进度值从旧领域搬到新领域（按原分摊方式等分）
    if(taskHasType(t,'progress')&&(data.scoreTypes||[]).indexOf('progress')>=0){
      const earned=t.totalEarned||0;
      if(earned!==0&&opts.oldDids.length&&opts.newDids.length){
        const oldShare=earned/opts.oldDids.length;
        opts.oldDids.forEach(did=>{
          Ledger.post({op:'grant',account:'progress:'+did,delta:-oldShare,visible:false,reason:{src:'task-domain-migrate'}});
        });
        const newShare=earned/opts.newDids.length;
        opts.newDids.forEach(did=>{
          Ledger.post({op:'grant',account:'progress:'+did,delta:newShare,visible:false,reason:{src:'task-domain-migrate'}});
        });
      }
    }
  }

  Object.assign(t,data);
  if(!data.stageRewards)delete t.stageRewards;
  if(opts.domainMode){
    const modeLabel=opts.domainMode==='migrate'?'连同历史迁移':(opts.domainMode==='future'?'仅影响未来':'重算历史');
    Ledger.event('任务「'+data.name+'」领域变更：'+modeLabel,'task-domain',{taskId:t.id,oldDomains:opts.oldDids,newDomains:opts.newDids,mode:opts.domainMode});
  }
  Ledger.event('修改任务「'+data.name+'」','edit');
  save();
}

// Replay all check-in logs for a task using new parameters
function recalcTaskHistory(t, newData){
  Ledger.txn(function(){
  // Collect all check-in logs for this task, sorted ascending by time
  const checkinLogs=state.logs.filter(l=>l.src==='checkin'&&l.taskId===t.id)
    .sort((a,b)=>a.time-b.time);
  
  if(checkinLogs.length===0)return;
  
  // Step 1: Undo all old amounts from scores
  const oldCost=t.vitalityCost||0;
  checkinLogs.forEach(log=>{
    // Undo old net amount (including 'both' check-ins)
    applyCheckinGain(log,-1);
    // Undo old vitality cost
    if(oldCost>0){
      Ledger.post({op:'grant',account:'vitality',delta:oldCost,visible:false,reason:{src:'recalc-cost'}});
    }
  });
  
  // Step 2: New parameters
  const newInitial=newData.initialValue;
  const newInterest=newData.interestRate;
  const newDebt=newData.debtRate;
  const newCost=newData.vitalityCost||0;
  const newDids=newData.domainIds||['d_default'];
  const newScoreTypes=taskScoreTypes(newData);
  
  // Step 3: Replay each check-in
  let runningStreak=0;
  let runningLastCheckIn=null;
  let totalEarned=0;
  
  checkinLogs.forEach((log,idx)=>{
    const logTime=log.time;
    let gapDays=0;
    if(runningLastCheckIn){
      const prev=new Date(runningLastCheckIn);prev.setHours(0,0,0,0);
      const curr=new Date(logTime);curr.setHours(0,0,0,0);
      gapDays=Math.round((curr-prev)/864e5);
    }
    
    const isFirst=(idx===0&&!runningLastCheckIn);
    let newStreak, broken=false;
    if(isFirst){
      newStreak=1;
    }else if(gapDays<=0){
      newStreak=runningStreak||1;
    }else if(gapDays===1){
      newStreak=runningStreak+1;
    }else{
      newStreak=1; broken=true;
    }
    
    const bonus=newInitial*(newInterest/100)*Math.max(0,newStreak-1);
    const gross=newInitial+bonus;
    // Debt: pendingDebt reduces earnable amount at check-in; not tracked in replay
    const debt=0;
    const net=gross-debt;
    
    // Apply new net to scores (distribute across new domains)
    if(newScoreTypes.indexOf('vitality')>=0)Ledger.post({op:'grant',account:'vitality',delta:net,visible:false,reason:{src:'recalc'}});
    let newParts=null;
    if(newScoreTypes.indexOf('progress')>=0){
      newParts=splitCents(net,newDids.length);
      newDids.forEach((did,i)=>{
        Ledger.post({op:'grant',account:'progress:'+did,delta:newParts[i],visible:false,reason:{src:'recalc'}});
      });
    }
    
    if(newCost>0){
      Ledger.post({op:'grant',account:'vitality',delta:-newCost,visible:false,reason:{src:'recalc-cost'}});
    }
    
    // Update log entry（清除旧的双分值字段，避免统计仍读到旧值）
    delete log.amtV;delete log.amtP;
    log.amt=net;
    log.st=(newScoreTypes.indexOf('vitality')>=0&&newScoreTypes.indexOf('progress')>=0)?'both':(newScoreTypes.indexOf('progress')>=0?'progress':'vitality');
    log.dom=newScoreTypes.indexOf('progress')>=0?newDids.join(','):'';
    // 重放后刷新分配明细，保证后续撤销仍能逐领域精确反向
    if(newParts)log.splits=newDids.map((did,i)=>({dom:did,amt:newParts[i]}));
    else delete log.splits;
    let desc='「'+newData.name+'」打卡';
    if(bonus>0)desc+=' (连胜'+newStreak+'天 +'+fmt(bonus)+')';
    if(newCost>0)desc+=' (消耗活力-'+fmt(newCost)+')';
    log.desc=desc;
    log.prevStreak=runningStreak;
    log.prevLastCheckIn=runningLastCheckIn;
    
    // Update linked cost log if exists
    if(oldCost>0||newCost>0){
      const costLog=state.logs.find(l=>(l.link||'')===log.id);
      if(costLog){
        if(newCost>0){
          costLog.amt=-newCost;
          costLog.desc='「'+newData.name+'」消耗活力点';
        }else{
          Ledger.removeLogs(l=>l.id!==costLog.id);
        }
      }else if(newCost>0&&oldCost===0){
        Ledger.append({id:uid(),time:logTime,st:'vitality',amt:-newCost,desc:'「'+newData.name+'」消耗活力点',src:'cost',dom:'',taskId:t.id,link:log.id});
      }
    }
    
    totalEarned+=net;
    runningStreak=newStreak;
    runningLastCheckIn=logTime;
  });
  
  // Step 4: Update task state
  t.streak=runningStreak;
  t.lastCheckIn=runningLastCheckIn;
  t.totalEarned=totalEarned;
  t.checkInCount=checkinLogs.length;
  
  // Re-check achievements for affected domain(s)
  if(newScoreTypes.indexOf('progress')>=0){
    newDids.forEach(did=>checkAchievements(did));
  }
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  },{label:'recalc',save:'none',render:false});
}
function delTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(!t)return;
  const taskIndex=state.tasks.indexOf(t);
  const taskCopy=clone(t);

  // Move earned progress to default domain so it isn't orphaned
  let progressMoved=null;
  if(taskHasType(t,'progress')&&(t.totalEarned||0)!==0){
    const dids=getTaskDomainIds(t);
    const share=t.totalEarned/dids.length;
    const fromDomains=dids.map(did=>({did:did,amount:share}));
    dids.forEach(did=>{
      Ledger.post({op:'grant',account:'progress:'+did,delta:-share,visible:false,reason:{src:'delete-task'}});
    });
    Ledger.post({op:'grant',account:'progress:d_default',delta:t.totalEarned,visible:false,reason:{src:'delete-task'}});
    progressMoved={fromDomains:fromDomains,totalMoved:t.totalEarned};
  }

  state.tasks=state.tasks.filter(x=>x.id!==id);
  Ledger.event('删除任务「'+t.name+'」','delete-task',{taskCopy:taskCopy,taskIndex:taskIndex,progressMoved:progressMoved});
  checkAchievements();
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  save();
}

// ===== Achievement CRUD =====
function saveAchData(data){
  if(data.id){
    const a=state.achievements.find(x=>x.id===data.id);
    if(!a)return;
    Object.assign(a,data);
  }else{
    state.achievements.push({
      id:uid(),name:data.name,domainId:data.domainId,threshold:data.threshold,
      points:data.points,unlocked:false,unlockedAt:null
    });
    Ledger.event('设定里程碑「'+data.name+'」','create');
  }
  save();
  checkAchievements(data.domainId);
}
function delAch(id){
  const a=state.achievements.find(x=>x.id===id);
  if(!a)return;
  const achIndex=state.achievements.indexOf(a);
  const achCopy=clone(a);
  // Don't subtract achievement points — they were earned and should be kept
  state.achievements=state.achievements.filter(x=>x.id!==id);
  Ledger.event('删除里程碑「'+a.name+'」','delete-ach',{achCopy:achCopy,achIndex:achIndex});
  save();
}

// ===== Metric (Radar) CRUD =====
function openMetricModal(id){
  const m=id?state.metrics.find(x=>x.id===id):null;
  document.getElementById('metricId').value=id||'';
  document.getElementById('metricModalTitle').textContent=id?'编辑指标':'自定义指标';
  document.getElementById('metricName').value=m?m.name:'';
  fillDomainChecklist(document.getElementById('metricDomainList'),m?(m.domainIds||[]):['d_default']);
  openModal('metricModal');
  setTimeout(()=>document.getElementById('metricName').focus(),50);
}
function getCheckedMetricDomains(){
  const ids=[];
  document.querySelectorAll('#metricDomainList .dom-check input:checked').forEach(cb=>ids.push(cb.value));
  return ids;
}
function handleMetricSave(){
  const id=document.getElementById('metricId').value;
  const name=document.getElementById('metricName').value.trim();
  const domainIds=getCheckedMetricDomains();
  if(!name){toast('请输入指标名称','err');return}
  if(!domainIds.length){toast('请至少选择一个领域','err');return}
  if(id){
    const m=state.metrics.find(x=>x.id===id);
    if(!m)return;
    m.name=name;m.domainIds=domainIds;
  }else{
    state.metrics.push({id:uid(),name:name,domainIds:domainIds});
  }
  save();
  closeModal('metricModal');
  toast(id?'指标已更新':'指标已添加');
  render();
}
function delMetric(id){
  const m=state.metrics.find(x=>x.id===id);
  if(!m)return;
  if(!confirm('删除指标「'+m.name+'」？'))return;
  state.metrics=state.metrics.filter(x=>x.id!==id);
  save();
  render();
}

// ===== Shop Categories =====
function addShopCategory(){
  const inp=document.getElementById('shopCatAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入分类名称','err');return}
  state.shopCategories.push({id:uid(),name:name});
  Ledger.event('创建商品分类「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('shopCatAdd').style.display='none';
  toast('分类「'+name+'」已创建');
  render();
}
function delShopCategory(id){
  const c=state.shopCategories.find(x=>x.id===id);
  if(!c)return;
  if(id==='sc_default'){toast('默认分类不可删除','err');return}
  if(!confirm('删除商品分类「'+c.name+'」？\n（商品将移至默认分类，可在银行流水撤销此操作）'))return;
  const catIndex=state.shopCategories.indexOf(c);
  const catCopy=clone(c);
  const affectedProducts=[];
  state.products.forEach(p=>{
    if(p.categoryId===id){
      affectedProducts.push({id:p.id,prevCategoryId:id});
      p.categoryId='sc_default';
    }
  });
  state.shopCategories=state.shopCategories.filter(x=>x.id!==id);
  Ledger.event('删除商品分类「'+c.name+'」','delete-shopcat',{catCopy:catCopy,catIndex:catIndex,affectedProducts:affectedProducts});
  save();
  toast('分类已删除，商品已移至默认');
  render();
}
function renameShopCategory(id){
  const c=state.shopCategories.find(x=>x.id===id);
  if(!c)return;
  const name=promptName('重命名分类：',c.name,20,function(n){return state.shopCategories.some(x=>x.id!==id&&x.name===n);});
  if(name===null)return;
  c.name=name;
  commit();
}
function fillShopCatSelect(sel,selected){fillSelect(sel,state.shopCategories,selected);}

// ===== Product CRUD =====
function productGateContext(){
  return{
    domainIds:new Set(state.domains.map(function(d){return d.id;})),
    achIds:new Set(state.achievements.map(function(a){return a.id;}))
  };
}
function saveProdData(data){
  const tier=validProductTier(data.tier);
  const gate=normalizeProductGate(data.gate,productGateContext());
  const currency=tierCurrency(tier);
  if(data.id){
    const p=state.products.find(x=>x.id===data.id);
    if(!p)return;
    Object.assign(p,data,{tier:tier,gate:gate,currency:currency});
  }else{
    state.products.push({
      id:uid(),name:data.name,desc:data.desc,currency:currency,
      tier:tier,gate:gate,
      price:data.price,stock:data.stock,categoryId:data.categoryId||'sc_default',
      debtRate:data.debtRate||0,
      sold:0,createdAt:now()
    });
    Ledger.event('上架商品「'+data.name+'」','create');
  }
  save();
}
function delProd(id){
  const p=state.products.find(x=>x.id===id);
  if(!p)return;
  const prodIndex=state.products.indexOf(p);
  const prodCopy=clone(p);
  state.products=state.products.filter(x=>x.id!==id);
  Ledger.event('删除商品「'+p.name+'」','delete-prod',{prodCopy:prodCopy,prodIndex:prodIndex});
  save();
}
function buyProduct(id){
  const p=state.products.find(x=>x.id===id);
  if(!p)return;
  if(p.stock===0){toast('已售罄','err');return}
  const tier=validProductTier(p.tier);
  const cur=tierCurrency(tier);
  const cn=cur==='vitality'?'活力点':'成果点';
  const balance=state.scores[cur];
  const willLoan=balance<p.price;
  const loanAmt=willLoan?(p.price-balance):0;
  const loanId=uid();

  const txr=Ledger.txn(function(){
    // 唯一门槛判定点：策略拒绝抛事务错误，由 txn 统一回滚
    Ledger.checkPurchase(p);
    if(willLoan)Ledger.post({op:'grant',account:cur,delta:loanAmt,visible:false,reason:{src:'loan-draw'}});
    if(p.stock>0)p.stock--;
    p.sold=(p.sold||0)+1;

    let desc='购买「'+p.name+'」';
    if(willLoan){
      desc+=' (贷款'+fmt(loanAmt)+' '+cn+')';
      Ledger.liability.open({
        id:loanId,amount:loanAmt,debtRate:p.debtRate||0,currency:cur,
        productId:p.id,productName:p.name,reason:{src:'purchase'}
      });
    }
    Ledger.spend(cur,p.price,{src:'purchase',desc:desc,prodId:p.id,loanId:willLoan?loanId:'',loanAmt:willLoan?loanAmt:0});
    processDailyTaskDebts(true);
    processLoansWithDecayReserve();
  },{label:'buyProduct',save:'none',render:false});
  if(!txr.ok){
    const info=(txr.error&&txr.error.info)||{};
    if(txr.error&&txr.error.code==='PURCHASE_DENIED')toast(info.reason||'购买条件未满足','err');
    return;
  }
  save();
  toast('已购买：'+p.name+' (-'+fmt(p.price)+' '+cn+')'+(willLoan?' · 贷款'+fmt(loanAmt):''));
  render();
}

// ===== Daily task debt processing =====
// Accumulates pending debt on each task (does NOT deduct from total scores).
// Debt is only applied at check-in time, reducing the earnable amount.
// If net (gross - pendingDebt) goes negative, the excess is deducted from total scores.
function processDailyTaskDebts(silent=false){
  const today=new Date();today.setHours(0,0,0,0);

  state.tasks.forEach(task=>{
    if(task.archived)return; // 归档任务不参与打卡与债务累积
    if(task.debtRate<=0)return;
    if(!task.lastCheckIn)return;

    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const gapDays=Math.round((today-prev)/864e5);

    // Only accumulate debt if streak is broken (gap >= 2 days)
    if(gapDays<2)return;

    // Calculate how many debt days have already been accumulated
    let lastDebtDay;
    if(task.lastDebtDate){
      lastDebtDay=new Date(task.lastDebtDate);lastDebtDay.setHours(0,0,0,0);
    }else{
      // First time: debt starts from the day after lastCheckIn
      lastDebtDay=new Date(prev.getTime()+864e5);
    }

    const daysSince=Math.round((today-lastDebtDay)/864e5);
    if(daysSince<=0)return;

    // Accumulate to pendingDebt (don't touch total scores)
    const dailyDebt=task.initialValue*(task.debtRate/100);
    task.pendingDebt=(task.pendingDebt||0)+dailyDebt*daysSince;
    task.lastDebtDate=today.getTime();
  });

  if(!silent)save();
}

// ===== Metabolism (auto-archive / auto-delete) =====
// Tasks not checked in for 2+ weeks get archived; never-checked tasks get deleted after 2 weeks.
function processMetabolism(silent=false){
  const today=new Date();today.setHours(0,0,0,0);
  const twoWeeks=14*864e5;
  let changed=false;
  const toDelete=[];
  state.tasks.forEach(task=>{
    if(task.archived)return; // already archived
    const lastTs=effectiveLastTs(task);
    if(!lastTs){
      // Never checked in and never exempted: check createdAt
      const created=task.createdAt||now();
      if(today.getTime()-created>=twoWeeks){
        toDelete.push(task);
      }
      return;
    }
    const last=new Date(lastTs);last.setHours(0,0,0,0);
    if(today.getTime()-last.getTime()>=twoWeeks){
      // Has been checked in before, now inactive 2+ weeks → archive
      task.archived=true;
      task.archivedAt=now();
      changed=true;
      Ledger.event('任务「'+task.name+'」连续两周未打卡，已归档','archive',{taskId:task.id});
    }
  });
  if(toDelete.length){
    toDelete.forEach(t=>{
      Ledger.event('任务「'+t.name+'」从未打卡且超两周，已自动删除','auto-delete',{taskName:t.name});
    });
    const ids=new Set(toDelete.map(t=>t.id));
    state.tasks=state.tasks.filter(t=>!ids.has(t.id));
    changed=true;
  }
  if(changed&&!silent)save();
}
function unlockTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t||!t.archived)return;
  const cost=3;
  if((state.scores.vitality||0)<cost){toast('活力点不足（需要'+cost+'点）','err');return}
  const txr=Ledger.txn(function(){
    t.archived=false;
    delete t.archivedAt;
    // Reset streak/debt so it's a fresh start
    t.pendingDebt=0;
    delete t.lastDebtDate;
    Ledger.spend('vitality',cost,{src:'unlock',desc:'解锁归档任务「'+t.name+'」 (-'+cost+'活力)',taskId:t.id});
  },{label:'unlock',save:'none',render:false});
  if(!txr.ok)return;
  save();
  toast('已解锁「'+t.name+'」，可重新打卡');
  render();
}

// ===== Loan processing (daily interest) =====
// silent：不单独写盘（由调用方统一 commit）
// reserveVitality：还贷前先预留「当天已腐化但尚未入账」的活力点，避免用这笔钱还贷
function processLoans(silent=false,reserveVitality=0){
  Ledger.txn(function(){
    if(!state.loans)state.loans=[];

    // Process daily interest if days have passed
    if(state.loans.length>0){
      const today=new Date();today.setHours(0,0,0,0);
      let lastDate;
      if(state.lastDebtDate){
        lastDate=new Date(state.lastDebtDate);lastDate.setHours(0,0,0,0);
      }else{
        lastDate=today;
      }
      const days=Math.round((today-lastDate)/864e5);
      if(days>0){
        state.loans.slice().forEach(function(loan){
          if(loan.debtRate<=0)return;
          // 复利按天换算为一次幂运算，避免按天循环
          Ledger.liability.mutate(loan.id,function(before){return before*Math.pow(1+loan.debtRate/100,days);},{src:'loan-interest'});
        });
        state.lastDebtDate=today.getTime();
      }
    }else{
      state.lastDebtDate=now();
    }

    // Auto-pay loans when balance is sufficient (always check)
    if(state.loans.length>0){
      const reserve=(typeof reserveVitality==='number'&&isFinite(reserveVitality))?Math.max(0,reserveVitality):0;
      state.loans.slice().forEach(function(loan){
        const avail=(state.scores[loan.currency]||0)-(loan.currency==='vitality'?reserve:0);
        if(avail>=loan.amount){
          Ledger.spend(loan.currency,loan.amount,{src:'loan-repay',desc:'偿还贷款「'+loan.productName+'」',loanId:loan.id,loanCopy:clone(loan)});
          Ledger.liability.close(loan.id,{src:'loan-repay'});
        }
      });
    }
  },{label:'loans',save:silent?'none':'debounce',render:false});
}
// 还贷前统一按当天腐化总额预留（不改变 processLoans 与 processChoreDecay 的先后顺序）
function processLoansWithDecayReserve(){
  const decay=computeChoreDecay();
  processLoans(true,decay.total||0);
}

// ===== 手动修正余额（用于修复历史版本重复扣减造成的余额偏差） =====
function manualAdjustBalance(){
  const cur=window.prompt('选择货币：输入 1 = 活力点，2 = 成果点');
  if(cur===null)return;
  const c=String(cur).trim();
  let key='';
  if(c==='1'||c==='活力'||c==='活力点')key='vitality';
  else if(c==='2'||c==='成果'||c==='成果点')key='achievement';
  else{toast('无效的货币选择','err');return}
  const label=key==='vitality'?'活力点':'成果点';
  const before=state.scores[key]||0;
  const raw=window.prompt('「'+label+'」当前余额：'+fmt(before)+'\n请输入调整值（可为负数，如 -2 表示减少 2）');
  if(raw===null)return;
  if(!String(raw).trim()){toast('请输入调整值','err');return}
  const amt=Number(raw);
  if(!isFinite(amt)){toast('请输入有效数字','err');return}
  if(amt===0){toast('调整值为 0，未做修改','err');return}
  const after=Math.round((before+amt)*10000)/10000;
  const txr=Ledger.txn(function(){
    Ledger.post({
      op:'adjust',account:key,target:after,
      entry:{st:key,amt:amt,desc:'手动修正'+label+'余额 '+fmt(before)+' → '+fmt(after),src:'manual-adjust',dom:'',before:before,after:after},
      reason:{src:'manual-adjust'}
    });
  },{label:'manual-adjust',save:'none',render:false});
  if(!txr.ok)return;
  save();
  toast(label+'已修正：'+fmt(before)+' → '+fmt(after));
  render();
}

// ===== 清除数据 =====
// 只清除数据成果，保留任务/项目/杂事/商品/周期/领域/集合等全部设定
function clearDataResults(){
  state.scores={vitality:0,progress:{},achievement:0};
  state.loans=[];
  state.logs=[];
  state.cards={exemption:0};
  state.lastDebtDate=null;
  state.affairUndo={};
  state.ext.stats=newExtState().stats;
  state.ext.watermarks=newExtState().watermarks;
  state.ext.budgets={period:'week',items:[],records:[]};
  state.ext.audit=[];
  // 结果型扩展数据随清空归零；商品门槛等配置类字段保留
  state.ext.activity={};
  state.ext.achievementCounted={};

  state.tasks.forEach(t=>{
    t.checkInCount=0;
    t.streak=0;
    t.lastCheckIn=null;
    t.totalEarned=0;
    t.pendingDebt=0;
    t.archived=false;
    delete t.archivedAt;
    delete t.lastDebtDate;
    // 保留阶段奖励数值（v/p），只把当前档位归零
    if(t.stageRewards&&typeof t.stageRewards.last==='number')t.stageRewards.last=0;
  });

  state.affairs.forEach(a=>{
    a.currentCell=0;
    a.alreadyGiven=0;
    a.doneAt=null;
    a.startedAt=null;
    if(Array.isArray(a.steps))a.steps.forEach(s=>{s.doneAt=null;});
  });

  // 杂事：清空完成与腐化记录，保留杂事定义与经济配置
  (state.chores||[]).forEach(c=>{
    c.done=false;
    c.doneAt=null;
    c.settled=false;
    c.decayKey=dayKey(now()); // 腐化从今天重新起算，不追溯历史
  });
  choreDoneOpen=false;

  state.achievements.forEach(a=>{a.unlocked=false;a.unlockedAt=null;});

  state.products.forEach(p=>{
    const sold=p.sold||0;
    p.stock=(p.stock===-1||p.stock===undefined||p.stock===null)?-1:(p.stock||0)+sold;
    p.sold=0;
  });

  state.activities.forEach(act=>{act.lastRun=null;});

  closeModal('clearDataModal');
  save();
  render();
  toast('已清除数据成果，所有设定已保留');
}

// 彻底重置，效果等同于从未使用过本应用（主题设置保留）
function clearEverything(){
  state=defaults();
  affairView='list';
  affairCalCursor=null;
  affairCalSelected=null;
  affairDoneOpen=false;
  choreDoneOpen=false;
  loadIssue=null;
  // 清掉 localStorage 残留：保留损坏备份（事故恢复用），清理阶段预设与备份提醒时间
  try{localStorage.removeItem(STAGE_PRESET_KEY);}catch(e){}
  try{localStorage.removeItem(BACKUP_KEY);}catch(e){}
  stagePresets={stepPct:50,decreasePct:100};
  // 重置每日 tick 基准，避免清空后立刻被当成跨天而触发一轮结算
  _lastTickDay=dayKey(now());
  save();
  const rb=document.getElementById('recoverBar');if(rb)rb.style.display='none';
  closeModal('clearDataModal');
  render();
  toast('已清除全部设置与数据');
}

// ===== Tab =====
function goTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
}

// ===== Helpers for selects =====
function fillSelect(sel,items,selected){
  if(!sel)return;
  sel.innerHTML=items.map(function(x){
    return '<option value="'+x.id+'"'+(x.id===selected?' selected':'')+'>'+esc(x.name)+'</option>';
  }).join('');
}
function fillCollectionSelect(sel,selected){fillSelect(sel,state.collections,selected);}
function fillDomainSelect(sel,selected){fillSelect(sel,state.domains,selected);}
// Multi-select domain checklist for task modal
function fillDomainChecklist(container, selectedIds){
  const selSet=new Set(selectedIds);
  container.innerHTML=state.domains.map(d=>{
    const isSel=selSet.has(d.id);
    return '<label class="dom-check'+(isSel?' sel':'')+'" data-dom-id="'+d.id+'">'
      +'<input type="checkbox" value="'+d.id+'" '+(isSel?'checked':'')+'>'
      +'<span>'+esc(d.name)+'</span></label>';
  }).join('');
  // 事件委托（容器只绑一次）：整行点击切换勾选，勾选框自身变化同步高亮
  if(container._domCheckBound)return;
  container._domCheckBound=true;
  container.addEventListener('click',function(e){
    const lbl=e.target.closest('.dom-check');
    if(!lbl||!container.contains(lbl))return;
    if(e.target.tagName==='INPUT')return; // 勾选框本体交给原生 + change 处理
    // 阻断 label 的原生激活，避免「原生切换 + 手动反转」造成点一次翻两次
    e.preventDefault();
    const cb=lbl.querySelector('input');
    if(!cb)return;
    cb.checked=!cb.checked;
    lbl.classList.toggle('sel',cb.checked);
  });
  container.addEventListener('change',function(e){
    if(!e.target||e.target.tagName!=='INPUT')return;
    const lbl=e.target.closest('.dom-check');
    if(lbl)lbl.classList.toggle('sel',e.target.checked);
  });
}
function getCheckedDomainIds(){
  const ids=[];
  document.querySelectorAll('#taskDomainList .dom-check input:checked').forEach(cb=>ids.push(cb.value));
  return ids.length>0?ids:['d_default'];
}

// ===== Render: Work =====
// 三处分数栏（打工/银行/商店）共用的刷新逻辑
function setScoreCell(id,val){
  const el=document.getElementById(id);
  if(!el)return;
  el.textContent=fmt(val);
  el.classList.toggle('neg',val<0);
}
function renderWork(){
  setScoreCell('wVitality',state.scores.vitality);
  setScoreCell('wProgress',totalProgress());
  setScoreCell('wAchievement',state.scores.achievement);

  const domCount=state.domains.length;
  document.getElementById('wProgressSub').textContent=domCount>1?domCount+'个领域':'';

  // Domain pills (clickable to filter tasks)
  const dp=document.getElementById('domainPills');
  let dpHtml=state.domains.map(d=>{
    const val=domainProgress(d.id);
    const isActive=state.filterDomain===d.id;
    let pill='<div class="domain-pill'+(isActive?' active':'')+'" onclick="filterByDomain(\''+d.id+'\')" style="cursor:pointer"><span class="dp-dot"></span>'+esc(d.name)+' <span class="dp-val">'+fmt(val)+'</span>';
    if(d.id!=='d_default'){
      pill+='<span class="dp-mgmt" onclick="event.stopPropagation()"><button onclick="renameDomain(\''+d.id+'\')" title="重命名">✎</button><button class="dp-del" onclick="delDomain(\''+d.id+'\')" title="删除">×</button></span>';
    }
    pill+='</div>';
    return pill;
  }).join('');
  dpHtml+='<div class="domain-pill add" onclick="toggleInline(\'domAddInline\')">+ 领域</div>';
  // inline add for domain
  dpHtml+='<div class="inline-add" id="domAddInline" style="display:none;margin-top:6px;width:100%">'
    +'<input type="text" id="domAddName" placeholder="输入领域名称" maxlength="20" autocomplete="off">'
    +'<button class="btn btn-sm" onclick="addDomain()">添加</button></div>';
  dp.innerHTML=dpHtml;

  renderChores();
  renderAffairs();
  syncMajorCollapse();

  // Task groups by collection
  const tg=document.getElementById('taskGroups');
  if(!state.tasks.length){
    tg.innerHTML='<div class="empty"><p>还没有任务，创建一个开始积累分数</p><button class="btn btn-sm" onclick="openTaskModal()">新建任务</button></div>';
  }else{
    let html='';
    state.collections.forEach(c=>{
      const tasks=state.tasks.filter(t=>!t.archived&&t.collectionId===c.id&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
      const isCollapsed=(state.collapsedColls||[]).includes(c.id);
      html+='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="'+c.id+'">';
      // Header (clickable to toggle collapse)
      html+='<div class="coll-header" onclick="toggleCollapse(\'collection\',\''+c.id+'\')">';
      html+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(c.name)+' <span class="coll-count">'+tasks.length+'个任务</span></div>';
      html+='<div class="coll-actions" onclick="event.stopPropagation()">';
      html+='<span class="drag-handle" title="拖拽集合">⋮⋮</span>';
      html+='<button onclick="openTaskModal(null,\''+c.id+'\')">+ 任务</button>';
      if(c.id!=='c_default'){
        html+='<button onclick="renameCollection(\''+c.id+'\')">重命名</button><button onclick="delCollection(\''+c.id+'\')">删除</button>';
      }
      html+='</div>';
      html+='</div>';
      // Body (collapsible)
      html+='<div class="coll-body">';
      if(tasks.length===0){
        html+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无任务 · 拖拽 ⋮⋮ 按钮可排序</p></div>';
      }else{
        html+=tasks.map(t=>taskCardHTML(t,c.id)).join('');
      }
      html+='</div>';
      html+='</div>';
    });
    // Tasks without valid collection
    const noColl=state.tasks.filter(t=>!t.archived&&!state.collections.find(c=>c.id===t.collectionId)&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
    if(noColl.length){
      html+='<div class="coll-group" data-coll-id="_none"><div class="coll-header" onclick="toggleCollapse(\'collection\',\'_none\')"><div class="coll-name"><span class="coll-toggle">▼</span>未分类 <span class="coll-count">'+noColl.length+'个任务</span></div><div class="coll-actions" onclick="event.stopPropagation()"><span class="drag-handle" title="拖拽集合">⋮⋮</span></div></div>';
      html+='<div class="coll-body">'+noColl.map(t=>taskCardHTML(t,'_none')).join('')+'</div>';
      html+='</div>';
    }
    tg.innerHTML=html;
  }

  // Archive section
  const archived=state.tasks.filter(t=>t.archived);
  const am=document.getElementById('archiveMeta');
  if(am)am.textContent=archived.length?'（'+archived.length+'个任务）':'';
  const ab=document.getElementById('archiveGroups');
  if(ab){
    if(archived.length===0){
      ab.innerHTML='<div class="empty" style="padding:12px"><p style="margin:0;color:var(--text-3)">连续两周未打卡的任务将自动归档至此</p></div>';
    }else{
      const isCollapsed=(state.collapsedColls||[]).includes('_archive');
      ab.innerHTML='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="_archive">'
        +'<div class="coll-header" onclick="toggleCollapse(\'collection\',\'_archive\')">'
        +'<div class="coll-name"><span class="coll-toggle">▼</span>已归档 <span class="coll-count">'+archived.length+'个任务</span></div>'
        +'</div>'
        +'<div class="coll-body">'+archived.map(t=>{
          const cost=3;
          const canUnlock=(state.scores.vitality||0)>=cost;
          return '<div class="card" style="opacity:.7">'
            +'<div class="card-top"><div>'+(taskHasType(t,'progress')?'<span class="tag p">进度值</span>':'')+(taskHasType(t,'vitality')?'<span class="tag v">活力点</span>':'')+'<span class="card-title">'+esc(t.name)+'</span></div>'
            +'<div class="card-actions"><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div></div>'
            +'<div class="card-meta"><span>打卡 '+(t.checkInCount||0)+' 次</span><span>归档于 '+(t.archivedAt?fmtTime(t.archivedAt):'—')+'</span></div>'
            +'<div class="card-bottom"><div class="preview"><span style="color:var(--text-3)">需 '+cost+' 活力点解锁</span></div><button class="btn btn-sm btn-exempt" onclick="unlockTask(\''+t.id+'\')" '+(canUnlock?'':'disabled')+'>解锁</button></div>'
            +'</div>';
        }).join('')+'</div></div>';
    }
  }
}

// ===== 项目（原「事务」完整结构） =====
function affairSteps(a){return Array.isArray(a.steps)?a.steps.filter(function(s){return s&&s.text;}):[];}
function affairTotalSteps(a){return affairSteps(a).length;}
function affairDoneSteps(a){return affairSteps(a).filter(function(s){return s.doneAt;}).length;}
function affairLastAdvance(a){
  let ts=a.startedAt||0;
  affairSteps(a).forEach(function(s){if(s.doneAt&&s.doneAt>ts)ts=s.doneAt;});
  return ts||0;
}
function frSameDay(ts1,ts2){const a=new Date(ts1),b=new Date(ts2);return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
function fmtClock(ts){const d=new Date(ts);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function fmtPlan(ts){const d=new Date(ts);return (d.getMonth()+1)+'/'+d.getDate()+' '+fmtClock(ts);}
function fmtDateCal(ts){const d=new Date(ts),wd=['日','一','二','三','四','五','六'];return (d.getMonth()+1)+'月'+d.getDate()+'日 周'+wd[d.getDay()];}
function toLocalInput(ts){if(!ts)return '';const d=new Date(ts);const p=function(x){return String(x).padStart(2,'0');};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());}
function fromLocalInput(v){if(!v)return null;const t=new Date(v).getTime();return isNaN(t)?null:t;}
// ===== 项目奖励曲线（10 格累计比例，格 9 恒为 100）=====
const AFFAIR_CURVES={
  even:[10,20,30,40,50,60,70,80,90,100],
  lateHeavy:[2,5,10,17,26,37,50,65,82,100],
  earlyHeavy:[20,36,50,62,72,80,86,91,95,100],
  allAtEnd:[0,0,0,0,0,0,0,0,0,100]
};
const AFFAIR_CURVE_NAMES={even:'平均',lateHeavy:'后重',earlyHeavy:'前重',allAtEnd:'全押后',custom:'自定义'};
let editAffairCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
function affairCurve(a){return (a.curve&&Array.isArray(a.curve.values)&&a.curve.values.length===10)?a.curve.values:AFFAIR_CURVES.even;}
function affairCurveType(a){return (a.curve&&a.curve.type)||'even';}
function affairTargetAt(a,cell){
  const vals=affairCurve(a);
  const v=vals[cell];
  return round2(((v===undefined?100:v)/100)*(a.totalReward||0));
}
function affairIsDone(a){return !!(a.doneAt)||((a.currentCell||0)>=9);}
function affairTags(a){
  if(a.domainId)return '<span class="tag p">'+esc(domainName(a.domainId))+'</span>';
  return '<span class="tag v">活力点</span>';
}
function migrateAffair(a){
  if(!a)return a;
  if(typeof a.totalReward!=='number'||isNaN(a.totalReward))a.totalReward=0.1;
  if(typeof a.currentCell!=='number'||isNaN(a.currentCell))a.currentCell=0;
  a.currentCell=Math.max(0,Math.min(9,Math.round(a.currentCell)));
  if(typeof a.alreadyGiven!=='number'||isNaN(a.alreadyGiven))a.alreadyGiven=0;
  if(!a.curve||!Array.isArray(a.curve.values)||a.curve.values.length!==10){
    a.curve={type:'even',values:AFFAIR_CURVES.even.slice()};
  }else{
    a.curve.values=a.curve.values.map(function(v){return toNum(v);});
  }
  if(!a.curve.type)a.curve.type='custom';
  if(!a.ach||typeof a.ach!=='object')a.ach={enabled:false,amount:0};
  if(a.ach.enabled===undefined)a.ach.enabled=false;
  if(typeof a.ach.amount!=='number'||isNaN(a.ach.amount))a.ach.amount=0;
  return a;
}

// ===== 项目预设 =====
let editPresetCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
function renderAffairPresetsHTML(){
  const presets=state.affairPresets||[];
  let h='<div class="affair-presets">'
    +'<div class="affair-presets-head"><span class="affair-presets-title">预设</span>'
    +'<button class="btn btn-sm" onclick="openPresetModal()">＋ 新建预设</button></div>';
  if(presets.length){
    h+='<div class="affair-preset-chips">'+presets.map(function(p){
      return '<span class="affair-preset-chip" onclick="openPresetModal(\''+p.id+'\')">'+esc(p.name)+'<b>+'+fmt(p.totalReward)+'</b></span>';
    }).join('')+'</div>';
  }else{
    h+='<div class="affair-presets-empty">没有预设。新建后，可在新建项目时一键套用总奖励与曲线。</div>';
  }
  h+='</div>';
  return h;
}
function applyAffairPreset(){
  const sel=document.getElementById('affairPresetSel');
  const p=state.affairPresets.find(function(x){return x.id===sel.value;});
  if(!p)return;
  document.getElementById('affairReward').value=p.totalReward;
  editAffairCurve={type:p.curve.type,values:(p.curve.values||AFFAIR_CURVES.even).slice()};
  setAffairCurve(editAffairCurve.type);
  document.getElementById('affairAchEnabled').checked=!!(p.ach&&p.ach.enabled);
  document.getElementById('affairAchAmount').value=(p.ach&&p.ach.amount)?p.ach.amount:1;
  toggleAffairAch();
}
function openPresetModal(id){
  document.getElementById('presetId').value=id||'';
  const del=document.getElementById('presetDelBtn');
  if(id){
    const p=state.affairPresets.find(function(x){return x.id===id;});
    if(!p)return;
    document.getElementById('presetModalTitle').textContent='编辑预设';
    document.getElementById('presetName').value=p.name;
    document.getElementById('presetReward').value=p.totalReward;
    editPresetCurve={type:p.curve.type,values:(p.curve.values||AFFAIR_CURVES.even).slice()};
    setPresetCurve(editPresetCurve.type);
    document.getElementById('presetAchEnabled').checked=!!(p.ach&&p.ach.enabled);
    document.getElementById('presetAchAmount').value=(p.ach&&p.ach.amount)?p.ach.amount:1;
    togglePresetAch();
    if(del)del.style.display='';
  }else{
    document.getElementById('presetModalTitle').textContent='新建预设';
    document.getElementById('presetName').value='';
    document.getElementById('presetReward').value='';
    editPresetCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
    setPresetCurve('even');
    document.getElementById('presetAchEnabled').checked=false;
    document.getElementById('presetAchAmount').value=1;
    togglePresetAch();
    if(del)del.style.display='none';
  }
  openModal('presetModal');
  setTimeout(function(){document.getElementById('presetName').focus();},50);
}
function presetCurvePreview(){
  const total=Number(document.getElementById('presetReward').value)||0;
  const vals=editPresetCurve.values;
  let pts='';
  for(let i=0;i<10;i++){pts+='<b>'+(i+1)+'</b><i>'+fmt(round2(vals[i]/100*total))+'</i>';}
  return pts;
}
function presetCurveRefresh(){const p=document.getElementById('presetCurvePreview');if(p)p.innerHTML=presetCurvePreview();}
function setPresetCurve(type){
  editPresetCurve.type=type;
  document.querySelectorAll('#presetCurveRow .curve-btn').forEach(function(b){b.classList.toggle('on',b.dataset.curve===type);});
  if(type!=='custom'&&AFFAIR_CURVES[type])editPresetCurve.values=AFFAIR_CURVES[type].slice();
  const custom=document.getElementById('presetCurveCustom');
  if(custom){custom.style.display=(type==='custom')?'':'none';if(type==='custom')renderPresetCurveCustom();}
  const prev=document.getElementById('presetCurvePreview');
  if(prev)prev.innerHTML=presetCurvePreview();
}
function renderPresetCurveCustom(){
  const cont=document.getElementById('presetCurveCustom');
  if(!cont)return;
  cont.innerHTML=editPresetCurve.values.map(function(v,i){
    return '<label class="curve-cell"><span>'+(i+1)+'</span><input type="number" min="0" max="100" step="1" value="'+v+'" data-i="'+i+'" oninput="presetCurveInput('+i+',this.value)"></label>';
  }).join('');
}
function presetCurveInput(i,v){
  const n=Number(v);if(!isNaN(n))editPresetCurve.values[i]=Math.max(0,Math.min(100,n));
  const prev=document.getElementById('presetCurvePreview');
  if(prev)prev.innerHTML=presetCurvePreview();
}
function getPresetCurve(){
  const values=editPresetCurve.values.slice();
  values[9]=100;
  return {type:editPresetCurve.type,values:values};
}
function togglePresetAch(){
  const on=document.getElementById('presetAchEnabled').checked;
  const row=document.getElementById('presetAchAmountRow');
  if(row)row.style.display=on?'':'none';
}
function savePreset(){
  const id=document.getElementById('presetId').value;
  const name=document.getElementById('presetName').value.trim();
  if(!name){toast('请输入预设名称','err');return;}
  let totalReward=Number(document.getElementById('presetReward').value);
  if(isNaN(totalReward)||totalReward<0)totalReward=0;
  const curve=getPresetCurve();
  const achEnabled=document.getElementById('presetAchEnabled').checked;
  const achAmount=Math.max(0,Number(document.getElementById('presetAchAmount').value)||0);
  const ach={enabled:achEnabled,amount:achEnabled?achAmount:0};
  if(id){
    const p=state.affairPresets.find(function(x){return x.id===id;});
    if(!p)return;
    p.name=name;p.totalReward=totalReward;p.curve=curve;p.ach=ach;
  }else{
    state.affairPresets.push({id:uid(),name:name,totalReward:totalReward,curve:curve,ach:ach});
  }
  save();
  closeModal('presetModal');
  toast(id?'预设已更新':'预设已创建');
  render();
}
function delPreset(id){
  const p=state.affairPresets.find(function(x){return x.id===id;});
  if(!p)return;
  if(!confirm('删除预设「'+p.name+'」？'))return;
  state.affairPresets=state.affairPresets.filter(function(x){return x.id!==id;});
  save();
  closeModal('presetModal');
  toast('预设已删除');
  render();
}

function renderAffairs(){
  const panel=document.getElementById('affairPanel');
  if(!panel)return;
  const affairs=state.affairs||[];
  const meta=document.getElementById('affairMeta');
  if(meta){
    const open=affairs.filter(function(a){return !a.doneAt;}).length;
    meta.textContent=affairs.length?('共'+affairs.length+' · 未完成'+open):'';
  }
  let html=renderAffairPresetsHTML();
  // 1. 进行中区（有步骤未全完成，或已开始推进的无步骤事务）
  const inProg=affairs.filter(function(a){return !a.doneAt&&(affairTotalSteps(a)>0||(a.currentCell||0)>0);})
    .sort(function(a,b){return (b.totalReward||0)-(a.totalReward||0)||affairLastAdvance(a)-affairLastAdvance(b);});
  html+=affairZoneStart('inprog','进行中',inProg.length,'');
  html+=inProg.length?inProg.map(affairInProgressCardHTML).join(''):'<div class="affair-empty">暂无进行中的项目</div>';
  html+=AFFAIR_ZONE_END;
  // 2. 日程区（列表/日历视图切换只影响本区呈现）
  const schedCount=affairUnits().length;
  html+=affairZoneStart('schedule','日程',schedCount,'<button class="affair-view-toggle" onclick="event.stopPropagation();toggleAffairView()">'+(affairView==='cal'?'列表':'日历')+'</button>');
  html+=(affairView==='cal')?renderAffairCalendar():renderAffairSchedule();
  html+=AFFAIR_ZONE_END;
  // 3. 草稿区（无步骤、未安排、尚未推进）
  const drafts=affairs.filter(function(a){return !a.doneAt&&!a.plannedAt&&affairTotalSteps(a)===0&&(a.currentCell||0)===0;})
    .sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);});
  html+=affairZoneStart('draft','草稿',drafts.length,'');
  html+=drafts.length?drafts.map(affairDraftCardHTML).join(''):'<div class="affair-empty">没有草稿</div>';
  html+=AFFAIR_ZONE_END;
  // 4. 已完成（折叠组，默认收起，置于最底部）
  const done=affairs.filter(function(a){return affairIsDone(a);});
  html+=doneZoneHTML(done);
  panel.innerHTML=html;
}

function affairStatusLine(a){
  const total=a.totalReward||0;
  if(affairIsDone(a)){
    let s='已完成 · +'+fmt(total);
    if(a.ach&&a.ach.enabled&&a.ach.amount)s+=' · +'+fmt(a.ach.amount)+' 成果';
    return s;
  }
  let s='当前格 +'+fmt(a.alreadyGiven||0);
  const t=affairTotalSteps(a);
  if(t>0)s+=' · 已完成 '+affairDoneSteps(a)+'/'+t+' 步';
  if(a.ach&&a.ach.enabled&&a.ach.amount)s+=' · (+'+fmt(a.ach.amount)+' 成果)';
  return s;
}
function affairAxisHTML(a){
  const cell=a.currentCell||0;
  const draggable=(affairTotalSteps(a)===0&&!a.doneAt);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  return '<div class="affair-axis'+(draggable?' draggable':'')+'" data-affair-id="'+a.id+'"'+(draggable?'':' style="pointer-events:none"')+'>'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'</div>';
}
function affairZoneStart(key,title,count,extra){
  const collapsed=(state.affairCollapsed||[]).indexOf(key)>=0;
  return '<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="affair-zone-'+key+'">'
    +'<div class="affair-zone-title" onclick="toggleAffairZone(\''+key+'\')">'
    +'<span class="coll-toggle">▼</span>'+title+' <span class="affair-zone-count">'+count+'</span>'
    +(extra||'')
    +'</div>'
    +'<div class="affair-zone-body">';
}
const AFFAIR_ZONE_END='</div></div>';
function doneZoneHTML(done){
  const collapsed=!affairDoneOpen;
  return '<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="affair-zone-done">'
    +'<div class="affair-zone-title" onclick="toggleAffairDone()">'
    +'<span class="coll-toggle">▼</span>已完成 <span class="affair-zone-count">'+done.length+'</span></div>'
    +'<div class="affair-zone-body">'+(done.length?done.map(affairDoneCardHTML).join(''):'<div class="affair-empty">无</div>')+'</div>'
    +'</div>';
}
function toggleAffairZone(key){
  const arr=state.affairCollapsed||[];
  const i=arr.indexOf(key);
  if(i>=0)arr.splice(i,1);else arr.push(key);
  state.affairCollapsed=arr;
  save();
  const el=document.getElementById('affair-zone-'+key);
  if(el)el.classList.toggle('collapsed',arr.indexOf(key)>=0);
}
function affairMoreBtn(a){
  return '<button class="btn btn-sm affair-more" onclick="toggleAffairMenu(event,\''+a.id+'\')">⋯</button>';
}
let affairMenuTarget=null;
function toggleAffairMenu(e,id){
  e.stopPropagation();
  if(affairMenuTarget===id){closeAffairMenu();return;}
  affairMenuTarget=id;
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  let menu=document.getElementById('affairMenu');
  if(!menu){menu=document.createElement('div');menu.id='affairMenu';menu.className='affair-menu';document.body.appendChild(menu);}
  const canUndo=affairCanUndo(a);
  menu.innerHTML=
    '<button onclick="openAffairModal(\''+id+'\');closeAffairMenu()">编辑</button>'
    +(canUndo
      ?'<button onclick="affairUndoAction(\''+id+'\');closeAffairMenu()">撤销上一步</button>'
      :'<button disabled>撤销上一步</button>')
    +'<button class="danger" onclick="delAffair(\''+id+'\');closeAffairMenu()">删除</button>';
  const r=e.currentTarget.getBoundingClientRect();
  menu.style.display='block';
  menu.style.left=Math.max(8,Math.min(r.right-110,window.innerWidth-118))+'px';
  menu.style.top=(r.bottom+4)+'px';
}
function closeAffairMenu(){
  affairMenuTarget=null;
  const m=document.getElementById('affairMenu');
  if(m)m.style.display='none';
}
document.addEventListener('click',function(e){
  if(!affairMenuTarget)return;
  const menu=document.getElementById('affairMenu');
  const path=(e.composedPath&&e.composedPath())||[];
  if(path.indexOf(menu)>=0)return;
  closeAffairMenu();
});

function affairInProgressCardHTML(a){
  const stall=a.startedAt&&daysSince(a.startedAt)>3;
  return '<div class="card affair-card'+(stall?' stalled':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<button class="btn btn-sm btn-checkin" onclick="advanceAffairStep(\''+a.id+'\')">完成下一步</button>'
    +'</div>'
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairScheduleCardHTML(a,opts){
  const late=opts&&opts.late;
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<span class="affair-time">'+(opts&&opts.time?opts.time:fmtPlan(a.plannedAt))+'</span>'
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffair(\''+a.id+'\')">完成</button>'
    +'</div>'
    +'</div>'
    +'</div>';
}

function affairDraftCardHTML(a){
  return '<div class="card affair-card" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +'<button class="btn btn-sm" onclick="openAffairPlanModal(\''+a.id+'\')">计划</button>'
    +affairMoreBtn(a)
    +'</div>'
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairDoneCardHTML(a){
  return '<div class="card affair-card done" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<span class="affair-time">✓ '+fmtTime(a.doneAt)+'</span>'
    +'</div>'
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

// 执行单元：有时间且未完成的条目（有时间的步骤各自成条；否则事务整体成条）
function affairUnits(){
  const out=[];
  (state.affairs||[]).forEach(function(a){
    if(a.doneAt)return;
    const steps=affairSteps(a);
    const timed=[];
    steps.forEach(function(s,i){if(!s.doneAt&&s.plannedAt)timed.push({kind:'step',affair:a,step:s,index:i,ts:s.plannedAt});});
    if(timed.length>0){for(let k=0;k<timed.length;k++)out.push(timed[k]);}
    else if(a.plannedAt){out.push({kind:'affair',affair:a,step:null,index:-1,ts:a.plannedAt});}
  });
  return out;
}
function affairStepUnitCardHTML(u,opts){
  const a=u.affair,s=u.step,i=u.index;
  const late=opts&&opts.late;
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(s.text)+'</span></div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +'<span class="affair-time">'+(opts&&opts.time?opts.time:fmtClock(u.ts))+'</span>'
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffairStep(\''+a.id+'\','+i+')">完成</button>'
    +'</div>'
    +'</div>'
    +'<div class="affair-meta"><span class="affair-sub">'+esc(a.name)+' · 第 '+(i+1)+'/'+affairTotalSteps(a)+' 步</span></div>'
    +'</div>';
}

function renderAffairSchedule(){
  const units=affairUnits();
  const nowTs=Date.now();
  const todayStart=dayStartTs(nowTs);
  const tomorrowStart=todayStart+864e5;
  const dayAfter=tomorrowStart+864e5;
  const weekEnd=weekStartTs(1,nowTs)+7*864e5;
  function bucket(ts){
    if(ts<tomorrowStart)return 'today';
    if(ts<dayAfter)return 'tomorrow';
    if(ts<weekEnd)return 'week';
    return 'later';
  }
  const defs=[{key:'today',title:'今天'},{key:'tomorrow',title:'明天'},{key:'week',title:'本周'},{key:'later',title:'之后'}];
  let html='';
  defs.forEach(function(d){
    const items=units.filter(function(u){return bucket(u.ts)===d.key;}).sort(function(a,b){return a.ts-b.ts;});
    html+='<div class="affair-day-group">'
      +'<div class="affair-day-title">'+d.title+' <span class="affair-zone-count">'+items.length+'</span></div>';
    if(items.length===0){
      html+='<div class="affair-empty">无</div>';
    }else{
      html+=items.map(function(u){
        const late=u.ts<todayStart;
        const timeOnly=(d.key==='today'||d.key==='tomorrow')?fmtClock(u.ts):fmtPlan(u.ts);
        if(u.kind==='step')return affairStepUnitCardHTML(u,{late:late,time:timeOnly});
        return affairScheduleCardHTML(u.affair,{late:late,time:timeOnly});
      }).join('');
    }
    html+='</div>';
  });
  return html;
}

function renderAffairCalendar(){
  const units=affairUnits();
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  const y=affairCalCursor.y,m=affairCalCursor.m;
  const todayTs=dayStartTs(Date.now());
  const first=new Date(y,m,1);
  const firstDow=(first.getDay()+6)%7; // 周一=0
  const startTs=first.getTime()-firstDow*864e5;
  let html='<div class="cal-head">'
    +'<button class="cal-nav" onclick="affairCalShift(-1)">◀</button>'
    +'<div class="cal-title">'+y+'年'+(m+1)+'月</div>'
    +'<button class="cal-nav" onclick="affairCalShift(1)">▶</button>'
    +'</div>';
  html+='<div class="cal-grid">';
  ['一','二','三','四','五','六','日'].forEach(function(w){html+='<div class="cal-dow">'+w+'</div>';});
  for(let i=0;i<42;i++){
    const ts=startTs+i*864e5;
    const d=new Date(ts);
    const inMonth=d.getMonth()===m;
    const isToday=ts===todayTs;
    const count=units.filter(function(u){return frSameDay(u.ts,ts);}).length;
    const sel=affairCalSelected&&frSameDay(ts,affairCalSelected);
    let dots='';
    for(let k=0;k<Math.min(count,3);k++)dots+='<i class="cal-dot"></i>';
    html+='<div class="cal-cell'+(inMonth?'':' out')+(isToday?' today':'')+(sel?' sel':'')+'" onclick="affairSelectDay('+ts+')">'
      +'<span class="cal-num">'+d.getDate()+'</span>'
      +(count?'<span class="cal-dots">'+dots+'</span>':'')
      +'</div>';
  }
  html+='</div>';
  // 选中日详情
  html+='<div class="cal-day-detail">';
  if(affairCalSelected){
    const selTs=affairCalSelected;
    const items=units.filter(function(u){return frSameDay(u.ts,selTs);}).sort(function(a,b){return a.ts-b.ts;});
    html+='<div class="cal-day-head">'+fmtDateCal(selTs)+'</div>';
    if(items.length===0){
      html+='<div class="affair-empty">这一天没有安排</div>';
    }else{
      html+=items.map(function(u){
        const late=u.ts<todayTs;
        if(u.kind==='step')return affairStepUnitCardHTML(u,{late:late,time:fmtClock(u.ts)});
        return affairScheduleCardHTML(u.affair,{late:late,time:fmtClock(u.ts)});
      }).join('');
    }
  }
  html+='</div>';
  return html;
}

// ===== 事务：交互 =====
function addAffairFromInput(){
  const inp=document.getElementById('affairInput');
  if(!inp)return;
  const name=inp.value.trim();
  if(!name){toast('请输入项目名称','err');return;}
  state.affairs.push({id:uid(),name:name,totalReward:0.1,curve:{type:'even',values:AFFAIR_CURVES.even.slice()},currentCell:0,alreadyGiven:0,domainId:null,plannedAt:null,steps:[],ach:{enabled:false,amount:0},createdAt:now(),startedAt:null,doneAt:null});
  Ledger.event('创建项目「'+name+'」','affair-create');
  save();
  inp.value='';
  inp.focus();
  render();
}

// ===== 事务结算（历史最高水位）=====
function applyAffairValue(a,amt,desc){
  if(!amt||amt<=0)return;
  if(a.domainId){
    Ledger.grant('progress:'+a.domainId,amt,{src:'affair',desc:desc,dom:a.domainId,affairId:a.id});
    checkAchievements(a.domainId);
  }else{
    Ledger.grant('vitality',amt,{src:'affair',desc:desc,affairId:a.id});
  }
  return amt;
}
function reverseAffairValue(a,amt,desc){
  if(!amt||amt<=0)return;
  if(a.domainId){
    Ledger.spend('progress:'+a.domainId,amt,{src:'affair',desc:desc,dom:a.domainId,affairId:a.id});
  }else{
    Ledger.spend('vitality',amt,{src:'affair',desc:desc,affairId:a.id});
  }
}
// 推进 currentCell 并按水位结算；到达格 9 视为完成 + 发放成果点
function affairApplyProgress(a,cell){
  cell=Math.max(0,Math.min(9,Math.round(cell)));
  Ledger.txn(function(){
    a.currentCell=cell;
    if(cell>0&&!a.startedAt)a.startedAt=now();
    const target=affairTargetAt(a,cell);
    const diff=round2(target-(a.alreadyGiven||0));
    if(diff>0){
      applyAffairValue(a,diff,'项目「'+a.name+'」进度结算');
      a.alreadyGiven=round2(target);
    }
    if(cell>=9&&!a.doneAt){
      a.doneAt=now();
      if(a.ach&&a.ach.enabled&&a.ach.amount>0){
        Ledger.grant('achievement',a.ach.amount,{src:'affair',desc:'完成项目「'+a.name+'」',affairId:a.id});
        toast('项目「'+a.name+'」完成 · 成果点 +'+fmt(a.ach.amount),'warn');
      }else{
        toast('项目「'+a.name+'」已完成');
      }
    }
  },{label:'affair-progress',save:'none',render:false});
}

// ===== 撤销（快照持久化到 state，限量保留）=====
const AFFAIR_UNDO_LIMIT=5;
function affairCanUndo(a){const s=(state.affairUndo&&state.affairUndo[a.id]);return !!(s&&s.length);}
function affairPushUndo(a){
  if(!state.affairUndo)state.affairUndo={};
  const stack=state.affairUndo[a.id]||(state.affairUndo[a.id]=[]);
  stack.push({cell:a.currentCell||0,given:a.alreadyGiven||0,doneAt:a.doneAt||null,startedAt:a.startedAt||null});
  if(stack.length>AFFAIR_UNDO_LIMIT)stack.shift();
}
function affairUndoAction(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const stack=(state.affairUndo&&state.affairUndo[a.id])||[];
  const snap=stack.pop();
  if(!snap){toast('没有可撤销的操作','warn');return;}
  const revoked=round2((a.alreadyGiven||0)-(snap.given||0));
  const txr=Ledger.txn(function(){
    if(revoked>0)reverseAffairValue(a,revoked,'撤销项目「'+a.name+'」推进');
    if(!!a.doneAt&&!snap.doneAt&&a.ach&&a.ach.enabled&&a.ach.amount>0){
      Ledger.grant('achievement',-a.ach.amount,{src:'affair',desc:'撤销项目「'+a.name+'」成果点',affairId:a.id});
    }
    a.currentCell=snap.cell;a.alreadyGiven=snap.given;a.doneAt=snap.doneAt;a.startedAt=snap.startedAt;
  },{label:'affair-undo',save:'none',render:false});
  if(!txr.ok)return;
  commit('已撤销「'+a.name+'」');
}

function _completeAffairStep(a,s){
  affairPushUndo(a);
  s.doneAt=now();
  const steps=affairSteps(a);
  const allDone=steps.every(function(x){return x.doneAt;});
  affairApplyProgress(a,allDone?9:Math.min(8,(a.currentCell||0)+1));
  commit();
}
function advanceAffairStep(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a||a.doneAt)return;
  const next=affairSteps(a).find(function(s){return !s.doneAt;});
  if(!next){affairPushUndo(a);affairApplyProgress(a,9);commit();return;}
  _completeAffairStep(a,next);
}
function completeAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt){toast('该项目已完成','warn');return;}
  affairPushUndo(a);
  affairApplyProgress(a,9);
  commit();
}
function completeAffairStep(id,idx){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt){toast('该项目已完成','warn');return;}
  const steps=affairSteps(a);
  const s=steps[idx];
  if(!s){toast('步骤不存在','warn');return;}
  if(s.doneAt){toast('该步骤已完成','warn');return;}
  _completeAffairStep(a,s);
}

// ===== 无步骤事务：进度轴拖拽推进 =====
function initAffairAxes(){
  const THRESH=8;
  document.querySelectorAll('.affair-axis.draggable').forEach(function(axis){
    const track=axis.querySelector('.stage-track');
    if(!track||track._affairBound)return;
    track._affairBound=true;
    const id=axis.dataset.affairId;
    let startX=0,startY=0,startCell=0,pid=0;
    let dragging=false,decided=false,abandoned=false,pushed=false;
    function setCellFromX(clientX){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      const rect=track.getBoundingClientRect();
      let p=(clientX-rect.left)/rect.width;
      p=Math.max(0,Math.min(1,p));
      let cell=Math.floor(p*10);if(cell>9)cell=9;if(cell<0)cell=0;
      if(cell<=startCell)return;
      if(!pushed){affairPushUndo(a);pushed=true;}
      affairApplyProgress(a,cell);
      const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';
    }
    track.addEventListener('pointerdown',function(e){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      startCell=a.currentCell||0;
      dragging=false;decided=false;abandoned=false;pushed=false;
    });
    track.addEventListener('pointermove',function(e){
      if(e.pointerId!==pid||decided)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
      if(Math.abs(dx)>Math.abs(dy)){
        decided=true;dragging=true;
        if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
        e.preventDefault();
        setCellFromX(e.clientX);
      }else{
        decided=true;abandoned=true;
      }
    });
    function end(e){
      if(e&&e.pointerId!==pid)return;
      if(pushed){commit();}
      dragging=false;decided=false;abandoned=false;pushed=false;
    }
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
  });
}

function openAffairPlanModal(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  document.getElementById('affairPlanId').value=id;
  document.getElementById('affairPlanInput').value=a.plannedAt?toLocalInput(a.plannedAt):'';
  openModal('affairPlanModal');
}

function saveAffairPlan(){
  const id=document.getElementById('affairPlanId').value;
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const v=document.getElementById('affairPlanInput').value;
  if(!v){toast('请选择日期时间','err');return;}
  a.plannedAt=fromLocalInput(v);
  save();
  closeModal('affairPlanModal');
  toast('已规划项目「'+a.name+'」');
  render();
}

function openAffairModal(id){
  document.getElementById('affairId').value=id||'';
  const sel=document.getElementById('affairDomain');
  let dHtml='<option value="">不关联（记活力点）</option>';
  dHtml+=state.domains.map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
  sel.innerHTML=dHtml;
  const psSel=document.getElementById('affairPresetSel');
  if(psSel){
    psSel.innerHTML='<option value="">不套用</option>'+state.affairPresets.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+'</option>';}).join('');
    psSel.value='';
  }
  const delBtn=document.getElementById('affairDelBtn');
  if(id){
    const a=state.affairs.find(function(x){return x.id===id;});
    if(!a)return;
    document.getElementById('affairModalTitle').textContent='编辑项目';
    document.getElementById('affairName').value=a.name;
    document.getElementById('affairReward').value=(a.totalReward===undefined?'':a.totalReward);
    document.getElementById('affairPlannedAt').value=a.plannedAt?toLocalInput(a.plannedAt):'';
    sel.value=a.domainId||'';
    editAffairSteps=clone(a.steps||[]);
    editAffairCurve={type:affairCurveType(a),values:affairCurve(a).slice()};
    setAffairCurve(editAffairCurve.type);
    document.getElementById('affairAchEnabled').checked=!!(a.ach&&a.ach.enabled);
    document.getElementById('affairAchAmount').value=(a.ach&&a.ach.amount)?a.ach.amount:1;
    toggleAffairAch();
    if(delBtn)delBtn.style.display='';
  }else{
    document.getElementById('affairModalTitle').textContent='新建项目';
    document.getElementById('affairName').value='';
    document.getElementById('affairReward').value='';
    document.getElementById('affairPlannedAt').value='';
    sel.value='';
    editAffairSteps=[];
    editAffairCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
    setAffairCurve('even');
    document.getElementById('affairAchEnabled').checked=false;
    document.getElementById('affairAchAmount').value=1;
    toggleAffairAch();
    if(delBtn)delBtn.style.display='none';
  }
  renderAffairSteps();
  openModal('affairModal');
  setTimeout(function(){document.getElementById('affairName').focus();},50);
}

function handleAffairSave(){
  const id=document.getElementById('affairId').value;
  const name=document.getElementById('affairName').value.trim();
  let totalReward=Number(document.getElementById('affairReward').value);
  if(isNaN(totalReward)||totalReward<0)totalReward=0;
  const curve=getAffairCurve();
  const achEnabled=document.getElementById('affairAchEnabled').checked;
  const achAmount=Math.max(0,Number(document.getElementById('affairAchAmount').value)||0);
  const domainId=document.getElementById('affairDomain').value||null;
  const plannedAt=fromLocalInput(document.getElementById('affairPlannedAt').value);
  const steps=readAffairSteps();
  if(!name){toast('请输入项目名称','err');return;}
  const ach={enabled:achEnabled,amount:achEnabled?achAmount:0};
  if(id){
    const a=state.affairs.find(function(x){return x.id===id;});
    if(!a)return;
    a.name=name;a.totalReward=totalReward;a.curve=curve;a.ach=ach;a.domainId=domainId;
    if(!a.doneAt)a.plannedAt=plannedAt;
    a.steps=steps;
    Ledger.event('修改项目「'+name+'」','affair-edit');
  }else{
    state.affairs.push({id:uid(),name:name,totalReward:totalReward,curve:curve,currentCell:0,alreadyGiven:0,domainId:domainId,plannedAt:plannedAt,steps:steps,ach:ach,createdAt:now(),startedAt:null,doneAt:null});
    Ledger.event('创建项目「'+name+'」','affair-create');
  }
  save();
  closeModal('affairModal');
  toast(id?'项目已更新':'项目已创建');
  render();
}

function delAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(!confirm('删除项目「'+a.name+'」？'))return;
  state.affairs=state.affairs.filter(function(x){return x.id!==id;});
  Ledger.event('删除项目「'+a.name+'」','affair-del');
  save();
  closeModal('affairModal');
  toast('项目已删除');
  render();
}

function renderAffairSteps(){
  const cont=document.getElementById('affairSteps');
  if(!cont)return;
  if(editAffairSteps.length===0){
    cont.innerHTML='<div class="affair-step-empty">暂无步骤（可选填，保存后可直接「完成」整个项目）</div>';
    return;
  }
  cont.innerHTML=editAffairSteps.map(function(s,i){
    const t=s.plannedAt?toLocalInput(s.plannedAt):'';
    const badge=s.plannedAt?('🕒 '+fmtPlan(s.plannedAt)):'';
    return '<div class="affair-step-row">'
      +'<div class="affair-step-line">'
      +'<input type="text" class="affair-step-input" data-i="'+i+'" value="'+escAttr(s.text||'')+'" placeholder="步骤 '+(i+1)+'" maxlength="60" oninput="affairStepInput('+i+',this.value)">'
      +'<button type="button" class="btn btn-sm btn-danger" onclick="affairRemoveStep('+i+')">×</button>'
      +'</div>'
      +'<div class="affair-step-line">'
      +'<input type="datetime-local" class="affair-step-time" value="'+t+'" title="单独安排本步骤执行时间（可选）" oninput="affairStepTime('+i+',this.value)">'
      +'<span class="affair-step-time-badge" id="affairStepBadge'+i+'">'+badge+'</span>'
      +'</div>'
      +'</div>';
  }).join('');
}
function affairStepInput(i,v){if(editAffairSteps[i])editAffairSteps[i].text=v;}
function affairStepTime(i,v){
  if(!editAffairSteps[i])return;
  editAffairSteps[i].plannedAt=fromLocalInput(v);
  const b=document.getElementById('affairStepBadge'+i);
  if(b)b.textContent=editAffairSteps[i].plannedAt?('🕒 '+fmtPlan(editAffairSteps[i].plannedAt)):'';
}
function affairAddStep(){editAffairSteps.push({text:'',doneAt:null,plannedAt:null});renderAffairSteps();}
function affairRemoveStep(i){editAffairSteps.splice(i,1);renderAffairSteps();}
function readAffairSteps(){
  return editAffairSteps.filter(function(s){return s&&s.text&&s.text.trim();})
    .map(function(s){return {text:s.text.trim(),doneAt:s.doneAt||null,plannedAt:s.plannedAt||null};});
}
function affairCurvePreview(){
  const total=Number(document.getElementById('affairReward').value)||0;
  const vals=editAffairCurve.values;
  let pts='';
  for(let i=0;i<10;i++){pts+='<b>'+(i+1)+'</b><i>'+fmt(round2(vals[i]/100*total))+'</i>';}
  return pts;
}
function affairCurveRefresh(){
  const p=document.getElementById('affairCurvePreview');
  if(p)p.innerHTML=affairCurvePreview();
}
function setAffairCurve(type){
  editAffairCurve.type=type;
  document.querySelectorAll('#affairCurveRow .curve-btn').forEach(function(b){b.classList.toggle('on',b.dataset.curve===type);});
  if(type!=='custom'&&AFFAIR_CURVES[type])editAffairCurve.values=AFFAIR_CURVES[type].slice();
  const custom=document.getElementById('affairCurveCustom');
  if(custom){custom.style.display=(type==='custom')?'':'none';if(type==='custom')renderAffairCurveCustom();}
  const prev=document.getElementById('affairCurvePreview');
  if(prev)prev.innerHTML=affairCurvePreview();
}
function renderAffairCurveCustom(){
  const cont=document.getElementById('affairCurveCustom');
  if(!cont)return;
  cont.innerHTML=editAffairCurve.values.map(function(v,i){
    return '<label class="curve-cell"><span>'+(i+1)+'</span><input type="number" min="0" max="100" step="1" value="'+v+'" data-i="'+i+'" oninput="affairCurveInput('+i+',this.value)"></label>';
  }).join('');
}
function affairCurveInput(i,v){
  const n=Number(v);if(!isNaN(n))editAffairCurve.values[i]=Math.max(0,Math.min(100,n));
  const prev=document.getElementById('affairCurvePreview');
  if(prev)prev.innerHTML=affairCurvePreview();
}
function getAffairCurve(){
  const type=editAffairCurve.type;
  const values=editAffairCurve.values.slice();
  values[9]=100;
  return {type:type,values:values};
}
function toggleAffairAch(){
  const on=document.getElementById('affairAchEnabled').checked;
  const row=document.getElementById('affairAchAmountRow');
  if(row)row.style.display=on?'':'none';
}
function toggleAffairView(){affairView=(affairView==='cal'?'list':'cal');affairCalSelected=null;render();}
function toggleAffairDone(){affairDoneOpen=!affairDoneOpen;render();}
function affairSelectDay(ts){affairCalSelected=ts;render();}
function affairCalShift(d){
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  let y=affairCalCursor.y,m=affairCalCursor.m+d;
  if(m<0){m=11;y--;}else if(m>11){m=0;y++;}
  affairCalCursor={y:y,m:m};
  affairCalSelected=null;
  render();
}

// ===== 杂事（极简快速清单）=====
// 与「项目」是两个独立入口：杂事只记名称、勾选和可选日期，走批量结算 + 腐化债。
function choreCfg(){return normalizeChoreConfig(state.choreConfig);}
function choreFreshDays(c){
  if(c&&typeof c.freshDays==='number'&&isFinite(c.freshDays)&&c.freshDays>=0)return c.freshDays;
  return choreCfg().freshDays;
}
function choreBaseTs(c){
  const base=(c&&c.plannedAt)?c.plannedAt:((c&&c.createdAt)?c.createdAt:now());
  return dayStartTs(base);
}
// 超期天数：日期（或创建日）+ 保鲜期之后开始计腐化，当天不算
function choreOverdueDays(c,ts){
  if(!c||c.done)return 0;
  const today=dayStartTs(ts||now());
  const deadline=choreBaseTs(c)+Math.round(choreFreshDays(c))*864e5;
  const d=Math.round((today-deadline)/864e5);
  return d>0?d:0;
}
// 腐化档位：按「超期件数」匹配，返回每件每天的系数
function choreTierRate(count,cfg){
  cfg=cfg||choreCfg();
  if(count<=0)return 0;
  if(count<=cfg.tier1Max)return cfg.tier1Rate;
  if(count<=cfg.tier2Max)return cfg.tier2Rate;
  return cfg.tier3Rate;
}
function choreDailyDecay(count,cfg){return round2(count*choreTierRate(count,cfg));}
function choreUnsettled(){
  return (state.chores||[]).filter(function(c){return c.done&&!c.settled;});
}
// 批量结算：每 N 件已完成且未结算的杂事发放 Y 活力点（可一次结算多批）
function settleChoreBatches(silent=false){
  const cfg=choreCfg();
  const need=Math.max(1,Math.round(cfg.batchN));
  const pool=choreUnsettled().sort(function(a,b){return (a.doneAt||0)-(b.doneAt||0);});
  const batches=Math.floor(pool.length/need);
  if(batches<=0)return 0;
  const used=pool.slice(0,batches*need);
  used.forEach(function(c){c.settled=true;});
  const gain=round2(batches*cfg.batchY);
  const txr=Ledger.txn(function(){
    if(gain>0){
      const target=round2((state.scores.vitality||0)+gain);
      Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:gain,desc:'杂事批量结算：'+used.length+' 件',src:'chore-batch',dom:''},reason:{src:'chore-batch'}});
      if(!silent)toast('批量结算 '+used.length+' 件杂事 · 活力点 +'+fmt(gain));
    }else{
      Ledger.event('杂事批量结算：'+used.length+' 件（当前奖励为 0）','chore-batch');
    }
  },{label:'chore-batch',save:'none',render:false});
  return txr.ok?gain:0;
}
// 腐化债静默结算：超期杂事按档位系数逐日累积，直接从活力点扣除，不弹提示
// 纯计算：只统计当天应扣总额与件数/天数，不修改 state、不写日志
function computeChoreDecay(){
  const chores=state.chores||[];
  if(!chores.length)return {total:0,charged:0,dueDays:0,overdue:[],today:dayStartTs(now())};
  const cfg=choreCfg();
  const today=dayStartTs(now());
  const overdue=chores.filter(function(c){return !c.done&&choreOverdueDays(c)>0;});
  if(!overdue.length)return {total:0,charged:0,dueDays:0,overdue:[],today:today};
  const rate=choreTierRate(overdue.length,cfg);
  let total=0,dueDays=0,charged=0;
  overdue.forEach(function(c){
    const deadline=choreBaseTs(c)+Math.round(choreFreshDays(c))*864e5;
    let start=deadline+864e5;
    if(c.decayKey){
      const p=String(c.decayKey).split('-');
      const last=new Date(Number(p[0]),Number(p[1])-1,Number(p[2])).getTime();
      if(isFinite(last))start=Math.max(start,last+864e5);
    }
    const days=Math.round((today-start)/864e5)+1;
    if(days<=0)return;
    charged++;
    dueDays+=days;
    total+=rate*days;
  });
  return {total:round2(total),charged:charged,dueDays:dueDays,overdue:overdue,today:today};
}
function processChoreDecay(silent=false){
  const r=computeChoreDecay();
  if(r.total<=0||r.charged<=0)return 0;
  const txr=Ledger.txn(function(){
    const target=round2((state.scores.vitality||0)-r.total);
    Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:-r.total,desc:'杂事腐化债：'+r.charged+' 件超期，累计 '+r.dueDays+' 天',src:'chore-decay',dom:''},reason:{src:'chore-decay'}});
    r.overdue.forEach(function(c){c.decayKey=dayKey(r.today);});
  },{label:'chore-decay',save:silent?'none':'debounce',render:false});
  return txr.ok?r.total:0;
}
function addChoreFromInput(){
  const inp=document.getElementById('choreInput');
  if(!inp)return;
  const name=inp.value.trim();
  if(!name){toast('请输入杂事内容','err');return;}
  if(!Array.isArray(state.chores))state.chores=[];
  state.chores.push({id:uid(),name:name,done:false,doneAt:null,plannedAt:null,createdAt:now(),settled:false,freshDays:null,decayKey:null});
  Ledger.event('新增杂事「'+name+'」','chore-create');
  save();
  inp.value='';inp.focus();
  render();
}
function toggleChoreDone(id){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(c.done){
    c.done=false;c.doneAt=null;
    // 取消勾选：腐化从今天重新起算；已结算的批次不回退，避免反复领取
    c.decayKey=dayKey(now());
  }else{
    c.done=true;c.doneAt=now();
    c.decayKey=dayKey(now());
    settleChoreBatches();
  }
  commit();
}
function toggleChoreDoneZone(){choreDoneOpen=!choreDoneOpen;render();}
function fmtChoreDate(ts){
  const d=new Date(ts);
  return (d.getMonth()+1)+'/'+d.getDate();
}
function choreCardHTML(c){
  const overdue=choreOverdueDays(c);
  let meta='';
  if(c.plannedAt)meta+='<span class="chore-date">📅 '+fmtChoreDate(c.plannedAt)+'</span>';
  if(overdue>0)meta+='<span class="chore-overdue">超期 '+overdue+' 天</span>';
  return '<div class="card chore-card'+(c.done?' done':'')+(overdue>0?' overdue':'')+'" data-chore-id="'+c.id+'" onclick="openChoreModal(\''+c.id+'\')">'
    +'<label class="chore-check" onclick="event.stopPropagation()">'
    +'<input type="checkbox"'+(c.done?' checked':'')+' onchange="toggleChoreDone(\''+c.id+'\')">'
    +'</label>'
    +'<div class="chore-main">'
    +'<div class="chore-name">'+esc(c.name)+'</div>'
    +(meta?'<div class="chore-meta">'+meta+'</div>':'')
    +'</div>'
    +'</div>';
}
function renderChores(){
  const panel=document.getElementById('chorePanel');
  if(!panel)return;
  const chores=state.chores||[];
  const cfg=choreCfg();
  const todo=chores.filter(function(c){return !c.done;}).sort(function(a,b){
    const ap=a.plannedAt||9e15,bp=b.plannedAt||9e15;
    return ap-bp||((b.createdAt||0)-(a.createdAt||0));
  });
  const done=chores.filter(function(c){return c.done;}).sort(function(a,b){return (b.doneAt||0)-(a.doneAt||0);});
  const unsettled=choreUnsettled().length;
  const need=Math.max(1,Math.round(cfg.batchN));
  const rem=unsettled%need;
  const next=rem===0?need:need-rem;
  const readyBatches=Math.floor(unsettled/need);
  const meta=document.getElementById('choreMeta');
  if(meta)meta.textContent=chores.length?('待办 '+todo.length+' · 已完成 '+done.length):'';
  let html='<div class="chore-econ-bar">'
    +'<span>单件不发放活力 · 每完成 <b>'+need+'</b> 件 → <b>+'+fmt(cfg.batchY)+'</b> 活力</span>'
    +'<span>'+(readyBatches>0
      ?('有 '+readyBatches+' 批待入账（'+unsettled+' 件）· 完成下一件即入账')
      :('待入账 '+unsettled+' 件 · 再完成 '+next+' 件可结算'))+'</span>'
    +'</div>';
  html+=todo.length?todo.map(choreCardHTML).join(''):'<div class="affair-empty">还没有杂事。输入名称回车，即刻创建。</div>';
  if(done.length){
    const collapsed=!choreDoneOpen;
    html+='<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="chore-zone-done">'
      +'<div class="affair-zone-title" onclick="toggleChoreDoneZone()">'
      +'<span class="coll-toggle">▼</span>已完成 <span class="affair-zone-count">'+done.length+'</span></div>'
      +'<div class="affair-zone-body">'+done.map(choreCardHTML).join('')+'</div>'
      +'</div>';
  }
  panel.innerHTML=html;
}
// 杂事编辑：名称、可选日期、可选覆盖保鲜期
function toDateInputValue(ts){
  if(!ts)return '';
  const d=new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function openChoreModal(id){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  const isEdit=!!c;
  document.getElementById('choreModalTitle').textContent=isEdit?'编辑杂事':'新建杂事';
  document.getElementById('choreId').value=isEdit?c.id:'';
  document.getElementById('choreName').value=isEdit?c.name:'';
  document.getElementById('choreDate').value=isEdit&&c.plannedAt?toDateInputValue(c.plannedAt):'';
  document.getElementById('choreFreshDays').value=isEdit&&typeof c.freshDays==='number'?c.freshDays:'';
  const hint=document.getElementById('choreFreshDefaultHint');
  if(hint)hint.textContent=choreCfg().freshDays;
  document.getElementById('choreDelBtn').style.display=isEdit?'':'none';
  openModal('choreModal');
  if(!isEdit)setTimeout(function(){document.getElementById('choreName').focus();},50);
}
function saveChore(){
  const id=document.getElementById('choreId').value;
  const name=document.getElementById('choreName').value.trim();
  if(!name){toast('请输入杂事名称','err');return;}
  const dv=document.getElementById('choreDate').value;
  const plannedAt=dv?new Date(dv+'T00:00:00').getTime():null;
  const fv=String(document.getElementById('choreFreshDays').value).trim();
  let fresh=null;
  if(fv!==''){
    const n=Number(fv);
    if(!isFinite(n)){toast('保鲜期需为数字','err');return;}
    fresh=Math.max(0,Math.round(n));
  }
  if(!Array.isArray(state.chores))state.chores=[];
  if(id){
    const c=state.chores.find(function(x){return x.id===id;});
    if(!c)return;
    c.name=name;c.plannedAt=plannedAt;c.freshDays=fresh;
    // 日期或保鲜期改动后从今天重新起算腐化，不补扣历史
    c.decayKey=dayKey(now());
    Ledger.event('修改杂事「'+name+'」','chore-edit');
  }else{
    state.chores.push({id:uid(),name:name,done:false,doneAt:null,plannedAt:plannedAt,createdAt:now(),settled:false,freshDays:fresh,decayKey:null});
    Ledger.event('新增杂事「'+name+'」','chore-create');
  }
  closeModal('choreModal');
  commit(id?'杂事已更新':'杂事已创建');
}
function delChore(){
  const id=document.getElementById('choreId').value;
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(!confirm('删除杂事「'+c.name+'」？'))return;
  state.chores=state.chores.filter(function(x){return x.id!==id;});
  // 删除类日志应记为 chore-delete（此前误用了 chore-create）
  Ledger.event('删除杂事「'+c.name+'」','chore-delete');
  closeModal('choreModal');
  commit('杂事已删除');
}
// 杂事经济设置（统一入口；设置后作为所有杂事的默认）
// 表单字段与配置键的映射：读写表单都走这张表，避免 8 个字段散落三处
const CHORE_CFG_FIELDS={
  freshDays:'choreCfgFresh',
  batchN:'choreCfgN',
  batchY:'choreCfgY',
  tier1Max:'choreCfgT1Max',
  tier1Rate:'choreCfgT1Rate',
  tier2Max:'choreCfgT2Max',
  tier2Rate:'choreCfgT2Rate',
  tier3Rate:'choreCfgT3Rate'
};
function readChoreCfgForm(){
  const raw={};
  Object.keys(CHORE_CFG_FIELDS).forEach(function(k){
    const el=document.getElementById(CHORE_CFG_FIELDS[k]);
    if(el)raw[k]=el.value;
  });
  return normalizeChoreConfig(raw);
}
function writeChoreCfgForm(cfg){
  Object.keys(CHORE_CFG_FIELDS).forEach(function(k){
    const el=document.getElementById(CHORE_CFG_FIELDS[k]);
    if(el)el.value=cfg[k];
  });
}
function choreCfgInputPreview(){
  const cont=document.getElementById('choreCfgPreview');
  if(!cont)return;
  const cfg=readChoreCfgForm();
  const ex1=choreDailyDecay(cfg.tier1Max,cfg);
  const ex2=choreDailyDecay(cfg.tier2Max,cfg);
  const ex3=choreDailyDecay(cfg.tier2Max+1,cfg);
  cont.innerHTML='超期 '+cfg.tier1Max+' 件 → '+fmt(ex1)+' 活力/天 · 超期 '+cfg.tier2Max+' 件 → '+fmt(ex2)+' 活力/天 · 超期 '+(cfg.tier2Max+1)+' 件及以上 → '+fmt(ex3)+' 活力/天';
}
function openChoreConfigModal(){
  writeChoreCfgForm(choreCfg());
  choreCfgInputPreview();
  openModal('choreConfigModal');
}
function resetChoreConfig(){
  writeChoreCfgForm(defaultChoreConfig());
  choreCfgInputPreview();
}
function saveChoreConfig(){
  const cfg=readChoreCfgForm();
  state.choreConfig=cfg;
  // 规则收紧/放宽后，腐化债从今天重新起算，避免追溯补扣
  (state.chores||[]).forEach(function(c){
    if(!c.done)c.decayKey=dayKey(now());
  });
  closeModal('choreConfigModal');
  commit('杂事经济设置已保存，作为所有杂事的默认');
}

function stageBarHTML(t){
  const cell=stageSel(t);
  const hasV=taskHasType(t,'vitality');
  const hasP=taskHasType(t,'progress');
  // 阶段预览显示实际结算值：档位值 + 连胜利息 - 待扣债
  const c=calcCheckIn(t);
  let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,c):stageNetAt(t,'progress',cell,c));
  reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,c))+' 进度'):(hasV?' 活力':' 进度');
  const label=stageCellLabel(cell);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  const anchorLabels=STAGE_NAMES.map((n,k)=>'<span'+(k===(cell>>1)?' class="on"':'')+' style="left:'+(k*20)+'%">'+n+'</span>').join('');
  let curStreak=t.streak||0;if(curStreak===0&&t.lastCheckIn)curStreak=1;
  let meta='';if(c.bonus>0)meta+='利息+'+fmt(c.bonus);
  if(curStreak>0)meta+=(meta?' · ':'')+'连胜'+curStreak+'天';
  const pend=t.pendingDebt||0;if(pend>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend);
  return '<div class="stage-bar" data-tid="'+t.id+'">'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'<div class="stage-labels">'+anchorLabels+'</div>'
    +'<div class="stage-preview">'+label+' · '+reward+(meta?' · '+meta:'')+'</div>'
    +'</div>';
}

function taskCardHTML(t,collId){
  const c=calcCheckIn(t);
  const s=calcSkip(t);
  const staged=taskIsStaged(t);
  const types=taskScoreTypes(t);
  const hasV=types.indexOf('vitality')>=0;
  const hasP=types.indexOf('progress')>=0;
  const isV=!hasP;
  const name=hasV&&hasP?'活力+进度':(hasP?'进度值':'活力点');
  const posClass=hasP?'pos p':'pos';
  const typeTag=hasV&&hasP
    ?'<span class="tag v">活力点</span><span class="tag p">进度值</span>'
    :(hasP?'<span class="tag p">进度值</span>':'<span class="tag v">活力点</span>');
  const sign=c.net>=0?'+':'';
  const cost=t.vitalityCost||0;
  // Use effective streak for display consistency with calcCheckIn
  let curStreak=t.streak||0;
  if(curStreak===0&&t.lastCheckIn)curStreak=1;

  // Preview: show check-in result and skip penalty
  let prev='';
  prev+='<span style="color:var(--text-2)">打卡</span> <span class="'+posClass+'">'+sign+fmt(c.net)+'</span>';
  if(c.bonus>0)prev+=' <span class="'+posClass+'">(连胜'+c.newStreak+'天 +'+fmt(c.bonus)+')</span>';
  if(c.debt>0)prev+=' <span class="neg">(抵扣待扣债-'+fmt(c.debt)+')</span>';
  if(cost>0)prev+=' <span class="neg">(活力-'+fmt(cost)+')</span>';

  if(s.debt>0){
    prev+='　<span style="color:var(--text-2)">不打卡</span> <span class="neg">待扣债+'+fmt(s.debt)+'</span>';
  }else if(c.isFirst){
    prev+='　<span style="color:var(--text-3)">不打卡：无惩罚</span>';
  }else if(c.gapDays<=0){
    prev+='　<span style="color:var(--text-3)">已打卡</span>';
  }else if(c.gapDays===1){
    prev+='　<span style="color:var(--text-3)">今日未打卡，明日累积待扣债</span>';
  }else{
    prev+='　<span style="color:var(--text-3)">已断更'+(c.gapDays-1)+'天</span>';
  }

  const domTags=!isV?getTaskDomainIds(t).map(did=>'<span class="tag d">'+esc(domainName(did))+'</span>').join(''):'';
  const streakTag=curStreak>0?'<span class="tag d">连胜'+curStreak+'天</span>':'';

  // Exemption card eligibility
  const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const checkedToday=!!(t.lastCheckIn&&new Date(t.lastCheckIn)>=todayStart);
  const exemptToday=!!(t.lastExempt&&new Date(t.lastExempt)>=todayStart);
  const cards=(state.cards&&state.cards.exemption)||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const canExempt=ruleEnabled&&cards>0&&!checkedToday&&!exemptToday;
  const exemptLabel=c.gapDays>=2?'补救':'请假';
  const exemptBtn=canExempt
    ?'<button class="btn btn-sm btn-exempt" title="剩余豁免卡 '+cards+' 张" onclick="useExemption(\''+t.id+'\')">豁免·'+exemptLabel+'</button>'
    :'';

  const checkinBtn='<button class="btn btn-sm btn-checkin" onclick="checkIn(\''+t.id+'\')" '+(cost>0&&state.scores.vitality<cost?'title="活力点不足，将进入负值（贷款）"':'')+'>打卡</button>';
  return '<div class="card task-card" data-task-id="'+t.id+'" data-coll-id="'+(collId||'')+'">'
    +'<div class="task-row">'
    +'<div class="task-title-wrap">'
    +(hasV?'<span class="tdot v" title="活力点"></span>':'')+(hasP?'<span class="tdot p" title="进度值"></span>':'')
    +'<span class="card-title">'+esc(t.name)+'</span>'
    +'</div>'
    +'<div class="task-row-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span>'+checkinBtn+'</div>'
    +'</div>'
    +(staged?'<div class="task-stage-row">'+stageBarHTML(t)+'</div>':'')
    +'<div class="task-extra">'
    +'<div class="card-top">'
    +'<div>'+typeTag+domTags+streakTag+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div>'
    +'</div>'
    +'<div class="card-meta">'
    +'<span>初始 <b>'+fmt(t.initialValue)+'</b></span>'
    +'<span>利率 <b>'+fmt(t.interestRate)+'%</b>/连胜天</span>'
    +'<span>债率 <b>'+fmt(t.debtRate)+'%</b>/断更天</span>'
    +(cost>0?'<span style="color:var(--vitality)">活力消耗 <b>'+fmt(cost)+'</b></span>':'')
    +'<span>打卡 <b>'+(t.checkInCount||0)+'</b>次</span>'
    +'<span>上次 <b>'+fmtTime(t.lastCheckIn)+'</b></span>'
    +'</div>'
    +'<div class="card-bottom">'
    +(staged?stageBarHTML(t):'<div class="preview">'+prev+'</div>')
    +checkinBtn
    +'</div>'
    +'</div>'
    +'</div>';
}

// ===== 阶段奖励：卡片进度条拖拽 =====
// 单个进度条实例的显示更新（滑块位置 / 档位名高亮 / 数值预览）
function applyStageBar(bar,t,cell){
  if(!bar)return;
  const track=bar.querySelector('.stage-track');
  if(track){const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';}
  bar.querySelectorAll('.stage-labels span').forEach(function(n,k){n.classList.toggle('on',k===(cell>>1));});
  const preview=bar.querySelector('.stage-preview');
  if(preview){
    const hasV=taskHasType(t,'vitality'),hasP=taskHasType(t,'progress');
    const cc=calcCheckIn(t);
    let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,cc):stageNetAt(t,'progress',cell,cc));
    reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,cc))+' 进度'):(hasV?' 活力':' 进度');
    let cs=t.streak||0;if(cs===0&&t.lastCheckIn)cs=1;
    let meta='';if(cc.bonus>0)meta+='利息+'+fmt(cc.bonus);
    if(cs>0)meta+=(meta?' · ':'')+'连胜'+cs+'天';
    const pend2=t.pendingDebt||0;if(pend2>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend2);
    preview.textContent=stageCellLabel(cell)+' · '+reward+(meta?' · '+meta:'');
  }
}
// 同一任务在卡片中存在两个进度条实例（长按展开前 / 展开后），统一按 state 中的唯一值刷新
function updateStageBar(track,tid,cell){
  const t=state.tasks.find(x=>x.id===tid);if(!t)return;
  document.querySelectorAll('.stage-bar[data-tid="'+tid+'"]').forEach(function(bar){
    applyStageBar(bar,t,cell);
  });
}
function setStageFromX(track,tid,clientX){
  const t=state.tasks.find(x=>x.id===tid);if(!t||!taskIsStaged(t))return;
  const rect=track.getBoundingClientRect();
  let p=(clientX-rect.left)/rect.width;
  p=Math.max(0,Math.min(1,p));
  let cell=Math.floor(p*10);if(cell>9)cell=9;if(cell<0)cell=0; // 吸附到 10 个格位 0..9
  if(t.stageRewards)t.stageRewards.last=cell;
  updateStageBar(track,tid,cell);
}
function initStageBars(){
  const THRESH=8;
  document.querySelectorAll('.stage-bar[data-tid]').forEach(function(bar){
    const track=bar.querySelector('.stage-track');
    if(!track||track._stageBound)return;
    track._stageBound=true;
    const tid=bar.dataset.tid;
    let startX=0,startY=0,pid=0;
    let dragging=false,decided=false,abandoned=false,dirty=false;
    track.addEventListener('pointerdown',function(e){
      if(!state.tasks.find(x=>x.id===tid))return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
    track.addEventListener('pointermove',function(e){
      if(e.pointerId!==pid||decided)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
      if(Math.abs(dx)>Math.abs(dy)){
        decided=true;dragging=true;
        if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
        e.preventDefault();
        setStageFromX(track,tid,e.clientX);
        dirty=true;
      }else{
        decided=true;abandoned=true;
      }
    });
    track.addEventListener('pointerup',function(e){
      if(e.pointerId!==pid)return;
      if(dirty)save();
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
    track.addEventListener('pointercancel',function(e){
      if(e.pointerId!==pid)return;
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
  });
}

// ===== 任务卡片：长按 1 秒浮现详情，3 秒后自动淡出 =====
let taskReveal={card:null,timer:null,startX:0,startY:0};
function initTaskReveal(){
  document.addEventListener('pointerdown',function(e){
    const card=e.target.closest?e.target.closest('.task-card'):null;
    if(!card)return;
    // 不拦截交互控件（拖拽把手/按钮等）
    if(e.target.closest&&e.target.closest('.drag-handle,.card-actions,button,a,input,select,textarea,.task-extra,.stage-bar'))return;
    taskReveal.card=card;
    taskReveal.startX=e.clientX;taskReveal.startY=e.clientY;
    clearTimeout(taskReveal.timer);
    taskReveal.timer=setTimeout(function(){showTaskExtra(card);},1000);
  });
  document.addEventListener('pointermove',function(e){
    if(!taskReveal.card)return;
    if(Math.abs(e.clientX-taskReveal.startX)>12||Math.abs(e.clientY-taskReveal.startY)>12){
      clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;
    }
  });
  ['pointerup','pointercancel'].forEach(function(ev){
    document.addEventListener(ev,function(){
      if(taskReveal.card){clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;}
    });
  });
  // 阻止长按触发系统右键/文本选择菜单
  document.addEventListener('contextmenu',function(e){
    if(e.target.closest&&e.target.closest('.task-card'))e.preventDefault();
  });
}
function showTaskExtra(card){
  card.classList.add('revealed');
  clearTimeout(card._taskHideTimer);
  card._taskHideTimer=setTimeout(function(){card.classList.remove('revealed');},3000);
}

function achCardHTML(a,domId){
  const prog=domainProgress(a.domainId);
  // 门槛为 0 时避免 0/0 产生 NaN 宽度
  const pct=a.threshold>0?Math.min(100,(prog/a.threshold)*100):(prog>0?100:0);
  return '<div class="card" data-ach-id="'+a.id+'" data-dom-id="'+(domId||a.domainId)+'">'
    +'<div class="card-top">'
    +'<div><span class="tag a">成果</span><span class="card-title">'+(a.unlocked?'✓ ':'')+esc(a.name)+'</span></div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openAchModal(\''+a.id+'\')">编辑</button><button class="del" onclick="confirmDelAch(\''+a.id+'\')">删除</button></div>'
    +'</div>'
    +'<div class="card-meta">'
    +'<span>领域 <b>'+esc(domainName(a.domainId))+'</b></span>'
    +'<span>门槛 <b>'+fmt(a.threshold)+'</b></span>'
    +'<span>奖励 <b>'+fmt(a.points)+'</b>成果点</span>'
    +(a.unlocked?'<span style="color:var(--achievement)">已解锁 · '+fmtTime(a.unlockedAt)+'</span>':'<span>当前 '+fmt(prog)+'/'+fmt(a.threshold)+'</span>')
    +'</div>'
    +(a.unlocked?'':'<div class="prog-bar"><div class="prog-fill" style="width:'+pct+'%"></div></div>')
    +'</div>';
}

// ===== Render: Bank =====
function renderBank(){
  setScoreCell('bVitality',state.scores.vitality);
  setScoreCell('bProgress',totalProgress());
  setScoreCell('bAchievement',state.scores.achievement);

  // Radar (domain capability) + metric chips
  renderRadar();
  renderMetricChips();

  // Loan display
  const lb=document.getElementById('loanBox');
  if(state.loans&&state.loans.length>0){
    lb.style.display='block';
    let lhtml='<div class="lb-title">贷款 ('+state.loans.length+'笔)</div>';
    lhtml+=state.loans.map(l=>{
      const cn=l.currency==='vitality'?'活力点':'成果点';
      const days=l.date?Math.max(0,Math.round((now()-l.date)/864e5)):0;
      const dailyInterest=l.debtRate>0?l.amount*(l.debtRate/100):0;
      return '<div class="loan-item">'
        +'<div class="li-name">'+esc(l.productName)+' · '+cn+(l.debtRate>0?' · 债率'+fmt(l.debtRate)+'%/天':'')+'</div>'
        +'<div class="li-amt">欠 '+fmt(l.amount)+(days>0?' · 已借'+days+'天':'')+(dailyInterest>0?' · 日息-'+fmt(dailyInterest):'')+'</div>'
        +'</div>';
    }).join('');
    lb.innerHTML=lhtml;
  }else{
    lb.style.display='none';
  }

  // Stats
  const vIn=sumLog('vitality',true),vOut=sumLog('vitality',false);
  const pIn=sumLog('progress',true);
  const aIn=sumLog('achievement',true),aOut=sumLog('achievement',false);
  const totalCI=state.tasks.reduce((s,t)=>s+(t.checkInCount||0),0);
  const unlocked=state.achievements.filter(a=>a.unlocked).length;
  const purchases=state.logs.filter(l=>l.src==='purchase').length;

  const vIncomeEl=document.getElementById('vIncome');
  vIncomeEl.textContent=fmt(vIn);
  vIncomeEl.classList.toggle('neg',vIn<0);
  document.getElementById('vSpend').textContent=fmt(vOut);
  const pIncomeEl=document.getElementById('pIncome');
  pIncomeEl.textContent=fmt(pIn);
  pIncomeEl.classList.toggle('neg',pIn<0);
  document.getElementById('totalCheckins').textContent=totalCI;
  const aIncomeEl=document.getElementById('aIncome');
  aIncomeEl.textContent=fmt(aIn);
  aIncomeEl.classList.toggle('neg',aIn<0);
  document.getElementById('achUnlocked').textContent=unlocked;
  const aSpendEl=document.getElementById('aSpend');
  aSpendEl.textContent=fmt(aOut);
  aSpendEl.classList.toggle('neg',aOut<0);
  document.getElementById('totalPurchases').textContent=purchases;

  document.getElementById('bVitalitySub').textContent='收入'+fmt(vIn)+' / 消费'+fmt(vOut);
  document.getElementById('bProgressSub').textContent=state.domains.length+'个领域';
  document.getElementById('bAchSub').textContent='收入'+fmt(aIn)+' / 消费'+fmt(aOut);

  // Milestones grouped by domain
  const ag=document.getElementById('achGroups');
  if(!state.achievements.length){
    ag.innerHTML='<div class="empty"><p>设定里程碑，领域进度达标后自动解锁成果点</p><button class="btn btn-sm" onclick="openAchModal()">新建里程碑</button></div>';
  }else{
    let ahtml='';
    state.domains.forEach(d=>{
      const achs=state.achievements.filter(a=>a.domainId===d.id);
      if(achs.length===0)return;
      const isCollapsed=(state.collapsedAchDoms||[]).includes(d.id);
      const showHeader=state.domains.length>1;
      ahtml+='<div class="ach-dom-group'+(isCollapsed?' collapsed':'')+'" data-dom-id="'+d.id+'">';
      if(showHeader){
        ahtml+='<div class="coll-header" onclick="toggleCollapse(\'ach-domain\',\''+d.id+'\')">';
        ahtml+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(d.name)+' <span class="coll-count">'+achs.length+'个里程碑</span></div>';
        ahtml+='<div class="coll-actions" onclick="event.stopPropagation()">';
        ahtml+='<span class="drag-handle" title="拖拽领域">⋮⋮</span>';
        if(d.id!=='d_default'){
          ahtml+='<button onclick="renameDomain(\''+d.id+'\')">重命名</button><button onclick="delDomain(\''+d.id+'\')">删除</button>';
        }
        ahtml+='<button onclick="openAchModal(null,\''+d.id+'\')">+ 里程碑</button>';
        ahtml+='</div>';
        ahtml+='</div>';
      }
      ahtml+='<div class="coll-body">';
      ahtml+=achs.map(a=>achCardHTML(a,d.id)).join('');
      ahtml+='</div>';
      ahtml+='</div>';
    });
    ag.innerHTML=ahtml;
  }

  drawChart();
  drawVitalityFlowChart();
  drawWeekCompareChart();

  // Logs
  const logTotal=state.logs.length;
  document.getElementById('logMeta').textContent=logTotal+' 条'+(logTotal>LOG_DISPLAY?'（仅显示最近 '+LOG_DISPLAY+' 条）':'');
  const ll=document.getElementById('logList');
  if(!state.logs.length){
    ll.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无记录</p></div>';
  }else{
    // 可撤销白名单直接来自适配器注册表：新增一种可撤销类型只需在 UNDO_ADAPTERS 加 key
    const undoableSrc=Object.keys(UNDO_ADAPTERS);
    ll.innerHTML=state.logs.slice(0,LOG_DISPLAY).map(l=>{
      const isBoth=l.st==='both';
      const cls=l.amt>0?'pos'+(isBoth||l.st==='progress'?' p':l.st==='achievement'?' a':''):l.amt<0?'neg':'zero';
      const dotCls=isBoth?'p':l.st==='vitality'?'v':l.st==='progress'?'p':l.st==='achievement'?'a':'s';
      const sign=l.amt>0?'+':'';
      const amtTxt=l.amt!==0?sign+fmt(l.amt):'—';
      const unit=isBoth?' 活力+进度':l.st==='vitality'?' 活力':l.st==='progress'?' 进度':l.st==='achievement'?' 成果':'';
      const canUndo=undoableSrc.includes(l.src);
      return '<div class="log-item">'
        +'<div class="log-dot '+dotCls+'"></div>'
        +'<div class="log-desc">'+esc(l.desc)+'</div>'
        +'<div class="log-amt '+cls+'">'+amtTxt+unit+'</div>'
        +'<div class="log-time">'+fmtTime(l.time)+'</div>'
        +(canUndo?'<button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button>':'')
        +'</div>';
    }).join('');
  }
}

function sumLog(st,pos){
  return state.logs.filter(l=>logHasType(l,st)&&(pos?logAmt(l,st)>0:logAmt(l,st)<0)).reduce((s,l)=>s+logAmt(l,st),0);
}

// ===== Chart state & interactivity =====
var chartState={trendMode:'cumulative',hiddenSeries:{vitality:false,progress:false,achievement:false}};

function toggleChartSeries(type){
  chartState.hiddenSeries[type]=!chartState.hiddenSeries[type];
  // Update legend visual state
  document.querySelectorAll('.ch-legend .clickable').forEach(el=>{
    const map={'活力':'vitality','进度':'progress','成果':'achievement'};
    const t=map[el.textContent.trim()];
    if(t)el.classList.toggle('dimmed',chartState.hiddenSeries[t]);
  });
  drawChart();
}

function toggleTrendMode(){
  chartState.trendMode=chartState.trendMode==='cumulative'?'daily':'cumulative';
  document.getElementById('trendModeBtn').textContent=chartState.trendMode==='cumulative'?'日增':'累积';
  drawChart();
}

function showChartTip(e,html){
  const tip=document.getElementById('chartTooltip');
  tip.innerHTML=html;
  tip.style.display='block';
  tip.style.left=(e.clientX+12)+'px';
  tip.style.top=(e.clientY-10)+'px';
}
function hideChartTip(){
  document.getElementById('chartTooltip').style.display='none';
}

function drawChart(){
  const svg=document.getElementById('trendChart');
  const days=7;
  const today=new Date();today.setHours(0,0,0,0);
  const dayLabels=[],dayStart=[],dayEnd=[];
  for(let i=days-1;i>=0;i--){
    const d=new Date(today);d.setDate(d.getDate()-i);
    dayLabels.push((d.getMonth()+1)+'/'+d.getDate());
    dayStart.push(d.getTime());
    dayEnd.push(d.getTime()+864e5);
  }
  const types=['vitality','progress','achievement'];
  const typeNames={vitality:'活力',progress:'进度',achievement:'成果'};
  // 取色直接读主题 CSS 变量，避免深/浅色再硬编码一份
  const rootStyle=getComputedStyle(document.documentElement);
  function cssVar(name,fallback){const v=(rootStyle.getPropertyValue(name)||'').trim();return v||fallback;}
  const colors={
    vitality:cssVar('--vitality','#5b9a6e'),
    progress:cssVar('--progress','#5b7fa8'),
    achievement:cssVar('--achievement','#b08640')
  };
  const gridColor=cssVar('--border','#e0e0e0');
  const labelColor=cssVar('--text-3','#aaa');
  const zeroColor=cssVar('--border-2','#ccc');
  // 一次遍历日志按天分桶（每类每天净额）；累计模式再做前缀和，避免 O(3×7×logs) 反复扫描
  const windowStart=dayStart[0];
  const windowEnd=dayEnd[days-1];
  const before={};
  const daily={};
  types.forEach(type=>{before[type]=0;daily[type]=new Array(days).fill(0);});
  state.logs.forEach(l=>{
    const t=l.time;
    if(t>=windowEnd)return;
    if(t<windowStart){
      types.forEach(type=>{if(logHasType(l,type))before[type]+=logAmt(l,type);});
      return;
    }
    for(let i=days-1;i>=0;i--){
      if(t>=dayStart[i]){
        types.forEach(type=>{if(logHasType(l,type))daily[type][i]+=logAmt(l,type);});
        return;
      }
    }
  });
  const series={};
  types.forEach(type=>{
    series[type]=[];
    let run=before[type];
    for(let i=0;i<days;i++){
      if(chartState.trendMode==='cumulative'){
        run+=daily[type][i];
        series[type].push(run);
      }else{
        series[type].push(daily[type][i]);
      }
    }
  });
  let maxVal=1;
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    series[type].forEach(v=>{if(Math.abs(v)>maxVal)maxVal=Math.abs(v)});
  });
  const W=700,H=140,padL=36,padR=8,padT=8,padB=22;
  const cW=W-padL-padR,cH=H-padT-padB,stepX=cW/(days-1);
  // 基线：任一可见序列出现负值（负债）时，0 线居中、上下对称展开；
  // daily 与 cumulative 都适用，避免累计模式下负值折线跑到图表下方
  const hasNeg=types.some(t=>!chartState.hiddenSeries[t]&&series[t].some(v=>v<0));
  const baseline=hasNeg?padT+cH/2:padT+cH;
  function pt(type,i){
    const x=padL+i*stepX;
    const y=baseline-(series[type][i]/maxVal)*(hasNeg?cH/2:cH);
    return[x,y];
  }
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    // 有负值时纵轴从 +maxVal 到 -maxVal，0 刻度正好落在居中基线上
    const val=hasNeg?Math.round(maxVal-(maxVal/2)*g):Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // 0 线（daily / cumulative 有负值时均绘制）
  if(hasNeg){
    s+='<line x1="'+padL+'" y1="'+baseline+'" x2="'+(W-padR)+'" y2="'+baseline+'" stroke="'+zeroColor+'" stroke-width="1.5"/>';
  }
  // X axis labels
  dayLabels.forEach((label,i)=>{
    const x=padL+i*stepX;
    s+='<text x="'+x+'" y="'+(H-5)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
  });
  // Draw lines and dots for each visible series
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    let path='';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      path+=(i===0?'M':'L')+x+','+y+' ';
    });
    s+='<path class="svg-line" d="'+path+'" fill="none" stroke="'+colors[type]+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      const tipHtml=typeNames[type]+' · '+dayLabels[i]+'<br><b>'+fmt(v)+'</b>';
      s+='<circle class="svg-dot" cx="'+x+'" cy="'+y+'" r="3" fill="'+colors[type]+'" onmouseover="showChartTip(event,\''+tipHtml.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    });
  });
  svg.innerHTML=s;
}

function drawVitalityFlowChart(){
  const svg=document.getElementById('flowChart');
  const weeks=4;
  const today=new Date();today.setHours(0,0,0,0);
  // Calculate week boundaries
  const weekRanges=[];
  for(let i=0;i<weeks;i++){
    const end=i===0?today.getTime()+864e5:weekRanges[i-1].start;
    const start=end-7*864e5;
    weekRanges.push({start:start,end:end});
  }
  const weekLabels=weekRanges.map((wr,i)=>{
    if(i===0)return'本周';
    if(i===1)return'上周';
    return(i+1)+'周前';
  });
  // For each week, categorize vitality flow:
  // 产出: vitality earned from check-ins (src='checkin', st='vitality', amt>0)
  // 投资: vitality spent on progress task costs (src='cost', amt<0)
  // 消费: vitality spent on shop purchases (src='purchase', st='vitality', amt<0)
  const produceData=[],investData=[],consumeData=[];
  weekRanges.forEach(wr=>{
    let prod=0,inv=0,cons=0;
    state.logs.forEach(l=>{
      if(l.time>=wr.start&&l.time<wr.end){
        if(l.src==='checkin'&&(l.st==='vitality'||l.st==='both')&&logAmt(l,'vitality')>0)prod+=logAmt(l,'vitality');
        else if(l.src==='cost'&&l.amt<0)inv+=Math.abs(l.amt);
        else if(l.src==='purchase'&&l.st==='vitality'&&l.amt<0)cons+=Math.abs(l.amt);
      }
    });
    produceData.push(prod);
    investData.push(inv);
    consumeData.push(cons);
  });
  const maxVal=Math.max(1,...produceData,...investData,...consumeData);
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorProd=isDark?'#7ab088':'#5b9a6e';
  const colorInv=isDark?'#7894b5':'#5b7fa8';
  const colorCons=isDark?'#c47b6e':'#c2615a';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  const W=700,H=180,padL=36,padR=8,padT=8,padB=30;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks;
  const barW=groupW*0.18;
  const gap=barW*0.25;
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // Bars and labels for each week
  weekLabels.forEach((label,i)=>{
    const gc=padL+groupW*i+groupW/2;
    // Production bar (left)
    const pH=(produceData[i]/maxVal)*cH;
    const pX=gc-gap*1.5-barW;
    const pY=padT+cH-pH;
    const pTip='产出 · '+label+'<br><b>'+fmt(produceData[i])+'</b> 活力';
    s+='<rect class="svg-bar" x="'+pX+'" y="'+pY+'" width="'+barW+'" height="'+pH+'" fill="'+colorProd+'" rx="2" onmouseover="showChartTip(event,\''+pTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Investment bar (center)
    const iH=(investData[i]/maxVal)*cH;
    const iX=gc-barW/2;
    const iY=padT+cH-iH;
    const iTip='投资 · '+label+'<br><b>'+fmt(investData[i])+'</b> 活力 → 进度任务';
    s+='<rect class="svg-bar" x="'+iX+'" y="'+iY+'" width="'+barW+'" height="'+iH+'" fill="'+colorInv+'" rx="2" onmouseover="showChartTip(event,\''+iTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Consumption bar (right)
    const cH2=(consumeData[i]/maxVal)*cH;
    const cX=gc+gap*1.5;
    const cY=padT+cH-cH2;
    const cTip='消费 · '+label+'<br><b>'+fmt(consumeData[i])+'</b> 活力 → 商店购买';
    s+='<rect class="svg-bar" x="'+cX+'" y="'+cY+'" width="'+barW+'" height="'+cH2+'" fill="'+colorCons+'" rx="2" onmouseover="showChartTip(event,\''+cTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Week label
    s+='<text x="'+gc+'" y="'+(H-14)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
    // Efficiency rate below
    const totalSpend=investData[i]+consumeData[i];
    const rate=totalSpend>0?Math.round(investData[i]/totalSpend*100):0;
    const rateColor=rate>=50?colorInv:colorCons;
    s+='<text x="'+gc+'" y="'+(H-3)+'" text-anchor="middle" font-size="9" fill="'+rateColor+'" font-weight="600">投资率 '+rate+'%</text>';
  });
  // Baseline
  s+='<line x1="'+padL+'" y1="'+(padT+cH)+'" x2="'+(W-padR)+'" y2="'+(padT+cH)+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.5"/>';
  svg.innerHTML=s;
}

function drawWeekCompareChart(){
  const svg=document.getElementById('weekCompareChart');
  if(!svg)return;
  const summaryEl=document.getElementById('weekCompareSummary');
  const weeks=6,anchor=1;
  const today=new Date();today.setHours(0,0,0,0);
  const ranges=[];
  for(let i=weeks-1;i>=0;i--){
    const start=weekStartTs(anchor,today.getTime())-i*7*864e5;
    ranges.push({start:start,end:start+7*864e5});
  }
  const data=ranges.map((r,i)=>{
    const w=weekScore(r.start,r.end);
    const label=i===weeks-1?'本周':i===weeks-2?'上周':((weeks-1-i)+'周前');
    return {label:label,score:w.score,investRate:w.investRate,prog:w.prog,vit:w.vit,ach:w.ach,checkins:w.checkins,invest:w.invest,consume:w.consume};
  });
  const cur=data[weeks-1],prev=data[weeks-2];
  if(summaryEl&&cur&&prev){
    const delta=cur.score-prev.score;
    const cls=delta>0?'up':delta<0?'down':'';
    const arrow=delta>0?'↑':delta<0?'↓':'＝';
    summaryEl.innerHTML='<b>'+fmt(cur.score)+'</b> vs <b>'+fmt(prev.score)+'</b> <span class="'+cls+'">'+arrow+' '+fmt(Math.abs(delta))+'</span>';
  }
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorBar=isDark?'#7894b5':'#5b7fa8';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const colorLine=isDark?'#7ab088':'#5b9a6e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  let minScore=0,maxScore=1;
  data.forEach(d=>{if(d.score<minScore)minScore=d.score;if(d.score>maxScore)maxScore=d.score;});
  if(minScore>0)minScore=0;
  if(maxScore<=0)maxScore=1;
  const W=700,H=220,padL=42,padR=48,padT=14,padB=26;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks,barW=groupW*0.5;
  const range=(maxScore-minScore)||1;
  const yScore=v=>padT+cH-((v-minScore)/range)*cH;
  const yInvest=v=>padT+cH-(Math.max(0,Math.min(100,v))/100)*cH;
  const xCenter=i=>padL+groupW*i+groupW/2;
  let s='';
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=maxScore-(range/4)*g;
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+fmt(val)+'</text>';
  }
  if(minScore<0){
    const y0=yScore(0);
    s+='<line x1="'+padL+'" y1="'+y0+'" x2="'+(W-padR)+'" y2="'+y0+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.2"/>';
  }
  [['0','0%'],['50','50%'],['100','100%']].forEach(pair=>{
    const y=yInvest(Number(pair[0]));
    s+='<text x="'+(W-padR+6)+'" y="'+(y+3)+'" font-size="9" fill="'+labelColor+'">'+pair[1]+'</text>';
  });
  let ratePath='';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    ratePath+=(i===0?'M':'L')+x+','+y+' ';
  });
  s+='<path d="'+ratePath+'" fill="none" stroke="'+colorLine+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    const rTip=d.label+' 投资率 <b>'+fmt(d.investRate)+'%</b>';
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+colorLine+'" onmouseover="showChartTip(event,\''+rTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  data.forEach((d,i)=>{
    const x=xCenter(i);
    const y0=yScore(0),yy=yScore(d.score);
    const yTop=Math.min(y0,yy),hBar=Math.max(1,Math.abs(yy-y0));
    const fill=d.score<0?colorNeg:colorBar;
    const tip='<b>'+d.label+'</b> 总分 '+fmt(d.score)
      +'<br>进度 +'+fmt(d.prog)+'　活力 '+fmt(d.vit)
      +'<br>成果 +'+fmt(d.ach)+'　打卡 '+d.checkins+'次'
      +'<br>投资 '+fmt(d.invest)+'　消费 '+fmt(d.consume)
      +'<br>投资率 '+fmt(d.investRate)+'%';
    s+='<rect class="svg-bar" x="'+(x-barW/2)+'" y="'+yTop+'" width="'+barW+'" height="'+hBar+'" fill="'+fill+'" rx="2" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    s+='<text x="'+x+'" y="'+(yTop-4)+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+labelColor+'">'+fmt(d.score)+'</text>';
    s+='<text x="'+x+'" y="'+(H-8)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+d.label+'</text>';
  });
  svg.innerHTML=s;
}

// ===== Render: Radar (domain capability) =====
function renderRadar(){
  const svg=document.getElementById('radarChart');
  const empty=document.getElementById('radarEmpty');
  const metrics=state.metrics||[];
  if(!metrics.length){
    svg.style.display='none';
    empty.style.display='block';
    empty.innerHTML='<p>尚未设定指标，雷达图将按指标汇总领域进度展示</p><button class="btn btn-sm" onclick="openMetricModal()">新建指标</button>';
    return;
  }
  svg.style.display='block';
  empty.style.display='none';
  empty.innerHTML='';
  // Radar rendering
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorMain=isDark?'#7894b5':'#5b7fa8';
  const colorFill=isDark?'rgba(120,148,181,.18)':'rgba(91,127,168,.15)';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#888';
  const N=metrics.length;
  const vals=metrics.map(m=>metricValue(m));
  const maxVal=Math.max(1,...vals.map(v=>Math.abs(v)));
  const cx=150,cy=150,R=88;
  const ang=i=>-Math.PI/2+i*(2*Math.PI/N);
  const xyr=(i,r)=>{const a=ang(i);return[cx+Math.cos(a)*r,cy+Math.sin(a)*r]};
  // Radii for grid rings (clamp negatives to 0)
  const rad=i=>Math.max(0,Math.min(1,vals[i]/maxVal))*R;
  let s='';
  // Concentric grid polygons (4 rings)
  for(let ring=1;ring<=4;ring++){
    const rr=R*ring/4;
    let pts='';
    for(let i=0;i<N;i++){const[x,y]=xyr(i,rr);pts+=(i?' ':'')+x+','+y;}
    s+='<polygon points="'+pts+'" fill="none" stroke="'+gridColor+'" stroke-width="1"/>';
    // Ring value label (small, top-left)
    const ringVal=Math.round(maxVal*ring/4*100)/100;
    s+='<text x="'+(cx+8)+'" y="'+(cy-rr)+'" font-size="8" fill="'+labelColor+'">'+fmt(ringVal)+'</text>';
  }
  // Axis lines
  for(let i=0;i<N;i++){
    const[x,y]=xyr(i,R);
    s+='<line x1="'+cx+'" y1="'+cy+'" x2="'+x+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
  }
  // Data polygon
  let dataPts='';
  for(let i=0;i<N;i++){const[x,y]=xyr(i,rad(i));dataPts+=(i?' ':'')+x+','+y;}
  s+='<polygon points="'+dataPts+'" fill="'+colorFill+'" stroke="'+colorMain+'" stroke-width="1.5" stroke-linejoin="round"/>';
  // Vertices + labels + hit areas
  metrics.forEach((m,i)=>{
    const[x,y]=xyr(i,rad(i));
    const neg=vals[i]<0;
    const shortName=m.name.length>6?m.name.slice(0,6)+'…':m.name;
    // Axis name label (outside vertex)
    const lx2=cx+Math.cos(ang(i))*(R+18), ly2=cy+Math.sin(ang(i))*(R+18);
    const anchor=Math.abs(Math.cos(ang(i)))<0.3?'middle':(Math.cos(ang(i))>0?'start':'end');
    s+='<text x="'+lx2+'" y="'+ly2+'" text-anchor="'+anchor+'" font-size="10" fill="'+labelColor+'">'+esc(shortName)+'</text>';
    // Value label (inside/near vertex)
    const vx=cx+Math.cos(ang(i))*(rad(i)+14), vy=cy+Math.sin(ang(i))*(rad(i)+14);
    s+='<text x="'+vx+'" y="'+vy+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+(neg?colorNeg:colorMain)+'">'+fmt(vals[i])+'</text>';
    // Vertex dot
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+(neg?colorNeg:colorMain)+'"/>';
    // Hit area for tooltip
    const tip='<b>'+esc(m.name)+'</b><br>总值 '+fmt(vals[i])
      +(m.domainIds||[]).map(did=>'<br>· '+esc(domainName(did))+' '+fmt(domainProgress(did))).join('');
    s+='<circle cx="'+x+'" cy="'+y+'" r="10" fill="transparent" style="cursor:pointer" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  svg.innerHTML=s;
}
function renderMetricChips(){
  const mc=document.getElementById('metricChips');
  if(!mc)return;
  const metrics=state.metrics||[];
  let html=metrics.map(m=>{
    const val=metricValue(m);
    const doms=(m.domainIds||[]).map(did=>domainName(did)).join('、');
    return '<div class="metric-chip" onclick="openMetricModal(\''+m.id+'\')" title="领域：'+esc(doms)+'">'
      +'<span class="mc-name">'+esc(m.name)+'</span>'
      +'<span class="mc-val'+(val<0?' neg':'')+'">'+fmt(val)+'</span>'
      +'<button class="mc-del" title="删除指标" onclick="event.stopPropagation();delMetric(\''+m.id+'\')">×</button>'
      +'</div>';
  }).join('');
  html+='<div class="metric-chip add" onclick="openMetricModal()">+ 指标</div>';
  mc.innerHTML=html;
}

// ===== Render: Shop =====
function renderShop(){
  setScoreCell('sVitality',state.scores.vitality);
  setScoreCell('sAchievement',state.scores.achievement);

  const sl=document.getElementById('shopList');
  let html='';
  state.shopCategories.forEach(cat=>{
    // Filter out sold-out products (stock===0) — they go to the sold-out section
    const prods=state.products.filter(p=>(p.categoryId||'sc_default')===cat.id&&p.stock!==0);
    const isCollapsed=(state.collapsedShopCats||[]).includes(cat.id);
    html+='<div class="shop-cat-group'+(isCollapsed?' collapsed':'')+'" data-cat-id="'+cat.id+'">';
    // Category header (clickable to toggle collapse)
    html+='<div class="coll-header" onclick="toggleCollapse(\'shop-category\',\''+cat.id+'\')">';
    html+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(cat.name)+' <span class="coll-count">'+prods.length+'件</span></div>';
    html+='<div class="coll-actions" onclick="event.stopPropagation()">';
    html+='<span class="drag-handle" title="拖拽分类">⋮⋮</span>';
    html+='<button onclick="openProdModal(null,\''+cat.id+'\')">+ 商品</button>';
    if(cat.id!=='sc_default'){
      html+='<button onclick="renameShopCategory(\''+cat.id+'\')">重命名</button><button onclick="delShopCategory(\''+cat.id+'\')">删除</button>';
    }
    html+='</div>';
    html+='</div>';
    // Body (collapsible)
    html+='<div class="coll-body">';
    if(prods.length===0){
      html+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无商品 · 拖拽 ⋮⋮ 按钮可排序或跨分类移动</p></div>';
    }else{
      html+='<div class="shop-grid">'+prods.map(p=>shopCardHTML(p,cat.id)).join('')+'</div>';
    }
    html+='</div>';
    html+='</div>';
  });

  // Sold-out section
  const soldoutProds=state.products.filter(p=>p.stock===0);
  if(soldoutProds.length>0){
    const isSoldCollapsed=(state.collapsedShopCats||[]).includes('sc_soldout');
    html+='<div class="shop-cat-group'+(isSoldCollapsed?' collapsed':'')+'" data-cat-id="sc_soldout">';
    html+='<div class="coll-header" onclick="toggleCollapse(\'shop-category\',\'sc_soldout\')">';
    html+='<div class="coll-name"><span class="coll-toggle">▼</span>售罄 <span class="coll-count">'+soldoutProds.length+'件</span></div>';
    html+='<div class="coll-actions" onclick="event.stopPropagation()">';
    html+='</div>';
    html+='</div>';
    html+='<div class="coll-body">';

    // Group sold-out products by their original categoryId
    const soldByCat={};
    soldoutProds.forEach(function(p){
      const catId=p.categoryId||'sc_default';
      if(!soldByCat[catId])soldByCat[catId]=[];
      soldByCat[catId].push(p);
    });

    // Render each sub-group
    Object.keys(soldByCat).forEach(function(catId){
      const cat=state.shopCategories.find(function(c){return c.id===catId;});
      const catName=cat?cat.name:'默认';
      const prods=soldByCat[catId];

      // Build category options for the dropdown
      const catOptions=state.shopCategories.map(function(c){
        return '<option value="'+c.id+'"'+(c.id===catId?' selected':'')+'>'+esc(c.name)+'</option>';
      }).join('');

      html+='<div class="soldout-sub" data-prev-cat-id="'+catId+'">';
      html+='<div class="soldout-sub-header">';
      html+='<div class="ss-name"><span class="drag-handle" title="拖拽排序">⋮⋮</span>'+esc(catName)+'</div>';
      html+='<select onchange="changeSoldoutCat(this,\''+catId+'\')">'+catOptions+'</select>';
      html+='</div>';
      html+='<div class="shop-grid">'+prods.map(function(p){return shopCardHTML(p,'sc_soldout',catId);}).join('')+'</div>';
      html+='</div>';
    });

    html+='</div>';
    html+='</div>';
  }

  sl.innerHTML=html;

  const pl=document.getElementById('purchaseList');
  const purchases=state.logs.filter(l=>l.src==='purchase');
  if(!purchases.length){
    pl.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无购买记录</p></div>';
  }else{
    pl.innerHTML=purchases.slice(0,50).map(l=>{
      const dotCls=l.st==='vitality'?'v':'a';
      return '<div class="log-item"><div class="log-dot '+dotCls+'"></div><div class="log-desc">'+esc(l.desc)+'</div><div class="log-amt neg">'+fmt(l.amt)+'</div><div class="log-time">'+fmtTime(l.time)+'</div><button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button></div>';
    }).join('');
  }
}

// Product card HTML helper
function shopCardHTML(p,catId,prevCatId){
  const tier=validProductTier(p.tier);
  const cur=tierCurrency(tier);
  const isV=cur==='vitality';
  const cn=isV?'活力点':'成果点';
  const balance=state.scores[cur];
  const willLoan=balance<p.price;
  const isSoldout=p.stock===0;
  const gate=evaluateProductGate(p);
  const locked=gate.deny&&!isSoldout;
  const stockTxt=p.stock===-1?'':p.stock===0?' · 售罄':' · 库存'+p.stock;
  const debtTxt=(p.debtRate||0)>0?' · 债率'+fmt(p.debtRate)+'%/天':'';
  const loanWarn=willLoan&&!isSoldout&&!gate.deny?' · 贷款'+fmt(p.price-balance):'';
  const soldoutCls=isSoldout?' soldout':'';
  const lockedCls=locked?' locked':'';
  const dataPrevCat=prevCatId?' data-prev-cat-id="'+prevCatId+'"':'';
  const tierTxt=' · '+(PROD_TIER_NAMES[tier]||PROD_TIER_NAMES.daily);
  const gateHTML=gate.deny?'<div class="sh-gate">'+gate.reasons.map(function(r){return '<div>'+esc(r)+'</div>';}).join('')+'</div>':'';
  const buyHTML=isSoldout
    ?'<div class="sh-buy" style="text-align:center;font-size:12px;color:var(--text-3);padding:8px">售罄</div>'
    :gate.deny
      ?'<button class="btn btn-sm sh-buy" disabled>门槛未达标</button>'
      :'<button class="btn btn-sm sh-buy" onclick="buyProduct(\''+p.id+'\')">'+(willLoan?'贷款购买':'购买')+'</button>';
  return '<div class="shop-card'+soldoutCls+lockedCls+'" data-prod-id="'+p.id+'" data-cat-id="'+catId+'"'+dataPrevCat+'>'
    +'<div class="card-top" style="margin-bottom:0"><div class="sh-name">'+esc(p.name)+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序或跨分类移动">⋮⋮</span><button onclick="openProdModal(\''+p.id+'\')">编辑</button><button class="del" onclick="confirmDelProd(\''+p.id+'\')">删除</button></div></div>'
    +(p.desc?'<div class="sh-desc">'+esc(p.desc)+'</div>':'')
    +'<div class="sh-cost '+(isV?'v':'a')+'">'+fmt(p.price)+'<span class="unit">'+cn+tierTxt+stockTxt+debtTxt+loanWarn+'</span></div>'
    +gateHTML
    +buyHTML
    +'</div>';
}

// Change sold-out product's original category (sub-grouping)
function changeSoldoutCat(sel,oldCatId){
  const newCatId=sel.value;
  // Move all sold-out products from oldCatId to newCatId
  state.products.forEach(function(p){
    if(p.stock===0&&(p.categoryId||'sc_default')===oldCatId){
      p.categoryId=newCatId;
    }
  });
  save();
  render();
  toast('售罄商品分类已更新');
}

// ===== Render All =====
function render(){renderWork();renderBank();renderShop();renderCycle();updateExemptChip();initStageBars();initAffairAxes()}

// ===== Cycle Settings (周期活动) =====
function fmtDate(ts){
  if(!ts)return '—';
  const d=new Date(ts);
  const today=new Date();today.setHours(0,0,0,0);
  const diffDays=Math.round((ts-today.getTime())/864e5);
  if(diffDays===0)return '今天';
  if(diffDays===1)return '明天';
  if(diffDays===2)return '后天';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function cycleNextGrant(cfg){
  const anchor=cfg.anchor||1;
  if(cfg.period==='day'){const d=new Date();d.setHours(0,0,0,0);return d.getTime()+864e5;}
  if(cfg.period==='month'){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();}
  const d=new Date();d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=anchor-dow;if(diff<=0)diff+=7;
  return d.getTime()+diff*864e5;
}
function updateExemptChip(){
  const chip=document.getElementById('exemptChip');
  if(!chip)return;
  const bal=state.cards.exemption||0;
  chip.style.display=bal>0?'inline-flex':'none';
  chip.textContent='豁免卡 × '+bal;
}
function periodLabel(p){return p==='day'?'每天':p==='month'?'每月':'每周';}
const COND_METRICS=[
  {v:'checkins',n:'打卡次数'},
  {v:'vitality',n:'活力点'},
  {v:'progress',n:'进度值'},
  {v:'achievement',n:'成果点'},
  {v:'new_tasks',n:'新增任务'},
  {v:'new_domains',n:'新增领域'}
];
const COND_TARGET_TYPES=[{v:'all',n:'全部'},{v:'domain',n:'按领域'},{v:'task',n:'按任务'}];
const COND_NEW_FILTERS=[{v:'none',n:'当前'},{v:'new_task',n:'本周期新增任务'},{v:'new_domain',n:'本周期新增领域'}];
const COND_AGGREGATES=[{v:'sum',n:'总计'},{v:'any',n:'任意单个'}];
// 主体类型：成果点仅全部；计数类(新增任务/新增领域)支持全部+领域；值类(打卡/活力/进度)支持全部+领域+任务
function condTargetTypesFor(metric){
  if(metric==='achievement')return ['all'];
  if(metric==='new_tasks'||metric==='new_domains')return ['all','domain'];
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
  if(act.period==='day')return '昨日';
  if(act.period==='month')return '上月';
  return '上周';
}
function condItemLabel(it){
  if(!it)return '';
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
function rewardItemLabel(it){
  if(!it)return '';
  if(it.type==='card')return cardName(it.card||'exemption')+' ×'+(it.amount||0)+(it.cap?'（上限'+(it.cap||0)+'）':'');
  if(it.type==='progress'){
    if(it.domainId)return domainName(it.domainId)+'进度 +'+fmt(it.amount);
    return '进度(全领域) +'+fmt(it.amount);
  }
  if(it.type==='vitality'){
    const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
    return tName?('「'+tName+'」活力 +'+fmt(it.amount)):('活力 +'+fmt(it.amount));
  }
  if(it.type==='achievement')return '成果 +'+fmt(it.amount);
  return '';
}
function actMetaLabel(a){
  const c=a.condition||{mode:'all',items:[]};
  const condItems=c.items||[];
  const condTxt=condItems.length?condItems.map(condNodeLabel).join(c.mode==='any'?' 或 ':' 且 '):'无条件';
  const resItems=(a.result&&a.result.items)||[];
  const resTxt=resItems.length?resItems.map(rewardItemLabel).join('、'):'无';
  return '前提：'+condTxt+'　结果：'+resTxt;
}
function readRewardItems(){
  const rewardItems=[];
  document.querySelectorAll('#activityResultDetails .reward-row').forEach(row=>{
    const type=row.querySelector('.rr-type').value;
    const amount=Math.max(0,Number(row.querySelector('.rr-amount').value)||0);
    if(amount<=0&&type!=='card')return;
    if(type==='card'){
      rewardItems.push({type:'card',card:'exemption',amount:Math.round(amount),cap:Math.max(1,Math.round(Number(row.querySelector('.rr-cap').value)||3))});
    }else if(type==='progress'){
      const did=row.querySelector('.rr-domain').value;
      const r={type:'progress',amount:amount};
      if(did)r.domainId=did;
      rewardItems.push(r);
    }else if(type==='vitality'){
      const tid=row.querySelector('.rr-task').value;
      const r={type:'vitality',amount:amount};
      if(tid)r.taskId=tid;
      rewardItems.push(r);
    }else if(type==='achievement'){
      rewardItems.push({type:'achievement',amount:amount});
    }
  });
  return rewardItems;
}
function updateCondPreview(){
  const el=document.getElementById('condPreview');
  if(!el)return;
  const items=condDraft.items||[];
  const mode=condDraft.mode==='any'?'any':'all';
  const period=document.getElementById('activityPeriod').value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
  const when=period==='day'?'每天结算时':period==='month'?'每月结算时':('每'+anchorNames[anchor]+'结算时');
  const actLike={period:period};
  let condTxt;
  if(!items.length)condTxt='无条件触发';
  else condTxt=items.map(n=>condNLNode(n,actLike)).join(mode==='any'?' 或 ':' 且 ');
  const rewards=readRewardItems();
  const resTxt=rewards.length?rewards.map(rewardItemLabel).join('、'):'（未设置奖励）';
  el.innerHTML='<span class="cp-badge">预览</span>'+esc(when)+'，若 '+esc(condTxt)+'，则发放 '+esc(resTxt)+'。';
}
function openActivityModal(id){
  const a=id?state.activities.find(x=>x.id===id):null;
  document.getElementById('activityId').value=id||'';
  document.getElementById('activityModalTitle').textContent=id?'编辑周期活动':'新建周期活动';
  document.getElementById('activityName').value=a?a.name:'';
  document.getElementById('activityPeriod').value=a?a.period:'week';
  document.getElementById('activityAnchor').value=a?(a.anchor||1):1;
  condDraft=normalizeCondition((a&&a.condition)||{mode:'all',items:[]});
  document.getElementById('activityCondMode').value=(condDraft.mode==='any')?'any':'all';
  document.getElementById('activityDeleteBtn').style.display=id?'':'none';
  renderActivityResultDetails(a?a.result:null);
  renderCondTree();
  activityPeriodChanged();
  // 折叠分区：基本信息展开，前提与奖励默认收起以保持简洁（标题栏显示摘要）
  setAcc('accBasic',true);
  setAcc('accCond',false);
  setAcc('accResult',false);
  updateActivitySummary();
  openModal('activityModal');
  setTimeout(()=>document.getElementById('activityName').focus(),50);
}
function activityPeriodChanged(){
  const p=document.getElementById('activityPeriod').value;
  document.getElementById('activityAnchorFg').style.display=(p==='week')?'':'none';
  updateCondPreview();
  updateActivitySummary();
}
function toggleAcc(id){const el=document.getElementById(id);if(el)el.classList.toggle('open');}
function setAcc(id,open){const el=document.getElementById(id);if(el)el.classList.toggle('open',open);}
function updateActivitySummary(){
  const periodSel=document.getElementById('activityPeriod');
  if(periodSel){
    const p=periodSel.value;
    const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
    const a=parseInt(document.getElementById('activityAnchor').value,10)||1;
    const basicSum=document.getElementById('accBasicSum');
    if(basicSum)basicSum.textContent=p==='week'?('每周 · '+anchorNames[a]):periodLabel(p);
  }
  const condMode=document.getElementById('activityCondMode');
  const condSum=document.getElementById('accCondSum');
  if(condSum){
    const n=countCondLeaves(condDraft.items||[]);
    const m=(condMode&&condMode.value==='any')?'任一':'全部';
    condSum.textContent=n?((m==='任一'?'任一满足':'全部满足')+' · '+n+' 项'):'无条件';
  }
  const resBox=document.getElementById('activityResultDetails');
  const resSum=document.getElementById('accResultSum');
  if(resSum&&resBox){
    const n=resBox.querySelectorAll('.reward-row').length;
    resSum.textContent=n?(n+' 项奖励'):'未设置';
  }
}
// ===== 条件芯片编辑器（嵌套条件组 + 点选面板）=====
function countCondLeaves(items){
  return (items||[]).reduce((s,node)=>{
    if(node&&node.group)return s+countCondLeaves(node.items);
    return s+1;
  },0);
}
function condListAt(parentPath){
  if(!parentPath)return condDraft.items;
  const parts=parentPath.split('/').map(Number);
  let list=condDraft.items;
  for(const idx of parts){
    const node=list[idx];
    if(!node||!node.group)return condDraft.items;
    list=node.items;
  }
  return list;
}
function condNodeAt(path){
  if(!path)return null;
  const parts=path.split('/').filter(Boolean).map(Number);
  let list=condDraft.items;
  let node=null;
  for(let i=0;i<parts.length;i++){
    const idx=parts[i];
    if(idx<0||idx>=list.length)return null;
    node=list[idx];
    if(node&&node.group)list=node.items;
  }
  return node;
}
function condMetricChipText(it){
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it);
}
function condItemRow(it,path){
  it=it||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'};
  return '<div class="cond-chip-line">'
    +'<button class="cc-chip cc-metric" title="点击修改指标" onclick="openCondMetricPanel(\''+path+'\',this)">'+esc(condMetricChipText(it))+'</button>'
    +'<button class="cc-chip cc-op" title="点击修改运算符" onclick="openCondOpPanel(\''+path+'\',this)">'+esc(opLabel(it.op))+'</button>'
    +'<button class="cc-chip cc-value" title="点击修改数值" onclick="editCondValue(\''+path+'\',this)">'+esc(fmt(it.value))+'</button>'
    +'<button class="cc-del" title="删除此条件" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>';
}
function condGroupInnerHTML(group,path,depth){
  const items=group.items||[];
  if(!items.length)return '<div class="cond-empty-sm">组内还没有条件</div>';
  return renderCondNodes(items,path,depth+1);
}
function condGroupHTML(group,path,depth){
  const canNest=depth<1;
  return '<div class="cond-group">'
    +'<div class="cond-group-head">'
    +'<span class="cg-label">满足</span>'
    +'<select class="cg-mode" onchange="changeGroupMode(\''+path+'\',this.value)">'
    +'<option value="all"'+(group.mode==='any'?'':' selected')+'>全部</option>'
    +'<option value="any"'+(group.mode==='any'?' selected':'')+'>任意</option>'
    +'</select>'
    +'<span class="cg-label2">以下条件</span>'
    +'<button class="cc-del" title="删除此条件组" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>'
    +'<div class="cond-group-body">'
    +condGroupInnerHTML(group,path,depth)
    +'<div class="cond-actions">'
    +'<button class="btn btn-sm" onclick="addCondItem(\''+path+'\')">+ 添加条件</button>'
    +(canNest?'<button class="btn btn-sm" onclick="addCondGroup(\''+path+'\')">+ 添加条件组</button>':'')
    +'</div>'
    +'</div></div>';
}
function renderCondNodes(items,parentPath,depth){
  return (items||[]).map((node,idx)=>{
    const path=parentPath?parentPath+'/'+idx:String(idx);
    return (node&&node.group)?condGroupHTML(node,path,depth):condItemRow(node,path);
  }).join('');
}
function renderCondTree(){
  const box=document.getElementById('activityCondItems');
  if(!box)return;
  box.innerHTML=(condDraft.items&&condDraft.items.length)?renderCondNodes(condDraft.items,'',0):'<div class="cond-empty">还没有条件，满足任意情况即触发</div>';
  updateCondPreview();
  updateActivitySummary();
}
function addCondItem(parentPath){condListAt(parentPath).push({range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'});renderCondTree();}
function addCondGroup(parentPath){condListAt(parentPath).push({group:true,mode:'all',items:[{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'}]});renderCondTree();}
function removeCondNode(path){
  if(!path)return;
  const parts=path.split('/').map(Number);
  const idx=parts.pop();
  const parentPath=parts.join('/');
  const list=condListAt(parentPath);
  if(list&&idx>=0&&idx<list.length)list.splice(idx,1);
  renderCondTree();
}
function changeGroupMode(path,mode){
  const node=condNodeAt(path);
  if(node&&node.group)node.mode=(mode==='any'?'any':'all');
  renderCondTree();
}
function onCondModeChange(){
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  updateCondPreview();
  updateActivitySummary();
}
// ===== 点选浮层面板 =====
function getCondPanelEl(){
  let el=document.getElementById('condPanel');
  if(!el){
    el=document.createElement('div');
    el.id='condPanel';
    el.className='cond-panel';
    document.body.appendChild(el);
  }
  return el;
}
function positionCondPanel(anchor){
  const el=getCondPanelEl();
  el.style.visibility='hidden';
  el.style.display='block';
  // 移动端以底部抽屉形式展示，位置交给 CSS（.cond-panel.sheet）
  const sheet=!!(window.matchMedia&&window.matchMedia('(max-width:560px)').matches);
  el.classList.toggle('sheet',sheet);
  if(sheet){
    el.style.left='';
    el.style.top='';
    el.style.visibility='visible';
    return;
  }
  const r=anchor.getBoundingClientRect();
  const pw=el.offsetWidth||200;
  const ph=el.offsetHeight||0;
  const vw=window.innerWidth,vh=window.innerHeight;
  const left=Math.max(8,Math.min(r.left,vw-pw-8));
  let top=r.bottom+6;
  if(top+ph>vh-8)top=r.top-ph-6;
  if(top<8)top=8;
  el.style.left=left+'px';
  el.style.top=top+'px';
  el.style.visibility='visible';
}
function renderCondPanel(){
  const el=getCondPanelEl();
  const p=condPanel;
  let html='';
  if(p.kind==='op'){
    html='<div class="cp-title">运算符</div><div class="cp-opts">';
    [['>=','≥'],['>','>'],['<=','≤'],['<','<']].forEach(o=>{
      html+='<button class="cp-opt" onclick="commitCondOp(\''+o[0]+'\')">'+o[1]+'</button>';
    });
    html+='</div>';
  }else if(p.step==='range'){
    html='<div class="cp-title">时间范围</div><div class="cp-opts">';
    COND_RANGES.forEach(r=>{
      html+='<button class="cp-opt" onclick="pickCondRange(\''+r.v+'\')">'+r.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='days'){
    html='<div class="cp-title">最近多少天</div><div class="cp-days">'
      +'<input type="number" id="condPanelDays" value="'+p.days+'" min="1" step="1">'
      +'<button class="btn btn-sm" onclick="confirmCondDays()">确定</button></div>';
  }else if(p.step==='metric'){
    html='<div class="cp-title">指标</div><div class="cp-opts">';
    COND_METRICS.forEach(m=>{
      html+='<button class="cp-opt" onclick="pickCondMetric(\''+m.v+'\')">'+m.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='targetType'){
    html='<div class="cp-title">统计主体</div><div class="cp-opts">';
    condTargetTypesFor(p.metric).forEach(tt=>{
      const n=(COND_TARGET_TYPES.find(x=>x.v===tt)||{}).n||tt;
      html+='<button class="cp-opt" onclick="pickCondTargetType(\''+tt+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='newFilter'){
    html='<div class="cp-title">新增筛选</div><div class="cp-opts">';
    condNewFilterOptions(p.targetType).forEach(nf=>{
      const n=(COND_NEW_FILTERS.find(x=>x.v===nf)||{}).n||nf;
      html+='<button class="cp-opt" onclick="pickCondNewFilter(\''+nf+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='domain'){
    html='<div class="cp-title">选择领域</div><div class="cp-opts">';
    state.domains.forEach(d=>{
      html+='<button class="cp-opt" onclick="pickCondDomain(\''+d.id+'\')">'+esc(d.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='task'){
    html='<div class="cp-title">选择任务</div><div class="cp-opts">';
    state.tasks.forEach(t=>{
      html+='<button class="cp-opt" onclick="pickCondTask(\''+t.id+'\')">'+esc(t.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='aggregate'){
    html='<div class="cp-title">聚合方式</div><div class="cp-opts">';
    COND_AGGREGATES.forEach(a=>{
      html+='<button class="cp-opt" onclick="pickCondAggregate(\''+a.v+'\')">'+a.n+'</button>';
    });
    html+='</div>';
  }
  el.innerHTML=html;
  if(p.kind==='metric'&&p.step==='days'){
    setTimeout(()=>{const inp=document.getElementById('condPanelDays');if(inp){inp.focus();inp.select();}},0);
  }
}
function openCondMetricPanel(path,anchor){
  const it=condNodeAt(path)||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  condPanel={visible:true,kind:'metric',path:path,anchor:anchor,step:'range',range:it.range||'period',days:it.days||7,metric:it.metric||'checkins',targetType:it.targetType||'all',newFilter:it.newFilter||'none',target:it.target||'',aggregate:it.aggregate||'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function openCondOpPanel(path,anchor){
  condPanel={visible:true,kind:'op',path:path,anchor:anchor,step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function pickCondRange(range){
  condPanel.range=range;
  condPanel.step=(range==='recent')?'days':'metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function confirmCondDays(){
  const inp=document.getElementById('condPanelDays');
  condPanel.days=Math.max(1,Math.round(Number(inp&&inp.value)||7));
  condPanel.step='metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondMetric(metric){
  condPanel.metric=metric;
  // 成果点仅支持「全部」，直接提交
  if(metric==='achievement'){commitCondValue('all','','none','sum');return;}
  condPanel.step='targetType';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondTargetType(tt){
  condPanel.targetType=tt;
  // 单任务：主体即锁定唯一实体，无需新增筛选与聚合
  if(tt==='task'){
    condPanel.newFilter='none';
    condPanel.step='task';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 计数类指标（新增任务/新增领域）：本身已限定「新增」，无需新增筛选/聚合
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    if(tt==='all'){commitCondValue('all','','none','sum');}
    else{condPanel.step='domain';renderCondPanel();positionCondPanel(condPanel.anchor);}
    return;
  }
  // 值类指标（打卡/活力/进度）：全部→新增筛选；按领域→先选领域再新增筛选
  condPanel.step=(tt==='all')?'newFilter':'domain';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondNewFilter(nf){
  condPanel.newFilter=nf;
  condPanel.step='aggregate';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondDomain(id){
  condPanel.target=id;
  // 计数类指标选完领域即完成；值类指标继续选新增筛选
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    commitCondValue('domain',id,'none','sum');
  }else{
    condPanel.step='newFilter';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
  }
}
function pickCondTask(id){
  commitCondValue('task',id,'none','sum');
}
function pickCondAggregate(agg){
  commitCondValue(condPanel.targetType,condPanel.target,condPanel.newFilter,agg);
}
function commitCondValue(targetType,target,newFilter,aggregate){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group){
    it.range=condPanel.range;
    if(condPanel.range==='recent')it.days=condPanel.days;else delete it.days;
    it.metric=condPanel.metric;
    it.targetType=targetType;
    if(targetType==='all')delete it.target;else it.target=target;
    it.newFilter=newFilter;
    it.aggregate=aggregate;
  }
  closeCondPanel();
  renderCondTree();
}
function commitCondOp(op){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group)it.op=op;
  closeCondPanel();
  renderCondTree();
}
function closeCondPanel(){
  condPanel.visible=false;
  const el=document.getElementById('condPanel');
  if(el){el.style.display='none';el.innerHTML='';}
}
function editCondValue(path,btn){
  const it=condNodeAt(path);
  if(!it||it.group)return;
  const valChip=btn.closest('.cond-chip-line').querySelector('.cc-value');
  if(!valChip)return;
  const input=document.createElement('input');
  input.type='number';
  input.className='cc-value-input';
  input.value=it.value;
  input.step='0.1';
  let done=false;
  const commit=()=>{
    if(done)return;
    done=true;
    const v=Number(input.value);
    it.value=(v!==undefined&&!isNaN(v))?v:0;
    renderCondTree();
  };
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();commit();}
    else if(e.key==='Escape'){done=true;renderCondTree();}
  });
  input.addEventListener('blur',commit);
  valChip.replaceWith(input);
  input.focus();
  input.select();
}
document.addEventListener('click',function(e){
  if(!condPanel.visible)return;
  // 用 composedPath 判定：面板内部点击后按钮可能因 innerHTML 重渲染脱离 DOM，
  // 此时 e.target.closest 会返回 null；composedPath 仍保留派发时的祖先链，可正确识别面板内点击。
  const path=(e.composedPath&&e.composedPath())||[];
  const inPanel=path.some(n=>n&&n.getAttribute&&n.getAttribute('id')==='condPanel');
  const inChip=path.some(n=>n&&n.classList&&n.classList.contains('cc-chip'));
  if(!inPanel&&!inChip)closeCondPanel();
});
function rewardRowHTML(item){
  item=item||{type:'vitality',amount:10};
  const typeOpts=[['vitality','活力点'],['progress','进度值'],['achievement','成果点'],['card','断更豁免卡']]
    .reduce((s,o)=>s+'<option value="'+o[0]+'"'+((item.type||'vitality')===o[0]?' selected':'')+'>'+o[1]+'</option>','');
  const domOpts='<option value="">全部领域</option>'+state.domains.map(d=>'<option value="'+d.id+'"'+((item.domainId||'')===d.id?' selected':'')+'>'+esc(d.name)+'</option>').join('');
  const taskOpts='<option value="">不指定任务</option>'+state.tasks.map(t=>'<option value="'+t.id+'"'+((item.taskId||'')===t.id?' selected':'')+'>'+esc(t.name)+'</option>').join('');
  const isVit=(item.type==='vitality');
  const isProg=(item.type==='progress');
  const isCard=(item.type==='card');
  return '<div class="reward-row">'
    +'<select class="rr-type" onchange="rrTypeChanged(this)">'+typeOpts+'</select>'
    +'<select class="rr-task" onchange="updateCondPreview()" style="display:'+(isVit?'':'none')+'" title="关联任务（可选）">'+taskOpts+'</select>'
    +'<select class="rr-domain" onchange="updateCondPreview()" style="display:'+(isProg?'':'none')+'" title="关联领域（可选）">'+domOpts+'</select>'
    +'<input type="number" class="rr-amount" oninput="updateCondPreview()" value="'+(item.amount||10)+'" min="0" step="0.1" title="数量">'
    +'<input type="number" class="rr-cap" oninput="updateCondPreview()" value="'+(item.cap||3)+'" min="1" step="1" style="display:'+(isCard?'':'none')+'" title="豁免卡累计上限">'
    +'<button class="rr-del" onclick="removeRewardRow(this)">×</button>'
    +'</div>';
}
function renderActivityResultDetails(result){
  const box=document.getElementById('activityResultDetails');
  result=result||{};
  const items=(result.items&&result.items.length)?result.items:[{type:'vitality',amount:10}];
  box.innerHTML=items.map(rewardRowHTML).join('');
}
function addRewardRow(){
  const box=document.getElementById('activityResultDetails');
  const tmp=document.createElement('div');
  tmp.innerHTML=rewardRowHTML({type:'vitality',amount:10});
  box.appendChild(tmp.firstChild);
  updateActivitySummary();
  updateCondPreview();
}
function removeRewardRow(btn){
  btn.closest('.reward-row').remove();
  updateActivitySummary();
  updateCondPreview();
}
function rrTypeChanged(sel){
  const row=sel.closest('.reward-row');
  const dom=row.querySelector('.rr-domain');
  const task=row.querySelector('.rr-task');
  const cap=row.querySelector('.rr-cap');
  const m=sel.value;
  task.style.display=(m==='vitality')?'':'none';
  dom.style.display=(m==='progress')?'':'none';
  cap.style.display=(m==='card')?'':'none';
  updateCondPreview();
}
function validateDomain(id){return state.domains.some(d=>d.id===id)?id:'d_default'}
function handleActivitySave(){
  const id=document.getElementById('activityId').value;
  const name=document.getElementById('activityName').value.trim();
  if(!name){toast('请输入活动名称','err');return}
  const period=document.getElementById('activityPeriod').value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  const condition=condDraft;
  const rewardItems=readRewardItems();
  const result={items:rewardItems};
  if(!rewardItems.length){toast('请至少添加一个有效的奖励项','err');return}
  if(id){
    const idx=state.activities.findIndex(x=>x.id===id);
    if(idx<0){toast('活动不存在','err');return}
    const prev=state.activities[idx];
    state.activities[idx]={id:id,name:name,enabled:prev.enabled,period:period,anchor:anchor,condition:condition,result:result,lastRun:prev.lastRun};
  }else{
    state.activities.push({id:uid(),name:name,enabled:true,period:period,anchor:anchor,condition:condition,result:result,lastRun:null});
  }
  closeModal('activityModal');
  processActivities(true);
  commit(id?'活动已更新':'活动已创建');
}
function toggleActivity(id,enabled){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  a.enabled=enabled;
  processActivities(true);
  commit(enabled?'活动已开始运行':'活动已停止');
}
let pendingDeleteActivityId=null;
function askDelActivity(id){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  pendingDeleteActivityId=id;
  document.getElementById('activityDeleteMsg').innerHTML='活动「'+esc(a.name)+'」将被删除。<br><span style="color:var(--text-3);font-size:11px">「撤销历史获得」会回收该活动已发放的活力点 / 进度值 / 成果点与豁免卡。</span>';
  openModal('activityDeleteModal');
}
function askDelActivityFromModal(){
  const id=document.getElementById('activityId').value;
  closeModal('activityModal');
  askDelActivity(id);
}
function doDeleteActivity(revoke){
  const id=pendingDeleteActivityId;
  pendingDeleteActivityId=null;
  closeModal('activityDeleteModal');
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  if(revoke)revokeActivityGrants(id);
  state.activities=state.activities.filter(x=>x.id!==id);
  commit(revoke?'活动已删除，历史获得已撤销':'活动已删除');
}
function revokeActivityGrants(actId){
  const logs=state.logs.filter(l=>l.actId===actId);
  let cardUndo=0;
  const txr=Ledger.txn(function(){
    logs.forEach(function(l){
      if(l.src==='reward'){
        const amt=Number(l.amt)||0;
        if(l.st==='vitality')Ledger.post({op:'spend',account:'vitality',delta:-amt,visible:false,reason:{src:'activity-revoke'}});
        else if(l.st==='achievement')Ledger.post({op:'spend',account:'achievement',delta:-amt,visible:false,reason:{src:'activity-revoke'}});
        else if(l.st==='progress'){
          // 按发放时落盘的分配明细逐领域全额退回；旧流水无明细时回退到单一领域
          if(Array.isArray(l.splits)&&l.splits.length){
            l.splits.forEach(function(sp){
              const did=sp.dom||'d_default';
              Ledger.post({op:'spend',account:'progress:'+did,delta:-(Number(sp.amt)||0),visible:false,reason:{src:'activity-revoke',dom:did}});
            });
          }else{
            const did=l.dom||'d_default';
            Ledger.post({op:'spend',account:'progress:'+did,delta:-amt,visible:false,reason:{src:'activity-revoke',dom:did}});
          }
        }
      }else if(l.src==='card-grant'){
        cardUndo+=(typeof l.granted==='number'?l.granted:parseCardGrantAmt(l.desc));
      }
    });
    if(cardUndo>0){
      const cur=state.cards.exemption||0;
      Ledger.post({op:'adjust',account:'card:exemption',target:Math.max(0,cur-cardUndo),visible:false,reason:{src:'activity-revoke'}});
    }
    // 删除已回收流水：奖励记录不存在即代表已撤销，重复调用不会二次退款
    Ledger.removeLogs(function(l){return l.actId!==actId;});
  },{label:'activity-revoke',save:'none',render:false});
  return txr.ok;
}
function parseCardGrantAmt(desc){
  const m=/(\d+)\s*张/.exec(desc||'');return m?parseInt(m[1],10):0;
}
function renderExemptPanel(){
  const box=document.getElementById('exemptUsePanel');
  if(!box)return;
  const cards=state.cards.exemption||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const today=new Date();today.setHours(0,0,0,0);
  const eligible=state.tasks.filter(t=>{
    if(t.archived)return false;
    const checkedToday=!!(t.lastCheckIn&&new Date(t.lastCheckIn)>=today);
    const exemptToday=!!(t.lastExempt&&new Date(t.lastExempt)>=today);
    return !checkedToday&&!exemptToday;
  });
  const selOpts=eligible.map(t=>{
    const lastEff=effectiveLastTs(t);
    let gapDays=0;
    if(lastEff){const prev=new Date(lastEff);prev.setHours(0,0,0,0);gapDays=Math.round((today-prev)/864e5);}
    const label=t.name+(gapDays>=2?'  ·  已断更'+(gapDays-1)+'天':'');
    return '<option value="'+t.id+'">'+esc(label)+'</option>';
  }).join('');
  const canUse=ruleEnabled&&cards>0&&eligible.length>0;
  box.innerHTML=
    '<div class="act-head"><div class="act-name">断更豁免卡 <span class="badge">剩余 '+cards+' 张</span></div></div>'
    +(ruleEnabled?'':'<div class="sec-note" style="color:var(--danger)">当前没有「发放豁免卡」的运行中活动，请先在上方新建并启用一个奖励豁免卡的周期活动。</div>')
    +(ruleEnabled&&cards<=0?'<div class="sec-note">暂无可用豁免卡，待周期结算自动发放后即可使用。</div>':'')
    +'<div class="reward-row" style="margin-top:10px">'
    +'<select id="exemptTaskSel" style="flex:1">'+(selOpts||'<option value="">暂无可豁免任务</option>')+'</select>'
    +'<button class="btn btn-sm btn-exempt" style="width:auto" onclick="useExemptionFromSel()" '+(canUse?'':'disabled')+'>使用豁免</button>'
    +'</div>'
    +'<div class="sec-note">事前「请假」：今天不打卡仍延续连胜利率；事后「补救」：已断更则清零待扣债。使用不消耗活力、不增加进度。</div>';
}
function useExemptionFromSel(){
  const sel=document.getElementById('exemptTaskSel');
  if(!sel||!sel.value){toast('请先选择要豁免的任务','warn');return;}
  useExemption(sel.value);
}
function renderCycle(){
  const acts=state.activities||[];
  const total=acts.length;
  const enabledActs=acts.filter(a=>a.enabled);
  const bal=state.cards.exemption||0;

  const cardGrants=enabledActs.flatMap(a=>(a.result&&a.result.items||[]).filter(it=>it.type==='card'));
  const cardTotal=cardGrants.reduce((s,it)=>s+(it.amount||0),0);
  const cardCap=cardGrants.length?Math.max.apply(null,cardGrants.map(it=>it.cap||1)):0;
  document.getElementById('cyCardBal').textContent=bal;
  document.getElementById('cyCardSub').textContent=cardGrants.length?('每周期发放 '+cardTotal+' 张'+(cardCap?' · 上限 '+cardCap:'')):'未配置豁免卡活动';

  document.getElementById('cyGranted').textContent=enabledActs.length;
  document.getElementById('cyGrantedSub').textContent='共 '+total+' 个活动'+(enabledActs.length<total?' · 停用 '+(total-enabledActs.length)+' 个':'  ·  全部运行中');

  let next=null;const nextActs=[];
  enabledActs.forEach(a=>{
    const t=cycleNextGrant(a);
    if(t===null)return;
    if(next===null||t<next){next=t;nextActs.length=0;nextActs.push(a);}
    else if(t===next)nextActs.push(a);
  });
  document.getElementById('cyNext').textContent=next!==null?fmtDate(next):'—';
  const nextSub=document.getElementById('cyNextSub');
  nextSub.textContent=next!==null?(nextActs.length===1?('结算「'+nextActs[0].name+'」'):('将结算 '+nextActs.length+' 个活动')):'无运行中的活动';

  const box=document.getElementById('cycleActivities');
  if(!acts.length){
    box.innerHTML='<div class="empty"><p>尚未创建周期活动</p><button class="btn btn-sm" onclick="openActivityModal()">新建活动</button></div>';
  }else{
    box.innerHTML=acts.map(a=>{
      const stateTxt=a.enabled?'运行中':'已停用';
      const stateColor=a.enabled?'var(--progress)':'var(--text-3)';
      return '<div class="rule-card">'
        +'<div class="act-head">'
        +'<div class="act-name">'+esc(a.name)+' <span class="badge">'+periodLabel(a.period)+'</span>'
        +'<span style="font-size:10px;color:'+stateColor+'">'+stateTxt+'</span></div>'
        +'<div class="act-ctrls">'
        +'<label class="switch" title="运行／停止" onclick="event.stopPropagation()"><input type="checkbox" '+(a.enabled?'checked':'')+' onchange="toggleActivity(\''+a.id+'\',this.checked)"><span class="slider"></span></label>'
        +'<span class="act-switch-lbl">'+(a.enabled?'运行':'停止')+'</span>'
        +'<button class="btn btn-sm" onclick="openActivityModal(\''+a.id+'\')">编辑详情</button>'
        +'</div>'
        +'</div>'
        +'<div class="act-meta">'+actMetaLabel(a)+'</div>'
        +'</div>';
    }).join('');
  }

  renderExemptPanel();
}

// ===== Inline toggle =====
// Filter tasks by domain (clicking a domain pill)
function filterByDomain(domId){
  if(state.filterDomain===domId){
    state.filterDomain=null; // click again to clear filter
  }else{
    state.filterDomain=domId;
  }
  save();
  renderWork();
  renderBank();
}

function toggleInline(id){
  const el=document.getElementById(id);
  el.style.display=el.style.display==='none'?'flex':'none';
  if(el.style.display!=='none'){
    const inp=el.querySelector('input');
    if(inp)setTimeout(()=>inp.focus(),30);
  }
}

// ===== Major section collapse (事务/任务/档案馆) =====
function toggleMajor(key){
  const arr=state.majorCollapsed||[];
  const i=arr.indexOf(key);
  if(i>=0)arr.splice(i,1);else arr.push(key);
  state.majorCollapsed=arr;
  save();
  const el=document.getElementById('major_'+key);
  if(el)el.classList.toggle('collapsed',arr.indexOf(key)>=0);
}
function syncMajorCollapse(){
  ['chore','affair','task','archive'].forEach(function(k){
    const el=document.getElementById('major_'+k);
    if(el)el.classList.toggle('collapsed',(state.majorCollapsed||[]).indexOf(k)>=0);
  });
}

// ===== Collapse toggle =====
function toggleCollapse(type,id){
  var arr;
  if(type==='collection')arr=state.collapsedColls;
  else if(type==='ach-domain')arr=state.collapsedAchDoms;
  else if(type==='shop-category')arr=state.collapsedShopCats;
  else{ // legacy: treat as collection
    arr=state.collapsedColls;
    id=type;
  }
  if(!arr)arr=[];
  var i=arr.indexOf(id);
  if(i>=0)arr.splice(i,1);
  else arr.push(id);
  if(type==='collection')state.collapsedColls=arr;
  else if(type==='ach-domain')state.collapsedAchDoms=arr;
  else if(type==='shop-category')state.collapsedShopCats=arr;
  save();
  // Toggle DOM without full re-render for smoothness
  var selector;
  if(type==='ach-domain')selector='.ach-dom-group[data-dom-id="'+id+'"]';
  else if(type==='shop-category')selector='.shop-cat-group[data-cat-id="'+id+'"]';
  else selector='.coll-group[data-coll-id="'+id+'"]'; // collection or legacy
  var group=document.querySelector(selector);
  if(group)group.classList.toggle('collapsed');
}

// ===== Drag-and-drop (generic, long-press to reorder) =====
let drag={active:false,type:null,id:null,groupId:null,el:null,ghost:null,indicator:null,timer:null,
  startX:0,startY:0,originRect:null,offsetX:0,offsetY:0,pointerId:null};
let dragJustEnded=false;

function initDrag(){
  document.addEventListener('pointerdown',onDragDown);
  document.addEventListener('pointermove',onDragMove);
  document.addEventListener('pointerup',onDragUp);
  document.addEventListener('pointercancel',onDragUp);
  // 兜底：窗口失焦（系统手势切走、切标签页等）时结束拖拽，避免 body 残留 overflow:hidden
  window.addEventListener('blur',onDragUp);
  // Suppress click events that fire right after a drag (e.g. on collapsible headers)
  document.addEventListener('click',function(e){
    if(dragJustEnded){e.preventDefault();e.stopPropagation();}
  },true);
}

function getDragTarget(target){
  // Don't interfere with modals or interactive elements
  if(target.closest('.modal-bg.show'))return null;

  // Only start drag from a .drag-handle or .drag-handle-h element
  var handle=target.closest('.drag-handle,.drag-handle-h');
  if(!handle)return null;

  // 1. Task card
  var taskCard=handle.closest('.card[data-task-id]');
  if(taskCard)return{el:taskCard,type:'task',id:taskCard.dataset.taskId,groupId:taskCard.dataset.collId};

  // 2. Milestone card
  var achCard=handle.closest('.card[data-ach-id]');
  if(achCard)return{el:achCard,type:'milestone',id:achCard.dataset.achId,groupId:achCard.dataset.domId};

  // 3. Product card
  var prodCard=handle.closest('.shop-card[data-prod-id]');
  if(prodCard)return{el:prodCard,type:'product',id:prodCard.dataset.prodId,groupId:prodCard.dataset.catId};

  // 4. Collection group (handle is inside the header)
  var collGroup=handle.closest('.coll-group[data-coll-id]');
  if(collGroup)return{el:collGroup,type:'collection',id:collGroup.dataset.collId,groupId:null};

  // 5. Achievement domain group
  var achDomGroup=handle.closest('.ach-dom-group[data-dom-id]');
  if(achDomGroup)return{el:achDomGroup,type:'ach-domain',id:achDomGroup.dataset.domId,groupId:null};

  // 6. Shop category group
  var shopCatGroup=handle.closest('.shop-cat-group[data-cat-id]');
  if(shopCatGroup)return{el:shopCatGroup,type:'shop-category',id:shopCatGroup.dataset.catId,groupId:null};

  return null;
}

function onDragDown(e){
  if(drag.active)return;
  var target=getDragTarget(e.target);
  if(!target)return;

  drag.type=target.type;
  drag.id=target.id;
  drag.groupId=target.groupId;
  drag.el=target.el;
  drag.startX=e.clientX;
  drag.startY=e.clientY;
  drag.pointerId=e.pointerId;

  // Start drag immediately (no long-press timer needed)
  drag.active=true;
  target.el.classList.add('dragging');
  document.body.style.overflow='hidden';

  // Cache the element's position ONCE at drag start
  drag.originRect=target.el.getBoundingClientRect();
  drag.offsetX=drag.startX-drag.originRect.left;
  drag.offsetY=drag.startY-drag.originRect.top;

  drag.ghost=target.el.cloneNode(true);
  drag.ghost.classList.add('drag-ghost');
  drag.ghost.classList.remove('dragging');
  drag.ghost.style.width=drag.originRect.width+'px';
  drag.ghost.style.left=drag.originRect.left+'px';
  drag.ghost.style.top=drag.originRect.top+'px';
  document.body.appendChild(drag.ghost);

  drag.indicator=document.createElement('div');
  drag.indicator.className='drag-indicator';

  // Capture pointer to ensure we keep receiving events
  if(e.pointerId!==undefined&&target.el.setPointerCapture){
    try{target.el.setPointerCapture(e.pointerId);}catch(err){}
  }

  toast('拖拽中…松手放置','warn');
}

function getDragSiblings(){
  var type=drag.type,groupId=drag.groupId;
  if(type==='task'){
    return[].slice.call(document.querySelectorAll('#taskGroups .card[data-task-id][data-coll-id="'+groupId+'"]:not(.dragging)'));
  }else if(type==='milestone'){
    return[].slice.call(document.querySelectorAll('#achGroups .card[data-ach-id][data-dom-id="'+groupId+'"]:not(.dragging)'));
  }else if(type==='product'){
    // Allow cross-category drag: return ALL product cards across all categories
    return[].slice.call(document.querySelectorAll('.shop-card[data-prod-id]:not(.dragging)'));
  }else if(type==='collection'){
    return[].slice.call(document.querySelectorAll('#taskGroups .coll-group[data-coll-id]:not(.dragging)'));
  }else if(type==='ach-domain'){
    return[].slice.call(document.querySelectorAll('#achGroups .ach-dom-group[data-dom-id]:not(.dragging)'));
  }else if(type==='shop-category'){
    return[].slice.call(document.querySelectorAll('.shop-cat-group[data-cat-id]:not(.dragging)'));
  }
  return[];
}

function onDragMove(e){
  if(!drag.active)return;
  e.preventDefault();

  // Position ghost using cached offset — ghost follows the finger precisely
  drag.ghost.style.left=(e.clientX-drag.offsetX)+'px';
  drag.ghost.style.top=(e.clientY-drag.offsetY)+'px';

  var siblings=getDragSiblings();
  if(drag.indicator&&drag.indicator.parentNode)drag.indicator.parentNode.removeChild(drag.indicator);

  // Only place indicator among siblings that share the same parent as the dragged element
  var validSiblings=siblings.filter(function(s){
    // For products, allow placing in ANY shop-grid (cross-category)
    if(drag.type==='product')return s.classList&&s.classList.contains('shop-card');
    // For other types, require same parent
    return s.parentNode===drag.el.parentNode;
  });

  var indicatorPlaced=false;
  for(var i=0;i<validSiblings.length;i++){
    var r=validSiblings[i].getBoundingClientRect();
    var mid=r.top+r.height/2;
    if(e.clientY<mid){
      validSiblings[i].parentNode.insertBefore(drag.indicator,validSiblings[i]);
      indicatorPlaced=true;
      break;
    }
  }
  if(!indicatorPlaced&&validSiblings.length>0){
    var last=validSiblings[validSiblings.length-1];
    last.parentNode.insertBefore(drag.indicator,last.nextSibling);
  }
}

function onDragUp(e){
  // 幂等兜底：无论是否处于拖拽状态，都先恢复页面滚动（可被 pointerup/pointercancel/blur 重复调用）
  document.body.style.overflow='';
  if(!drag.active)return;

  // Release pointer capture
  if(drag.pointerId!==undefined&&drag.el&&drag.el.releasePointerCapture){
    try{drag.el.releasePointerCapture(drag.pointerId);}catch(err){}
  }

  var type=drag.type;
  var groupId=drag.groupId;
  var indicator=drag.indicator;
  var insertBefore=indicator?indicator.nextSibling:null;

  // For products: allow cross-category drops into any .shop-grid
  // For other types: only allow within same parent
  var validDrop=false;
  var targetCatId=groupId; // for products, will be updated if dropped in different category

  if(type==='product'){
    // Find which category group the indicator landed in
    var targetGrid=null;
    if(indicator){
      targetGrid=indicator.parentNode;
    }
    if(targetGrid&&targetGrid.classList.contains('shop-grid')){
      // Find the ancestor .shop-cat-group or .soldout-subgroup
      var catGroup=targetGrid.closest('.shop-cat-group[data-cat-id]');
      if(catGroup){
        targetCatId=catGroup.dataset.catId;
      }
      // Move the DOM element to the target grid
      if(insertBefore&&insertBefore.parentNode===targetGrid){
        targetGrid.insertBefore(drag.el,insertBefore);
      }else{
        targetGrid.appendChild(drag.el);
      }
      validDrop=true;
    }
  }else{
    // Other types: only move within same parent
    if(insertBefore&&indicator.parentNode===drag.el.parentNode){
      insertBefore.parentNode.insertBefore(drag.el,insertBefore);
      validDrop=true;
    }else if(indicator&&indicator.parentNode===drag.el.parentNode){
      indicator.parentNode.appendChild(drag.el);
      validDrop=true;
    }
  }
  // If invalid drop (indicator in wrong container), don't move the element

  drag.el.classList.remove('dragging');
  // Restore scrolling
  document.body.style.overflow='';
  if(drag.ghost){drag.ghost.remove();drag.ghost=null;}
  if(drag.indicator){drag.indicator.remove();drag.indicator=null;}

  // Suppress the click that follows pointerup after a drag
  dragJustEnded=true;
  setTimeout(function(){dragJustEnded=false;},150);

  // Persist new order only if the drop was valid
  if(validDrop){
    if(type==='task')saveTaskOrderFromDOM(groupId);
    else if(type==='collection')saveCollectionOrderFromDOM();
    else if(type==='milestone')saveAchOrderFromDOM(groupId);
    else if(type==='ach-domain')saveAchDomOrderFromDOM();
    if(type==='product'){
      // 关键：跨分类移动后，被拖拽卡片本身的 data-cat-id 仍是旧分类，
      // 导致 saveProdOrderFromDOM(新分类) 查询不到它、却已把 state 里的 categoryId 改成新分类，
      // 最终在重排时被丢弃（尤其从「售罄」区拖出时没有第二次回捞）。此处先同步属性再持久化。
      if(drag.el&&targetCatId!=='sc_soldout'){
        drag.el.setAttribute('data-cat-id',targetCatId);
      }
      // Check if product moved to a different category
      var prod=state.products.find(function(p){return p.id===drag.id;});
      if(prod){
        if(targetCatId==='sc_soldout'){
          // Dropped in sold-out section — find target sub-group category via the card's new parent
          var soldoutSub=(drag.el&&drag.el.parentNode)?drag.el.parentNode.closest('.soldout-sub[data-prev-cat-id]'):null;
          if(soldoutSub){
            var targetPrevCat=soldoutSub.dataset.prevCatId;
            if(prod.categoryId!==targetPrevCat){
              prod.categoryId=targetPrevCat;
            }
          }
        }else{
          // Dropped into a normal category — update categoryId
          prod.categoryId=targetCatId;
        }
      }
      // Save order and re-render
      if(targetCatId==='sc_soldout'){
        // For sold-out section, just save and re-render (order within sub-groups)
        save();
      }else{
        saveProdOrderFromDOM(targetCatId);
        if(targetCatId!==groupId&&groupId!=='sc_soldout'){
          saveProdOrderFromDOM(groupId);
        }
      }
      render();
    }
    else if(type==='shop-category')saveShopCatOrderFromDOM();
  }else{
    // Invalid drop — re-render to restore correct DOM
    render();
  }

  drag.active=false;
  drag.el=null;
  drag.type=null;
  drag.id=null;
  drag.groupId=null;
  drag.originRect=null;
  drag.pointerId=null;
}

function saveTaskOrderFromDOM(collId){
  var cards=document.querySelectorAll('.card[data-task-id][data-coll-id="'+collId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.taskId;});
  var collTasks={};
  state.tasks.forEach(function(t){collTasks[t.id]=t;});
  var newOrder=[];
  var collIdx=0;
  state.tasks.forEach(function(t){
    if((t.collectionId||'c_default')===collId||(collId==='_none'&&!state.collections.find(function(c){return c.id===t.collectionId;}))){
      if(collIdx<orderedIds.length&&collTasks[orderedIds[collIdx]]){
        newOrder.push(collTasks[orderedIds[collIdx]]);
        collIdx++;
      }
    }else{
      newOrder.push(t);
    }
  });
  while(collIdx<orderedIds.length){
    if(collTasks[orderedIds[collIdx]])newOrder.push(collTasks[orderedIds[collIdx]]);
    collIdx++;
  }
  state.tasks=newOrder;
  save();
  toast('任务顺序已更新');
}

function saveCollectionOrderFromDOM(){
  var groups=document.querySelectorAll('#taskGroups .coll-group[data-coll-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.collId;});
  var map={};
  state.collections.forEach(function(c){map[c.id]=c;});
  state.collections=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  save();
  toast('集合顺序已更新');
}

function saveAchDomOrderFromDOM(){
  var groups=document.querySelectorAll('.ach-dom-group[data-dom-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.domId;});
  var map={};
  state.domains.forEach(function(d){map[d.id]=d;});
  var reordered=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  // Append any domains not rendered (e.g. empty domains)
  state.domains.forEach(function(d){
    if(orderedIds.indexOf(d.id)<0)reordered.push(d);
  });
  state.domains=reordered;
  save();
  toast('领域顺序已更新');
}

function saveAchOrderFromDOM(domId){
  var cards=document.querySelectorAll('.card[data-ach-id][data-dom-id="'+domId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.achId;});
  var map={};
  state.achievements.forEach(function(a){map[a.id]=a;});
  var newOrder=[];
  var idx=0;
  state.achievements.forEach(function(a){
    if(a.domainId===domId){
      if(idx<orderedIds.length&&map[orderedIds[idx]]){
        newOrder.push(map[orderedIds[idx]]);
        idx++;
      }
    }else{
      newOrder.push(a);
    }
  });
  while(idx<orderedIds.length){
    if(map[orderedIds[idx]])newOrder.push(map[orderedIds[idx]]);
    idx++;
  }
  state.achievements=newOrder;
  save();
  toast('里程碑顺序已更新');
}

function saveProdOrderFromDOM(catId){
  var cards=document.querySelectorAll('.shop-card[data-prod-id][data-cat-id="'+catId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.prodId;});
  var map={};
  state.products.forEach(function(p){map[p.id]=p;});
  var newOrder=[];
  var idx=0;
  state.products.forEach(function(p){
    if((p.categoryId||'sc_default')===catId){
      if(idx<orderedIds.length&&map[orderedIds[idx]]){
        newOrder.push(map[orderedIds[idx]]);
        idx++;
      }
    }else{
      newOrder.push(p);
    }
  });
  while(idx<orderedIds.length){
    if(map[orderedIds[idx]])newOrder.push(map[orderedIds[idx]]);
    idx++;
  }
  state.products=newOrder;
  save();
  toast('商品顺序已更新');
}

function saveShopCatOrderFromDOM(){
  var groups=document.querySelectorAll('.shop-cat-group[data-cat-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.catId;});
  var map={};
  state.shopCategories.forEach(function(c){map[c.id]=c;});
  state.shopCategories=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  save();
  toast('分类顺序已更新');
}

// ===== Undo adapters =====
// 撤销规则按 src 注册：新增一种可撤销流水 = 在 UNDO_ADAPTERS 里加一个 key。
// undoLog / Ledger.reverse 只负责查流水、查适配器、开事务与统一收尾。
// reverse(log,ctx) 返回 false 表示已交由内层撤销处理，外层不再重复收尾（cost → 父打卡）。
const UNDO_ADAPTERS={
  checkin:{reverse:function(log){
    // Reverse the score gain (handles 'vitality' / 'progress' / 'both')
    applyCheckinGain(log,-1);
    // 活跃度索引按原打卡日期反向扣减（与正向写入共用同一维护函数）
    const actDids=String(log.dom||'').split(',').filter(Boolean);
    noteCheckinActivity(actDids.length?actDids:['d_default'],-1,log.time);
    // Decrement task stats
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){
        t.checkInCount=Math.max(0,(t.checkInCount||0)-1);
        const earnedAmt=(log.st==='both'||log.st==='progress')?logAmt(log,'progress'):logAmt(log,'vitality');
        t.totalEarned=(t.totalEarned||0)-earnedAmt;
        // Restore previous streak, lastCheckIn, lastDebtDate, and pendingDebt
        t.streak=log.prevStreak||0;
        t.lastCheckIn=log.prevLastCheckIn||null;
        if(log.prevLastDebtDate){
          t.lastDebtDate=log.prevLastDebtDate;
        }else{
          delete t.lastDebtDate;
        }
        t.pendingDebt=log.prevPendingDebt||0;
        // 恢复打卡前的阶段档位
        if(log.prevStageLast!==null&&log.prevStageLast!==undefined&&t.stageRewards){
          t.stageRewards.last=log.prevStageLast;
        }
      }
    }
    // Also reverse any linked cost log (restore vitality)
    const costLogs=state.logs.filter(l=>(l.link||'')===log.id);
    costLogs.forEach(cl=>{
      Ledger.post({op:'grant',account:'vitality',delta:-cl.amt,visible:false,reason:{src:'undo-cost'}});
    });
    // Remove the check-in log and any linked cost log
    Ledger.removeLogs(l=>l.id!==log.id&&(l.link||'')!==log.id);
    toast('已撤销打卡');
  }},
  cost:{reverse:function(log,ctx){
    // If cost has a link, undo the parent check-in instead
    if(log.link){
      ctx.undo(log.link);
      return false;
    }
    // Standalone cost — just reverse
    Ledger.post({op:'grant',account:'vitality',delta:-log.amt,visible:false,reason:{src:'undo-cost'}});
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销');
  }},
  purchase:{reverse:function(log){
    // Refund and restore stock. 贷款购买时只退自付部分，避免把贷款额一起退回。
    const paidPart=Math.abs(log.amt)-(typeof log.loanAmt==='number'?log.loanAmt:0);
    Ledger.post({op:'grant',account:log.st,delta:paidPart,visible:false,reason:{src:'undo-purchase'}});
    if(log.prodId){
      const p=state.products.find(x=>x.id===log.prodId);
      if(p){
        // Restore stock even if sold out (stock===0) so it returns to its original category
        if(p.stock>=0)p.stock++;
        p.sold=Math.max(0,(p.sold||0)-1);
      }
    }
    // Also remove any associated loan
    if(log.loanId){
      state.loans=state.loans.filter(l=>l.id!==log.loanId);
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销购买');
  }},
  achievement:{reverse:function(log){
    // Un-unlock achievement
    if(log.achId){
      const a=state.achievements.find(x=>x.id===log.achId);
      if(a){
        a.unlocked=false;
        a.unlockedAt=null;
      }
    }
    Ledger.post({op:'grant',account:'achievement',delta:-log.amt,visible:false,reason:{src:'undo-achievement'}});
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销成就解锁');
  }},
  'loan-repay':{reverse:function(log){
    // Undo loan repayment: restore the repaid amount and re-create the loan
    Ledger.post({op:'grant',account:log.st,delta:Math.abs(log.amt),visible:false,reason:{src:'undo-loan-repay'}});
    if(log.loanCopy){
      // Re-create the loan that was auto-paid
      state.loans.push(log.loanCopy);
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销还款，贷款已恢复');
  }},
  'manual-adjust':{reverse:function(log){
    // 撤销手动修正：反向应用调整值
    Ledger.post({op:'grant',account:log.st,delta:-log.amt,visible:false,reason:{src:'undo-manual-adjust'}});
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销余额修正');
  }},
  'delete-coll':{reverse:function(log){
    // Restore deleted collection
    if(log.collCopy){
      // Restore collection at its original position
      state.collections.splice(Math.min(log.collIndex,state.collections.length),0,log.collCopy);
    }
    // Restore tasks to the collection
    if(log.affectedTasks){
      log.affectedTasks.forEach(at=>{
        const t=state.tasks.find(x=>x.id===at.id);
        if(t)t.collectionId=at.prevCollectionId;
      });
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除集合');
  }},
  'delete-task':{reverse:function(log){
    // Restore the deleted task
    if(log.taskCopy){
      state.tasks.splice(Math.min(log.taskIndex,state.tasks.length),0,log.taskCopy);
    }
    // Reverse progress move: take back from default, return to original domains
    if(log.progressMoved){
      Ledger.post({op:'grant',account:'progress:d_default',delta:-log.progressMoved.totalMoved,visible:false,reason:{src:'undo-delete-task'}});
      log.progressMoved.fromDomains.forEach(d=>{
        Ledger.post({op:'grant',account:'progress:'+d.did,delta:d.amount,visible:false,reason:{src:'undo-delete-task'}});
      });
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除任务');
  }},
  'delete-ach':{reverse:function(log){
    // Restore the deleted milestone
    if(log.achCopy){
      state.achievements.splice(Math.min(log.achIndex,state.achievements.length),0,log.achCopy);
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除里程碑');
  }},
  'delete-domain':{reverse:function(log){
    // Restore the deleted domain
    if(log.domCopy){
      state.domains.splice(Math.min(log.domIndex,state.domains.length),0,log.domCopy);
    }
    // Reverse progress merge: take back from default, return to original domain
    if(log.progressVal){
      Ledger.post({op:'grant',account:'progress:d_default',delta:-log.progressVal,visible:false,reason:{src:'undo-delete-domain'}});
      Ledger.post({op:'adjust',account:'progress:'+log.domCopy.id,target:log.progressVal,visible:false,reason:{src:'undo-delete-domain'}});
    }
    // Restore tasks' domain assignments
    if(log.affectedTasks){
      log.affectedTasks.forEach(at=>{
        const t=state.tasks.find(x=>x.id===at.id);
        if(t){
          if(at.prevDomainIds)t.domainIds=at.prevDomainIds;
          if(at.prevDomainId)t.domainId=at.prevDomainId;
        }
      });
    }
    // Restore achievements' domain assignments
    if(log.affectedAchs){
      log.affectedAchs.forEach(aa=>{
        const a=state.achievements.find(x=>x.id===aa.id);
        if(a)a.domainId=aa.prevDomainId;
      });
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除领域');
  }},
  'delete-prod':{reverse:function(log){
    // Restore the deleted product
    if(log.prodCopy){
      state.products.splice(Math.min(log.prodIndex,state.products.length),0,log.prodCopy);
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除商品');
  }},
  'delete-shopcat':{reverse:function(log){
    // Restore the deleted shop category
    if(log.catCopy){
      state.shopCategories.splice(Math.min(log.catIndex,state.shopCategories.length),0,log.catCopy);
    }
    // Restore products' category assignments
    if(log.affectedProducts){
      log.affectedProducts.forEach(ap=>{
        const p=state.products.find(x=>x.id===ap.id);
        if(p)p.categoryId=ap.prevCategoryId;
      });
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销删除分类');
  }},
  exempt:{reverse:function(log){
    // Undo exemption: return card + restore pendingDebt/lastExempt/lastDebtDate
    Ledger.post({op:'grant',account:'card:exemption',delta:1,visible:false,reason:{src:'undo-exempt'}});
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){
        if(log.prevLastExempt)t.lastExempt=log.prevLastExempt;else delete t.lastExempt;
        t.pendingDebt=log.prevPendingDebt||0;
        if(log.prevLastDebtDate)t.lastDebtDate=log.prevLastDebtDate;else delete t.lastDebtDate;
      }
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销豁免');
  }},
  unlock:{reverse:function(log){
    // Undo unlock: re-archive task + refund vitality
    Ledger.post({op:'grant',account:'vitality',delta:-log.amt,visible:false,reason:{src:'undo-unlock'}});
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){t.archived=true;t.archivedAt=now();}
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销解锁，任务已重新归档');
  }},
  archive:{reverse:function(log){
    // Undo auto-archive: un-archive task
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){t.archived=false;delete t.archivedAt;}
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销归档');
  }}
};

function undoLog(logId){
  const txr=Ledger.txn(function(){
    const log=state.logs.find(l=>l.id===logId);
    if(!log){toast('记录不存在','err');return;}
    const ad=Object.prototype.hasOwnProperty.call(UNDO_ADAPTERS,log.src)?UNDO_ADAPTERS[log.src]:null;
    if(!ad){toast('该记录不支持撤销','err');return;}
    // 适配器返回 false：内层已处理并完成收尾（如 cost → 父打卡）
    if(ad.reverse(log,{undo:undoLog})===false)return;
    // 撤销里程碑解锁本身不能再触发重新解锁（否则点数与日志会被立刻补回来）
    if(log.src!=='achievement')checkAchievements();
    processDailyTaskDebts(true);
    processLoansWithDecayReserve();
  },{label:'undo',save:'none',render:false});
  if(!txr.ok){console.warn('undo aborted',logId,txr.error);return;}
  // 嵌套撤销（cost 转父打卡）由最外层统一收尾，避免事务中途渲染
  if(txr.nested)return;
  save();
  render();
}

// ===== Modals =====
function openModal(id){document.getElementById(id).classList.add('show')}
function closeModal(id){document.getElementById(id).classList.remove('show')}

function openTaskModal(id,presetCollId){
  const title=document.getElementById('taskModalTitle');
  document.getElementById('taskId').value='';
  fillCollectionSelect(document.getElementById('taskCollection'),presetCollId||'c_default');
  fillDomainChecklist(document.getElementById('taskDomainList'),['d_default']);
  if(id){
    const t=state.tasks.find(x=>x.id===id);
    if(!t)return;
    title.textContent='编辑任务';
    document.getElementById('taskId').value=id;
    document.getElementById('taskName').value=t.name;
    document.getElementById('taskDesc').value=t.description||'';
    document.getElementById('taskInitial').value=t.initialValue;
    document.getElementById('taskInterest').value=t.interestRate;
    document.getElementById('taskDebt').value=t.debtRate;
    document.getElementById('taskCost').value=t.vitalityCost||0;
    fillCollectionSelect(document.getElementById('taskCollection'),t.collectionId||'c_default');
    fillDomainChecklist(document.getElementById('taskDomainList'),getTaskDomainIds(t));
    editTypes=taskScoreTypes(t).slice();
    applyScoreTypePicks();
    // Always offer recalculation when editing; hint reflects whether history exists
    const hasHistory=(t.checkInCount||0)>0||state.logs.some(l=>l.src==='checkin'&&l.taskId===t.id);
    document.getElementById('recalcFG').style.display='block';
    document.getElementById('recalcHint').textContent=hasHistory?('用新参数重放全部 '+(t.checkInCount||0)+' 次打卡记录'):'该任务暂无打卡历史';
    document.getElementById('taskRecalc').checked=false;
  }else{
    title.textContent='新建任务';
    document.getElementById('taskName').value='';
    document.getElementById('taskDesc').value='';
    document.getElementById('taskInitial').value=10;
    document.getElementById('taskInterest').value=10;
    document.getElementById('taskDebt').value=5;
    document.getElementById('taskCost').value=0;
    editTypes=['vitality'];
    applyScoreTypePicks();
    document.getElementById('recalcFG').style.display='none';
  }
  // 初始化阶段奖励编辑状态
  const taskForStage=id?state.tasks.find(x=>x.id===id):null;
  const sr=taskForStage&&taskForStage.stageRewards;
  editStage={enabled:!!sr,v:Array.isArray(sr&&sr.v)?sr.v.slice():[],p:Array.isArray(sr&&sr.p)?sr.p.slice():[],dirtyV:false,dirtyP:false,last:(sr&&typeof sr.last==='number')?sr.last:0};
  const stageCb=document.getElementById('taskStageEnabled');
  if(stageCb)stageCb.checked=editStage.enabled;
  if(editStage.enabled){const rf=document.getElementById('recalcFG');if(rf)rf.style.display='none';}
  renderStageRows();
  refreshTaskSliders();
  setTaskAccordion('accTaskType',true);
  setTaskAccordion('accTaskNum',false);
  setTaskAccordion('accTaskMeta',false);
  setTaskAccordion('accTaskStage',false);
  updateTaskAccSummaries();
  openModal('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}

// ===== 任务弹窗：数值滑动条 + 分区摘要 =====
const TASK_SLIDERS={taskInitial:{min:0,max:100},taskInterest:{min:0,max:50},taskDebt:{min:0,max:50},taskCost:{min:0,max:100}};
function refreshTaskSliders(){
  document.querySelectorAll('.slide-track').forEach(function(track){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    const v=Math.max(r.min,Math.min(r.max,Number(input.value)||0));
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(((v-r.min)/(r.max-r.min))*100)+'%';
  });
}
function bindTaskSliders(){
  let cur=null;
  function setFromX(track,clientX){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const rect=track.getBoundingClientRect();
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    let ratio=(clientX-rect.left)/rect.width;
    ratio=Math.max(0,Math.min(1,ratio));
    let v=r.min+ratio*(r.max-r.min);
    v=Math.round(v*10)/10;
    v=Math.max(r.min,Math.min(r.max,v));
    input.value=v;
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(ratio*100)+'%';
  }
  document.querySelectorAll('.slide-track').forEach(function(track){
    track.addEventListener('pointerdown',function(e){
      cur=track;
      if(track.setPointerCapture){try{track.setPointerCapture(e.pointerId);}catch(err){}}
      setFromX(track,e.clientX);
    });
    track.addEventListener('pointermove',function(e){
      if(cur===track)setFromX(track,e.clientX);
    });
    track.addEventListener('pointerup',function(){cur=null;});
    track.addEventListener('pointercancel',function(){cur=null;});
  });
  document.addEventListener('input',function(e){
    const id=e.target&&e.target.id;
    if(id&&TASK_SLIDERS[id]){refreshTaskSliders();updateTaskAccSummaries();}
  });
  const collSel=document.getElementById('taskCollection');
  if(collSel)collSel.addEventListener('change',updateTaskAccSummaries);
}
function updateTaskAccSummaries(){
  const tsEl=document.getElementById('accTaskTypeSum');
  if(tsEl){
    const v=editTypes.indexOf('vitality')>=0,p=editTypes.indexOf('progress')>=0;
    let s=(v&&p)?'活力+进度':(p?'进度值':'活力点');
    try{
      if(p){const ds=getCheckedDomainIds();s+=' · '+ds.map(domainName).join('、');}
    }catch(err){}
    tsEl.textContent=s;
  }
  const numEl=document.getElementById('accTaskNumSum');
  if(numEl){
    const g=function(id){const el=document.getElementById(id);return el?el.value:'';};
    numEl.textContent='初始'+g('taskInitial')+' · 利率'+g('taskInterest')+'% · 债率'+g('taskDebt')+'% · 花'+g('taskCost');
  }
  const metaEl=document.getElementById('accTaskMetaSum');
  if(metaEl){
    const sel=document.getElementById('taskCollection');
    metaEl.textContent=(sel&&sel.selectedOptions&&sel.selectedOptions.length)?sel.selectedOptions[0].text:'';
  }
  const stageEl=document.getElementById('accTaskStageSum');
  if(stageEl){
    stageEl.textContent=editStage.enabled?'5 档':'未配置';
  }
}
function setTaskAccordion(id,open){
  const el=document.getElementById(id);
  if(el)el.classList.toggle('open',open);
}

function applyScoreTypePicks(){
  document.getElementById('tpV').classList.toggle('sel',editTypes.indexOf('vitality')>=0);
  document.getElementById('tpP').classList.toggle('sel',editTypes.indexOf('progress')>=0);
  document.getElementById('domainFG').style.display=editTypes.indexOf('progress')>=0?'block':'none';
  renderStageRows();
  updateTaskAccSummaries();
}
function toggleScoreType(type){
  const i=editTypes.indexOf(type);
  if(i>=0){
    if(editTypes.length===1){toast('至少选择一种分值类型','warn');return;}
    editTypes.splice(i,1);
  }else{
    editTypes.push(type);
  }
  applyScoreTypePicks();
}

// ===== 阶段奖励：编辑界面 =====
function onStageEnabled(){
  const cb=document.getElementById('taskStageEnabled');
  editStage.enabled=!!cb.checked;
  if(editStage.enabled){
    const base=parseFloat(document.getElementById('taskInitial').value)||0;
    if(!Array.isArray(editStage.v)||editStage.v.length!==5)editStage.v=[base,base,base,base,base];
    if(!Array.isArray(editStage.p)||editStage.p.length!==5)editStage.p=[base,base,base,base,base];
    editStage.dirtyV=false;editStage.dirtyP=false;
  }
  renderStageRows();
  updateTaskAccSummaries();
}
function onStageInput(type){
  if(type==='vitality')editStage.dirtyV=true;else editStage.dirtyP=true;
  updateTaskAccSummaries();
}
function stageRowHTML(type,label){
  const vals=type==='vitality'?editStage.v:editStage.p;
  const inputs=STAGE_NAMES.map((n,i)=>
    '<div class="stage-cell"><span class="stage-cell-name">'+n+'</span>'
    +'<input type="number" id="stage_'+type+'_'+i+'" value="'+((vals[i]!==undefined&&vals[i]!==null)?vals[i]:'')+'" step="0.1" min="0" oninput="onStageInput(\''+type+'\')"></div>'
  ).join('');
  return '<div class="stage-row">'
    +'<div class="stage-row-head"><span class="stage-row-title">'+label+'</span>'
    +'<div class="sp-group">'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'arith\',\''+type+'\')">等差</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'arith\',\''+type+'\')">▾</button></div>'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'decr\',\''+type+'\')">缓增</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'decr\',\''+type+'\')">▾</button></div>'
    +'</div></div>'
    +'<div class="stage-inputs">'+inputs+'</div>'
    +'<div class="sp-panel" id="sp_panel_'+type+'" style="display:none"></div>'
    +'</div>';
}
function renderStageRows(){
  const cont=document.getElementById('taskStageRows');
  if(!cont)return;
  if(!editStage.enabled){cont.innerHTML='';return;}
  const hasV=editTypes.indexOf('vitality')>=0;
  const hasP=editTypes.indexOf('progress')>=0;
  let html='';
  if(hasV)html+=stageRowHTML('vitality','活力点');
  if(hasP)html+=stageRowHTML('progress','进度值');
  cont.innerHTML=html;
}
function toggleStageParam(kind,type){
  const panel=document.getElementById('sp_panel_'+type);
  if(!panel)return;
  const showing=panel.style.display!=='none'&&panel.dataset.kind===kind;
  if(kind==='arith'){
    panel.innerHTML='<div class="sp-param"><label>步长 %</label><input type="number" id="sp_arith_step" value="'+stagePresets.stepPct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'arith\',\''+type+'\')">生成</button>';
    panel.dataset.kind='arith';
  }else{
    panel.innerHTML='<div class="sp-param"><label>总增幅 %</label><input type="number" id="sp_decr_gain" value="'+stagePresets.decreasePct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'decr\',\''+type+'\')">生成</button>';
    panel.dataset.kind='decr';
  }
  panel.style.display=showing?'none':'block';
}
function applyStagePreset(kind,type){
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function runStagePreset(kind,type){
  if(kind==='arith'){
    stagePresets.stepPct=Number(document.getElementById('sp_arith_step').value)||0;
  }else{
    stagePresets.decreasePct=Number(document.getElementById('sp_decr_gain').value)||0;
  }
  saveStagePresets();
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function generateStage(kind,type,params){
  const isV=(type==='vitality');
  let hasVals=false;
  for(let i=0;i<5;i++){const el=document.getElementById('stage_'+type+'_'+i);if(el&&el.value!==''){hasVals=true;break;}}
  if(hasVals&&!window.confirm('这会覆盖当前的 5 个数值，继续吗？'))return;
  const base=parseFloat(document.getElementById('taskInitial').value)||0;
  const vals=kind==='arith'?genArith(base,params.stepPct):genDecr(base,params.decreasePct);
  if(isV){editStage.v=vals;editStage.dirtyV=false;}else{editStage.p=vals;editStage.dirtyP=false;}
  for(let i=0;i<5;i++){
    const el=document.getElementById('stage_'+type+'_'+i);
    if(el)el.value=fmt(vals[i]);
  }
  updateTaskAccSummaries();
}
function genArith(base,stepPct){
  const step=Math.max(0,Number(stepPct)||0)/100;
  return STAGE_NAMES.map((_,n)=>round2(base*(1+step*n)));
}
function genDecr(base,gainPct){
  const total=base*Math.max(0,Number(gainPct)||0)/100;
  const r=0.5,sum=1+r+r*r+r*r*r;
  const d1=total/sum;
  const vals=[round2(base)];
  for(let k=1;k<5;k++){
    let inc=0;
    for(let i=0;i<k;i++)inc+=d1*Math.pow(r,i);
    vals.push(round2(base+inc));
  }
  return vals;
}

function handleTaskSave(){
  const id=document.getElementById('taskId').value;
  const name=document.getElementById('taskName').value.trim();
  const description=document.getElementById('taskDesc').value.trim();
  const initialValue=parseFloat(document.getElementById('taskInitial').value);
  const interestRate=parseFloat(document.getElementById('taskInterest').value);
  const debtRate=parseFloat(document.getElementById('taskDebt').value);
  const vitalityCost=parseFloat(document.getElementById('taskCost').value);
  const collectionId=document.getElementById('taskCollection').value;
  const domainIds=getCheckedDomainIds();

  if(!name){toast('请输入任务名称','err');return}
  if(isNaN(initialValue)||initialValue<0){toast('初始数值需 ≥ 0','err');return}
  if(isNaN(interestRate)||interestRate<0){toast('利率需 ≥ 0','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}
  if(isNaN(vitalityCost)||vitalityCost<0){toast('活力点花费需 ≥ 0','err');return}

  // 阶段奖励
  let stageRewards=null;
  if(editStage.enabled){
    const hasV=editTypes.indexOf('vitality')>=0;
    const hasP=editTypes.indexOf('progress')>=0;
    const readRow=function(type){
      const arr=[];
      for(let i=0;i<5;i++){
        const el=document.getElementById('stage_'+type+'_'+i);
        let v=el?parseFloat(el.value):NaN;
        if(isNaN(v)||v<0)v=0;
        arr.push(round2(v));
      }
      return arr;
    };
    stageRewards={last:editStage.last!==undefined?editStage.last:0};
    if(hasV)stageRewards.v=readRow('vitality');
    if(hasP)stageRewards.p=readRow('progress');
  }

  const prevTask=id?state.tasks.find(x=>x.id===id):null;
  const wasStaged=prevTask&&taskIsStaged(prevTask);
  const recalc=id?((document.getElementById('taskRecalc').checked)&&!wasStaged&&!editStage.enabled):false;
  const saved=saveTaskData({id:id||null,name:name,description:description,scoreTypes:editTypes.slice(),domainIds:domainIds,collectionId:collectionId,initialValue:initialValue,interestRate:interestRate,debtRate:debtRate,vitalityCost:vitalityCost,stageRewards:stageRewards,recalc:recalc});
  if(!saved)return;
  closeModal('taskModal');
  toast(id?(recalc?'任务已更新，历史数据已重算':'任务已更新'):'任务已创建');
  render();
}

function openAchModal(id,presetDomId){
  const title=document.getElementById('achModalTitle');
  document.getElementById('achId').value='';
  fillDomainSelect(document.getElementById('achDomain'),presetDomId||'d_default');
  if(id){
    const a=state.achievements.find(x=>x.id===id);
    if(!a)return;
    title.textContent='编辑里程碑';
    document.getElementById('achId').value=id;
    document.getElementById('achName').value=a.name;
    document.getElementById('achThreshold').value=a.threshold;
    document.getElementById('achPoints').value=a.points;
    fillDomainSelect(document.getElementById('achDomain'),a.domainId);
  }else{
    title.textContent='新建里程碑';
    document.getElementById('achName').value='';
    document.getElementById('achThreshold').value=100;
    document.getElementById('achPoints').value=1;
  }
  openModal('achModal');
  setTimeout(()=>document.getElementById('achName').focus(),50);
}

function handleAchSave(){
  const id=document.getElementById('achId').value;
  const name=document.getElementById('achName').value.trim();
  const threshold=parseFloat(document.getElementById('achThreshold').value);
  const points=parseFloat(document.getElementById('achPoints').value);
  const domainId=document.getElementById('achDomain').value;

  if(!name){toast('请输入里程碑名称','err');return}
  if(isNaN(threshold)||threshold<0){toast('门槛需 ≥ 0','err');return}
  if(isNaN(points)||points<=0){toast('成果点需 > 0','err');return}

  saveAchData({id:id||null,name:name,domainId:domainId,threshold:threshold,points:points});
  closeModal('achModal');
  toast(id?'里程碑已更新':'里程碑已设定');
  render();
}

function fillProdGateSelects(domainId,milestoneId){
  const ds=document.getElementById('prodGateDomain');
  if(ds){
    let html='<option value="">不限制活跃度</option>';
    state.domains.forEach(function(d){
      html+='<option value="'+escAttr(d.id)+'"'+(d.id===(domainId||'')?' selected':'')+'>'+esc(d.name)+(isArchivedEntity(d)?'（已归档）':'')+'</option>';
    });
    ds.innerHTML=html;
  }
  const ms=document.getElementById('prodGateMilestone');
  if(ms){
    let html='<option value="">请选择里程碑</option>';
    state.achievements.forEach(function(a){
      const stateTxt=isArchivedEntity(a)?'（已归档）':(a.unlocked?'（已解锁）':'（未解锁）');
      html+='<option value="'+escAttr(a.id)+'"'+(a.id===(milestoneId||'')?' selected':'')+'>'+esc(a.name)+stateTxt+'</option>';
    });
    ms.innerHTML=html;
  }
}

function onProdTierChange(){
  const sel=document.getElementById('prodTier');
  const tier=validProductTier(sel?sel.value:'daily');
  const q=document.getElementById('prodGateQuality');
  const e=document.getElementById('prodGateExclusive');
  if(q)q.style.display=tier==='quality'?'block':'none';
  if(e)e.style.display=tier==='exclusive'?'block':'none';
  const hint=document.getElementById('prodTierHint');
  if(hint){
    hint.textContent=tier==='daily'
      ?'支付币种：活力点 · 无门槛'
      :tier==='quality'
        ?'支付币种：成果点 · 需满足累计成果点与活跃度门槛'
        :'支付币种：成果点 · 需绑定处于已解锁状态的里程碑';
  }
  editCurrency=tierCurrency(tier);
}

function openProdModal(id,presetCatId){
  const title=document.getElementById('prodModalTitle');
  document.getElementById('prodId').value='';
  fillShopCatSelect(document.getElementById('prodCategory'),presetCatId||'sc_default');
  fillProdGateSelects('','');
  document.getElementById('prodTier').value='daily';
  document.getElementById('prodGateLifetime').value=0;
  document.getElementById('prodGateDays').value=7;
  document.getElementById('prodGateTimes').value=1;
  if(id){
    const p=state.products.find(x=>x.id===id);
    if(!p)return;
    title.textContent='编辑商品';
    document.getElementById('prodId').value=id;
    document.getElementById('prodName').value=p.name;
    document.getElementById('prodDesc').value=p.desc||'';
    document.getElementById('prodPrice').value=p.price;
    document.getElementById('prodStock').value=p.stock;
    document.getElementById('prodDebtRate').value=p.debtRate||0;
    fillShopCatSelect(document.getElementById('prodCategory'),p.categoryId||'sc_default');
    const tier=validProductTier(p.tier);
    const gate=normalizeProductGate(p.gate,productGateContext());
    document.getElementById('prodTier').value=tier;
    fillProdGateSelects(gate.activity.domainId,gate.milestoneId);
    document.getElementById('prodGateLifetime').value=gate.minLifetime;
    if(gate.activity.domainId){
      document.getElementById('prodGateDays').value=gate.activity.days||7;
      document.getElementById('prodGateTimes').value=gate.activity.times||1;
    }
    pickCurrency(tierCurrency(tier));
  }else{
    title.textContent='上架商品';
    document.getElementById('prodName').value='';
    document.getElementById('prodDesc').value='';
    document.getElementById('prodPrice').value=10;
    document.getElementById('prodStock').value=-1;
    document.getElementById('prodDebtRate').value=0;
    pickCurrency('vitality');
  }
  onProdTierChange();
  openModal('prodModal');
  setTimeout(()=>document.getElementById('prodName').focus(),50);
}

function pickCurrency(type){
  editCurrency=type;
  const pv=document.getElementById('ppV');
  const pa=document.getElementById('ppA');
  if(pv)pv.classList.toggle('sel',type==='vitality');
  if(pa)pa.classList.toggle('sel',type==='achievement');
}

function gateIntField(id,label,min,max){
  const raw=document.getElementById(id).value;
  const n=Number(raw);
  if(raw===''||!isFinite(n)||Math.round(n)!==n||n<min||(max!==undefined&&n>max)){
    toast(label+'需为 '+(max!==undefined?(min+'~'+max):('≥ '+min))+' 的整数','err');
    return null;
  }
  return n;
}

function handleProdSave(){
  const id=document.getElementById('prodId').value;
  const name=document.getElementById('prodName').value.trim();
  const desc=document.getElementById('prodDesc').value.trim();
  const price=parseFloat(document.getElementById('prodPrice').value);
  const stock=parseInt(document.getElementById('prodStock').value,10);
  const debtRate=parseFloat(document.getElementById('prodDebtRate').value);
  const categoryId=document.getElementById('prodCategory').value;
  const tier=validProductTier(document.getElementById('prodTier').value);

  if(!name){toast('请输入商品名称','err');return}
  if(isNaN(price)||price<0.1){toast('价格需 ≥ 0.1','err');return}
  if(isNaN(stock)||stock<-1){toast('库存需 ≥ -1','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}

  let gate=defaultProductGate();
  if(tier==='quality'){
    const minLifetime=gateIntField('prodGateLifetime','累计成果点门槛',0);
    if(minLifetime===null)return;
    const domainId=document.getElementById('prodGateDomain').value;
    gate.minLifetime=minLifetime;
    if(domainId){
      if(!state.domains.some(function(d){return d.id===domainId;})){
        toast('关联领域不存在，请重新选择','err');return;
      }
      const days=gateIntField('prodGateDays','活跃度天数 X',1,ACTIVITY_MAX_DAYS);
      if(days===null)return;
      const times=gateIntField('prodGateTimes','活跃度次数 Y',1);
      if(times===null)return;
      gate.activity={domainId:domainId,days:days,times:times};
    }
  }else if(tier==='exclusive'){
    const mid=document.getElementById('prodGateMilestone').value;
    if(!mid){toast('专属级需绑定一个里程碑','err');return}
    if(!state.achievements.some(function(a){return a.id===mid;})){
      toast('绑定的里程碑不存在，请重新选择','err');return;
    }
    gate.milestoneId=mid;
  }

  saveProdData({id:id||null,name:name,desc:desc,price:price,stock:stock,debtRate:debtRate,categoryId:categoryId,tier:tier,gate:gate});
  closeModal('prodModal');
  toast(id?'商品已更新':'商品已上架');
  render();
}

function confirmDelTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(t&&confirm('删除任务「'+t.name+'」？\n（已获得的积分不会消失，可在银行流水撤销此操作）')){delTask(id);toast('任务已删除');render()}
}
function confirmDelAch(id){
  const a=state.achievements.find(x=>x.id===id);
  if(a&&confirm('删除里程碑「'+a.name+'」？\n（已获得的成果点不会消失，可在银行流水撤销此操作）')){delAch(id);toast('里程碑已删除');render()}
}
function confirmDelProd(id){
  const p=state.products.find(x=>x.id===id);
  if(p&&confirm('删除商品「'+p.name+'」？\n（可在银行流水撤销此操作）')){delProd(id);toast('商品已删除');render()}
}

// ===== Toast =====
function toast(msg,type){
  const wrap=document.getElementById('toastWrap');
  if(!wrap)return;
  const t=document.createElement('div');
  t.className='toast'+(type?' '+type:'');
  t.textContent=msg;
  wrap.appendChild(t);
  // 同时最多 3 条，避免批量操作时堆满屏幕
  while(wrap.children.length>3)wrap.removeChild(wrap.firstChild);
  setTimeout(()=>t.remove(),2800);
}

// ===== Export / Import =====
function markBackup(){try{localStorage.setItem(BACKUP_KEY,String(Date.now()));}catch(e){}}
function maybeBackupReminder(){
  let last=0;
  try{last=Number(localStorage.getItem(BACKUP_KEY))||0;}catch(e){}
  if(!last)return;
  const days=(Date.now()-last)/864e5;
  if(days>=7){
    toast('已 '+Math.floor(days)+' 天未备份数据，建议「导出」一份备份','warn');
  }
}
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='计分系统_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();URL.revokeObjectURL(url);
  markBackup();
  toast('数据已导出');
}
function importData(ev){
  const f=ev.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=function(e){
    const raw=e.target.result;
    try{
      const probe=JSON.parse(raw);
      if(!probe||typeof probe!=='object'||Array.isArray(probe)||!probe.scores)throw 0;
    }catch(err){toast('导入失败：格式不正确','err');return;}
    // 统一走 parseState 的迁移口径，避免导入/加载两套迁移规则漂移
    loadIssue=null;
    const s=parseState(raw);
    if(loadIssue){toast('导入失败：格式不正确','err');return;}
    state=s;
    commit('导入成功');
  };
  r.readAsText(f);ev.target.value='';
}

// ===== PWA Install =====
let deferredPrompt=null;

// Inject manifest via Blob (works for single-file HTML)
function injectManifest(){
  const manifest={
    name:'计分系统',
    short_name:'计分',
    description:'活力点、进度值、成果点自动计分系统',
    start_url:'.',
    display:'standalone',
    background_color:'#e8e8e8',
    theme_color:'#e8e8e8',
    icons:[]
  };
  const blob=new Blob([JSON.stringify(manifest)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  let link=document.querySelector('link[rel="manifest"]');
  if(!link){link=document.createElement('link');link.rel='manifest';document.head.appendChild(link);}
  link.href=url;
}

// Register a minimal service worker via Blob for offline support
function registerSW(){
  if(!('serviceWorker' in navigator))return;
  const swCode=`
    const CACHE='score-sys-v1';
    self.addEventListener('install',e=>{self.skipWaiting()});
    self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
    self.addEventListener('fetch',e=>{
      e.respondWith(
        caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
          const copy=resp.clone();
          caches.open(CACHE).then(c=>c.put(e.request,copy));
          return resp;
        }).catch(()=>r))
      );
    });
  `;
  const blob=new Blob([swCode],{type:'application/javascript'});
  const url=URL.createObjectURL(blob);
  navigator.serviceWorker.register(url).catch(()=>{});
}

function initPWA(){
  injectManifest();
  registerSW();

  // Detect if already running as installed app
  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches
      ||window.navigator.standalone===true;
  }

  const btn=document.getElementById('installBtn');

  // If already standalone, hide install button
  if(isStandalone()){
    if(btn)btn.style.display='none';
  }

  // Listen for install prompt (capture deferredPrompt, button already visible)
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredPrompt=e;
  });

  // Listen for app installed event
  window.addEventListener('appinstalled',()=>{
    if(btn)btn.style.display='none';
    deferredPrompt=null;
    toast('已安装至桌面');
  });

  // Also check display-mode change (uninstall scenario)
  window.matchMedia('(display-mode: standalone)').addEventListener('change',e=>{
    if(!btn)return;
    if(e.matches){
      btn.style.display='none';
    }else{
      // Running in browser after uninstall — show button
      btn.style.display='';
    }
  });
}

function installApp(){
  if(!deferredPrompt){
    // Browser doesn't support install prompt — show manual instructions
    openModal('installModal');
    return;
  }
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(()=>{
    deferredPrompt=null;
    const btn=document.getElementById('installBtn');
    if(btn)btn.style.display='none';
  });
}

// 数据损坏/被截断：先备份原始内容，避免被下一次保存覆盖而彻底丢失
// 固定两个键轮换（latest/prev），不再每次生成时间戳键导致 localStorage 无限膨胀
const CORRUPT_BACKUP_KEY='score_sys_corrupt_backup';
function backupCorrupt(raw){
  try{
    const cur=localStorage.getItem(CORRUPT_BACKUP_KEY);
    if(cur)localStorage.setItem(CORRUPT_BACKUP_KEY+'_prev',cur);
    localStorage.setItem(CORRUPT_BACKUP_KEY,raw);
    // 清理历史版本留下的时间戳键
    const stale=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.indexOf(CORRUPT_BACKUP_KEY+'_')===0&&k!==CORRUPT_BACKUP_KEY+'_prev')stale.push(k);
    }
    stale.forEach(function(k){localStorage.removeItem(k);});
  }catch(e){}
}

// 启动装载：只读 IndexedDB；无存档则使用全新默认状态（v1 原点，无旧版迁移）
async function loadStateFromStorage(){
  loadIssue=null;
  let raw=null;
  try{raw=await withTimeout(idbGet(KEY),3000,undefined);}catch(e){}
  const hasIDB=(raw!==undefined&&raw!==null&&raw!=='');
  if(hasIDB){
    const s=parseState(raw);
    if(loadIssue){
      if(loadIssue.type==='corrupt'){try{await idbPut(KEY+'_corrupt',raw);}catch(e){}}
      backupCorrupt(raw);
    }
    return s;
  }
  return defaults();
}

async function attemptRecovery(){
  const bar=document.getElementById('recoverBar');
  const btn=bar?bar.querySelector('button'):null;
  if(btn){btn.disabled=true;btn.textContent='恢复中…';}
  try{
    let raw=null;
    try{raw=await idbGet(KEY+'_corrupt');}catch(e){}
    if(raw===undefined||raw===null||raw===''){toast('未找到可恢复的原始数据','err');return;}
    const s=parseState(raw);
    if(!s||typeof s!=='object'||!s.scores){toast('恢复失败：原始内容无法解析','err');return;}
    state=s;
    save();
    render();
    toast('已尝试恢复上次数据','ok');
  }finally{
    if(bar)bar.style.display='none';
    if(btn){btn.disabled=false;btn.textContent='尝试恢复';}
  }
}

// 开发期自检：确认日志写入口只存在于 Ledger 内部（#debug 下输出警告，避免业务层回潮直写）
function devAuditLogWrites(){
  if(location.hash!=='#debug')return;
  const bad=[];
  if(typeof addLog!=='undefined')bad.push('addLog 仍可从业务层调用');
  if(typeof pushLog!=='undefined')bad.push('pushLog 仍可从业务层调用');
  if(typeof Ledger.event!=='function')bad.push('Ledger.event 缺失');
  if(typeof Ledger.append!=='function')bad.push('Ledger.append 缺失');
  if(typeof Ledger.removeLogs!=='function')bad.push('Ledger.removeLogs 缺失');
  if(typeof Ledger.reverse!=='function')bad.push('Ledger.reverse 缺失');
  if(bad.length)console.warn('[dev] 日志写入口自检失败：'+bad.join('；'));
  // 源码级回潮检查：http(s) 下取样 app.js，确认日志数组直写次数没有超过 Ledger 内部与全量重置的既有额度
  if(location.protocol==='http:'||location.protocol==='https:'){
    fetch('app.js').then(function(r){return r.ok?r.text():'';}).then(function(src){
      if(!src)return;
      const quotas=[[/state\.logs\.unshift/g,1],[/state\.logs\.push/g,1],[/state\.logs\.length\s*=/g,1],[/state\.logs\s*=(?!=)/g,2]];
      const hits=[];
      quotas.forEach(function(q){
        const n=(src.match(q[0])||[]).length;
        if(n>q[1])hits.push(q[0].source+' ×'+n+'（上限 '+q[1]+'）');
      });
      if(hits.length)console.warn('[dev] 检测到日志直写回潮：'+hits.join('；'));
    }).catch(function(){});
  }
}

// ===== Init =====
async function init(){
  state=await loadStateFromStorage();
  if(loadIssue){
    toast(loadIssue.type==='salvaged'
      ?'检测到数据不完整，已自动修复并恢复可读部分（原始内容已备份）'
      :'本地数据已损坏，已重置（原始内容已备份）','err');
    if(loadIssue.type==='corrupt'){const rb=document.getElementById('recoverBar');if(rb)rb.style.display='flex';}
  }
  maybeBackupReminder();
  // 申请持久化存储，降低浏览器自动清理 IndexedDB 的风险
  try{
    if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
  }catch(e){}
  const n=new Date(),wd=['日','一','二','三','四','五','六'];
  document.getElementById('todayDate').textContent=
    n.getFullYear()+'.'+String(n.getMonth()+1).padStart(2,'0')+'.'+String(n.getDate()).padStart(2,'0')+' 周'+wd[n.getDay()];

  // Ensure default domain/collection/shopCategory exist
  if(!state.domains.find(d=>d.id==='d_default'))state.domains.unshift({id:'d_default',name:'默认'});
  if(!state.collections.find(c=>c.id==='c_default'))state.collections.unshift({id:'c_default',name:'默认'});
  if(!state.shopCategories.find(c=>c.id==='sc_default'))state.shopCategories.unshift({id:'sc_default',name:'默认'});

  // 能力雷达指标为纯自定义：未创建指标时不显示任何指标
  if(!Array.isArray(state.metrics))state.metrics=[];

  document.querySelectorAll('.modal-bg').forEach(bg=>{
    bg.addEventListener('click',e=>{if(e.target===bg)bg.classList.remove('show')});
  });

  // 模态保存按钮集中登记，新增模态只需在此表加一行
  const MODAL_SAVERS={
    taskSaveBtn:handleTaskSave,
    achSaveBtn:handleAchSave,
    prodSaveBtn:handleProdSave,
    metricSaveBtn:handleMetricSave,
    activitySaveBtn:handleActivitySave,
    affairSaveBtn:handleAffairSave,
    affairPlanSaveBtn:saveAffairPlan,
    presetSaveBtn:savePreset,
    choreSaveBtn:saveChore,
    choreCfgSaveBtn:saveChoreConfig
  };
  Object.keys(MODAL_SAVERS).forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.addEventListener('click',MODAL_SAVERS[id]);
  });
  // 任意模态内按 Enter 触发该模态右下角主按钮（不再逐模态重复绑定）
  document.querySelectorAll('.modal-bg').forEach(bg=>{
    bg.addEventListener('keydown',e=>{
      if(e.key!=='Enter'||!e.target||e.target.tagName!=='INPUT')return;
      e.preventDefault();
      const btn=bg.querySelector('.modal-foot .btn:last-child');
      if(btn)btn.click();
    });
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')document.querySelectorAll('.modal-bg.show').forEach(m=>m.classList.remove('show'));
  });

  checkAchievements();
  // 启动时各处理器统一 silent，最后一次写盘
  processDailyTaskDebts(true);
  processMetabolism(true);
  processLoansWithDecayReserve();
  processActivities(true);
  processChoreDecay(true);
  save();
  setInterval(schedulerTick,60000);
  initDrag();
  initTaskReveal();
  bindTaskSliders();
  initPWA();
  devAuditLogWrites();
  render();
}

init();
