import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { reverseBoundBudget } from './budget-binding.js';
import { runCommand } from './command.js';
import { parseCardGrantAmt } from './cond-ui.js';
import { noteCheckinActivity } from './gate.js';
import { Ledger, applyCheckinGain, setReverseHandler } from './ledger.js';
import { processDailyTaskDebts, processLoansWithDecayReserve, skipNextLoanAutoPay } from './debt.js';
import { logAmt, clone, now } from './pure.js';
import { state } from './state.js';
import { toast } from './toast.js';
// undo.js —— 撤销适配器与快照
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。
function undoAbort(code,reason){
  const e=new Error(reason);
  e.__txn=true;
  e.code=code;
  e.info={reason:reason};
  throw e;
}

// ===== Undo adapters =====
// 撤销规则按 src 注册：新增一种可撤销流水 = 在 UNDO_ADAPTERS 里加一个 key。
// undoLog / Ledger.reverse 只负责查流水、查适配器、开事务与统一收尾。
// reverse(log,ctx) 返回 false 表示已交由内层撤销处理，外层不再重复收尾（cost → 父打卡）。
const UNDO_ADAPTERS={
  checkin:{reverse:function(log){
    // 联动撤销现实账目：当期硬撤、跨期冲正；失败则抛出 __txn 让整个撤销事务回滚
    let budRef=log.budgetRef||null;
    if(!budRef&&state.ext&&state.ext.budgets&&Array.isArray(state.ext.budgets.ledger)){
      const be=state.ext.budgets.ledger.find(function(e){
        return e&&e.status==='active'&&e.links&&e.links.checkinLogId===log.id;
      });
      if(be)budRef={entryId:be.id,catId:be.categoryId,amount:be.amount,periodKey:be.periodKey};
    }
    if(budRef)reverseBoundBudget(budRef);
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
    // ===== 整单撤销：带 orderId 的购买（资产定价 / 附带赠送）=====
    // 同一单的货币腿、资产腿、赠送腿必须一起退；任何一条赠送已被消耗都拒绝整单撤销。
    if(log.orderId){
      const orderLogs=state.logs.filter(function(l){return l.orderId===log.orderId;});
      if(!orderLogs.length){toast('该笔购买已撤销','warn');return false;}
      orderLogs.forEach(function(g){
        if(g.src!=='purchase-grant')return;
        const granted=Number(g.granted)||0;
        if(granted<=0)return;
        if(g.st==='card'){
          if((state.cards[g.card]||0)<granted)undoAbort('UNDO_GRANT_SPENT','赠送的资产「'+(g.card||'')+'」已被使用，无法整单撤销');
        }else if((Number(state.scores[g.st])||0)<granted){
          undoAbort('UNDO_GRANT_SPENT','赠送的货币已被使用，无法整单撤销');
        }
      });
      // 现实预算只联动货币腿；资产定价商品本就不会产生预算账目
      orderLogs.filter(function(l){return l.src==='purchase'&&l.st!=='card';}).forEach(function(cl){
        let budEntry=null;
        if(state.ext&&state.ext.budgets&&Array.isArray(state.ext.budgets.ledger)){
          budEntry=state.ext.budgets.ledger.find(function(e){
            return e&&e.status!=='reversed'&&e.links&&e.links.purchaseLogId===cl.id;
          })||null;
        }
        if(budEntry){
          const cat=BudgetEngine.category(budEntry.categoryId);
          const rp=cat?BudgetEngine.readPeriod(cat,now()):null;
          const curKey=cat?BudgetEngine.bounds(cat.cycle,now()).key:'';
          if(cat&&rp&&rp.period&&rp.period.end>now()&&budEntry.periodKey===curKey){
            const rev=BudgetEngine.reverseEntry(budEntry.id);
            if(!rev.ok)toast(rev.reason||'撤销失败','err');
          }
        }
      });
      // 货币腿：只退自付部分，贷款额不退回
      orderLogs.filter(function(l){return l.src==='purchase'&&l.st!=='card';}).forEach(function(cl){
        const paidPart=Math.abs(cl.amt)-(typeof cl.loanAmt==='number'?cl.loanAmt:0);
        Ledger.post({op:'grant',account:cl.st,delta:paidPart,visible:false,reason:{src:'undo-purchase'}});
        if(cl.loanId)state.loans=state.loans.filter(function(l){return l.id!==cl.loanId;});
      });
      // 资产腿：原额退回
      orderLogs.filter(function(l){return l.src==='purchase'&&l.st==='card';}).forEach(function(l){
        Ledger.post({op:'grant',account:'card:'+(l.card||''),delta:Math.abs(l.amt),visible:false,reason:{src:'undo-purchase'}});
      });
      // 赠送：原额收回（预检已确保余额足够，不会出现负数）
      orderLogs.filter(function(l){return l.src==='purchase-grant';}).forEach(function(g){
        const amt=Number(g.granted)||0;
        if(amt<=0)return;
        if(g.st==='card')Ledger.post({op:'grant',account:'card:'+(g.card||''),delta:-amt,visible:false,reason:{src:'undo-purchase-grant'}});
        else Ledger.post({op:'grant',account:g.st,delta:-amt,visible:false,reason:{src:'undo-purchase-grant'}});
      });
      // 库存/销量只恢复一次
      const forProd=orderLogs.find(function(l){return l.prodId;})||log;
      if(forProd.prodId){
        const p=state.products.find(function(x){return x.id===forProd.prodId;});
        if(p){
          if(p.stock>=0)p.stock++;
          p.sold=Math.max(0,(p.sold||0)-1);
        }
      }
      const ids={};
      orderLogs.forEach(function(l){ids[l.id]=true;});
      Ledger.removeLogs(function(l){return !ids[l.id];});
      toast('已撤销购买（整单）');
      return;
    }
    // ===== 旧路径：无 orderId 的普通货币购买，行为保持不变 =====
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
        // reverseEntry 不再自带提示：失败时在这里补一条，撤销购买本身继续
        const rev=BudgetEngine.reverseEntry(budEntry.id);
        if(!rev.ok)toast(rev.reason||'撤销失败','err');
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
  const log=state.logs.find(l=>l.id===logId);
  if(!log)return runCommand({reject:{reason:'missing',toast:{msg:'记录不存在',type:'err'}}});
  if(!Object.prototype.hasOwnProperty.call(UNDO_ADAPTERS,log.src)){
    return runCommand({reject:{reason:'unsupported',toast:{msg:'该记录不支持撤销',type:'err'}}});
  }
  return runCommand({
    label:'undo',
    failText:function(err){
      const info=(err&&err.info)||{};
      return '撤销失败：'+(info.reason||(err&&err.code)||'未知原因');
    },
    onFail:function(err){console.warn('undo aborted',logId,err);},
    run:function(){
      const ad=Object.prototype.hasOwnProperty.call(UNDO_ADAPTERS,log.src)?UNDO_ADAPTERS[log.src]:null;
      if(!ad)return;
      // 适配器返回 false：内层已处理并完成收尾（如 cost → 父打卡）
      if(ad.reverse(log,{undo:undoLog})===false)return;
      // 撤销里程碑解锁本身不能再触发重新解锁（否则点数与日志会被立刻补回来）
      if(log.src!=='achievement')checkAchievements();
      processDailyTaskDebts(true);
      // 撤销「贷款还款」后余额恢复，必须只禁用本次收尾的自动还款；
      // 否则刚恢复的贷款会被立即再次还掉，撤销等于没发生。
      if(log.src==='loan-repay')skipNextLoanAutoPay();
      processLoansWithDecayReserve();
    }
  });
}

// 把撤销实现注入账务引擎（账务 → 撤销 的调用改为运行时注入，消除 ledger ↔ undo 循环）
setReverseHandler(undoLog);

export { UNDO_ADAPTERS, undoLog };
