import { exemptionActivity } from './conditions.js';
import { noteCheckinActivity } from './gate.js';
import { BudgetEngine } from './budget.js';
import { budgetOf, budgetRefOf, openBudgetAmountDialog, rememberBudgetDraft, resolveActionBudget } from './budget-binding.js';
import { Ledger } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve } from './library.js';
import { save } from './persist.js';
import { stageCellLabel, stageNetAt, stageSel, taskIsStaged, effectiveLastTs, fmt, getTaskDomainIds, now, taskCheckedToday, taskScoreTypes, uid, calcCheckIn } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { addDays, dayDiff, dayStart } from './time.js';
import { toast } from './toast.js';
import { domainProgress } from './utils.js';
// business.js —— Score Engine：打卡/豁免/任务数结算/杂事经济/贷款等业务逻辑
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Score Engine =====
// Calculate what happens if the user does NOT check in today
// Shows the pending debt that will reduce next check-in's earnable amount
function checkIn(taskId,stageIdx,resolved){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  if(t.archived){toast('该任务已归档，请先解锁','err');return}
  // 同日重复打卡直接拒绝：在任何写入/计算之前返回，余额、次数、连胜、待扣债均不变
  if(taskCheckedToday(t)){toast('「'+t.name+'」今日已打卡，明天再来','warn');return}
  // 临时金额：必须在 Ledger.txn 之前拿到；取消则整个打卡动作不发生
  const bind=budgetOf(t);
  if(bind&&bind.mode==='prompt'&&(!resolved||resolved.amount==null)){
    openBudgetAmountDialog({
      kind:'task',id:t.id,entity:t,title:'打卡：'+t.name,
      onConfirm:function(amount){checkIn(taskId,stageIdx,{amount:amount});},
      onCancel:function(){toast('已取消，本次未打卡','warn');}
    });
    return;
  }
  const br=resolveActionBudget(t,{
    kind:'task',id:t.id,source:'task',ts:now(),
    amount:resolved?resolved.amount:undefined
  });
  if(br.status==='skip')toast(br.reason,'warn');
  const plan=br.status==='ok'?br.plan:null;
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
    // 事务内只读一次时钟：打卡时间、流水时间、活跃度桶、统计桶共用这一个时刻，
    // 避免事务执行期间跨过零点导致"今天打卡记到昨天"。
    const txNow=now();
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

    // 现实预算：惩罚先于本笔收益入账（先扣后收），避免用本笔收入支付本笔超支惩罚
    let budgetRef=null;
    if(plan){
      const got=BudgetEngine.commitEntry(null,plan,{checkinLogId:checkinLogId});
      budgetRef=budgetRefOf(got.entry,plan);
      if(bind&&bind.mode==='prompt')t.budget.lastAmount=plan.amount;
    }

    const dids=getTaskDomainIds(t);
    t.lastCheckIn=txNow;
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
    const entry={id:checkinLogId,time:txNow,st:st,amt:0,desc:desc,src:'checkin',dom:dids.join(','),taskId:t.id,prevStreak:prevStreak,prevLastCheckIn:prevLastCheckIn,prevLastDebtDate:prevLastDebtDate,prevPendingDebt:prevPendingDebt,prevStageLast:prevStageLast,budgetRef:budgetRef};
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
    noteCheckinActivity(dids,1,txNow);

    if(hasP){
      dids.forEach(did=>checkAchievements(did));
    }
    // 先跑各处理器（不各自写盘），最后统一保存一次
    processDailyTaskDebts(true);
    processLoansWithDecayReserve();
  },{label:'checkin',save:'none',render:false});
  if(!txr.ok){
    // 整单回滚：余额、打卡记录、现实账目、惩罚全部不落盘
    if(plan)rememberBudgetDraft('task',t.id,plan.amount);
    const info=(txr.error&&txr.error.info)||{};
    toast(info.reason||('打卡失败：'+((txr.error&&txr.error.code)||'未知错误')),'err');
    return;
  }
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
  const todayStart=dayStart(now());
  const lastEff=effectiveLastTs(t);
  const gapDays=dayDiff(todayStart,lastEff);
  // Already checked in today?
  if(t.lastCheckIn&&t.lastCheckIn>=todayStart){toast('今日已打卡，无需豁免','warn');return;}
  // Already exempted today?
  if(t.lastExempt&&t.lastExempt>=todayStart){toast('今日已豁免','warn');return;}

  const prevLastExempt=t.lastExempt||null;
  const prevPendingDebt=t.pendingDebt||0;
  const prevLastDebtDate=t.lastDebtDate||null;
  const wasBroken=gapDays>=2;

  Ledger.post({op:'spend',account:'card:exemption',delta:-1,visible:false,reason:{src:'exempt-use'}});
  t.lastExempt=addDays(todayStart,1)-1000; // end of today
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

export { checkIn, useExemption, checkAchievements };
