import { normalizeAffairStepRefs } from './affair-steps.js';
import { normalizeCondition } from './cond-model.js';
import { gateConditionOf } from './cond-model.js';
import { normalizeBudgetBinding, normalizeBudgetRef } from './budget-binding.js';
import { ACTIVITY_MAX_DAYS, ASSET_VERSION, AUDIT_MAX, BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, BUDGET_RULE_KINDS, FLOW_MAX_STEPS, FLOW_RUN_KEEP, FLOW_VERSION, LOG_MAX, PROD_TIERS, PRODUCT_EXEC_MAX_PER_PERIOD, SCHEMA_VERSION, SHADOW_MAX, STATS_ENTITY_MAPS, STATS_KEEP_DAYS, STATS_SCALARS } from './constants.js';
import { defaultAssetDefs, defaultBudgetsState, defaultProductGate, migrateChore, normalizeChoreConfig, tierCurrency, defaults } from './defaults.js';
import { normalizeChoreOrder, reconcileChoreOrder } from './chore-list.js';
import { normalizeExecBuys } from './exec-quota.js';
import { budgetBounds, periodKey, migrateAffair, esc, now, uid, toNum, toTs, asArray, dateKeyOffset, round2, validAssetCat } from './pure.js';
import { emptyAccountSums } from './stats.js';
import { normalizeEventStore, EVENT_KINDS } from './events.js';
import { totalProgress } from './utils.js';
import { _persistBlocked, setPersistBlocked } from './persist-state.js';
export { _persistBlocked, setPersistBlocked };

// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// 点态指标：不按时间窗口累计，取“此刻”的实体状态（任务/项目的最近活跃、杂事超期件数等）
// 项目类窗口指标：数据源是项目/步骤上的时间戳与 src='affair' 的流水
// 杂事类指标：数据源是杂事时间戳与 src='chore-batch' / 'chore-decay' 的流水
// ===== Schema 版本与扩展区 =====
// v1 为原点：新装/归一后的存档均带 schema.ext；MIGRATIONS 表留给后续版本使用。
let loadIssue=null;
// 读档未成功（超时 / 读取失败）时暂停写盘：避免用空白默认库覆盖真实存档
// 标记与 setter 已抽到 persist-state.js，persist 直接读取，避免 normalize↔persist 循环依赖
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
  // 金额类字段读档即统一到两位，历史存档里的浮点尾巴不会带入后续计算
  t.initialValue=round2(toNum(t.initialValue));
  t.interestRate=round2(toNum(t.interestRate));
  t.debtRate=round2(toNum(t.debtRate));
  t.vitalityCost=round2(toNum(t.vitalityCost));
  t.checkInCount=Math.max(0,Math.round(toNum(t.checkInCount)));
  t.streak=Math.max(0,Math.round(toNum(t.streak)));
  t.totalEarned=round2(toNum(t.totalEarned));
  t.pendingDebt=round2(toNum(t.pendingDebt));
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
  // 资产定价与赠送：老商品缺省为 null / []，行为不变
  p.assetPrice=normalizeAssetPrice(p.assetPrice);
  p.grants=normalizeProductGrants(p.grants);
  // 执行权：老商品缺省为 null，购买行为完全不变
  p.exec=normalizeProductExec(p.exec);
  // 资产定价商品禁用现实预算联动，避免“资产 + 现实”双重记账
  if(p.assetPrice)p.budget={categoryId:'',amount:0};
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
  if(l.budgetRef!==undefined)l.budgetRef=normalizeBudgetRef(l.budgetRef);
  // 资产流水三要素（阶段 6 新增，可选）：缺省即缺省，不补默认键；非法类别按缺失处理
  if(l.assetCat!==undefined&&!validAssetCat(l.assetCat))delete l.assetCat;
  if(l.assetFrom!==undefined)l.assetFrom=String(l.assetFrom).slice(0,120);
  if(l.assetTo!==undefined)l.assetTo=String(l.assetTo).slice(0,120);
  return l;
}
function normalizeCards(c){
  const o={};
  if(c&&typeof c==='object')Object.keys(c).forEach(function(k){o[k]=toNum(c[k]);});
  return o;
}
// ===== 阶段 4：资产定义 / 动作流 / 运行层归一 =====
// state.cards 仍是「资产 ID → 余额」的扁平表；定义、配置、运行计量各放一层。
const ASSET_ID_RE=/^[a-z][a-z0-9_]{2,31}$/;
function isValidAssetId(id){return typeof id==='string'&&ASSET_ID_RE.test(id);}
// 资产「使用配方」：只保留可识别的类型，其余字段一律丢弃，避免存档注入
const ASSET_USE_TYPES=['task-exempt'];
function normalizeUseRecipe(r){
  if(!r||typeof r!=='object'||Array.isArray(r))return null;
  if(ASSET_USE_TYPES.indexOf(r.type)<0)return null;
  return{
    v:1,
    type:r.type,
    cost:Math.max(1,Math.min(10,Math.round(toNum(r.cost,1)))),
  };
}
function normalizeAssetDef(d){
  if(!d||typeof d!=='object'||Array.isArray(d))return null;
  const id=String(d.id||'');
  if(!id)return null;
  const ip=(d.issuePeriod&&typeof d.issuePeriod==='object'&&!Array.isArray(d.issuePeriod))?d.issuePeriod:{};
  const origin=['builtin','user','migrated'].indexOf(d.origin)>=0?d.origin:'user';
  const maxBalance=(d.maxBalance===null||d.maxBalance===undefined||d.maxBalance==='')?null:Math.max(0,Math.ceil(toNum(d.maxBalance)));
  const maxIssued=(d.maxIssuedPerPeriod===null||d.maxIssuedPerPeriod===undefined||d.maxIssuedPerPeriod==='')?null:Math.max(0,Math.round(toNum(d.maxIssuedPerPeriod)));
  return{
    v:Math.max(1,Math.round(toNum(d.v,ASSET_VERSION))),
    id:id,
    name:String(d.name||id).slice(0,24),
    unit:String(d.unit||'张').slice(0,4),
    maxBalance:maxBalance,
    maxIssuedPerPeriod:maxIssued,
    issuePeriod:{
      cycle:(ip.cycle==='month')?'month':'week',
      anchor:Math.min(7,Math.max(1,Math.round(toNum(ip.anchor,1))))
    },
    // 非法 id 的旧卡键不删余额，只把定义停用，等 UI/自检提示用户修正
    enabled:d.enabled!==false&&isValidAssetId(id),
    archived:!!d.archived,
    origin:origin,
    useRecipe:normalizeUseRecipe(d.useRecipe),
    createdAt:toTs(d.createdAt)||0,
    updatedAt:toTs(d.updatedAt)||0
  };
}
function normalizeAssetDefs(list,cards){
  const out=[];
  const seen=new Set();
  // 只有「assetDefs 字段整体缺失」时才播种示例；显式空数组代表用户已删空，不复活
  const seed=(list===undefined||list===null)?defaultAssetDefs():list;
  asArray(seed).forEach(function(d){
    const n=normalizeAssetDef(d);
    if(!n||seen.has(n.id))return;
    seen.add(n.id);
    out.push(n);
  });
  // v3 → v4 最小迁移：旧 cards 里没有定义的自定义卡键，直接按 id + 当前余额补定义
  if(cards&&typeof cards==='object'&&!Array.isArray(cards)){
    Object.keys(cards).forEach(function(id){
      if(seen.has(id))return;
      seen.add(id);
      out.push(normalizeAssetDef({
        id:id,name:id,unit:'张',
        maxBalance:Math.max(0,Math.ceil(toNum(cards[id]))),
        maxIssuedPerPeriod:null,
        enabled:true,archived:false,origin:'migrated',v:ASSET_VERSION
      }));
    });
  }
  return out;
}
function defaultFlowLimits(){
  return{maxSteps:FLOW_MAX_STEPS,maxRunsPerPeriod:1,maxGrantPerRun:20,maxSpendPerRun:20,maxAssetGrantPerRun:3,maxAssetSpendPerRun:3};
}
function normalizeFlowLimits(l){
  const d=defaultFlowLimits();
  l=(l&&typeof l==='object'&&!Array.isArray(l))?l:{};
  return{
    maxSteps:Math.min(FLOW_MAX_STEPS,Math.max(1,Math.round(toNum(l.maxSteps,d.maxSteps)))),
    maxRunsPerPeriod:Math.min(10,Math.max(1,Math.round(toNum(l.maxRunsPerPeriod,d.maxRunsPerPeriod)))),
    maxGrantPerRun:Math.min(100,Math.max(0,toNum(l.maxGrantPerRun,d.maxGrantPerRun))),
    maxSpendPerRun:Math.min(100,Math.max(0,toNum(l.maxSpendPerRun,d.maxSpendPerRun))),
    maxAssetGrantPerRun:Math.min(20,Math.max(0,Math.round(toNum(l.maxAssetGrantPerRun,d.maxAssetGrantPerRun)))),
    maxAssetSpendPerRun:Math.min(20,Math.max(0,Math.round(toNum(l.maxAssetSpendPerRun,d.maxAssetSpendPerRun))))
  };
}
export function normalizeFlow(f){
  if(!f||typeof f!=='object'||Array.isArray(f))return null;
  const t=(f.trigger&&typeof f.trigger==='object'&&!Array.isArray(f.trigger))?f.trigger:{};
  const v=Math.max(1,Math.round(toNum(f.v,FLOW_VERSION)));
  // 高于当前流版本的定义保留但禁用：不静默删除用户配置，执行器（后续阶段）拒绝编译
  const overVersion=v>FLOW_VERSION;
  // 事件触发（第二步起接通）：保留类型与事件键，启用状态沿用用户配置
  const eventKind=(t.type==='event'&&t.event&&EVENT_KINDS.indexOf(t.event.kind)>=0)?t.event.kind:'';
  return{
    v:v,
    id:String(f.id||uid()),
    name:String(f.name||'未命名动作流').slice(0,40),
    enabled:f.enabled!==false&&!overVersion,
    invalid:overVersion||f.invalid===true,
    trigger:eventKind?{type:'event',event:{kind:eventKind},period:'week',anchor:1}:{
      type:(t.type==='manual')?'manual':'period',
      period:(t.period==='day'||t.period==='month')?t.period:'week',
      anchor:Math.min(7,Math.max(1,Math.round(toNum(t.anchor,1))))
    },
    condition:normalizeCondition(f.condition),
    // 迁移/每周期一次：默认关闭，旧流行为不变
    settleWhenConditionFalse:f.settleWhenConditionFalse===true,
    // 迁移出的流默认简易模式；普通流保持高级编辑器
    editorMode:f.editorMode==='simple'?'simple':'advanced',
    limits:normalizeFlowLimits(f.limits),
    // 运行输入：只允许任务 id 类型，最多 3 个；资产使用配方在运行时注入
    inputs:asArray(f.inputs).filter(function(x){
      return x&&typeof x==='object'&&x.type==='task'&&typeof x.name==='string'&&/^[a-z][a-z0-9_]{0,15}$/.test(x.name);
    }).slice(0,3).map(function(x){return {name:x.name,type:'task'};}),
    // 步骤在 S4 编译期再逐项校验；这里只保证是对象数组，避免归一化吞掉用户配置
    steps:asArray(f.steps).filter(function(s){return s&&typeof s==='object'&&!Array.isArray(s);}),
    lastRun:f.lastRun||null,
    // 事件触发幂等位：最近一次已派发的事件键（打卡/购买提交后写入，跨刷新不重放）
    lastEventKey:(typeof f.lastEventKey==='string')?f.lastEventKey:'',
    createdAt:toTs(f.createdAt)||0,
    updatedAt:toTs(f.updatedAt)||0
  };
}
function normalizeFlows(list){
  return asArray(list).map(normalizeFlow).filter(Boolean);
}
function normalizeAssetMeters(x){
  const out={v:ASSET_VERSION,byAsset:{},idem:{}};
  if(!x||typeof x!=='object'||Array.isArray(x))return out;
  const by=(x.byAsset&&typeof x.byAsset==='object'&&!Array.isArray(x.byAsset))?x.byAsset:{};
  Object.keys(by).forEach(function(aid){
    const src=by[aid];
    if(!src||typeof src!=='object'||Array.isArray(src))return;
    const dst={};
    Object.keys(src).forEach(function(pk){
      const m=src[pk];
      if(!m||typeof m!=='object'||Array.isArray(m))return;
      dst[String(pk)]={
        issued:Math.max(0,toNum(m.issued)),
        spent:Math.max(0,toNum(m.spent)),
        runs:Math.max(0,Math.round(toNum(m.runs)))
      };
    });
    out.byAsset[String(aid)]=dst;
  });
  const idem=(x.idem&&typeof x.idem==='object'&&!Array.isArray(x.idem))?x.idem:{};
  Object.keys(idem).forEach(function(k){
    const r=idem[k];
    if(!r||typeof r!=='object'||Array.isArray(r))return;
    out.idem[String(k)]={flowId:String(r.flowId||''),runId:String(r.runId||''),at:toTs(r.at)};
  });
  return out;
}
// journal 的 IO 只保留原始值，避免导入外部 JSON 时把任意嵌套结构带进存档
function normalizeJournalIO(x){
  if(!x||typeof x!=='object'||Array.isArray(x))return{};
  const out={};
  Object.keys(x).slice(0,24).forEach(function(k){
    const v=x[k];
    if(v===null||typeof v==='number'||typeof v==='boolean'||typeof v==='string')out[k]=v;
    else if(Array.isArray(v))out[k]=v.slice(0,LOG_MAX).map(String);
  });
  return out;
}
// 流运行 journal：撤销所需的证据，随运行记录一起裁剪（只保留 recent 窗口内的记录）
function normalizeFlowRunJournal(j){
  if(!j||typeof j!=='object'||Array.isArray(j))return null;
  const steps=asArray(j.steps).slice(0,FLOW_MAX_STEPS).map(function(s){
    s=(s&&typeof s==='object'&&!Array.isArray(s))?s:{};
    return{
      stepId:String(s.stepId||''),
      atom:String(s.atom||''),
      kind:s.kind==='branch'?'branch':'atom',
      pass:s.pass===true,
      input:normalizeJournalIO(s.input),
      output:normalizeJournalIO(s.output),
      logIds:asArray(s.logIds).map(String).filter(Boolean).slice(0,LOG_MAX),
    };
  });
  return{
    v:1,
    runKey:String(j.runKey||''),
    trigger:(j.trigger==='manual'||j.trigger==='event'||j.trigger==='purchase')?j.trigger:'period',
    periodKey:String(j.periodKey||''),
    startedAt:toTs(j.startedAt),
    finishedAt:toTs(j.finishedAt),
    steps:steps,
    logIds:asArray(j.logIds).map(String).filter(Boolean).slice(0,LOG_MAX),
    accounts:asArray(j.accounts).slice(0,64).map(function(a){
      a=(a&&typeof a==='object'&&!Array.isArray(a))?a:{};
      return{key:String(a.key||''),before:toNum(a.before),after:toNum(a.after),delta:toNum(a.delta)};
    }),
    assets:asArray(j.assets).slice(0,32).map(function(a){
      a=(a&&typeof a==='object'&&!Array.isArray(a))?a:{};
      return{
        assetId:String(a.assetId||''),periodKey:String(a.periodKey||''),
        before:toNum(a.before),after:toNum(a.after),delta:toNum(a.delta),
        issuedBefore:toNum(a.issuedBefore),spentBefore:toNum(a.spentBefore),runsBefore:toNum(a.runsBefore),
        meterExisted:a.meterExisted===true,
      };
    }),
    totals:normalizeJournalIO(j.totals),
  };
}
function normalizeFlowRunRecord(r){
  if(!r||typeof r!=='object'||Array.isArray(r))return null;
  const id=String(r.id||'');
  if(!id)return null;
  const out={
    id:id,
    flowId:String(r.flowId||''),
    flowName:String(r.flowName||'').slice(0,40),
    runKey:String(r.runKey||''),
    trigger:(r.trigger==='manual'||r.trigger==='event'||r.trigger==='purchase')?r.trigger:'period',
    periodKey:String(r.periodKey||''),
    startedAt:toTs(r.startedAt),
    finishedAt:toTs(r.finishedAt),
    status:r.status==='reversed'?'reversed':'active',
    journalLogId:String(r.journalLogId||''),
    childLogIds:asArray(r.childLogIds).map(String).filter(Boolean),
    deltas:normalizeAccountSums(r.deltas),
    stepOutputs:(r.stepOutputs&&typeof r.stepOutputs==='object'&&!Array.isArray(r.stepOutputs))?r.stepOutputs:{},
    journal:normalizeFlowRunJournal(r.journal)
  };
  // 购买来源是既有可选字段：只在存档里存在时保留，老记录不凭空多出空键
  if(r.orderId!==undefined)out.orderId=String(r.orderId||'').slice(0,64);
  if(r.productId!==undefined)out.productId=String(r.productId||'').slice(0,64);
  return out;
}
function normalizeFlowRuns(x){
  const out={v:FLOW_VERSION,seq:0,byId:{},recent:[]};
  if(!x||typeof x!=='object'||Array.isArray(x))return out;
  out.seq=Math.max(0,Math.round(toNum(x.seq)));
  // recent 是唯一保留窗口：最多 FLOW_RUN_KEEP 条（按写入顺序，新的在前）
  const seen=new Set();
  asArray(x.recent).forEach(function(rid){
    if(out.recent.length>=FLOW_RUN_KEEP)return;
    const id=String(rid||'');
    if(!id||seen.has(id))return;
    seen.add(id);
    out.recent.push(id);
  });
  // byId 只保留仍被 recent 引用的记录，防止无界增长
  const by=(x.byId&&typeof x.byId==='object'&&!Array.isArray(x.byId))?x.byId:{};
  out.recent.forEach(function(id){
    const rec=normalizeFlowRunRecord(by[id]);
    if(rec)out.byId[id]=rec;
  });
  return out;
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
    refund:Math.max(0,toNum(p.refund,0)),
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
    refundAmount:Math.max(0,toNum(e.refundAmount,0)),
    source:['manual','product','task','affair','chore','reversal'].indexOf(e.source)>=0?e.source:'manual',
    productId:String(e.productId||''),
    note:String(e.note||'').slice(0,80),
    periodKey:String(e.periodKey||''),
    status:(e.status==='reversed'||e.status==='compensated')?e.status:'active',
    reversedAt:toTs(e.reversedAt),
    compensatedAt:toTs(e.compensatedAt),
    compensatedInPeriod:String(e.compensatedInPeriod||''),
    topupAdded:Math.max(0,toNum(e.topupAdded,0)),
    topupCost:Math.max(0,toNum(e.topupCost,0)),
    penaltyOverspendDelta:Math.max(0,toNum(e.penaltyOverspendDelta,0)),
    links:{
      purchaseLogId:String(links.purchaseLogId||''),
      topupLogId:String(links.topupLogId||''),
      penaltyLogIds:asArray(links.penaltyLogIds).map(String).filter(Boolean),
      feedbackLogIds:asArray(links.feedbackLogIds).map(String).filter(Boolean),
      checkinLogId:String(links.checkinLogId||''),
      affairId:String(links.affairId||''),
      affairAdvanceId:String(links.affairAdvanceId||''),
      choreId:String(links.choreId||''),
      reversalOf:String(links.reversalOf||'')
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
// 资产定价：消耗自定义资产购买；有资产定价的商品禁用贷款与现实预算
const PRODUCT_ASSET_PRICE_MAX=999;
function normalizeAssetPrice(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const assetId=typeof raw.assetId==='string'?raw.assetId:'';
  const amount=Math.round(toNum(raw.amount));
  if(!isValidAssetId(assetId)||amount<=0)return null;
  return{assetId:assetId,amount:Math.min(PRODUCT_ASSET_PRICE_MAX,amount)};
}
const PRODUCT_GRANT_CURRENCIES=['vitality','achievement'];
// 购买赠送：最多 3 条，资产/货币两种；金额必须为正有限数
function normalizeProductGrants(list){
  const out=[];
  asArray(list).slice(0,3).forEach(function(g){
    if(!g||typeof g!=='object'||Array.isArray(g))return;
    const amount=toNum(g.amount);
    if(!(amount>0)||!isFinite(amount))return;
    if(g.kind==='asset'&&typeof g.assetId==='string'&&isValidAssetId(g.assetId)){
      const n=Math.round(amount);
      if(n>0)out.push({kind:'asset',assetId:g.assetId,amount:Math.min(999,n)});
      return;
    }
    if(g.kind==='currency'&&PRODUCT_GRANT_CURRENCIES.indexOf(g.account)>=0){
      out.push({kind:'currency',account:g.account,amount:round2(amount)});
    }
  });
  return out;
}
// 执行权：指定购买时执行哪条动作流，以及每个周期最多买几次
const PRODUCT_EXEC_PERIODS=['day','week','month'];
function normalizeProductExec(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const flowId=typeof raw.flowId==='string'?raw.flowId.trim():'';
  if(!flowId)return null;
  const max=Math.round(toNum(raw.maxPerPeriod,1));
  const period=PRODUCT_EXEC_PERIODS.indexOf(raw.period)>=0?raw.period:'week';
  return{
    flowId:flowId.slice(0,64),
    maxPerPeriod:Math.min(PRODUCT_EXEC_MAX_PER_PERIOD,Math.max(1,isFinite(max)?max:1)),
    period:period
  };
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
    features:{audit:(x.features&&x.features.audit!==false)},
    // 阶段 4 运行层：缺省即空结构，旧存档读入后行为不变
    assetMeters:normalizeAssetMeters(x.assetMeters),
    flowRuns:normalizeFlowRuns(x.flowRuns),
    // 执行权购买次数：老存档缺省为空，计数从 0 起步
    execBuys:normalizeExecBuys(x.execBuys),
    // 阶段 5 事件触发：事件记录与派发留痕
    events:normalizeEventStore(x.events)
  };
  const pr=wm.progress&&typeof wm.progress==='object'?wm.progress:{};
  Object.keys(pr).forEach(function(k){out.watermarks.progress[k]=normalizeWatermark(pr[k]);});
  return out;
}
// 只接受当前 schema：低版本存档不再逐版本迁移，统一交给 normalizeXxx 的形状守卫补默认值；
// 高于当前版本视为不可信（可能来自更新版本）：拒载并暂停写盘，绝不用旧结构覆盖原存档。
function applyMigrations(p){
  const from=(p.schema&&typeof p.schema.v==='number')?p.schema.v:0;
  if(from>SCHEMA_VERSION){
    loadIssue={type:'future',from:from};
    setPersistBlocked(true);
    return false;
  }
  p.schema={v:SCHEMA_VERSION,migratedAt:now()};
  return true;
}
function parseState(raw){
  // 每次解析都是独立一次读档：先归零上一次的结果，避免失败状态残留到下一次成功解析
  loadIssue=null;
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
    if(!applyMigrations(p))return defaults();
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
    // 事项 × 预算绑定：在预算分类归一之后做，才能判定绑定是否已失效
    const budCtx={catIds:prodCtx.catIds};
    tasks.forEach(function(t){t.budget=normalizeBudgetBinding(t.budget,budCtx);});
    const affairs=asArray(p.affairs).filter(Boolean).map(migrateAffair);
    const chores=asArray(p.chores).filter(Boolean).map(migrateChore);
    affairs.forEach(function(a){a.budget=normalizeBudgetBinding(a.budget,budCtx);});
    chores.forEach(function(c){
      c.budget=normalizeBudgetBinding(c.budget,budCtx);
      c.budgetRef=normalizeBudgetRef(c.budgetRef);
    });
    // 步骤形状守卫：纯步骤原样通过；委派步骤的引用按「独占 + 杂事必须存在」修复，
    // 脏引用就地降级为纯步骤（老存档没有 choreRef，等于零迁移）。
    normalizeAffairStepRefs(affairs,chores);
    // 容器侧排序序列：有序列时只保留仍存在的杂事 id，并把缺失实体补到末尾；
    // 没有序列则保持为空，渲染回落到原排序（不改变任何现有可见顺序）。
    const choreIds=chores.map(function(c){return c.id;});
    const rawChoreOrder=normalizeChoreOrder(p.choreOrder,choreIds);
    const choreOrder=rawChoreOrder.length?reconcileChoreOrder(rawChoreOrder,choreIds,choreIds):[];
    // 资产余额先归一，再由余额反推 v3 存档里的孤立卡定义（最小迁移）
    const cards=normalizeCards(p.cards);
    const assetDefs=normalizeAssetDefs(p.assetDefs,cards);
    // 余额键按定义通用补齐：不再特判任何资产 id
    assetDefs.forEach(function(d){if(!Object.prototype.hasOwnProperty.call(cards,d.id))cards[d.id]=0;});
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
      affairs:affairs,
      chores:chores,
      choreOrder:choreOrder,
      choreConfig:normalizeChoreConfig(p.choreConfig),
      affairPresets:asArray(p.affairPresets).filter(Boolean).map(normalizePresetNums),
      affairCollapsed:asArray(p.affairCollapsed),
      affairUndo:(p.affairUndo&&typeof p.affairUndo==='object'&&!Array.isArray(p.affairUndo))?p.affairUndo:{},
      // B5：删除快照原样放行（条数上限由写入侧维护）；只挡明显损坏的条目
      affairDeleteUndo:asArray(p.affairDeleteUndo).filter(function(x){return x&&typeof x==='object'&&!Array.isArray(x)&&x.affair&&typeof x.affair==='object';}).slice(-5),
      conversions:asArray(p.conversions).filter(function(x){return x&&typeof x==='object'&&!Array.isArray(x);}),
      products:asArray(p.products).filter(Boolean).map(function(prod){return normalizeProduct(prod,prodCtx);}),
      logs:asArray(p.logs).filter(Boolean).map(normalizeLogNums),
      loans:asArray(p.loans).filter(Boolean).map(normalizeLoanNums),
      lastDebtDate:toTs(p.lastDebtDate),
      filterDomain:p.filterDomain||null,
      metrics:asArray(p.metrics).filter(Boolean),
      cards:cards,
      assetDefs:assetDefs,
      flows:normalizeFlows(p.flows),
      ext:extNorm
    };
  }catch(e){loadIssue={type:'corrupt'};return defaults();}
}

export function setLoadIssue(v){loadIssue=v;}

export { loadIssue, salvageJSON, normalizeScores, normalizeTaskNums, normalizeAchNums, normalizeProdNums, normalizeProductGate, normalizeProduct, normalizeActivityIndex, normalizeStatsDaily, normalizeAccountSums, normalizeAchievementCounted, normalizePresetNums, normalizeLoanNums, normalizeLogNums, normalizeCards, isValidAssetId, normalizeAssetDef, normalizeAssetDefs, normalizeUseRecipe, normalizeFlows, normalizeAssetMeters, normalizeFlowRunRecord, normalizeFlowRuns, normalizeWatermark, normalizeBudgetSettings, normalizeBudgetRule, normalizeBudgetCategory, normalizeBudgetPeriod, normalizeBudgetLedgerEntry, normalizeBudgets, normalizeProductBudget, normalizeAssetPrice, normalizeProductGrants, normalizeProductExec, normalizeExt, applyMigrations, parseState };
