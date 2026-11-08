import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { BACKUP_KEY, STAGE_PRESET_KEY } from './constants.js';
import { defaults, newExtState, tierCurrency } from './defaults.js';
import { setLastTickDay } from './entities.js';
import { noteCheckinActivity, validProductTier } from './gate.js';
import { Ledger, applyCheckinGain } from './ledger.js';
import { closeModal, openModal } from './modal-host.js';
import { normalizeActivity, normalizeProductBudget, normalizeProductGate, setLoadIssue, setPersistBlocked } from './normalize.js';
import { commit, save } from './persist.js';
import { dayKey, logAmt, round2, clone, daysSince, effectiveLastTs, fmt, getTaskDomainIds, now, splitCents, taskHasType, taskScoreTypes, uid } from './pure.js';
import { closeChoreDoneZone, computeChoreDecay, processChoreDecay, resetWorkUiState } from './render-work.js';
import { fillDomainChecklist, fillSelect } from './shell.js';
import { render } from './render.js';
import { resetStagePresets, setState, state } from './state.js';
import { toast } from './toast.js';
import { domainName, promptName } from './utils.js';
// library.js —— 集合/领域/任务/成就/指标/商品/每日结算/清数据等业务操作
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

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
  const prevUnlocked={};
  state.achievements.forEach(a=>{prevUnlocked[a.id]=!!a.unlocked;});

  // 领域删除是一个整体动作：任务/里程碑改挂、进度合并、活跃度清理、预算引用清理、
  // 成果点复核必须同事务提交，否则中途失败会留下“领域没了但进度没合并”的错账。
  const txr=Ledger.txn(function(){
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

    // 幽灵活跃度：领域没了但 ext.activity 还留着按日计数，会污染同 id 重建后的门槛统计
    let activityCopy=null;
    if(state.ext&&state.ext.activity&&state.ext.activity[id]){
      activityCopy=clone(state.ext.activity[id]);
      delete state.ext.activity[id];
    }

    // 预算引用清理：目标领域被删后规则会永远发不出奖励，统一改挂默认领域（撤销时还原）
    const budgetFixes=[];
    const bd=state.ext&&state.ext.budgets;
    if(bd&&Array.isArray(bd.categories)){
      bd.categories.forEach(function(cat){
        if(!cat)return;
        let changed=false;
        if(cat.defaultProgressDomainId===id){
          budgetFixes.push({catId:cat.id,type:'default',prev:id});
          cat.defaultProgressDomainId='d_default';changed=true;
        }
        (Array.isArray(cat.rules)?cat.rules:[]).forEach(function(r){
          if(r&&r.target&&r.target.domainId===id){
            budgetFixes.push({catId:cat.id,ruleId:r.id,type:'rule',prev:id});
            r.target.domainId='d_default';changed=true;
          }
        });
        if(changed)cat.updatedAt=now();
      });
    }

    state.domains=state.domains.filter(x=>x.id!==id);
    Ledger.event('删除领域「'+d.name+'」','delete-domain',{
      domCopy:domCopy,domIndex:domIndex,progressVal:progressVal,
      affectedTasks:affectedTasks,affectedAchs:affectedAchs,
      activityCopy:activityCopy,budgetFixes:budgetFixes
    });
    checkAchievements();

    // 删除动作本身可能因进度合并触发其他领域里程碑解锁；记录这些“副作用成果点”，
    // 撤销删除时一并回收，否则撤销后凭空多出一笔解锁。
    const triggeredAchs=[];
    const achLogIds=[];
    state.achievements.forEach(function(a){
      if(a.unlocked&&!prevUnlocked[a.id]){
        triggeredAchs.push({id:a.id,points:Number(a.points)||0});
        const lg=state.logs.find(function(l){return l.src==='achievement'&&l.achId===a.id;});
        if(lg)achLogIds.push(lg.id);
      }
    });
    const ev=state.logs.find(function(l){return l.src==='delete-domain'&&l.time&&l.domCopy&&l.domCopy.id===id;});
    if(ev){ev.triggeredAchs=triggeredAchs;ev.achLogIds=achLogIds;}
  },{label:'delete-domain',save:'none',render:false});
  if(!txr.ok)return;
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
    // 同时把流水自身的 splits 与活跃度索引一起搬走：撤销是按流水自带的分配明细
    // 精确反向的，只改 dom 会让撤销从旧领域扣钱、并把活跃度记在旧领域。
    // 流水改写与进度搬运必须同事务：中途失败不能留下“日志改了但账没搬”的半成品。
    const txr=Ledger.txn(function(){
      const migNew=(opts.newDids&&opts.newDids.length)?opts.newDids:['d_default'];
      state.logs.forEach(l=>{
        if(l.src!=='checkin'||l.taskId!==t.id)return;
        const prevDids=String(l.dom||'').split(',').filter(Boolean);
        noteCheckinActivity(prevDids.length?prevDids:(opts.oldDids||[]),-1,l.time);
        l.dom=migNew.join(',');
        noteCheckinActivity(migNew,1,l.time);
        if(Array.isArray(l.splits)&&l.splits.length){
          const amt=Number(logAmt(l,'progress'))||0;
          // 按分精确分摊：各领域之和逐分等于原额，撤销回放时不会出现 3.3333… 的浮点尾巴
          const parts=splitCents(amt,migNew.length);
          l.splits=migNew.map(function(did,i){return{dom:did,amt:parts[i]};});
        }
        // 流水被原地改写：同步重算它对统计日桶/生命周期的贡献
        Ledger.reagg(l);
      });
      // 2) 累计进度值从旧领域搬到新领域（按原分摊方式等分）
      if(taskHasType(t,'progress')&&(data.scoreTypes||[]).indexOf('progress')>=0){
        const earned=t.totalEarned||0;
        if(earned!==0&&opts.oldDids.length&&opts.newDids.length){
          // 与流水 splits 同一口径：按分均摊，扣/加两侧各自逐分等于 earned
          const oldParts=splitCents(-earned,opts.oldDids.length);
          opts.oldDids.forEach((did,i)=>{
            Ledger.post({op:'grant',account:'progress:'+did,delta:oldParts[i],visible:false,reason:{src:'task-domain-migrate'}});
          });
          const newParts=splitCents(earned,opts.newDids.length);
          opts.newDids.forEach((did,i)=>{
            Ledger.post({op:'grant',account:'progress:'+did,delta:newParts[i],visible:false,reason:{src:'task-domain-migrate'}});
          });
        }
      }
    },{label:'task-domain-migrate',save:'none',render:false});
    if(!txr.ok)return;
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
  checkinLogs.forEach(log=>{
    // Undo old net amount (including 'both' check-ins)
    applyCheckinGain(log,-1);
    // 退款必须读这条打卡实际关联的成本流水，而不是用任务当前的 vitalityCost 反算：
    // 历史上没扣过成本的打卡不能因为后来加了成本就被凭空退款。
    const linkedCost=state.logs.find(l=>l.src==='cost'&&(l.link||'')===log.id);
    const actualCost=linkedCost?Math.abs(Number(linkedCost.amt)||0):0;
    if(actualCost>0){
      Ledger.post({op:'grant',account:'vitality',delta:actualCost,visible:false,reason:{src:'recalc-cost'}});
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
    // 打卡流水字段被重写：同步刷新统计贡献（旧 agg 先扣、新值再加）
    Ledger.reagg(log);
    let desc='「'+newData.name+'」打卡';
    if(bonus>0)desc+=' (连胜'+newStreak+'天 +'+fmt(bonus)+')';
    if(newCost>0)desc+=' (消耗活力-'+fmt(newCost)+')';
    log.desc=desc;
    log.prevStreak=runningStreak;
    log.prevLastCheckIn=runningLastCheckIn;
    
    // Update linked cost log if exists
    const costLog=state.logs.find(l=>l.src==='cost'&&(l.link||'')===log.id);
    if(costLog||newCost>0){
      if(costLog){
        if(newCost>0){
          costLog.amt=-newCost;
          costLog.desc='「'+newData.name+'」消耗活力点';
          Ledger.reagg(costLog);
        }else{
          Ledger.removeLogs(l=>l.id!==costLog.id);
        }
      }else if(newCost>0){
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

  // 删除任务涉及的进度搬运、任务移除、成果点复核必须整体提交或整体回滚
  const txr=Ledger.txn(function(){
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
  },{label:'delete-task',save:'none',render:false});
  if(!txr.ok)return;
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
    achIds:new Set(state.achievements.map(function(a){return a.id;})),
    catIds:new Set((state.ext.budgets.categories||[]).map(function(c){return c.id;}))
  };
}
function saveProdData(data){
  const tier=validProductTier(data.tier);
  const ctx=productGateContext();
  const gate=normalizeProductGate(data.gate,ctx);
  const budget=normalizeProductBudget(data.budget,ctx);
  const currency=tierCurrency(tier);
  if(data.id){
    const p=state.products.find(x=>x.id===data.id);
    if(!p)return;
    Object.assign(p,data,{tier:tier,gate:gate,budget:budget,currency:currency});
  }else{
    state.products.push({
      id:uid(),name:data.name,desc:data.desc,currency:currency,
      tier:tier,gate:gate,budget:budget,
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
  // 贷款决策必须等事务内的预算结算完成后再判断：reconcileDue 可能先发放结余奖励，
  // 让余额在购买前变得够用；按事务外的旧余额借贷会凭空多开一笔贷。
  let willLoan=false;
  let loanAmt=0;
  const loanId=uid();

  let budgetMsg='';
  const txr=Ledger.txn(function(tx){
    // 唯一门槛判定点：策略拒绝抛事务错误，由 txn 统一回滚
    Ledger.checkPurchase(p);
    // 商品绑定现实预算：预检 → 计划（余额不足直接抛错，整笔回滚）→ 虚拟扣款 → 同事务写现实账
    let budgetPlan=null;
    if(p.budget&&p.budget.categoryId&&Number(p.budget.amount)>0){
      BudgetEngine.reconcileDue(p.budget.categoryId,now());
      budgetPlan=BudgetEngine.prepareEntry(p.budget.categoryId,Number(p.budget.amount),{
        source:'product',productId:p.id,ts:now(),
        note:'购买「'+p.name+'」'
      });
    }
    const balance=Number(state.scores[cur])||0;
    willLoan=balance<p.price;
    loanAmt=willLoan?round2(p.price-balance):0;
    if(willLoan&&loanAmt>0)Ledger.post({op:'grant',account:cur,delta:loanAmt,visible:false,reason:{src:'loan-draw'}});
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
    const spendRes=Ledger.spend(cur,p.price,{src:'purchase',desc:desc,prodId:p.id,loanId:willLoan?loanId:'',loanAmt:willLoan?loanAmt:0});
    if(budgetPlan){
      const br=BudgetEngine.commitEntry(tx,budgetPlan,{purchaseLogId:spendRes&&spendRes.entryId});
      budgetMsg=' · 记「'+budgetPlan.cat.name+'」'+fmt(budgetPlan.amount);
      if(br&&br.penaltyLogIds&&br.penaltyLogIds.length)budgetMsg+=' · 触发惩罚';
      if(br&&br.feedbackLogIds&&br.feedbackLogIds.length)budgetMsg+=' · 反哺';
    }
    processDailyTaskDebts(true);
    processLoansWithDecayReserve();
  },{label:'buyProduct',save:'none',render:false});
  if(!txr.ok){
    const info=(txr.error&&txr.error.info)||{};
    if(info.reason)toast(info.reason,'err');
    else if(txr.error&&txr.error.code==='PURCHASE_DENIED')toast('购买条件未满足','err');
    return;
  }
  save();
  toast('已购买：'+p.name+' (-'+fmt(p.price)+' '+cn+')'+(willLoan?' · 贷款'+fmt(loanAmt):'')+budgetMsg);
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

// ===== Metabolism（已迁移为周期活动）=====
// 自动归档不再有硬编码逻辑：首次载入/升级时播种一条可编辑、可停用、可删除的周期活动。
// 之后是否归档、归档阈值多少，全部由活动规则决定；本函数只负责播种。
function ensureMetabolismRule(){
  if(!state.ext||typeof state.ext!=='object')state.ext={};
  if(state.ext.metabolismSeeded)return false;
  state.ext.metabolismSeeded=true;
  if(!Array.isArray(state.activities))state.activities=[];
  if(state.activities.some(function(a){return a.id==='act_metabolism';}))return false;
  state.activities.push(normalizeActivity({
    id:'act_metabolism',
    name:'任务自动归档',
    enabled:true,
    period:'day',
    anchor:1,
    condition:{mode:'all',items:[{range:'today',metric:'task_idle',op:'>=',value:14,targetType:'all',target:'',newFilter:'none',aggregate:'sum'}]},
    result:{items:[{type:'archive',entity:'task',idleDays:14}]},
    lastRun:null
  }));
  return true;
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
// 一次性跳过自动还款：撤销「贷款还款」时使用，只影响当前这次处理，不改变长期行为
let _loanAutoPaySkipOnce=false;
// 单笔贷款的计息起点：优先用贷款自带的 lastInterestAt；
// 旧贷款没有该字段时回退到全局 lastDebtDate，再回退到贷款开立日。
function loanInterestStart(loan){
  if(loan&&typeof loan.lastInterestAt==='number'&&isFinite(loan.lastInterestAt)&&loan.lastInterestAt>0)return loan.lastInterestAt;
  if(state.lastDebtDate)return state.lastDebtDate;
  return Number(loan&&loan.date)||now();
}
function processLoans(silent=false,reserveVitality=0){
  const skipAutoPay=_loanAutoPaySkipOnce;
  _loanAutoPaySkipOnce=false;
  Ledger.txn(function(){
    if(!state.loans)state.loans=[];

    // 逐笔按自己的计息起点算天数：新借的贷款不会被全局 lastDebtDate 追溯计息
    if(state.loans.length>0){
      const today=new Date();today.setHours(0,0,0,0);
      state.loans.slice().forEach(function(loan){
        const startDay=new Date(loanInterestStart(loan));
        startDay.setHours(0,0,0,0);
        const days=Math.round((today-startDay)/864e5);
        if(days>0&&loan.debtRate>0){
          // 复利按天换算为一次幂运算，避免按天循环
          Ledger.liability.mutate(loan.id,function(before){return before*Math.pow(1+loan.debtRate/100,days);},{src:'loan-interest'});
        }
        // 每笔贷款各自推进起点；日息为 0 的贷款也推进，避免恢复计息时补算历史天数
        loan.lastInterestAt=today.getTime();
      });
      state.lastDebtDate=today.getTime();
    }else{
      state.lastDebtDate=now();
    }

    // Auto-pay loans when balance is sufficient (always check)
    if(state.loans.length>0&&!skipAutoPay){
      const reserve=(typeof reserveVitality==='number'&&isFinite(reserveVitality))?Math.max(0,reserveVitality):0;
      state.loans.slice().forEach(function(loan){
        const avail=(state.scores[loan.currency]||0)-(loan.currency==='vitality'?reserve:0);
        if(avail>=loan.amount){
          Ledger.spend(loan.currency,loan.amount,{src:'loan-repay',desc:'偿还贷款「'+loan.productName+'」',loanId:loan.id,loanCopy:clone(loan)});
          Ledger.liability.close(loan.id,{src:'loan-repay'});
        }
      });
    }
  },{label:'loans',save:silent?'none':undefined,render:false});
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
  // 预算：重置周期实例与账本，保留分类定义与设置
  state.ext.budgets.current={};
  state.ext.budgets.periods={};
  state.ext.budgets.ledger=[];
  state.ext.audit=[];
  state.ext.shadow=[];
  // 结果型扩展数据随清空归零；商品门槛等配置类字段保留
  state.ext.activity={};
  state.ext.achievementCounted={};

  // 任务：清零所有运行时状态，让卡片等价于“刚创建但打过 0 次卡”；
  // 任务定义（名称/分值/领域/集合/利率等）与 id/createdAt/archived/archivedAt 一律保留。
  // lastCheckIn=null 本次是有意放开：自动归档已迁移为周期活动规则，
  // 归档动作遇到“从未活跃”的任务会跳过（不归档、不删除）。
  state.tasks.forEach(t=>{
    t.lastCheckIn=null;
    delete t.lastExempt;
    t.checkInCount=0;
    t.streak=0;
    t.totalEarned=0;
    t.pendingDebt=0;
    delete t.lastDebtDate;
    if(t.stageRewards&&typeof t.stageRewards==='object')t.stageRewards.last=0;
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
  closeChoreDoneZone();

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
  setState(defaults());
  resetWorkUiState();
  setLoadIssue(null);
  // 用户显式选择“彻底重置”，视为放弃原存档：解除写入暂停
  setPersistBlocked(false);
  // 清掉 localStorage 残留：保留损坏备份（事故恢复用），清理阶段预设与备份提醒时间
  try{localStorage.removeItem(STAGE_PRESET_KEY);}catch(e){}
  try{localStorage.removeItem(BACKUP_KEY);}catch(e){}
  resetStagePresets();
  // 重置每日 tick 基准，避免清空后立刻被当成跨天而触发一轮结算
  setLastTickDay(dayKey(now()));
  save();
  const rb=document.getElementById('recoverBar');if(rb)rb.style.display='none';
  closeModal('clearDataModal');
  render();
  toast('已清除全部设置与数据');
}

export function skipNextLoanAutoPay(){_loanAutoPaySkipOnce=true;}

export { addCollection, delCollection, renameCollection, addDomain, delDomain, renameDomain, pendingTaskSave, saveTaskData, resolveDomainChange, cancelDomainChange, finalizeTaskSave, recalcTaskHistory, delTask, saveAchData, delAch, openMetricModal, getCheckedMetricDomains, handleMetricSave, delMetric, addShopCategory, delShopCategory, renameShopCategory, fillShopCatSelect, productGateContext, saveProdData, delProd, buyProduct, processDailyTaskDebts, ensureMetabolismRule, unlockTask, _loanAutoPaySkipOnce, loanInterestStart, processLoans, processLoansWithDecayReserve, manualAdjustBalance, clearDataResults, clearEverything };
