import { affairActive } from './cond-eval.js';
import { AFFAIR_CURVES } from './constants.js';
import { choreIsCyclic } from './chore-cycle.js';
import { choreOrderInsert } from './chore-list.js';
import { idleDaysSince, dayKey, affairLastAdvance, effectiveLastTs, now, uid } from './pure.js';
import { BudgetEngine } from './budget.js';
import { processDueFlows } from './flow-scheduler.js';
import { Ledger } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve } from './debt.js';
import { save, scheduleRender } from './persist.js';
import { processChoreDecay } from './chore-core.js';
import { state } from './state.js';
// entities.js —— 阶段 1 指标与结构操作（不活跃归档）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 结构操作：按“不活跃天数”归档实体 =====
// 动作自身携带阈值：条件只决定“何时执行”，动作决定“归档谁”。
// 从未活跃过的任务保持原样（与旧 processMetabolism 语义一致，交还用户处理）。
function archiveIdleEntities(entity,idleDays,ts,actName,dryRun){
  const days=Math.max(1,Math.round(Number(idleDays)||1));
  const label=actName||'周期活动';
  let n=0;
  function hit(d){return d!==null&&d>=days;}
  if(entity==='affair'){
    (state.affairs||[]).forEach(function(a){
      if(!affairActive(a))return;
      const d=idleDaysSince(affairLastAdvance(a)||a.createdAt,ts);
      if(!hit(d))return;
      n++;
      if(dryRun)return;
      a.archived=true;a.archivedAt=now();
      Ledger.event('项目「'+a.name+'」停滞 '+d+' 天，已由「'+label+'」归档','affair-archive',{affairId:a.id});
    });
    return n;
  }
  if(entity==='chore'){
    (state.chores||[]).forEach(function(c){
      if(c.archived)return;
      // 循环杂事的生命周期由 nextDue 决定，不参与“不活跃归档”（否则复发链被永久隐藏）
      if(choreIsCyclic(c))return;
      // 已完成但未结算的杂事不归档：否则会吞掉批量结算奖励
      if(c.done&&!c.settled)return;
      const d=idleDaysSince(c.doneAt||c.plannedAt||c.createdAt,ts);
      if(!hit(d))return;
      n++;
      if(dryRun)return;
      c.archived=true;c.archivedAt=now();
      Ledger.event('杂事「'+c.name+'」不活跃 '+d+' 天，已由「'+label+'」归档','chore-archive',{choreId:c.id});
    });
    return n;
  }
  (state.tasks||[]).forEach(function(t){
    if(t.archived)return;
    const d=idleDaysSince(effectiveLastTs(t),ts);
    if(!hit(d))return;
    n++;
    if(dryRun)return;
    t.archived=true;t.archivedAt=now();
    Ledger.event('任务「'+t.name+'」不活跃 '+d+' 天，已由「'+label+'」归档','archive',{taskId:t.id});
  });
  return n;
}
// ===== 资产发放核心：活动发卡与动作流 atom 共用的唯一上限/裁剪入口 =====
// mode='activity'：保留既有活动语义（单活动 cap 裁剪；余额已达上限返回 ok:false，不抛错）
// mode='flow'：严格失败语义（超出资产定义 maxBalance 返回 FLOW_ASSET_CAP，绝不静默裁剪）
// 只负责余额上限判断与写入；金额合法性（整数/单步上限）由调用方先行校验。
function assetGrantPlan(input){
  const mode=input.mode==='flow'?'flow':'activity';
  const raw=(state.cards&&state.cards[input.assetId])||0;
  const before=mode==='activity'?raw:(Number(raw)||0);
  const amount=Math.max(0,Math.round(Number(input.amount)||0));
  if(mode==='activity'){
    const cap=Math.max(1,Math.round(input.cap||1));
    if(!(amount>0&&before<cap))return{ok:false,granted:0,before:before,after:before,code:'CARD_AT_CAP'};
    const granted=Math.min(cap,before+amount)-before;
    if(granted<=0)return{ok:false,granted:0,before:before,after:before,code:'CARD_AT_CAP'};
    return{ok:true,granted:granted,before:before,after:before+granted};
  }
  if(!(amount>0))return{ok:false,granted:0,before:before,after:before,code:'FLOW_INVALID_AMOUNT'};
  const max=input.maxBalance;
  if(max!==null&&max!==undefined&&before+amount>Number(max)){
    return{ok:false,granted:0,before:before,after:before,code:'FLOW_ASSET_CAP'};
  }
  return{ok:true,granted:amount,before:before,after:before+amount};
}
function assetGrantCore(input){
  const plan=assetGrantPlan(input);
  if(!plan.ok)return plan;
  const r=Ledger.post({
    op:'grant',account:'card:'+input.assetId,delta:plan.granted,
    entry:input.entry?input.entry(plan.granted):undefined,
    reason:input.reason||{src:'card-grant'}
  });
  return Object.assign({},plan,{entryId:(r&&r.entryId)||null});
}
// ===== 每日跨天调度 =====

var _lastTickDay=null;
function schedulerTick(){
  const d=dayKey(Date.now());
  if(_lastTickDay===null){_lastTickDay=d;return;}
  if(d===_lastTickDay)return;
  _lastTickDay=d;
  // 统一以 silent 模式执行各处理器，最后只写盘一次
  // 动作流周期求值；条件不成立时由引擎自行保持 lastRun 不变
  processDueFlows(undefined, true);
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  processChoreDecay(true);
  // 预算结算兜底：周期结束后惰性结算（记一笔/购买/打开预算页之外的最后防线）
  BudgetEngine.reconcileAll();
  save();
  scheduleRender();
}

export function setLastTickDay(v){_lastTickDay=v;}

// ===== 按模板创建事项：任务 / 项目 / 杂事的最小形态 =====
// 只接受已校验的模板参数；项目不带步骤、杂事不带进度，避免造出“半成品复杂形态”。
// 名称、领域与数值的合法性由调用方（动作原子）先行校验，这里只负责写入。
function createEntitiesFromTemplate(kind, spec, ts) {
  const at = (ts === undefined || ts === null) ? now() : (Number(ts) || now());
  const s = spec || {};
  const count = Math.max(1, Math.round(Number(s.count) || 1));
  const base = String(s.name || '').trim();
  const did = String(s.domainId || '');
  const amount = Number(s.amount) || 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const name = count > 1 ? base + '（' + (i + 1) + '）' : base;
    if (kind === 'affair') {
      const a = {
        id: uid(), name: name, totalReward: amount, curve: { type: 'even', values: AFFAIR_CURVES.even.slice() },
        currentCell: 0, alreadyGiven: 0, domainId: did || null, plannedAt: null, steps: [],
        ach: { enabled: false, amount: 0 }, createdAt: at, startedAt: null, doneAt: null,
      };
      state.affairs.push(a);
      out.push({ kind: 'affair', id: a.id, name: a.name });
    } else if (kind === 'chore') {
      const c = {
        id: uid(), name: name, done: false, doneAt: null, plannedAt: null, createdAt: at,
        settled: false, freshDays: null, decayKey: null, tags: [],
      };
      if (!Array.isArray(state.chores)) state.chores = [];
      state.chores.push(c);
      state.choreOrder = choreOrderInsert(state.choreOrder, c.id);
      out.push({ kind: 'chore', id: c.id, name: c.name });
    } else {
      const t = {
        id: uid(), name: name, description: '', scoreTypes: ['vitality'], domainIds: [did || 'd_default'],
        collectionId: 'c_default', initialValue: 10, interestRate: 10, debtRate: 5,
        vitalityCost: amount, lastCheckIn: null, checkInCount: 0, totalEarned: 0, streak: 0,
        createdAt: at, archived: false,
      };
      state.tasks.push(t);
      out.push({ kind: 'task', id: t.id, name: t.name });
    }
  }
  return out;
}

export { affairActive, pointMetricValue, sumLogsInWindow, countLogsInWindow, logAffairDomain, affairWindowValue, choreWindowValue, evalCountMetric, evalCondItem, assetMetricValue, assetMovementInWindow } from './cond-eval.js';
export { archiveIdleEntities, assetGrantPlan, assetGrantCore, createEntitiesFromTemplate, _lastTickDay, schedulerTick };
