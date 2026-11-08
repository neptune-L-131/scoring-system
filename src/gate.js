import { gateConditionOf } from './cond-model.js';
import { normalizeCondition } from './cond-model.js';
import { evalNode } from './conditions.js';
import { ACH_EARN_SOURCES, ACTIVITY_MAX_DAYS, PROD_TIERS } from './constants.js';
import { condNLLeaf, condNLNode } from './cycle.js';
import { newExtState, defaultProductGate } from './defaults.js';
import { evalCondItem } from './entities.js';
import { Ledger } from './ledger.js';
import { buyProduct } from './library.js';
import { dayKey, dateKeyOffset, toNum, now } from './pure.js';
import { state } from './state.js';
// gate.js —— 成果点累计、领域活跃度索引、商品门槛评估
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 成果点：累计获得（单调累加）与已计入清单 =====
// 只有真实“获得”来源计入：里程碑解锁 / 周期活动奖励 / 项目奖励。
// 贷款、退款、撤销、手动修正都不计入；里程碑按 achId 记录已计入数额，撤销后再解锁不重复累计。
function noteAchievementEarned(delta,entry){
  if(!state.ext)return;
  if(!state.ext.stats)state.ext.stats=newExtState().stats;
  if(!state.ext.achievementCounted||typeof state.ext.achievementCounted!=='object')state.ext.achievementCounted={};
  const src=String((entry&&entry.src)||'');
  if(!ACH_EARN_SOURCES[src])return;
  let add=Math.max(0,Number(delta)||0);
  if(src==='achievement'&&entry&&entry.achId){
    const counted=Math.max(0,Number(state.ext.achievementCounted[entry.achId])||0);
    add=Math.max(0,add-counted);
    const points=Math.max(Number(entry.amt)||0,Number(delta)||0);
    state.ext.achievementCounted[entry.achId]=Math.max(counted,points);
  }
  if(add>0)state.ext.stats.lifetimeAchievementEarned=(Number(state.ext.stats.lifetimeAchievementEarned)||0)+add;
}
export function registerAchievementLifetimePolicy(){Ledger.registerPolicy({phase:'afterPost',priority:10,name:'achievement-lifetime',
  fn:function(ctx){
    if(ctx.account!=='achievement')return;
    const delta=(Number(ctx.after)||0)-(Number(ctx.before)||0);
    if(delta>0)noteAchievementEarned(delta,ctx.entry);
  }
});}

// ===== 活跃度索引：ext.activity[did]['YYYY-MM-DD'] = 次数 =====
// 写入只发生在打卡路径（以及撤销打卡的反向扣减），查询只读最近 N 个日期键。
// 索引保留最近 ACTIVITY_MAX_DAYS 个自然日；归档不清空，恢复后按历史活跃度继续计算。
function pruneActivityBucket(bucket,cutoff){
  Object.keys(bucket).forEach(function(k){
    if(k<cutoff||!(Number(bucket[k])>0))delete bucket[k];
  });
}
function noteCheckinActivity(dids,delta,ts){
  if(!state.ext)return;
  if(!state.ext.activity||typeof state.ext.activity!=='object')state.ext.activity={};
  const key=dayKey(ts||now());
  const cutoff=dateKeyOffset(ACTIVITY_MAX_DAYS-1);
  const list=(Array.isArray(dids)&&dids.length)?dids:['d_default'];
  list.forEach(function(did){
    let bucket=state.ext.activity[did];
    if(!bucket||typeof bucket!=='object')bucket=state.ext.activity[did]={};
    const next=Math.max(0,Math.round((Number(bucket[key])||0)+delta));
    if(next>0)bucket[key]=next;else delete bucket[key];
    pruneActivityBucket(bucket,cutoff);
    if(!Object.keys(bucket).length)delete state.ext.activity[did];
  });
}
// 最近 days 个自然日（含今天）的打卡次数：逐日哈希读取，复杂度 O(days)
// ===== 商品层级门槛 =====
// 只读 ext.stats / ext.activity / 领域与里程碑定义，不遍历 state.logs。
function validProductTier(tier){return PROD_TIERS.indexOf(tier)>=0?tier:'daily';}
// ===== 商品门槛：通用条件树 =====
// 老商品没有 condition 时，把三段式字段无损翻译成等价的叶子条件；
// 这样“升级前能买”等价于“升级后同一棵树求值为真”。
// 失败原因：all 组列出所有失败叶子；any 组整组失败时合并为一条“满足任一”
function gateFailReasons(node,act,ts){
  if(!node)return [];
  if(node.group||Array.isArray(node.items)){
    const items=node.items||[];
    if(!items.length)return [];
    if(node.mode==='any'){
      if(evalNode({group:true,mode:'any',items:items},act,ts))return [];
      return ['满足任一：'+items.map(function(n){return condNLNode(n,act);}).join(' 或 ')];
    }
    let out=[];
    items.forEach(function(n){out=out.concat(gateFailReasons(n,act,ts));});
    return out;
  }
  return evalCondItem(node,act,ts)?[]:[condNLLeaf(node,act)];
}
function evaluateProductGate(p){
  const tier=validProductTier(p&&p.tier);
  const out={ok:true,deny:false,tier:tier,code:null,reasons:[],reason:''};
  if(tier==='daily')return out;
  const gate=(p&&p.gate)||defaultProductGate();
  const cond=gateConditionOf(gate,tier);
  const act={period:'week'};
  const ts=now();
  if(evalNode({group:true,mode:cond.mode,items:cond.items},act,ts))return out;
  out.ok=false;out.deny=true;out.code='GATE_CONDITION';
  out.reasons=gateFailReasons({group:true,mode:cond.mode,items:cond.items},act,ts);
  if(!out.reasons.length)out.reasons.push('门槛条件未满足');
  out.reason=out.reasons.join('；');
  return out;
}
// 唯一门槛调用点由 buyProduct 触发；策略拒绝 → txn 回滚
export function registerProductGatePolicy(){Ledger.registerPolicy({phase:'beforePurchase',priority:10,name:'product-tier-gate',
  fn:function(ctx){return evaluateProductGate(ctx.product);}
});}

export { noteAchievementEarned, pruneActivityBucket, noteCheckinActivity, validProductTier, gateFailReasons, evaluateProductGate };
