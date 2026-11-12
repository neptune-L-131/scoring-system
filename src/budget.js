import { evalNode } from './conditions.js';
import { BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, BUDGET_TARGET_NAMES } from './constants.js';
import { newExtState, defaultBudgetSettings, defaultBudgetsState } from './defaults.js';
import { Ledger } from './ledger.js';
import { buyProduct } from './library.js';
import { save } from './persist.js';
import { dayKey, periodKey, fmt, now, uid, budgetBounds, round4 } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { domainName } from './utils.js';
// budget.js —— 现实预算规则引擎（BudgetEngine）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 现实预算规则引擎 =====
// 周/月按本地自然日切：周起始日可配（1=周一 … 7=周日），每月 1 日 00:00。
// 周起始日文案（与周期活动同一套 1=周一 约定）
const BudgetEngine=(function(){
  // 规则处理器注册表：新增规则类型只加一个 handler + UI 描述，主判定流程不变
  const RULE_HANDLERS={
    penalty:function(rule,ctx){
      if(ctx.settlement)return 0;
      const p=rule.params;
      if(p.mode==='ratio')return ctx.deltaOverspend>0?ctx.deltaOverspend*(p.rate||0):0;
      if(p.per==='episode'&&!(ctx.overspendBefore<=0&&ctx.overspendAfter>0))return 0;
      return p.value||0;
    },
    feedback:function(rule,ctx){
      if(ctx.settlement)return 0;
      return rule.params.mode==='ratio'?ctx.entryAmount*(rule.params.rate||0):(rule.params.value||0);
    },
    reward:function(rule,ctx){
      if(!ctx.settlement)return 0;
      return rule.params.mode==='ratio'?ctx.surplus*(rule.params.rate||0):(rule.params.value||0);
    }
  };
  function failB(code,info){const e=new Error(code);e.__txn=true;e.code=code;e.info=info||{};throw e;}
  function budgets(){
    if(!state.ext)state.ext=newExtState();
    const b=state.ext.budgets;
    if(!b||typeof b!=='object'||!Array.isArray(b.categories)||!b.settings)state.ext.budgets=defaultBudgetsState();
    return state.ext.budgets;
  }
  function settings(){return budgets().settings||defaultBudgetSettings();}
  function categories(){return budgets().categories;}
  function category(id){
    id=String(id||'');
    return categories().find(function(c){return c.id===id;})||null;
  }
  function blankPeriod(b){
    return{
      key:b.key,start:b.start,end:b.end,spent:0,refund:0,entryCount:0,
      topupAmount:0,topupCost:0,penalizedOverspend:0,penaltyCharged:0,feedbackGranted:0,
      ruleTotals:{},rewardSettled:false,rewardAmount:0,settlementSnapshot:null,closedAt:null,settledAt:null
    };
  }
  function readPeriod(cat,ts){
    const b=budgetBounds(cat.cycle,ts,cat.anchor);
    const map=budgets().periods[cat.id]||{};
    return{b:b,period:map[b.key]||null};
  }
  // 周期活动的预算上下文：活动没有“当前这一笔”的账目语境，
  // 因此按启用分类的当前周期做全局聚合；entryAmount 取当前周期最近一条有效账目金额。
  function activityContext(ts){
    ts=Number(ts)||now();
    const out={entryAmount:0,spent:0,overspend:0,entryCount:0};
    categories().forEach(function(cat){
      if(!cat||cat.archived||cat.enabled===false)return;
      const got=readPeriod(cat,ts);
      const p=got&&got.period;
      if(!p)return;
      out.spent=round4(out.spent+(Number(p.spent)||0));
      out.overspend=round4(out.overspend+overspendOf(cat,p));
      out.entryCount+=Math.max(0,Math.round(Number(p.entryCount)||0));
    });
    let latestTs=-1;
    (budgets().ledger||[]).forEach(function(e){
      if(!e||e.status!=='active')return;
      const cat=category(e.categoryId);
      if(!cat||cat.archived||cat.enabled===false)return;
      if(e.periodKey!==budgetBounds(cat.cycle,ts,cat.anchor).key)return;
      const t=Number(e.ts)||0;
      if(t>latestTs){latestTs=t;out.entryAmount=round4(Number(e.amount)||0);}
    });
    return out;
  }
  function getPeriod(cat,ts,create){
    const b=budgetBounds(cat.cycle,ts,cat.anchor);
    const bd=budgets();
    if(!bd.periods[cat.id])bd.periods[cat.id]={};
    const map=bd.periods[cat.id];
    let p=map[b.key];
    if(!p&&create){
      p=blankPeriod(b);
      map[b.key]=p;
    }
    if(p&&create)bd.current[cat.id]=b.key;
    return{b:b,period:p};
  }
  function effectiveLimit(cat,p){return round4((Number(cat.limit)||0)+(Number(p&&p.topupAmount)||0));}
  // 净花费 = 实际花费 - 本期冲正；冲正只影响“是否算超支”，不影响结余奖励口径
  function netSpentOf(p){return Math.max(0,round4((Number(p&&p.spent)||0)-(Number(p&&p.refund)||0)));}
  function overspendOf(cat,p){return Math.max(0,round4(netSpentOf(p)-effectiveLimit(cat,p)));}
  // 水位 = 当期所有存活账目 overspendAfter 的最大值；与撤销顺序无关，且只降不升
  function recomputeWater(cat,p){
    if(!cat||!p)return;
    const active=budgets().ledger.filter(function(e){
      return e&&e.categoryId===cat.id&&e.periodKey===p.key&&e.status==='active';
    });
    if(active.some(function(e){return !e.snapshot||!isFinite(Number(e.snapshot.overspendAfter));}))return;
    const calc=Math.max(0,round4(Math.max.apply(null,[0].concat(active.map(function(e){return round4(Number(e.snapshot.overspendAfter)||0);})))));
    p.penalizedOverspend=Math.min(round4(Number(p.penalizedOverspend)||0),calc);
  }
  function accountKeyOf(target){
    if(!target)return '';
    if(target.account==='progress')return 'progress:'+target.domainId;
    return target.account;
  }
  function resolveTarget(rule,cat){
    if(rule.target.account!=='progress')return{account:rule.target.account,domainId:''};
    const did=rule.target.domainId||cat.defaultProgressDomainId;
    if(!did||!state.domains.some(function(d){return d.id===did;}))return null;
    return{account:'progress',domainId:did};
  }
  // 预算规则的 when 求值：周期范围 = 分类当前周期；预算指标通过 budgetCtx 注入
  function evalWhen(rule,cat,periodStart,periodEnd,ts,ctx,settlement){
    const c=rule.when||{mode:'all',items:[]};
    if(!c.items||!c.items.length)return true;
    const act={
      period:cat.cycle,_budget:true,
      _periodRange:{start:periodStart,end:periodEnd},
      budgetCtx:{
        entryAmount:ctx.entryAmount||0,
        spent:ctx.spentAfter||0,
        overspend:ctx.overspendAfter||0,
        entryCount:ctx.entryCountAfter||0,
        surplus:ctx.surplus||0
      }
    };
    if(settlement)act._periodRange={start:periodStart,end:periodEnd};
    return evalNode({group:true,mode:c.mode==='any'?'any':'all',items:c.items},act,ts);
  }
  function ruleDesc(rule,cat,amt){
    const target=resolveTarget(rule,cat);
    const tgt=target?((target.account==='progress'?'进度·'+domainName(target.domainId):BUDGET_TARGET_NAMES[target.account])):'未知目标';
    if(rule.kind==='penalty')return'预算「'+cat.name+'」超支惩罚 -'+fmt(amt)+' '+tgt;
    if(rule.kind==='feedback')return'预算「'+cat.name+'」消费反哺 +'+fmt(amt)+' '+tgt;
    return'预算「'+cat.name+'」结余奖励 +'+fmt(amt)+' '+tgt;
  }
  // 计算一条规则在本笔/本期的金额；返回 0 表示不触发。集中处理 min/cap，便于新增规则类型
  function ruleAmount(rule,cat,ctx){
    const h=RULE_HANDLERS[rule.kind];
    if(!h)return 0;
    let amt=round4(h(rule,ctx)||0);
    if(amt<=0)return 0;
    const min=Number(rule.params.minAmount)||0;
    if(min>0&&amt<min)amt=min;
    const cap=(rule.params.capPerPeriod===null||rule.params.capPerPeriod===undefined)?null:Number(rule.params.capPerPeriod);
    if(cap!==null){
      const used=Number((ctx.period&&ctx.period.ruleTotals||{})[rule.id])||0;
      if(used>=cap)return 0;
      amt=Math.min(amt,cap-used);
    }
    return round4(amt);
  }
  function computeEffects(cat,period,b,ts,ctx,kindFilter){
    const out=[];
    const rules=(cat.rules||[]).slice().sort(function(a,b){return (a.priority||0)-(b.priority||0);});
    rules.forEach(function(rule){
      if(!rule.enabled)return;
      if(kindFilter&&kindFilter.indexOf(rule.kind)<0)return;
      // 奖励只在结期结算；惩罚/反哺只在记账时
      if(ctx.settlement&&rule.kind!=='reward')return;
      if(!ctx.settlement&&rule.kind==='reward')return;
      const target=resolveTarget(rule,cat);
      if(!target)return;
      if(!evalWhen(rule,cat,b.start,b.end,ts,ctx,ctx.settlement))return;
      const amt=ruleAmount(rule,cat,Object.assign({},ctx,{period:period}));
      if(amt<=0)return;
      out.push({
        ruleId:rule.id,kind:rule.kind,account:target.account,domainId:target.domainId,
        amount:amt,desc:ruleDesc(rule,cat,amt)
      });
    });
    return out;
  }
  // 只读分析：preview 与 prepareEntry 共用；不修改任何状态
  function analyze(catId,amount,ts,opts){
    opts=opts||{};
    ts=Number(ts)||now();
    amount=round4(Number(amount)||0);
    if(!(amount>0))return{ok:false,code:'BUDGET_INVALID_AMOUNT',reason:'金额必须大于 0'};
    const cat=category(catId);
    if(!cat)return{ok:false,code:'BUDGET_CATEGORY_MISSING',reason:'预算分类不存在'};
    if(cat.archived)return{ok:false,code:'BUDGET_CATEGORY_ARCHIVED',reason:'预算分类已归档'};
    if(!cat.enabled)return{ok:false,code:'BUDGET_CATEGORY_DISABLED',reason:'预算分类已停用'};
    const bd=budgets();
    const b=budgetBounds(cat.cycle,ts,cat.anchor);
    const map=bd.periods[cat.id]||{};
    const live=map[b.key]||null;
    const p=live||blankPeriod(b);
    const topupReq=round4(Math.max(0,Number(opts.topup)||0));
    if(topupReq>0){
      if(!cat.overdraft.enabled)return{ok:false,code:'BUDGET_TOPUP_DISABLED',reason:'该分类未开启额度扩容'};
      const maxReality=Math.max(0,round4(cat.overdraft.maxRealityPerPeriod-p.topupAmount));
      const maxCost=Math.max(0,round4(cat.overdraft.maxCostPerPeriod-p.topupCost));
      if(topupReq>maxReality+1e-9)return{ok:false,code:'BUDGET_TOPUP_LIMIT',reason:'扩容额度超过每期上限（还可扩 '+fmt(maxReality)+'）'};
      const c=round4(topupReq/(cat.overdraft.rate||1));
      if(c>maxCost+1e-9)return{ok:false,code:'BUDGET_TOPUP_LIMIT',reason:'扩容花费超过每期上限（还可花 '+fmt(maxCost)+' '+BUDGET_TARGET_NAMES[cat.overdraft.currency]+'）'};
    }
    const topupCost=topupReq>0?round4(topupReq/(cat.overdraft.rate||1)):0;
    const limitBefore=effectiveLimit(cat,p);
    const limitAfter=round4(limitBefore+topupReq);
    const spentBefore=round4(Number(p.spent)||0);
    const spentAfter=round4(spentBefore+amount);
    // 冲正（refund）只参与超支/水位判定，不参与结余奖励计算
    const netBefore=netSpentOf(p);
    const netAfter=Math.max(0,round4(netBefore+amount));
    const overspendBefore=Math.max(0,round4(netBefore-limitAfter));
    // 水位语义 = 已惩罚过的超支金额，单调不减：扩容会让当前超支变小，但水位不得跟着回落
    const waterBefore=round4(Number(p.penalizedOverspend)||0);
    const overspendAfter=Math.max(0,round4(netAfter-limitAfter));
    const deltaOverspend=Math.max(0,round4(overspendAfter-waterBefore));
    const entryCountAfter=(Number(p.entryCount)||0)+1;
    const surplus=Math.max(0,round4(cat.limit-spentAfter));
    const ctx={
      settlement:false,entryAmount:amount,spentBefore:spentBefore,spentAfter:spentAfter,
      overspendBefore:overspendBefore,overspendAfter:overspendAfter,deltaOverspend:deltaOverspend,
      entryCountAfter:entryCountAfter,surplus:surplus,period:p
    };
    const effects=computeEffects(cat,p,b,ts,ctx,['penalty','feedback']);
    // 结余奖励预估（仅展示，不发放）
    const rewardCtx=Object.assign({},ctx,{settlement:true,entryAmount:0});
    const rewardPreview=computeEffects(cat,p,b,ts,rewardCtx,['reward']);
    // 余额变化（只统计货币账户，进度账户允许为负，不阻断整笔）
    const bal={};
    ['vitality','achievement'].forEach(function(k){
      bal[k]={before:round4(Number(state.scores[k])||0),delta:0,after:0};
    });
    if(topupReq>0)bal[cat.overdraft.currency].delta=round4(bal[cat.overdraft.currency].delta-topupCost);
    effects.forEach(function(e){
      if(e.account==='progress')return;
      bal[e.account].delta=round4(bal[e.account].delta+(e.kind==='penalty'?-e.amount:e.amount));
    });
    Object.keys(bal).forEach(function(k){bal[k].after=round4(bal[k].before+bal[k].delta);});
    let insufficient=null;
    ['vitality','achievement'].forEach(function(k){
      if(insufficient)return;
      if(bal[k].after<-1e-9){
        insufficient={account:k,diff:round4(-bal[k].after),
          reason:'余额不足：还差 '+fmt(round4(-bal[k].after))+' '+BUDGET_TARGET_NAMES[k]};
      }
    });
    // 扩容建议：不静默扩容，只返回建议，由用户确认后显式传入 opts.topup
    let needsTopup=null;
    if(topupReq<=0&&cat.overdraft.enabled&&netAfter>limitBefore+1e-9){
      const need=round4(netAfter-limitBefore);
      const maxReality=Math.max(0,round4(cat.overdraft.maxRealityPerPeriod-p.topupAmount));
      const maxCost=Math.max(0,round4(cat.overdraft.maxCostPerPeriod-p.topupCost));
      const byCost=round4(maxCost*(cat.overdraft.rate||1));
      const sug=round4(Math.min(need,Math.max(0,maxReality),Math.max(0,byCost)));
      if(sug>0){
        const cost=round4(sug/(cat.overdraft.rate||1));
        const cur=round4(Number(state.scores[cat.overdraft.currency])||0);
        const after=round4(cur+bal[cat.overdraft.currency].delta-cost);
        needsTopup={
          amount:sug,cost:cost,currency:cat.overdraft.currency,
          affordable:after>=-1e-9,
          reason:after<-1e-9?('扩容花费不足：还差 '+fmt(round4(-after))+' '+BUDGET_TARGET_NAMES[cat.overdraft.currency]):''
        };
      }
    }
    return{
      ok:true,catId:cat.id,cat:cat,ts:ts,amount:amount,bounds:b,periodKey:b.key,
      period:p,periodLive:live,topup:{amount:topupReq,cost:topupCost,currency:cat.overdraft.currency},
      effects:effects,rewardPreview:rewardPreview,
      spentBefore:spentBefore,spentAfter:spentAfter,netBefore:netBefore,netAfter:netAfter,
      refund:round4(Number(p.refund)||0),
      limitBefore:limitBefore,limitAfter:limitAfter,
      overspendBefore:overspendBefore,overspendAfter:overspendAfter,deltaOverspend:deltaOverspend,
      waterBefore:waterBefore,entryCountAfter:entryCountAfter,balances:bal,
      insufficient:insufficient,needsTopup:needsTopup
    };
  }
  function preview(catId,amount,ts,opts){return analyze(catId,amount,ts,opts||{});}
  // 事项自动记账的 source 白名单：未知来源一律降级为 manual，避免脏字段进入账本
  const ENTRY_SOURCES=['manual','product','task','affair','chore'];
  function prepareEntry(catId,amount,opts){
    opts=opts||{};
    const plan=analyze(catId,amount,opts.ts,opts);
    if(!plan.ok)failB(plan.code,{reason:plan.reason});
    // allowNegative 仅由事项自动记账显式开启：余额不足时允许虚拟账户转负，照常完成动作。
    // 商品购买 / 手工记账不传该开关，保持“余额不足整笔拒绝”的既有语义。
    if(plan.insufficient){
      if(opts.allowNegative){
        plan.deficit=plan.insufficient;
        plan.insufficient=null;
      }else{
        failB('BUDGET_INSUFFICIENT',{
          reason:plan.insufficient.reason,account:plan.insufficient.account,diff:plan.insufficient.diff
        });
      }
    }
    plan.source=ENTRY_SOURCES.indexOf(opts.source)>=0?opts.source:'manual';
    plan.productId=String(opts.productId||'');
    plan.note=String(opts.note||'').slice(0,80);
    return plan;
  }
  // 唯一写入口：只在 Ledger.txn 正文内执行；所有现实账目/惩罚/反哺/扩容都在此落盘
  function commitEntry(tx,plan,extra){
    extra=extra||{};
    if(!plan||!plan.ok)failB('BUDGET_INVALID_PLAN',{reason:'预算计划无效'});
    if(!Ledger.inTxn())failB('BUDGET_NO_TXN',{reason:'预算写入必须在事务内执行'});
    const cat=category(plan.catId);
    if(!cat)failB('BUDGET_CATEGORY_MISSING',{reason:'预算分类不存在'});
    const got=getPeriod(cat,plan.ts,true);
    const p=got.period;
    const entryId=uid();
    let topupLogId='';
    // 1) 扩容（用户已确认）：先扩容再记账
    if(plan.topup.amount>0){
      const acc=plan.topup.currency;
      const res=Ledger.post({
        op:'spend',account:acc,delta:-plan.topup.cost,visible:false,
        entry:{st:acc,amt:-plan.topup.cost,desc:'预算「'+cat.name+'」扩容 '+fmt(plan.topup.amount)+'（花费 '+fmt(plan.topup.cost)+' '+BUDGET_TARGET_NAMES[acc]+'）',src:'budget-topup',budCatId:cat.id,budPeriodKey:p.key,budEntryId:entryId,budTopup:plan.topup.amount},
        reason:{src:'budget-topup'}
      });
      topupLogId=res.entryId||'';
      p.topupAmount=round4(p.topupAmount+plan.topup.amount);
      p.topupCost=round4(p.topupCost+plan.topup.cost);
      // 注意：扩容只抬有效限额，不动 penalizedOverspend（水位只增不减，撤销才降）
    }
    // 2) 惩罚/反哺
    const penaltyLogIds=[],feedbackLogIds=[];
    plan.effects.forEach(function(e){
      const isPenalty=e.kind==='penalty';
      const acc=accountKeyOf(e);
      const amt=isPenalty?-e.amount:e.amount;
      const res=Ledger.post({
        op:isPenalty?'spend':'grant',account:acc,delta:amt,
        entry:{
          st:e.account,amt:amt,desc:e.desc,src:isPenalty?'budget-penalty':'budget-feedback',
          dom:e.account==='progress'?e.domainId:'',
          budCatId:cat.id,budPeriodKey:p.key,budEntryId:entryId,budRuleId:e.ruleId,
          budOverspendDelta:isPenalty?plan.deltaOverspend:0
        },
        reason:{src:isPenalty?'budget-penalty':'budget-feedback'}
      });
      if(isPenalty){
        if(res.entryId)penaltyLogIds.push(res.entryId);
        p.penaltyCharged=round4(p.penaltyCharged+e.amount);
      }else{
        if(res.entryId)feedbackLogIds.push(res.entryId);
        p.feedbackGranted=round4(p.feedbackGranted+e.amount);
      }
      p.ruleTotals[e.ruleId]=round4((Number(p.ruleTotals[e.ruleId])||0)+e.amount);
    });
    // 3) 现实账目 + 周期聚合
    p.spent=round4(p.spent+plan.amount);
    p.entryCount=(Number(p.entryCount)||0)+1;
    // 只升不降：即使扩容/改额度让当前超支变小，也不回退已惩罚水位
    p.penalizedOverspend=Math.max(round4(Number(p.penalizedOverspend)||0),round4(Number(plan.overspendAfter)||0));
    p.closedAt=null;
    const entry={
      id:entryId,ts:plan.ts,txnId:(tx&&tx.label)||'',categoryId:cat.id,amount:plan.amount,
      source:plan.source||'manual',productId:plan.productId||'',note:plan.note||'',
      periodKey:p.key,status:'active',reversedAt:null,
      topupAdded:plan.topup.amount,topupCost:plan.topup.cost,
      penaltyOverspendDelta:plan.deltaOverspend,
      links:{
        purchaseLogId:String(extra.purchaseLogId||''),topupLogId:topupLogId,
        penaltyLogIds:penaltyLogIds,feedbackLogIds:feedbackLogIds,
        checkinLogId:String(extra.checkinLogId||''),affairId:String(extra.affairId||''),
        affairAdvanceId:String(extra.affairAdvanceId||''),choreId:String(extra.choreId||''),
        reversalOf:''
      },
      snapshot:{
        limit:round4(cat.limit),topupAmount:round4(p.topupAmount),
        overspendAfter:plan.overspendAfter,penaltyAfter:p.penalizedOverspend
      }
    };
    budgets().ledger.push(entry);
    budgets().current[cat.id]=p.key;
    pruneLedger();
    prunePeriods(cat);
    return{entry:entry,topupLogId:topupLogId,penaltyLogIds:penaltyLogIds,feedbackLogIds:feedbackLogIds};
  }
  function settlePeriod(cat,p,ts){
    if(!p)return false;
    if(p.rewardSettled){
      if(!p.closedAt)p.closedAt=p.end;
      return false;
    }
    // 周期实例自带边界：结期只认它自己的 start/end，不受之后 anchor 变更影响
    const b={key:p.key,start:p.start,end:p.end};
    const spent=round4(Number(p.spent)||0);
    const eff=effectiveLimit(cat,p);
    const overspend=Math.max(0,round4(spent-eff));
    const surplus=Math.max(0,round4(cat.limit-spent));
    const ctx={
      settlement:true,entryAmount:0,spentBefore:spent,spentAfter:spent,
      overspendBefore:overspend,overspendAfter:overspend,deltaOverspend:0,
      entryCountAfter:Number(p.entryCount)||0,surplus:surplus,period:p
    };
    const effects=computeEffects(cat,p,b,ts,ctx,['reward']);
    let total=0;
    effects.forEach(function(e){
      const acc=accountKeyOf(e);
      const res=Ledger.post({
        op:'grant',account:acc,delta:e.amount,
        entry:{
          st:e.account,amt:e.amount,desc:e.desc,src:'budget-reward',
          dom:e.account==='progress'?e.domainId:'',
          budCatId:cat.id,budPeriodKey:p.key,budRuleId:e.ruleId
        },
        reason:{src:'budget-reward'},
        idemKey:'budget-reward:'+cat.id+':'+p.key+':'+e.ruleId
      });
      total=round4(total+e.amount);
      p.ruleTotals[e.ruleId]=round4((Number(p.ruleTotals[e.ruleId])||0)+e.amount);
      return res;
    });
    p.rewardSettled=true;
    p.rewardAmount=total;
    p.settledAt=ts||now();
    p.closedAt=p.end;
    p.settlementSnapshot={
      limit:round4(cat.limit),topupAmount:round4(p.topupAmount),spent:spent,overspend:overspend,
      surplus:surplus,rewardAmount:total,settledAt:p.settledAt,
      rules:effects.map(function(e){return{ruleId:e.ruleId,amount:e.amount};})
    };
    return true;
  }
  function reconcileDue(catId,ts){
    ts=Number(ts)||now();
    function run(){
      const cat=category(catId);
      if(!cat)return false;
      const map=budgets().periods[cat.id];
      if(!map)return false;
      let changed=false;
      Object.keys(map).forEach(function(k){
        const p=map[k];
        if(!p||!p.end)return;
        if(p.end<=ts&&!p.rewardSettled){
          settlePeriod(cat,p,ts);
          changed=true;
        }
        if(p.end<=ts&&!p.closedAt)p.closedAt=p.end;
      });
      if(changed){prunePeriods(cat);pruneLedger();}
      return changed;
    }
    if(Ledger.inTxn())return run();
    const r=Ledger.txn(run,{label:'budget-settle',save:'none',render:false});
    return r.ok?r.value:false;
  }
  function reconcileAll(ts){
    ts=Number(ts)||now();
    function run(){
      let changed=false;
      categories().forEach(function(cat){changed=reconcileDue(cat.id,ts)||changed;});
      return changed;
    }
    if(Ledger.inTxn())return run();
    const r=Ledger.txn(run,{label:'budget-settle',save:'none',render:false});
    return r.ok?r.value:false;
  }
  function prunePeriods(cat){
    const map=budgets().periods[cat.id];
    if(!map)return;
    const keep=Math.max(1,Math.round(Number((settings().periodKeep||{})[cat.cycle])||BUDGET_PERIOD_KEEP[cat.cycle]||12));
    const cur=budgets().current[cat.id];
    const keys=Object.keys(map).sort(function(a,b){return (map[a].end||0)-(map[b].end||0);});
    while(keys.length>keep){
      const k=keys.shift();
      if(k===cur){keys.push(k);break;}
      delete map[k];
    }
  }
  // 分级裁剪：当期账目永不裁剪；历史账目按“已撤销/已冲正 → 无实体引用 → 有实体引用”顺序删除
  function pruneLedger(){
    const arr=budgets().ledger;
    const max=Math.max(1,Math.round(Number(settings().ledgerMax)||BUDGET_LEDGER_MAX));
    if(arr.length<=max)return;
    const curKeys={};
    categories().forEach(function(c){curKeys[c.id]=budgets().current[c.id]||'';});
    const isCurrent=function(e){
      const ck=curKeys[e.categoryId]||'';
      return !!(e.periodKey&&ck&&e.periodKey===ck);
    };
    const referenced=function(e){
      return !!(e.links&&(e.links.checkinLogId||e.links.affairId||e.links.choreId));
    };
    const removable=arr.filter(function(e){
      if(e.status&&e.status!=='active')return true;
      return !isCurrent(e);
    });
    removable.sort(function(a,b){
      const ar=(a.status&&a.status!=='active')?0:(referenced(a)?2:1);
      const br=(b.status&&b.status!=='active')?0:(referenced(b)?2:1);
      if(ar!==br)return ar-br;
      return (a.ts||0)-(b.ts||0);
    });
    const drop={};
    removable.slice(0,arr.length-max).forEach(function(e){drop[e.id]=true;});
    budgets().ledger=arr.filter(function(e){return !drop[e.id];});
  }
  // 惩罚/反哺/奖励流水被单独撤销时，同步回退周期聚合（水位不回退，避免再次被重复惩罚）
  function noteEffectReversed(log){
    if(!log)return;
    const bd=budgets();
    const cat=category(log.budCatId);
    if(!cat)return;
    const map=bd.periods[cat.id];
    const p=map&&map[log.budPeriodKey];
    if(!p)return;
    const amt=round4(Math.abs(Number(log.amt)||0));
    if(log.src==='budget-penalty'){
      p.penaltyCharged=Math.max(0,round4(p.penaltyCharged-amt));
      if(log.budRuleId)p.ruleTotals[log.budRuleId]=Math.max(0,round4((Number(p.ruleTotals[log.budRuleId])||0)-amt));
    }else if(log.src==='budget-feedback'){
      p.feedbackGranted=Math.max(0,round4(p.feedbackGranted-amt));
      if(log.budRuleId)p.ruleTotals[log.budRuleId]=Math.max(0,round4((Number(p.ruleTotals[log.budRuleId])||0)-amt));
    }else if(log.src==='budget-reward'){
      p.rewardAmount=Math.max(0,round4(p.rewardAmount-amt));
      // 结余奖励同样占用规则累计额度；不回退的话同一条规则在本周期内会被少发一次
      if(log.budRuleId)p.ruleTotals[log.budRuleId]=Math.max(0,round4((Number(p.ruleTotals[log.budRuleId])||0)-amt));
    }
  }
  function tryRefundTopup(cat,p,entry){
    let topup=round4(Number(entry.topupAdded)||0);
    let cost=round4(Number(entry.topupCost)||0);
    if(topup<=0)return 0;
    const spentNew=round4(Number(p.spent)||0)-round4(Number(entry.amount)||0);
    const limitAfter=round4((Number(cat.limit)||0)+((Number(p.topupAmount)||0)-topup));
    // 撤销扩容会不会立刻制造超支：会则保留扩容，不退款
    if(spentNew>limitAfter+1e-9)return 0;
    p.topupAmount=Math.max(0,round4(p.topupAmount-topup));
    p.topupCost=Math.max(0,round4(p.topupCost-cost));
    if(cost>0){
      Ledger.post({
        op:'grant',account:cat.overdraft.currency,delta:cost,visible:false,
        entry:{st:cat.overdraft.currency,amt:cost,desc:'预算「'+cat.name+'」扩容撤销退款 +'+fmt(cost),src:'budget-topup-refund',budCatId:cat.id,budPeriodKey:p.key,budEntryId:entry.id},
        reason:{src:'budget-topup-refund'}
      });
    }
    if(entry.links&&entry.links.topupLogId){
      const tid=entry.links.topupLogId;
      Ledger.removeLogs(function(l){return l.id!==tid;});
      entry.links.topupLogId='';
    }
    return topup;
  }
  // 跨期冲正：历史周期冻结（不改 spent / 水位 / 已发奖惩），只在本期记一笔退回额度。
  // 冲正只影响“是否还算超支”，不进入结余计算，避免用撤销旧消费的方式凭空多领结余奖励。
  function compensateEntry(ref){
    ref=ref||{};
    const nested=Ledger.inTxn();
    const run=function(){
      const cat=category(ref.catId);
      if(!cat)return null;
      const amt=round4(Math.max(0,Number(ref.amount)||0));
      if(amt<=0)return null;
      const bd=budgets();
      const origId=String(ref.entryId||'');
      const orig=origId?bd.ledger.find(function(e){return e.id===origId;})||null:null;
      if(orig&&orig.status&&orig.status!=='active')return orig;
      const dup=bd.ledger.find(function(e){
        return e&&e.source==='reversal'&&e.links&&e.links.reversalOf===origId&&origId;
      });
      if(dup)return dup;
      const got=getPeriod(cat,now(),true);
      const p=got.period;
      p.refund=round4((Number(p.refund)||0)+amt);
      if(orig){
        orig.status='compensated';
        orig.compensatedAt=now();
        orig.compensatedInPeriod=p.key;
      }
      const entry={
        id:uid(),ts:now(),txnId:'',categoryId:cat.id,
        amount:0,refundAmount:amt,source:'reversal',productId:'',note:'跨期冲正',
        periodKey:p.key,status:'active',reversedAt:null,topupAdded:0,topupCost:0,penaltyOverspendDelta:0,
        links:{
          purchaseLogId:'',topupLogId:'',penaltyLogIds:[],feedbackLogIds:[],
          checkinLogId:'',affairId:'',affairAdvanceId:'',choreId:'',reversalOf:origId
        },
        snapshot:{
          limit:round4(cat.limit),topupAmount:round4(p.topupAmount),
          overspendAfter:overspendOf(cat,p),penaltyAfter:round4(Number(p.penalizedOverspend)||0)
        }
      };
      bd.ledger.push(entry);
      bd.current[cat.id]=p.key;
      recomputeWater(cat,p);
      pruneLedger();
      prunePeriods(cat);
      return entry;
    };
    if(nested){const got=run();if(!got)return false;return true;}
    const r=Ledger.txn(run,{label:'budget-compensate',save:'none',render:false});
    if(!r.ok){
      const info=(r.error&&r.error.info)||{};
      toast(info.reason||'冲正失败','err');
      return false;
    }
    save();render();
    toast('已跨期冲正现实账目（历史周期与已发奖惩不变）');
    return true;
  }
  // 撤销一笔现实账目：只允许当期；按原始惩罚/反哺流水精确退回，水位按快照重算
  function reverseEntry(entryId){
    const nested=Ledger.inTxn();
    const r=Ledger.txn(function(){
      const bd=budgets();
      const e=bd.ledger.find(function(x){return x.id===entryId;});
      if(!e)return failB('BUDGET_ENTRY_MISSING',{reason:'账目不存在'});
      if(e.status&&e.status!=='active')return failB('BUDGET_ENTRY_REVERSED',{reason:'该账目已撤销或已冲正'});
      const cat=category(e.categoryId);
      if(!cat)return failB('BUDGET_CATEGORY_MISSING',{reason:'预算分类不存在'});
      const map=bd.periods[cat.id];
      const p=map&&map[e.periodKey];
      if(!p)return failB('BUDGET_PERIOD_MISSING',{reason:'周期实例不存在'});
      const nowKey=budgetBounds(cat.cycle,now(),cat.anchor).key;
      if(e.periodKey!==nowKey||p.end<=now())
        return failB('BUDGET_CROSS_PERIOD',{reason:'跨期账目不可撤销'});
      tryRefundTopup(cat,p,e);
      const linked=(e.links.penaltyLogIds||[]).concat(e.links.feedbackLogIds||[]);
      linked.forEach(function(id){
        if(state.logs.some(function(l){return l.id===id;}))Ledger.reverse(id);
      });
      const spentNew=Math.max(0,round4(p.spent-e.amount));
      p.spent=spentNew;
      p.entryCount=Math.max(0,(Number(p.entryCount)||0)-1);
      e.status='reversed';
      e.reversedAt=now();
      e.links.penaltyLogIds=[];
      e.links.feedbackLogIds=[];
      // 水位按存活账目快照重算：与撤销顺序无关，且只会降低
      recomputeWater(cat,p);
      return e;
    },{label:'budget-reverse',save:'none',render:false});
    if(!r.ok){
      const info=(r.error&&r.error.info)||{};
      toast(info.reason||'撤销失败','err');
      return false;
    }
    // 嵌套在别的撤销事务里时，由最外层统一 save/render/toast，避免事务中途刷新
    if(nested)return true;
    save();render();
    toast('已撤销预算账目');
    return true;
  }
  // 校验一条规则：target=progress 且分类无默认领域时拒绝保存，并指明第几条
  function validateRule(cat,rule,index){
    const no=index>0?('第 '+index+' 条规则：'):'';
    const target=rule.target||{};
    if(target.account==='progress'){
      const did=target.domainId||cat.defaultProgressDomainId;
      if(!did)return no+'目标为进度值，但未指定领域且分类没有默认领域';
      if(!state.domains.some(function(d){return d.id===did;}))return no+'目标领域不存在';
    }
    if(rule.params.mode==='ratio'&&!(Number(rule.params.rate)>0))return no+'比例模式必须填写大于 0 的系数';
    if(rule.params.mode==='fixed'&&!(Number(rule.params.value)>=0))return no+'固定值不能为负';
    if(rule.params.capPerPeriod!==null&&Number(rule.params.capPerPeriod)<0)return no+'每期上限不能为负';
    if(!(Number(rule.params.minAmount)>=0))return no+'最低值不能为负';
    // 结余转化系数之和不得超过 1：否则多条规则会把同一份结余放大成多倍奖励（只拦新保存，不追溯历史配置）
    if(rule.kind==='reward'&&rule.enabled&&rule.params.mode==='ratio'&&cat&&Array.isArray(cat.rules)){
      let sum=Number(rule.params.rate)||0;
      cat.rules.forEach(function(r){
        if(!r||r===rule||r.id===rule.id)return;
        if(r.kind!=='reward'||!r.enabled||!r.params||r.params.mode!=='ratio')return;
        sum+=Number(r.params.rate)||0;
      });
      if(sum>1+1e-9)return no+'结余转化的比例系数之和不能超过 1（当前 '+fmt(sum)+'）';
    }
    return '';
  }
  return{
    bounds:budgetBounds,categories:categories,category:category,settings:settings,
    readPeriod:readPeriod,activityContext:activityContext,effectiveLimit:effectiveLimit,overspendOf:overspendOf,
    preview:preview,prepareEntry:prepareEntry,commitEntry:commitEntry,
    settlePeriod:settlePeriod,reconcileDue:reconcileDue,reconcileAll:reconcileAll,
    reverseEntry:reverseEntry,compensateEntry:compensateEntry,noteEffectReversed:noteEffectReversed,validateRule:validateRule,
    netSpentOf:netSpentOf,recomputeWater:recomputeWater,
    pruneLedger:pruneLedger,prunePeriods:prunePeriods,ruleHandlers:RULE_HANDLERS
  };
})();
// 商品现实预算预检：只读校验，不写状态；金额/惩罚在 buyProduct 事务内实时计算
export function registerBudgetPreflightPolicy(){Ledger.registerPolicy({phase:'beforePurchase',priority:20,name:'budget-preflight',
  fn:function(ctx){
    const p=ctx.product;
    if(!p||!p.budget||!p.budget.categoryId)return true;
    const cat=BudgetEngine.category(p.budget.categoryId);
    if(!cat)return{deny:true,code:'BUDGET_CATEGORY_MISSING',reason:'商品绑定的预算分类不存在'};
    if(cat.archived)return{deny:true,code:'BUDGET_CATEGORY_ARCHIVED',reason:'商品绑定的预算分类已归档'};
    if(!cat.enabled)return{deny:true,code:'BUDGET_CATEGORY_DISABLED',reason:'商品绑定的预算分类已停用'};
    if(!(Number(p.budget.amount)>0))return{deny:true,code:'BUDGET_AMOUNT_INVALID',reason:'商品绑定了预算分类但现实金额为 0'};
    return true;
  }
});}

export { BudgetEngine };
