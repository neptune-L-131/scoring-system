import { computeChoreDecay } from './chore-core.js';
import { Ledger } from './ledger.js';
import { save } from './persist.js';
import { clone, effectiveLastTs, now, round2 } from './pure.js';
import { state } from './state.js';
import { addDays, dayDiff, dayStart } from './time.js';
// debt.js —— 打卡欠债与贷款计息/自动还款
// 从 library.js 抽出，供业务层与入口复用，避免 business/entities↔library 循环依赖，行为不变。

// Debt is only applied at check-in time, reducing the earnable amount.
// If net (gross - pendingDebt) goes negative, the excess is deducted from total scores.
function processDailyTaskDebts(silent=false){
  const todayTs=dayStart(now());

  state.tasks.forEach(task=>{
    if(task.archived)return; // 归档任务不参与打卡与债务累积
    if(task.debtRate<=0)return;
    if(!task.lastCheckIn)return;

    const gapDays=dayDiff(todayTs,effectiveLastTs(task));

    // Only accumulate debt if streak is broken (gap >= 2 days)
    if(gapDays<2)return;

    // Calculate how many debt days have already been accumulated
    let lastDebtDay;
    if(task.lastDebtDate){
      lastDebtDay=dayStart(task.lastDebtDate);
    }else{
      // First time: debt starts from the day after lastCheckIn
      lastDebtDay=addDays(dayStart(effectiveLastTs(task)),1);
    }

    const daysSince=dayDiff(todayTs,lastDebtDay);
    if(daysSince<=0)return;

    // Accumulate to pendingDebt (don't touch total scores)
    // 与 calcCheckIn / calcSkip 同一精度口径：日债务与累计欠债都保留两位
    const dailyDebt=round2(task.initialValue*(task.debtRate/100));
    task.pendingDebt=round2((task.pendingDebt||0)+dailyDebt*daysSince);
    task.lastDebtDate=todayTs;
  });

  if(!silent)save();
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
      const todayTs=dayStart(now());
      state.loans.slice().forEach(function(loan){
        const startDay=dayStart(loanInterestStart(loan));
        const days=dayDiff(todayTs,startDay);
        if(days>0&&loan.debtRate>0){
          // 复利按天换算为一次幂运算，避免按天循环
          Ledger.liability.mutate(loan.id,function(before){return before*Math.pow(1+loan.debtRate/100,days);},{src:'loan-interest'});
        }
        // 每笔贷款各自推进起点；日息为 0 的贷款也推进，避免恢复计息时补算历史天数
        loan.lastInterestAt=todayTs;
      });
      state.lastDebtDate=todayTs;
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
function skipNextLoanAutoPay(){_loanAutoPaySkipOnce=true;}

export { processDailyTaskDebts, loanInterestStart, processLoans, processLoansWithDecayReserve, skipNextLoanAutoPay, _loanAutoPaySkipOnce };
