import { noteCheckinActivity } from './gate.js';
import { BudgetEngine } from './budget.js';
import { budgetOf, budgetRefOf, openBudgetAmountDialog, rememberBudgetDraft, resolveActionBudget } from './budget-binding.js';
import { runCommand } from './command.js';
import { Ledger } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve } from './debt.js';
import { stageCellLabel, stageNetAt, stageSel, taskIsStaged, effectiveLastTs, fmt, getTaskDomainIds, now, taskCheckedToday, taskScoreTypes, uid, calcCheckIn } from './pure.js';
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
  if(t.archived)return runCommand({reject:{reason:'archived',toast:{msg:'该任务已归档，请先解锁',type:'err'}}});
  // 同日重复打卡直接拒绝：在任何写入/计算之前返回，余额、次数、连胜、待扣债均不变
  if(taskCheckedToday(t))return runCommand({reject:{reason:'checked-today',toast:{msg:'「'+t.name+'」今日已打卡，明天再来',type:'warn'}}});
  // 临时金额：必须在 Ledger.txn 之前拿到；取消则整个打卡动作不发生
  const bind=budgetOf(t);
  if(bind&&bind.mode==='prompt'&&(!resolved||resolved.amount==null)){
    openBudgetAmountDialog({
      kind:'task',id:t.id,entity:t,title:'打卡：'+t.name,
      onConfirm:function(amount){checkIn(taskId,stageIdx,{amount:amount});},
      onCancel:function(){runCommand({reject:{reason:'canceled',toast:{msg:'已取消，本次未打卡',type:'warn'}}});}
    });
    return;
  }
  const br=resolveActionBudget(t,{
    kind:'task',id:t.id,source:'task',ts:now(),
    amount:resolved?resolved.amount:undefined
  });
  // 超支等跳过提示不阻断打卡，但要在成功提示之前给出
  const skipReason=br.status==='skip'?br.reason:'';
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

  let netV=0,netP=0,stageName=null,stageCell=null;
  if(staged){
    const cell=(typeof stageIdx==='number')?Math.max(0,Math.min(9,Math.round(stageIdx))):stageSel(t);
    // 档位选择在事务外只算不写：写入放进事务内，保证打卡失败回滚时档位一起回退
    stageCell=cell;
    netV=hasV?stageNetAt(t,'vitality',cell,c):0;
    netP=hasP?stageNetAt(t,'progress',cell,c):0;
    stageName=stageCellLabel(cell);
  }else{
    netV=hasV?c.net:0;
    netP=hasP?c.net:0;
  }

  const preToasts=[];
  // Allow check-in even with insufficient vitality (goes negative, consistent with loan system)
  if(cost>0&&state.scores.vitality<cost)preToasts.push({msg:'活力点不足，将进入负值（贷款）',type:'warn'});
  if(skipReason)preToasts.push({msg:skipReason,type:'warn'});

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

  // 命令层统一开事务、落盘、渲染与提示；这里只负责状态与账务写入
  return runCommand({
    label:'checkin',
    failText:function(err){return '打卡失败：'+((err&&err.code)||'未知错误');},
    onFail:function(){if(plan)rememberBudgetDraft('task',t.id,plan.amount);},
    run:function(tx){
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
      const got=BudgetEngine.commitEntry(tx,plan,{checkinLogId:checkinLogId});
      budgetRef=budgetRefOf(got.entry,plan);
      if(bind&&bind.mode==='prompt')t.budget.lastAmount=plan.amount;
    }

    const dids=getTaskDomainIds(t);
    // 档位写入与其余状态同一事务：失败可随快照一起回滚
    if(staged&&stageCell!==null&&t.stageRewards)t.stageRewards.last=stageCell;
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
    // 事件只在事务提交后由命令层派发；这里仅描述“打卡发生”这一事实
    return {preToasts:preToasts,toast:{msg:toastMsg},events:[{
      kind:'checkin',
      sourceId:checkinLogId,
      occurredAt:txNow,
      payload:{
        taskId:t.id,streak:c.newStreak,cost:cost,logId:checkinLogId,
        budgetEntryId:(budgetRef&&(budgetRef.entryId||budgetRef.id))||''
      }
    }]};
    }
  });
}

// 豁免内核：登记字段 + 可见流水；是否联动债务结算由调用方决定。
// 扣资产由同一运行里的 asset.spend 完成，豁免本身不绑死任何资产。
function exemptTaskCore(taskId,opts){
  opts=opts||{};
  const t=state.tasks.find(x=>x.id===taskId);
  const ts=Number.isFinite(Number(opts.ts))?Number(opts.ts):now();
  if(!t)return {ok:false,code:'FLOW_TASK_UNKNOWN',reason:'任务不存在'};
  if(t.archived)return {ok:false,code:'FLOW_TASK_ARCHIVED',reason:'任务已归档'};
  const todayStart=dayStart(ts);
  if(t.lastCheckIn&&t.lastCheckIn>=todayStart)return {ok:false,code:'FLOW_TASK_CHECKED',reason:'今日已打卡，无需豁免'};
  if(t.lastExempt&&t.lastExempt>=todayStart)return {ok:false,code:'FLOW_TASK_EXEMPTED',reason:'今日已豁免'};
  const lastEff=effectiveLastTs(t);
  const gapDays=dayDiff(todayStart,lastEff);
  const wasBroken=gapDays>=2;
  const prevLastExempt=t.lastExempt||null;
  const prevPendingDebt=t.pendingDebt||0;
  const prevLastDebtDate=t.lastDebtDate||null;

  t.lastExempt=addDays(todayStart,1)-1000; // end of today
  t.pendingDebt=0;
  delete t.lastDebtDate;
  const desc=opts.desc||('「'+t.name+'」任务豁免'+(wasBroken?'（补救）':'（请假）'));
  const entry=Ledger.event(desc,opts.src||'exempt',{
    taskId:t.id,prevLastExempt:prevLastExempt,prevPendingDebt:prevPendingDebt,prevLastDebtDate:prevLastDebtDate,
  });
  // 动作流不需要全局债务联动：本步骤只改目标任务的待扣债，整单撤销范围才可控
  if(opts.processDebts!==false)processDailyTaskDebts(true);
  return {
    ok:true,taskId:t.id,entryId:(entry&&entry.id)||null,
    prevLastExempt:prevLastExempt,prevPendingDebt:prevPendingDebt,prevLastDebtDate:prevLastDebtDate,
    wasBroken:wasBroken,gapDays:gapDays,
  };
}

// 成就复核：opts.silent=true 时不弹 toast（干跑/动作流用）；
// 返回本次新增的 achievement 流水 ID 数组（旧调用方忽略返回值，行为不变）。
function checkAchievements(domId,opts){
  const silent=!!(opts&&opts.silent);
  const unlocked=[];
  state.achievements.forEach(a=>{
    if(domId&&a.domainId!==domId)return;
    const prog=domainProgress(a.domainId);
    if(!a.unlocked&&prog>=a.threshold){
      a.unlocked=true;
      a.unlockedAt=now();
      const r=Ledger.grant('achievement',a.points,{src:'achievement',desc:'里程碑「'+a.name+'」解锁',dom:a.domainId,achId:a.id});
      if(r&&r.entryId)unlocked.push(r.entryId);
      if(!silent)toast('成就解锁：'+a.name+' (+'+a.points+' 成果点)','warn');
    }
  });
  return unlocked;
}

export { checkIn, exemptTaskCore, checkAchievements };
