import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { normalizeCondition } from './cond-model.js';
import { condDraft, condDraftUI, countCondLeaves, renderActivityResultDetails, renderCondTree, resetCondDraftUI, setCondDraft } from './cond-ui.js';
import { COND_RANGES } from './constants.js';
import { archiveIdleEntities } from './entities.js';
import { openModal } from './modal-host.js';
import { cardName, isAffairMetric, isChoreMetric, isPointMetric, esc, fmt } from './pure.js';
import { state } from './state.js';
import { domainName, taskNameLabel } from './utils.js';
// cycle.js —— 周期活动列表与编辑
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Cycle Settings (周期活动) =====
function fmtDate(ts){
  if(!ts)return '—';
  const d=new Date(ts);
  const today=new Date();today.setHours(0,0,0,0);
  const diffDays=Math.round((ts-today.getTime())/864e5);
  if(diffDays===0)return '今天';
  if(diffDays===1)return '明天';
  if(diffDays===2)return '后天';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function cycleNextGrant(cfg){
  const anchor=cfg.anchor||1;
  if(cfg.period==='day'){const d=new Date();d.setHours(0,0,0,0);return d.getTime()+864e5;}
  if(cfg.period==='month'){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();}
  const d=new Date();d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=anchor-dow;if(diff<=0)diff+=7;
  return d.getTime()+diff*864e5;
}
function updateExemptChip(){
  const chip=document.getElementById('exemptChip');
  if(!chip)return;
  const bal=state.cards.exemption||0;
  chip.style.display=bal>0?'inline-flex':'none';
  chip.textContent='豁免卡 × '+bal;
}
function periodLabel(p){return p==='day'?'每天':p==='month'?'每月':'每周';}
const COND_METRICS=[
  {v:'checkins',n:'打卡次数'},
  {v:'vitality',n:'活力点'},
  {v:'progress',n:'进度值'},
  {v:'achievement',n:'成果点'},
  {v:'new_tasks',n:'新增任务'},
  {v:'new_domains',n:'新增领域'},
  {v:'budget_entry_amount',n:'本笔金额'},
  {v:'budget_period_spent',n:'本周期已花'},
  {v:'budget_period_overspend',n:'本周期超支'},
  {v:'budget_entry_count',n:'本周期笔数'},
  {v:'task_idle',n:'任务不活跃天数'},
  {v:'affair_completed',n:'项目完成数'},
  {v:'affair_steps',n:'项目推进步数'},
  {v:'affair_stall',n:'项目停滞天数'},
  {v:'affair_progress',n:'项目进度值'},
  {v:'affair_achievement',n:'项目成果点'},
  {v:'chore_completed',n:'杂事完成数'},
  {v:'chore_overdue',n:'杂事超期件数'},
  {v:'chore_decay',n:'杂事腐化值'},
  {v:'chore_batches',n:'杂事结算次数'},
  {v:'chore_idle',n:'杂事不活跃天数'},
  {v:'lifetime_achievement',n:'累计获得成果点'},
  {v:'domain_activity',n:'领域活跃次数'},
  {v:'milestone_unlocked',n:'里程碑已解锁'},
  {v:'checkin_streak',n:'连续打卡天数'},
  {v:'budget_remaining',n:'预算剩余'}
];
const COND_TARGET_TYPES=[{v:'all',n:'全部'},{v:'domain',n:'按领域'},{v:'task',n:'按任务'},{v:'milestone',n:'按里程碑'},{v:'budget',n:'按预算分类'}];
const COND_NEW_FILTERS=[{v:'none',n:'当前'},{v:'new_task',n:'本周期新增任务'},{v:'new_domain',n:'本周期新增领域'}];
const COND_AGGREGATES=[{v:'sum',n:'总计'},{v:'any',n:'任意单个'}];
// 主体类型：成果点仅全部；计数类(新增任务/新增领域)支持全部+领域；值类(打卡/活力/进度)支持全部+领域+任务
// 阶段 1：项目类支持全部+领域；杂事类仅全部；任务不活跃支持全部+领域+任务
function condTargetTypesFor(metric){
  if(metric==='achievement'||metric==='lifetime_achievement')return ['all'];
  if(metric==='milestone_unlocked')return ['milestone'];
  if(metric==='budget_remaining')return ['budget'];
  if(metric==='domain_activity')return ['domain'];
  if(metric.indexOf('budget_')===0)return ['all'];
  if(metric==='new_tasks'||metric==='new_domains')return ['all','domain'];
  if(isChoreMetric(metric))return ['all'];
  if(isAffairMetric(metric))return ['all','domain'];
  return ['all','domain','task'];
}
// 新增筛选选项（仅值类指标；按主体限制可用项）
function condNewFilterOptions(targetType){
  if(targetType==='all')return ['none','new_task','new_domain'];
  if(targetType==='domain')return ['none','new_task'];
  return ['none'];
}
function rangeLabel(range,days){
  if(range==='recent')return '最近'+(days||7)+'天';
  const r=COND_RANGES.find(x=>x.v===range);
  return r?r.n:'本周期';
}
function metricNameLabel(it){
  return (COND_METRICS.find(m=>m.v===it.metric)||{}).n||it.metric;
}
function condEntityWord(it){
  return it.newFilter==='new_domain'?'领域':'任务';
}
// 是否多实体语境（需要展示「总计/任意单个」聚合方式）
function condIsMulti(it){
  if(it.newFilter==='new_task'||it.newFilter==='new_domain')return true;
  if(it.targetType==='all'&&it.aggregate==='any')return true;
  return false;
}
// 主体+新增短语（不含范围与聚合）
function condScopePhrase(it){
  const t=it.target||'';
  if(it.newFilter==='new_task'){
    if(it.targetType==='domain'&&t)return domainName(t)+'新增任务';
    return '新增任务';
  }
  if(it.newFilter==='new_domain')return '新增领域';
  if(it.targetType==='domain'&&t)return domainName(t);
  if(it.targetType==='task'&&t)return taskNameLabel(t);
  if(it.targetType==='milestone'&&t){
    const a=(state.achievements||[]).find(x=>x.id===t);
    return a?a.name:'（里程碑已删除）';
  }
  if(it.targetType==='budget'&&t){
    const c=BudgetEngine.category(t);
    return c?c.name:'（预算分类已删除）';
  }
  return '';
}
function metricLabel(it){
  const mn=metricNameLabel(it);
  let s=condScopePhrase(it);
  if(condIsMulti(it))s+=(it.aggregate==='any'?'·任一'+condEntityWord(it):'·总计');
  return (s?s+'·':'')+mn;
}
function opLabel(op){return {'<=':'≤','>=':'≥','>':'>','<':'<'}[op]||'≥';}
function rangeTimeWord(it,act){
  if(it.range==='today')return '今天';
  if(it.range==='recent')return '最近'+(it.days||7)+'天';
  if(it.range==='total')return '累计';
  if(act&&act._budget)return '本周期';
  if(act.period==='day')return '昨日';
  if(act.period==='month')return '上月';
  return '上周';
}
function condItemLabel(it){
  if(!it)return '';
  if(isPointMetric(it.metric))return metricLabel(it)+' '+opLabel(it.op)+' '+fmt(it.value);
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it)+' '+opLabel(it.op)+' '+fmt(it.value);
}
function condNodeLabel(node){
  if(node&&node.group)return '（'+((node.items||[]).map(condNodeLabel).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condItemLabel(node);
}
function condNLLeaf(it,act){
  const rw=rangeTimeWord(it,act);
  const mn=metricNameLabel(it);
  const tail=' '+opLabel(it.op)+' '+fmt(it.value);
  // 点态指标没有时间窗口：直接“主体·指标 ≥ N”
  if(isPointMetric(it.metric))return (condScopePhrase(it)?condScopePhrase(it)+'·':'')+mn+tail;
  if(it.metric==='achievement')return rw+mn+tail;
  const scope=condScopePhrase(it);
  const ew=condEntityWord(it);
  const anyAgg=it.aggregate==='any';
  if(it.newFilter==='new_task'||it.newFilter==='new_domain'){
    if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
    return rw+scope+'总计'+mn+tail;
  }
  if(it.targetType==='all'){
    if(anyAgg)return rw+'任意单个'+ew+mn+tail;
    return rw+mn+tail;
  }
  if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
  return rw+scope+mn+tail;
}
function condNLNode(node,act){
  if(node&&node.group)return '（'+((node.items||[]).map(n=>condNLNode(n,act)).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condNLLeaf(node,act);
}
function rewardItemLabel(it){
  if(!it)return '';
  if(it.type==='archive'){
    const ent=it.entity==='affair'?'项目':it.entity==='chore'?'杂事':'任务';
    return '归档不活跃≥'+(it.idleDays||14)+'天的'+ent;
  }
  if(it.type==='card')return cardName(it.card||'exemption')+' ×'+(it.amount||0)+(it.cap?'（上限'+(it.cap||0)+'）':'');
  if(it.type==='progress'){
    if(it.domainId)return domainName(it.domainId)+'进度 +'+fmt(it.amount);
    return '进度(全领域) +'+fmt(it.amount);
  }
  if(it.type==='vitality'){
    const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
    return tName?('「'+tName+'」活力 +'+fmt(it.amount)):('活力 +'+fmt(it.amount));
  }
  if(it.type==='achievement')return '成果 +'+fmt(it.amount);
  return '';
}
function actMetaLabel(a){
  const c=a.condition||{mode:'all',items:[]};
  const condItems=c.items||[];
  const condTxt=condItems.length?condItems.map(condNodeLabel).join(c.mode==='any'?' 或 ':' 且 '):'无条件';
  const resItems=(a.result&&a.result.items)||[];
  const resTxt=resItems.length?resItems.map(rewardItemLabel).join('、'):'无';
  return '前提：'+condTxt+'　结果：'+resTxt;
}
function readRewardItems(){
  const rewardItems=[];
  document.querySelectorAll('#activityResultDetails .reward-row').forEach(row=>{
    const type=row.querySelector('.rr-type').value;
    if(type==='archive'){
      const entSel=row.querySelector('.rr-entity');
      const idleInp=row.querySelector('.rr-idle');
      rewardItems.push({
        type:'archive',
        entity:entSel?entSel.value:'task',
        idleDays:Math.max(1,Math.round(Number(idleInp&&idleInp.value)||14))
      });
      return;
    }
    const amount=Math.max(0,Number(row.querySelector('.rr-amount').value)||0);
    if(amount<=0&&type!=='card')return;
    if(type==='card'){
      rewardItems.push({type:'card',card:'exemption',amount:Math.round(amount),cap:Math.max(1,Math.round(Number(row.querySelector('.rr-cap').value)||3))});
    }else if(type==='progress'){
      const did=row.querySelector('.rr-domain').value;
      const r={type:'progress',amount:amount};
      if(did)r.domainId=did;
      rewardItems.push(r);
    }else if(type==='vitality'){
      const tid=row.querySelector('.rr-task').value;
      const r={type:'vitality',amount:amount};
      if(tid)r.taskId=tid;
      rewardItems.push(r);
    }else if(type==='achievement'){
      rewardItems.push({type:'achievement',amount:amount});
    }
  });
  return rewardItems;
}
function updateCondPreview(){
  const el=document.getElementById(condDraftUI.previewId||'condPreview');
  if(!el)return;
  // 预算规则条件：交给预算侧的自定义预览，不读取周期活动字段
  if(condDraftUI.previewFn){condDraftUI.previewFn(el,condDraft);return;}
  const periodSel=document.getElementById('activityPeriod');
  if(!periodSel)return;
  const items=condDraft.items||[];
  const mode=condDraft.mode==='any'?'any':'all';
  const period=periodSel.value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
  const when=period==='day'?'每天结算时':period==='month'?'每月结算时':('每'+anchorNames[anchor]+'结算时');
  const actLike={period:period};
  let condTxt;
  if(!items.length)condTxt='无条件触发';
  else condTxt=items.map(n=>condNLNode(n,actLike)).join(mode==='any'?' 或 ':' 且 ');
  const rewards=readRewardItems();
  let resTxt=rewards.length?rewards.map(rewardItemLabel).join('、'):'（未设置动作）';
  // 结构操作在配置时就给出当前命中数量：让用户确认“触发会发生什么”
  const arch=rewards.filter(r=>r.type==='archive');
  if(arch.length){
    let hit=0;
    arch.forEach(r=>{hit+=archiveIdleEntities(r.entity,r.idleDays,Date.now(),'',true);});
    resTxt+='（按当前状态将归档 '+hit+' 个）';
  }
  el.innerHTML='<span class="cp-badge">预览</span>'+esc(when)+'，若 '+esc(condTxt)+'，则 '+esc(resTxt)+'。';
}
function openActivityModal(id){
  const a=id?state.activities.find(x=>x.id===id):null;
  document.getElementById('activityId').value=id||'';
  document.getElementById('activityModalTitle').textContent=id?'编辑周期活动':'新建周期活动';
  document.getElementById('activityName').value=a?a.name:'';
  document.getElementById('activityPeriod').value=a?a.period:'week';
  document.getElementById('activityAnchor').value=a?(a.anchor||1):1;
  resetCondDraftUI();
  setCondDraft(normalizeCondition((a&&a.condition)||{mode:'all',items:[]}));
  document.getElementById('activityCondMode').value=(condDraft.mode==='any')?'any':'all';
  document.getElementById('activityDeleteBtn').style.display=id?'':'none';
  renderActivityResultDetails(a?a.result:null);
  renderCondTree();
  activityPeriodChanged();
  // 折叠分区：基本信息展开，前提与奖励默认收起以保持简洁（标题栏显示摘要）
  setAcc('accBasic',true);
  setAcc('accCond',false);
  setAcc('accResult',false);
  updateActivitySummary();
  openModal('activityModal');
  setTimeout(()=>document.getElementById('activityName').focus(),50);
}
function activityPeriodChanged(){
  const p=document.getElementById('activityPeriod').value;
  document.getElementById('activityAnchorFg').style.display=(p==='week')?'':'none';
  updateCondPreview();
  updateActivitySummary();
}
function toggleAcc(id){const el=document.getElementById(id);if(el)el.classList.toggle('open');}
function setAcc(id,open){const el=document.getElementById(id);if(el)el.classList.toggle('open',open);}
function updateActivitySummary(){
  const periodSel=document.getElementById('activityPeriod');
  if(periodSel){
    const p=periodSel.value;
    const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
    const a=parseInt(document.getElementById('activityAnchor').value,10)||1;
    const basicSum=document.getElementById('accBasicSum');
    if(basicSum)basicSum.textContent=p==='week'?('每周 · '+anchorNames[a]):periodLabel(p);
  }
  const condMode=document.getElementById('activityCondMode');
  const condSum=document.getElementById('accCondSum');
  if(condSum){
    const n=countCondLeaves(condDraft.items||[]);
    const m=(condMode&&condMode.value==='any')?'任一':'全部';
    condSum.textContent=n?((m==='任一'?'任一满足':'全部满足')+' · '+n+' 项'):'无条件';
  }
  const resBox=document.getElementById('activityResultDetails');
  const resSum=document.getElementById('accResultSum');
  if(resSum&&resBox){
    const n=resBox.querySelectorAll('.reward-row').length;
    resSum.textContent=n?(n+' 项动作'):'未设置';
  }
}

export { fmtDate, cycleNextGrant, updateExemptChip, periodLabel, COND_METRICS, COND_TARGET_TYPES, COND_NEW_FILTERS, COND_AGGREGATES, condTargetTypesFor, condNewFilterOptions, rangeLabel, metricNameLabel, condEntityWord, condIsMulti, condScopePhrase, metricLabel, opLabel, rangeTimeWord, condItemLabel, condNodeLabel, condNLLeaf, condNLNode, rewardItemLabel, actMetaLabel, readRewardItems, updateCondPreview, openActivityModal, activityPeriodChanged, toggleAcc, setAcc, updateActivitySummary };

registerRenderer('exempt', updateExemptChip);
