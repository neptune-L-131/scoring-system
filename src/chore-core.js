import { runCommand } from './command.js';
import { Ledger } from './ledger.js';
import { dayKey, dayStartTs, now, round2 } from './pure.js';
import { state } from './state.js';
import { addDays, dayDiff } from './time.js';
import { choreBaseTs, choreCfg, choreFreshDays, choreOverdueDays, choreTierRate } from './utils.js';
// chore-core.js —— 杂事腐化债的纯计算与结算
// 从 render-work.js 抽出，供渲染层与业务层共用，避免循环依赖，行为不变。

// 腐化债静默结算：超期杂事按档位系数逐日累积，直接从活力点扣除，不弹提示
// 纯计算：只统计当天应扣总额与件数/天数，不修改 state、不写日志
function computeChoreDecay(){
  const chores=state.chores||[];
  if(!chores.length)return {total:0,charged:0,dueDays:0,overdue:[],today:dayStartTs(now())};
  const cfg=choreCfg();
  const today=dayStartTs(now());
  const overdue=chores.filter(function(c){return !c.done&&!c.archived&&choreOverdueDays(c)>0;});
  if(!overdue.length)return {total:0,charged:0,dueDays:0,overdue:[],today:today};
  const rate=choreTierRate(overdue.length,cfg);
  let total=0,dueDays=0,charged=0;
  overdue.forEach(function(c){
    const deadline=addDays(choreBaseTs(c),Math.round(choreFreshDays(c)));
    let start=addDays(deadline,1);
    if(c.decayKey){
      const p=String(c.decayKey).split('-');
      const last=new Date(Number(p[0]),Number(p[1])-1,Number(p[2])).getTime();
      if(isFinite(last))start=Math.max(start,addDays(last,1));
    }
    const days=dayDiff(today,start)+1;
    if(days<=0)return;
    charged++;
    dueDays+=days;
    total+=rate*days;
  });
  return {total:round2(total),charged:charged,dueDays:dueDays,overdue:overdue,today:today};
}
function processChoreDecay(silent=false){
  const r=computeChoreDecay();
  if(r.total<=0||r.charged<=0)return 0;
  const res=runCommand({
    label:'chore-decay',save:!silent,render:false,silentFail:true,
    run:function(){
      const target=round2((state.scores.vitality||0)-r.total);
      Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:-r.total,desc:'杂事腐化债：'+r.charged+' 件超期，累计 '+r.dueDays+' 天',src:'chore-decay',dom:''},reason:{src:'chore-decay'}});
      r.overdue.forEach(function(c){c.decayKey=dayKey(r.today);});
    }
  });
  return res.ok?r.total:0;
}

export { computeChoreDecay, processChoreDecay };
