import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { parseCardGrantAmt } from './cond-ui.js';
import { noteCheckinActivity } from './gate.js';
import { Ledger, applyCheckinGain, setReverseHandler } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve, skipNextLoanAutoPay } from './library.js';
import { save } from './persist.js';
import { logAmt, clone, now } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
// undo.js —— 撤销适配器与快照
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

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
    // 先联动撤销该购买产生的现实预算账目（只走 BudgetEngine 已有入口）。
    // 跨期账目按预算既有口径不可撤销：此处只处理当期可撤销的账目，购买退款仍照常进行。
    let budEntry=null;
    if(state.ext&&state.ext.budgets&&Array.isArray(state.ext.budgets.ledger)){
      budEntry=state.ext.budgets.ledger.find(function(e){
        return e&&e.status!=='reversed'&&e.links&&e.links.purchaseLogId===log.id;
      })||null;
    }
    if(budEntry){
      const cat=BudgetEngine.category(budEntry.categoryId);
      const rp=cat?BudgetEngine.readPeriod(cat,now()):null;
      const curKey=cat?BudgetEngine.bounds(cat.cycle,now()).key:'';
      if(cat&&rp&&rp.period&&rp.period.end>now()&&budEntry.periodKey===curKey){
        BudgetEngine.reverseEntry(budEntry.id);
      }
    }
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
  'card-grant':{reverse:function(log){
    // 卡券发放撤销：按流水记录的实际张数退回卡券余额（已被消耗时最低归零）
    const card=log.card||'exemption';
    const granted=typeof log.granted==='number'?log.granted:parseCardGrantAmt(log.desc);
    if(granted>0){
      const cur=state.cards[card]||0;
      if(cur>0)Ledger.post({op:'adjust',account:'card:'+card,target:Math.max(0,cur-granted),visible:false,reason:{src:'undo-card-grant'}});
    }
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销卡券发放');
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
    // 还原被清理的活跃度桶与预算引用，避免撤销后门槛/规则统计与删除前不一致
    if(log.activityCopy){
      if(!state.ext.activity)state.ext.activity={};
      state.ext.activity[log.domCopy.id]=clone(log.activityCopy);
    }
    if(Array.isArray(log.budgetFixes)){
      log.budgetFixes.forEach(function(f){
        const cat=(state.ext.budgets.categories||[]).find(function(c){return c.id===f.catId;});
        if(!cat)return;
        if(f.type==='default')cat.defaultProgressDomainId=f.prev;
        else if(f.type==='rule'){
          const r=(cat.rules||[]).find(function(x){return x.id===f.ruleId;});
          if(r&&r.target)r.target.domainId=f.prev;
        }
      });
    }
    // 回收删除领域副作用触发的里程碑：重新上锁、退回成果点、删除对应解锁流水
    if(Array.isArray(log.achLogIds)&&log.achLogIds.length){
      log.achLogIds.forEach(function(lid){Ledger.removeLogs(function(l){return l.id!==lid;});});
    }
    if(Array.isArray(log.triggeredAchs)){
      log.triggeredAchs.forEach(function(x){
        const a=state.achievements.find(function(y){return y.id===x.id;});
        if(a){a.unlocked=false;a.unlockedAt=null;}
        if(Number(x.points)>0)Ledger.post({op:'grant',account:'achievement',delta:-Number(x.points),visible:false,reason:{src:'undo-delete-domain'}});
      });
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
  }},
  // 预算惩罚/反哺/奖励流水在银行页单独撤销：退回货币，并回退周期聚合（水位不回退）
  'budget-penalty':{reverse:function(log){
    const acc=log.st==='progress'?('progress:'+(log.dom||'d_default')):log.st;
    Ledger.post({op:'grant',account:acc,delta:Math.abs(log.amt),visible:false,reason:{src:'undo-budget-penalty'}});
    BudgetEngine.noteEffectReversed(log);
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销预算惩罚');
  }},
  'budget-feedback':{reverse:function(log){
    const acc=log.st==='progress'?('progress:'+(log.dom||'d_default')):log.st;
    Ledger.post({op:'spend',account:acc,delta:-Math.abs(log.amt),visible:false,reason:{src:'undo-budget-feedback'}});
    BudgetEngine.noteEffectReversed(log);
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销预算反哺');
  }},
  'budget-reward':{reverse:function(log){
    const acc=log.st==='progress'?('progress:'+(log.dom||'d_default')):log.st;
    Ledger.post({op:'spend',account:acc,delta:-Math.abs(log.amt),visible:false,reason:{src:'undo-budget-reward'}});
    BudgetEngine.noteEffectReversed(log);
    Ledger.removeLogs(l=>l.id!==log.id);
    toast('已撤销预算结余奖励');
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
    // 撤销「贷款还款」后余额恢复，必须只禁用本次收尾的自动还款；
    // 否则刚恢复的贷款会被立即再次还掉，撤销等于没发生。
    if(log.src==='loan-repay')skipNextLoanAutoPay();
    processLoansWithDecayReserve();
  },{label:'undo',save:'none',render:false});
  if(!txr.ok){toast('撤销失败：'+(txr.error&&txr.error.info&&txr.error.info.reason||txr.error&&txr.error.code||'未知原因'),'err');console.warn('undo aborted',logId,txr.error);return;}
  // 嵌套撤销（cost 转父打卡）由最外层统一收尾，避免事务中途渲染
  if(txr.nested)return;
  save();
  render();
}

// 把撤销实现注入账务引擎（账务 → 撤销 的调用改为运行时注入，消除 ledger ↔ undo 循环）
setReverseHandler(undoLog);

export { UNDO_ADAPTERS, undoLog };
