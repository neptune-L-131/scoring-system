import { BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, BUDGET_VERSION, SCHEMA_VERSION, STATS_VERSION } from './constants.js';
import { defaultWatermark, now, uid } from './pure.js';
// defaults.js —— 默认状态与默认配置工厂
// 由 state/normalize 抽离（第六轮循环依赖治理），返回值逐字未改。

function defaultBudgetSettings(){
  return{
    ledgerMax:BUDGET_LEDGER_MAX,
    periodKeep:{week:BUDGET_PERIOD_KEEP.week,month:BUDGET_PERIOD_KEEP.month},
    // 周起始日变更后的可见提示：{categoryId,name,from,to,at}
    anchorNotice:null
  };
}
function defaultBudgetsState(){
  return{version:BUDGET_VERSION,categories:[],current:{},periods:{},ledger:[],settings:defaultBudgetSettings()};
}
function defaultProductGate(){
  return{minLifetime:0,activity:{domainId:'',days:0,times:0},milestoneId:'',condition:{mode:'all',items:[]}};
}
function tierCurrency(tier){return tier==='daily'?'vitality':'achievement';}
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
  c.archived=!!c.archived;
  c.archivedAt=c.archivedAt||null;
  if(c.freshDays===undefined||c.freshDays===null||c.freshDays===''||isNaN(Number(c.freshDays)))c.freshDays=null;
  else c.freshDays=Math.max(0,Math.round(Number(c.freshDays)));
  return c;
}

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
function newExtState(){
  return{
    stats:{lifetimeVitalityIn:0,lifetimeVitalityOut:0,lifetimeProgressIn:0,lifetimeProgressOut:0,lifetimeAchievementIn:0,lifetimeAchievementOut:0,totalCheckins:0,totalPurchases:0,lifetimeAchievementEarned:0,version:STATS_VERSION,lastDay:null,daily:{},invisible:{vitality:0,achievement:0,progress:{},cards:{}},evicted:{vitality:0,achievement:0,progress:{},cards:{}},updatedAt:null},
    watermarks:{vitality:defaultWatermark(),achievement:defaultWatermark(),totalProgress:defaultWatermark(),progress:{}},
    budgets:defaultBudgetsState(),
    investment:{window:30},
    reports:[],
    audit:[],
    activity:{},
    achievementCounted:{},
    shadow:[],
    // 代谢规则是否已播种：一旦为 true，用户删除默认规则后不再自动补回
    metabolismSeeded:false,
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

export { defaultBudgetSettings, defaultBudgetsState, defaultProductGate, tierCurrency, defaultChoreConfig, normalizeChoreConfig, migrateChore, defaultActivities, newExtState, defaults };
