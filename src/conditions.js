// conditions.js —— 条件求值门面（导出名与签名保持不变）
// 第五轮 S2-A：结构递归下沉到 cond-kernel.js（纯逻辑），状态相关叶子求值下沉到 cond-eval.js。
// 本文件只保留对外的兼容门面，不再 import entities / budget / ledger / render。
import { condLeafEntities, domainMatchesTarget, domainMetricValue, eachStatsBucket, entityMetricValue, evalCondItem, evalCondition, logDomainsOf, logMatchesTarget, rangeStats, taskMatchesTarget, taskMetricValue, weekScore } from './cond-eval.js';
import { evalNode as evalNodeKernel, opSatisfied } from './cond-kernel.js';

function evalNode(node,act,ts){
  return evalNodeKernel(node,{evalLeaf:function(n){return evalCondItem(n,act,ts);}});
}

export { weekScore, evalCondition, evalNode, logDomainsOf, logMatchesTarget, taskMatchesTarget, domainMatchesTarget, eachStatsBucket, rangeStats, opSatisfied, taskMetricValue, domainMetricValue, condLeafEntities, entityMetricValue };
