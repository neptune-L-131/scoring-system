import { AFFAIR_CURVES, COND_AFFAIR_METRICS, COND_CHORE_METRICS, COND_GATE_METRICS, COND_POINT_METRICS, STAGE_NAMES, WEEK_ANCHOR_NAMES } from './constants.js';
// pure.js —— 纯函数底层（不读写全局 state、不调用 Ledger、import 时无副作用）
// 由 utils/state/business/conditions/normalize/budget/render-work 抽离（第六轮循环依赖治理），实现逐字未改。

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,5)}
function fmt(n){
  if(n===null||n===undefined||isNaN(n))return'0';
  const r=Math.round(n*100000)/100000;
  if(r===0){
    // Non-zero but too small for 5 decimal places — show more precision
    if(n>0)return parseFloat(n.toFixed(10)).toString();
    if(n<0)return parseFloat(n.toFixed(10)).toString();
    return'0';
  }
  if(Number.isInteger(r))return''+r;
  // Show up to 5 decimal places, trim trailing zeros
  return parseFloat(r.toFixed(5)).toString();
}
function now(){return Date.now()}
function daysSince(ts){return ts?(Date.now()-ts)/864e5:0}
function effectiveLastTs(task){return Math.max(task.lastCheckIn||0,task.lastExempt||0)}
function taskCheckedToday(task){
  if(!task||!task.lastCheckIn)return false;
  const start=new Date();start.setHours(0,0,0,0);
  return new Date(task.lastCheckIn)>=start;
}
function fmtTime(ts){
  if(!ts)return '从未';
  const d=new Date(ts),n=new Date(),diff=(n-d)/864e5;
  if(diff<1&&d.getDate()===n.getDate()&&d.getMonth()===n.getMonth())
    return '今天 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  if(diff<2)return '昨天';
  if(diff<7)return Math.floor(diff)+'天前';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function escAttr(s){return esc(String(s==null?'':s)).replace(/"/g,'&quot;');}
// 任务所属领域（新装/导入均由 parseState 归一为 domainIds 数组）
function getTaskDomainIds(t){
  if(t.domainIds&&Array.isArray(t.domainIds)&&t.domainIds.length>0)return t.domainIds;
  return['d_default'];
}
function taskScoreTypes(t){
  if(t.scoreTypes&&Array.isArray(t.scoreTypes)&&t.scoreTypes.length>0)return t.scoreTypes;
  return ['vitality'];
}
function taskHasType(t,type){return taskScoreTypes(t).indexOf(type)>=0;}
function logHasType(l,st){return l.st==='both'?(st==='vitality'||st==='progress'):l.st===st;}
// 深拷贝（优先原生 structuredClone，旧环境回退 JSON 往返）
function clone(o){
  if(typeof structuredClone==='function'){
    try{return structuredClone(o);}catch(e){}
  }
  return JSON.parse(JSON.stringify(o));
}
// 按"分"为单位平均分摊：尾差按领域顺序逐个 +1 分，保证各份之和逐分等于原额
function splitCents(amount,n){
  if(!n||n<1)return[];
  const cents=Math.round((Number(amount)||0)*100);
  const sign=cents<0?-1:1;
  const abs=Math.abs(cents);
  const base=Math.floor(abs/n);
  const rem=abs-base*n;
  const out=[];
  for(let i=0;i<n;i++)out.push(sign*(base+(i<rem?1:0))/100);
  return out;
}

function round2(v){return Math.round(v*100)/100;}
function logAmt(l,type){
  if(type==='vitality'&&typeof l.amtV==='number')return l.amtV;
  if(type==='progress'&&typeof l.amtP==='number')return l.amtP;
  return l.amt;
}

function stageRewards(t){const sr=t&&t.stageRewards;return sr&&(Array.isArray(sr.v)||Array.isArray(sr.p))?sr:null;}
function taskIsStaged(t){return !!stageRewards(t);}
function stageValues(t,type){const sr=stageRewards(t);if(!sr)return null;const arr=type==='vitality'?sr.v:sr.p;return Array.isArray(arr)&&arr.length===5?arr:null;}
function stageSel(t){const sr=stageRewards(t);const l=sr&&typeof sr.last==='number'?sr.last:0;return Math.max(0,Math.min(9,Math.round(l)));}
function stageValueAt(t,type,cell){const v=stageValues(t,type);if(!v)return 0;if(cell>=9)return v[4]+(v[4]-v[3])/2;const i=cell>>1,rem=cell&1;return rem?(v[i]+v[i+1])/2:v[i];}
function stageCellLabel(cell){if(cell<=8&&cell%2===0)return STAGE_NAMES[cell/2];return STAGE_NAMES[Math.min(4,(cell-1)>>1)]+'+';}
function stageNetAt(t,type,cell,c){
  const base=stageValueAt(t,type,cell);
  const info=c||calcCheckIn(t);
  return Math.max(0,base+(info.bonus||0)-(info.debt||0));
}
function calcCheckIn(task){
  // Determine calendar-day gap since last check-in
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // Determine streak state
  let curStreak=task.streak||0;
  if(curStreak===0&&!isFirst)curStreak=1;
  
  let newStreak, broken=false;
  if(isFirst){
    newStreak=1;                       // first ever check-in
  }else if(gapDays<=0){
    newStreak=curStreak;               // same day — streak unchanged
  }else if(gapDays===1){
    newStreak=curStreak+1;             // consecutive next day — streak grows
  }else{
    newStreak=1; broken=true;          // gap ≥ 2 — streak resets
  }

  // Interest bonus: grows with consecutive-day streak
  const bonus=task.initialValue*(task.interestRate/100)*Math.max(0,newStreak-1);
  const gross=task.initialValue+bonus;

  // Debt: subtract accumulated pendingDebt from the earnable amount.
  // If net goes negative, the excess is deducted from total scores at check-in.
  const pendingDebt=task.pendingDebt||0;
  const net=gross-pendingDebt;

  return{gross:gross,bonus:bonus,debt:pendingDebt,net:net,gapDays:gapDays,newStreak:newStreak,broken:broken,isFirst:isFirst,curStreak:curStreak};
}

function calcSkip(task){
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // If first check-in or same day, skipping today has no penalty yet
  if(isFirst||gapDays<=0){
    return{debt:0,gapAfterSkip:1,desc:'今日未打卡，明日开始累积待扣债'};
  }

  const gapAfterSkip=gapDays+1;
  const dailyDebt=task.initialValue*(task.debtRate/100);
  const currentPending=task.pendingDebt||0;

  if(gapDays===1){
    // Checked in yesterday, skipping today → tomorrow gap=2, first debt day
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，连胜中断'};
    }
  }else{
    // Already in debt period (gap >= 2), another day adds more
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天'};
    }
  }
}

function dayKey(ts){
  const d=new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function weekStartKey(ts,anchor){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1; // 1=Mon .. 7=Sun
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return dayKey(d.getTime()-diff*864e5);
}
function weekStartTs(anchor,ts){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return d.getTime()-diff*864e5;
}
function periodKey(cfg,ts){
  if(cfg.period==='day')return dayKey(ts);
  if(cfg.period==='month'){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  return weekStartKey(ts,cfg.anchor||1);
}
function dayStartTs(ts){const d=new Date(ts);d.setHours(0,0,0,0);return d.getTime();}
function prevPeriodRange(act,ts){
  if(act.period==='day'){const s=dayStartTs(ts);return {start:s-864e5,end:s};}
  if(act.period==='month'){const d=new Date(ts);const cur=new Date(d.getFullYear(),d.getMonth(),1).getTime();const prev=new Date(d.getFullYear(),d.getMonth()-1,1).getTime();return {start:prev,end:cur};}
  const cur=weekStartTs(act.anchor||1,ts);return {start:cur-7*864e5,end:cur};
}
function condWindowByRange(range,act,ts,days){
  if(range==='today'){const s=dayStartTs(ts);return {start:s,end:s+864e5};}
  if(range==='recent'){const d=Math.max(1,Math.round(Number(days)||7));return {start:ts-d*864e5,end:ts};}
  // 预算规则的条件在当期实时求值：周期范围 = 预算分类当前周期（而非周期活动的“上一周期”）
  if(act&&act._periodRange)return act._periodRange;
  return prevPeriodRange(act,ts);
}
function cardName(c){return c==='exemption'?'断更豁免卡':(c||'卡');}
function validRange(r){return r==='period'||r==='total'||r==='recent'||r==='today';}
function normOp(op){return ['>','<','<=','>='].indexOf(op)>=0?op:'>=';}
function isPointMetric(m){return COND_POINT_METRICS.indexOf(m)>=0;}
function isAffairMetric(m){return COND_AFFAIR_METRICS.indexOf(m)>=0;}
function isChoreMetric(m){return COND_CHORE_METRICS.indexOf(m)>=0;}
function isStage1Metric(m){return isAffairMetric(m)||isChoreMetric(m)||m==='task_idle';}
function isGateMetric(m){return COND_GATE_METRICS.indexOf(m)>=0;}
function toNum(v,def){const n=Number(v);return isFinite(n)?n:(def===undefined?0:def);}
function toTs(v){const n=Number(v);return (isFinite(n)&&n>0)?n:null;}
function asArray(v){return Array.isArray(v)?v:[];}
function defaultWatermark(){return {best:0,at:null};}
function dateKeyOffset(daysAgo){
  const d=new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()-Math.max(0,Math.round(Number(daysAgo)||0)));
  return dayKey(d.getTime());
}
function budgetBounds(cycle,ts,anchor){
  ts=Number(ts)||now();
  const d=new Date(ts);
  if(cycle==='month'){
    const y=d.getFullYear(),m=d.getMonth();
    return{key:'M:'+y+'-'+String(m+1).padStart(2,'0'),start:new Date(y,m,1).getTime(),end:new Date(y,m+1,1).getTime()};
  }
  const s=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const dow=(s.getDay()+6)%7+1; // 1=周一 … 7=周日
  const a=Math.min(7,Math.max(1,Math.round(Number(anchor)||1)));
  let diff=dow-a;
  if(diff<0)diff+=7;
  const start=new Date(s.getFullYear(),s.getMonth(),s.getDate()-diff).getTime();
  const end=new Date(s.getFullYear(),s.getMonth(),s.getDate()-diff+7).getTime();
  return{key:'W:'+dayKey(start),start:start,end:end};
}
function weekAnchorName(a){return WEEK_ANCHOR_NAMES[Math.min(7,Math.max(1,Math.round(Number(a)||1)))];}
function round4(v){return Math.round((Number(v)||0)*10000)/10000;}
function affairSteps(a){return Array.isArray(a.steps)?a.steps.filter(function(s){return s&&s.text;}):[];}
function affairTotalSteps(a){return affairSteps(a).length;}
function affairDoneSteps(a){return affairSteps(a).filter(function(s){return s.doneAt;}).length;}
function affairLastAdvance(a){
  let ts=a.startedAt||0;
  affairSteps(a).forEach(function(s){if(s.doneAt&&s.doneAt>ts)ts=s.doneAt;});
  return ts||0;
}
function affairCurve(a){return (a.curve&&Array.isArray(a.curve.values)&&a.curve.values.length===10)?a.curve.values:AFFAIR_CURVES.even;}
function affairCurveType(a){return (a.curve&&a.curve.type)||'even';}
function affairTargetAt(a,cell){
  const vals=affairCurve(a);
  const v=vals[cell];
  return round2(((v===undefined?100:v)/100)*(a.totalReward||0));
}
function affairIsDone(a){return !!(a.doneAt)||((a.currentCell||0)>=9);}
function migrateAffair(a){
  if(!a)return a;
  if(typeof a.totalReward!=='number'||isNaN(a.totalReward))a.totalReward=0.1;
  if(typeof a.currentCell!=='number'||isNaN(a.currentCell))a.currentCell=0;
  a.currentCell=Math.max(0,Math.min(9,Math.round(a.currentCell)));
  if(typeof a.alreadyGiven!=='number'||isNaN(a.alreadyGiven))a.alreadyGiven=0;
  if(!a.curve||!Array.isArray(a.curve.values)||a.curve.values.length!==10){
    a.curve={type:'even',values:AFFAIR_CURVES.even.slice()};
  }else{
    a.curve.values=a.curve.values.map(function(v){return toNum(v);});
  }
  if(!a.curve.type)a.curve.type='custom';
  if(!a.ach||typeof a.ach!=='object')a.ach={enabled:false,amount:0};
  if(a.ach.enabled===undefined)a.ach.enabled=false;
  if(typeof a.ach.amount!=='number'||isNaN(a.ach.amount))a.ach.amount=0;
  a.archived=!!a.archived;
  a.archivedAt=a.archivedAt||null;
  return a;
}


export { uid, fmt, now, daysSince, effectiveLastTs, taskCheckedToday, fmtTime, esc, escAttr, clone, splitCents, logHasType, taskScoreTypes, taskHasType, getTaskDomainIds, round2, logAmt, stageRewards, taskIsStaged, stageValues, stageSel, stageValueAt, stageCellLabel, stageNetAt, calcCheckIn, calcSkip, dayKey, weekStartKey, weekStartTs, periodKey, dayStartTs, prevPeriodRange, condWindowByRange, cardName, validRange, normOp, isPointMetric, isAffairMetric, isChoreMetric, isStage1Metric, isGateMetric, toNum, toTs, asArray, defaultWatermark, dateKeyOffset, budgetBounds, weekAnchorName, round4, affairSteps, affairTotalSteps, affairDoneSteps, affairLastAdvance, affairCurve, affairCurveType, affairTargetAt, affairIsDone, migrateAffair };

function idleDaysSince(baseTs,refTs){
  if(!baseTs)return null;
  const ref=dayStartTs(refTs||now());
  const base=dayStartTs(baseTs);
  const d=Math.round((ref-base)/864e5);
  return d>0?d:0;
}
function isArchivedEntity(o){return !!(o&&(o.archived||o.archivedAt));}
export { idleDaysSince, isArchivedEntity };
