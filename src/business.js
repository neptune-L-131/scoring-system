import { exemptionActivity } from './conditions.js';
import { noteCheckinActivity } from './gate.js';
import { Ledger } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve } from './library.js';
import { save } from './persist.js';
import { stageCellLabel, stageNetAt, stageSel, taskIsStaged, effectiveLastTs, fmt, getTaskDomainIds, now, taskCheckedToday, taskScoreTypes, uid, calcCheckIn } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { domainProgress } from './utils.js';
// business.js —— Score Engine：打卡/豁免/任务数结算/杂事经济/贷款等业务逻辑
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Score Engine =====
// Calculate what happens if the user does NOT check in today
// Shows the pending debt that will reduce next check-in's earnable amount
function checkIn(taskId,stageIdx){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  if(t.archived){toast('该任务已归档，请先解锁','err');return}
  // 同日重复打卡直接拒绝：在任何写入/计算之前返回，余额、次数、连胜、待扣债均不变
  if(taskCheckedToday(t)){toast('「'+t.name+'」今日已打卡，明天再来','warn');return}
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

export { checkIn, useExemption, checkAchievements };
