import { ASSET_VERSION, BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, BUDGET_VERSION, FLOW_VERSION, SCHEMA_VERSION, STATS_VERSION } from './constants.js';
import { normalizeChoreCycle, normalizeChoreHistory } from './chore-cycle.js';
import { normalizeChoreTags } from './chore-list.js';
import { defaultExecBuys } from './exec-quota.js';
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
  // 循环设置与完成历史：只守卫形状，不补默认值、不批量迁移。
  // 缺字段 / 非法配置一律按一次性杂事读入（删除坏字段，行为与旧版完全一致）。
  if(c.cycle!==undefined){
    const cy=normalizeChoreCycle(c.cycle);
    if(cy)c.cycle=cy;else delete c.cycle;
  }
  if(c.history!==undefined){
    const hist=normalizeChoreHistory(c.history);
    if(hist)c.history=hist;else delete c.history;
  }
  // 标签：独立命名空间；旧存档缺省读入空数组，非法条目丢弃，不批量迁移。
  c.tags=normalizeChoreTags(c.tags);
  return c;
}

function defaultAssetDef(id,name,extra){
  return Object.assign({
    v:ASSET_VERSION,id:id,name:name,unit:'张',
    maxBalance:null,maxIssuedPerPeriod:null,
    issuePeriod:{cycle:'week',anchor:1},
    enabled:true,archived:false,origin:'builtin',createdAt:0,updatedAt:0
  },extra||{});
}
// 新存档唯一的资产示例：出厂即带「任务豁免」使用配方，之后与普通资产完全同权
function defaultAssetDefs(){
  return[defaultAssetDef('exemption','断更豁免卡',{useRecipe:{v:1,type:'task-exempt',cost:1}})];
}
function defaultAssetCards(){
  const cards={};
  defaultAssetDefs().forEach(function(d){cards[d.id]=0;});
  return cards;
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
    features:{audit:true},
    // 阶段 4 运行层：资产周期计量与动作流运行记录（缺省空结构，懒安全）
    assetMeters:{v:ASSET_VERSION,byAsset:{},idem:{}},
    flowRuns:{v:FLOW_VERSION,seq:0,byId:{},recent:[]},
    // 执行权商品的本周期购买次数：不随购买流水裁剪而丢失
    execBuys:defaultExecBuys(),
    // 阶段 5 事件触发：只做事件记录的数据结构，不参与任何执行
    events:{v:1,recent:[]}
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
    // 杂事列表的容器侧 id 序列：空数组表示未设置顺序，渲染回落到原排序
    choreOrder:[],
    choreConfig:defaultChoreConfig(),
    affairPresets:[],
    affairCollapsed:[],
    affairUndo:{},
    // 删除项目的撤销快照（B5）：只留最近几条，整笔恢复项目与被一起删除的杂事
    affairDeleteUndo:[],
    // 事项转换记录（P3）：只保留最近若干条，最后一条可撤销
    conversions:[],
    loans:[],
    cards:defaultAssetCards(),
    // 阶段 4 配置层：资产定义（仅新存档播种示例）与动作流（默认空）
    assetDefs:defaultAssetDefs(),
    flows:[],
    lastDebtDate:null,
    filterDomain:null,
    metrics:[],
    ext:newExtState()
  };
}

export { defaultBudgetSettings, defaultBudgetsState, defaultProductGate, tierCurrency, defaultChoreConfig, normalizeChoreConfig, migrateChore, defaultAssetDef, defaultAssetDefs, defaultAssetCards, newExtState, defaults };
