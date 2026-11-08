import { BudgetEngine } from './budget.js';
import { checkAchievements } from './business.js';
import { processActivities, setLastTickDay } from './entities.js';
import { ensureMetabolismRule, processDailyTaskDebts, processLoansWithDecayReserve } from './library.js';
import { dayKey } from './pure.js';
import { processChoreDecay } from './render-work.js';
// startup.js —— 启动时的一次性处理器（活动/债务/贷款/预算结算/跨天基准）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// 启动/重新载入后统一要跑的一次性处理器（活动、债务、贷款、预算结算、跨天基准）
function runStartupProcessors(){
  checkAchievements();
  // 代谢规则必须先于活动执行播种：否则升级后首次启动不会自动归档
  ensureMetabolismRule();
  // 启动时各处理器统一 silent，最后一次写盘
  processDailyTaskDebts(true);
  processLoansWithDecayReserve();
  processActivities(true);
  processChoreDecay(true);
  // 启动时补结算：上次运行遗留的已结束周期在此结清
  BudgetEngine.reconcileAll();
  // 跨天检测基准必须在启动时写入：否则午夜前启动，第一次 tick 只把 null 填成当天
  // 并提前 return，真正的跨天结算会被跳过一次。
  setLastTickDay(dayKey(Date.now()));
}

export { runStartupProcessors };
