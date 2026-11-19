import { toNum } from './pure.js';
import { rangeOf } from './time.js';
// exec-quota.js —— 执行权商品「每周期最多购买 N 次」的计数
//
// 为什么单独记：购买流水只保留最近 LOG_MAX 条，用流水实时统计会在同周期内被截断后
// 偏少，限购失效。这里把「当前周期已买几次」落到 state.ext.execBuys，与日志窗口解耦。
//
// 数据形状：{ v, byProduct: { [商品id]: { key: '<周期键>', n: 次数 } } }
// - key 与既有周期口径同源（rangeOf 的 key）：跨周期键不等即从 0 起算，无需用户清理；
// - 只保留每个商品当前周期的记录，旧周期记录在下一次购买时被覆盖，不会无限增长；
// - 老存档没有该字段时由 normalizeExt 懒补空结构，计数从 0 起步。
const EXEC_BUY_VERSION=1;
const EXEC_BUY_KEY_MAX=32;
const EXEC_BUY_ID_MAX=64;

function defaultExecBuys(){return {v:EXEC_BUY_VERSION,byProduct:{}};}

function normalizeExecBuys(raw){
  const out=defaultExecBuys();
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  const src=raw.byProduct;
  if(!src||typeof src!=='object'||Array.isArray(src))return out;
  Object.keys(src).forEach(function(pid){
    if(typeof pid!=='string'||!pid||pid.length>EXEC_BUY_ID_MAX)return;
    const rec=src[pid];
    if(!rec||typeof rec!=='object'||Array.isArray(rec))return;
    const key=typeof rec.key==='string'?rec.key.slice(0,EXEC_BUY_KEY_MAX):'';
    if(!key)return;
    const n=Math.max(0,Math.round(toNum(rec.n)));
    if(n>0)out.byProduct[pid]={key:key,n:n};
  });
  return out;
}

// 周期键：与购买判定、商店展示使用同一个 rangeOf；执行权没有自定义锚点，周固定周一起算
function execBuyPeriodKey(exec,ts){
  return rangeOf((exec&&exec.period)||'week',ts,1).key;
}

// 本周期已购买次数：记录键与当前周期不一致（含跨周期、改周期口径）时按 0 处理
function execBoughtCount(store,productId,exec,ts){
  const by=(store&&store.byProduct)||{};
  const rec=by[productId];
  if(!rec||!rec.key)return 0;
  if(rec.key!==execBuyPeriodKey(exec,ts))return 0;
  return Math.max(0,Math.round(toNum(rec.n)));
}

// 购买成功后记一次：跨周期自动开启新记录（从 1 起算）。
// 调用点在事务内，失败回滚由 Ledger 快照整体还原，无需手工补偿。
function noteExecBuy(store,productId,exec,ts){
  if(!store||typeof store!=='object'||!productId)return;
  if(!store.byProduct||typeof store.byProduct!=='object')store.byProduct={};
  const key=execBuyPeriodKey(exec,ts);
  const n=execBoughtCount(store,productId,exec,ts);
  store.byProduct[productId]={key:key,n:n+1};
  store.v=EXEC_BUY_VERSION;
}

// 撤销购买后退回一次额度：只在同一周期内退，跨周期撤销不影响当前周期计数
function releaseExecBuy(store,productId,exec,ts){
  if(!store||!store.byProduct||!productId)return;
  const rec=store.byProduct[productId];
  if(!rec||!rec.key)return;
  if(rec.key!==execBuyPeriodKey(exec,ts))return;
  const n=Math.max(0,Math.round(toNum(rec.n))-1);
  if(n>0)rec.n=n;
  else delete store.byProduct[productId];
}

export { EXEC_BUY_VERSION, defaultExecBuys, normalizeExecBuys, execBuyPeriodKey, execBoughtCount, noteExecBuy, releaseExecBuy };
