import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { useExemption } from './business.js';
import { exemptionActivity } from './conditions.js';
import { COND_RANGES } from './constants.js';
import { COND_AGGREGATES, COND_METRICS, COND_NEW_FILTERS, COND_TARGET_TYPES, actMetaLabel, condNewFilterOptions, condTargetTypesFor, cycleNextGrant, fmtDate, metricLabel, opLabel, openActivityModal, periodLabel, rangeLabel, readRewardItems, updateActivitySummary, updateCondPreview } from './cycle.js';
import { processActivities } from './entities.js';
import { Ledger } from './ledger.js';
import { closeModal, openModal } from './modal-host.js';
import { commit, save } from './persist.js';
import { isGateMetric, isPointMetric, isStage1Metric, effectiveLastTs, esc, fmt, taskCheckedToday, uid } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { dayDiff, dayStart, now } from './time.js';
import { toast } from './toast.js';
// cond-ui.js —— 条件芯片编辑器与点选浮层
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let condDraft={mode:'all',items:[]};
let condDraftUI={box:'activityCondItems',previewId:'condPreview',previewFn:null,afterChange:null};
let condPanel={visible:false,kind:'metric',path:'',step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
// ===== 条件芯片编辑器（嵌套条件组 + 点选面板）=====
function countCondLeaves(items){
  return (items||[]).reduce((s,node)=>{
    if(node&&node.group)return s+countCondLeaves(node.items);
    return s+1;
  },0);
}
function condListAt(parentPath){
  if(!parentPath)return condDraft.items;
  const parts=parentPath.split('/').map(Number);
  let list=condDraft.items;
  for(const idx of parts){
    const node=list[idx];
    if(!node||!node.group)return condDraft.items;
    list=node.items;
  }
  return list;
}
function condNodeAt(path){
  if(!path)return null;
  const parts=path.split('/').filter(Boolean).map(Number);
  let list=condDraft.items;
  let node=null;
  for(let i=0;i<parts.length;i++){
    const idx=parts[i];
    if(idx<0||idx>=list.length)return null;
    node=list[idx];
    if(node&&node.group)list=node.items;
  }
  return node;
}
function condMetricChipText(it){
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it);
}
function condItemRow(it,path){
  it=it||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'};
  return '<div class="cond-chip-line">'
    +'<button class="cc-chip cc-metric" title="点击修改指标" onclick="openCondMetricPanel(\''+path+'\',this)">'+esc(condMetricChipText(it))+'</button>'
    +'<button class="cc-chip cc-op" title="点击修改运算符" onclick="openCondOpPanel(\''+path+'\',this)">'+esc(opLabel(it.op))+'</button>'
    +'<button class="cc-chip cc-value" title="点击修改数值" onclick="editCondValue(\''+path+'\',this)">'+esc(fmt(it.value))+'</button>'
    +'<button class="cc-del" title="删除此条件" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>';
}
function condGroupInnerHTML(group,path,depth){
  const items=group.items||[];
  if(!items.length)return '<div class="cond-empty-sm">组内还没有条件</div>';
  return renderCondNodes(items,path,depth+1);
}
function condGroupHTML(group,path,depth){
  const canNest=depth<1;
  return '<div class="cond-group">'
    +'<div class="cond-group-head">'
    +'<span class="cg-label">满足</span>'
    +'<select class="cg-mode" onchange="changeGroupMode(\''+path+'\',this.value)">'
    +'<option value="all"'+(group.mode==='any'?'':' selected')+'>全部</option>'
    +'<option value="any"'+(group.mode==='any'?' selected':'')+'>任意</option>'
    +'</select>'
    +'<span class="cg-label2">以下条件</span>'
    +'<button class="cc-del" title="删除此条件组" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>'
    +'<div class="cond-group-body">'
    +condGroupInnerHTML(group,path,depth)
    +'<div class="cond-actions">'
    +'<button class="btn btn-sm" onclick="addCondItem(\''+path+'\')">+ 添加条件</button>'
    +(canNest?'<button class="btn btn-sm" onclick="addCondGroup(\''+path+'\')">+ 添加条件组</button>':'')
    +'</div>'
    +'</div></div>';
}
function renderCondNodes(items,parentPath,depth){
  return (items||[]).map((node,idx)=>{
    const path=parentPath?parentPath+'/'+idx:String(idx);
    return (node&&node.group)?condGroupHTML(node,path,depth):condItemRow(node,path);
  }).join('');
}
function renderCondTree(){
  const box=document.getElementById(condDraftUI.box||'activityCondItems');
  if(!box)return;
  box.innerHTML=(condDraft.items&&condDraft.items.length)?renderCondNodes(condDraft.items,'',0):'<div class="cond-empty">还没有条件，满足任意情况即触发</div>';
  updateCondPreview();
  if(condDraftUI.afterChange)condDraftUI.afterChange();
  else updateActivitySummary();
}
function setCondDraftContext(draft,box,previewId,previewFn,afterChange){
  condDraft=draft;
  condDraftUI={box:box,previewId:previewId,previewFn:previewFn||null,afterChange:afterChange||null};
}
function resetCondDraftUI(){
  condDraftUI={box:'activityCondItems',previewId:'condPreview',previewFn:null,afterChange:null};
}
function addCondItem(parentPath){condListAt(parentPath).push({range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'});renderCondTree();}
function addCondGroup(parentPath){condListAt(parentPath).push({group:true,mode:'all',items:[{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'}]});renderCondTree();}
function removeCondNode(path){
  if(!path)return;
  const parts=path.split('/').map(Number);
  const idx=parts.pop();
  const parentPath=parts.join('/');
  const list=condListAt(parentPath);
  if(list&&idx>=0&&idx<list.length)list.splice(idx,1);
  renderCondTree();
}
function changeGroupMode(path,mode){
  const node=condNodeAt(path);
  if(node&&node.group)node.mode=(mode==='any'?'any':'all');
  renderCondTree();
}
function onCondModeChange(){
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  updateCondPreview();
  updateActivitySummary();
}
// ===== 点选浮层面板 =====
function getCondPanelEl(){
  let el=document.getElementById('condPanel');
  if(!el){
    el=document.createElement('div');
    el.id='condPanel';
    el.className='cond-panel';
    document.body.appendChild(el);
  }
  return el;
}
function positionCondPanel(anchor){
  const el=getCondPanelEl();
  el.style.visibility='hidden';
  el.style.display='block';
  // 移动端以底部抽屉形式展示，位置交给 CSS（.cond-panel.sheet）
  const sheet=!!(window.matchMedia&&window.matchMedia('(max-width:560px)').matches);
  el.classList.toggle('sheet',sheet);
  if(sheet){
    el.style.left='';
    el.style.top='';
    el.style.visibility='visible';
    return;
  }
  const r=anchor.getBoundingClientRect();
  const pw=el.offsetWidth||200;
  const ph=el.offsetHeight||0;
  const vw=window.innerWidth,vh=window.innerHeight;
  const left=Math.max(8,Math.min(r.left,vw-pw-8));
  let top=r.bottom+6;
  if(top+ph>vh-8)top=r.top-ph-6;
  if(top<8)top=8;
  el.style.left=left+'px';
  el.style.top=top+'px';
  el.style.visibility='visible';
}
function renderCondPanel(){
  const el=getCondPanelEl();
  const p=condPanel;
  let html='';
  if(p.kind==='op'){
    html='<div class="cp-title">运算符</div><div class="cp-opts">';
    [['>=','≥'],['>','>'],['<=','≤'],['<','<']].forEach(o=>{
      html+='<button class="cp-opt" onclick="commitCondOp(\''+o[0]+'\')">'+o[1]+'</button>';
    });
    html+='</div>';
  }else if(p.step==='range'){
    html='<div class="cp-title">时间范围</div><div class="cp-opts">';
    COND_RANGES.forEach(r=>{
      html+='<button class="cp-opt" onclick="pickCondRange(\''+r.v+'\')">'+r.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='days'){
    html='<div class="cp-title">最近多少天</div><div class="cp-days">'
      +'<input type="number" id="condPanelDays" value="'+p.days+'" min="1" step="1">'
      +'<button class="btn btn-sm" onclick="confirmCondDays()">确定</button></div>';
  }else if(p.step==='metric'){
    html='<div class="cp-title">指标</div><div class="cp-opts">';
    COND_METRICS.forEach(m=>{
      html+='<button class="cp-opt" onclick="pickCondMetric(\''+m.v+'\')">'+m.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='targetType'){
    html='<div class="cp-title">统计主体</div><div class="cp-opts">';
    condTargetTypesFor(p.metric).forEach(tt=>{
      const n=(COND_TARGET_TYPES.find(x=>x.v===tt)||{}).n||tt;
      html+='<button class="cp-opt" onclick="pickCondTargetType(\''+tt+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='newFilter'){
    html='<div class="cp-title">新增筛选</div><div class="cp-opts">';
    condNewFilterOptions(p.targetType).forEach(nf=>{
      const n=(COND_NEW_FILTERS.find(x=>x.v===nf)||{}).n||nf;
      html+='<button class="cp-opt" onclick="pickCondNewFilter(\''+nf+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='domain'){
    html='<div class="cp-title">选择领域</div><div class="cp-opts">';
    state.domains.forEach(d=>{
      html+='<button class="cp-opt" onclick="pickCondDomain(\''+d.id+'\')">'+esc(d.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='task'){
    html='<div class="cp-title">选择任务</div><div class="cp-opts">';
    state.tasks.forEach(t=>{
      html+='<button class="cp-opt" onclick="pickCondTask(\''+t.id+'\')">'+esc(t.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='milestone'){
    html='<div class="cp-title">选择里程碑</div><div class="cp-opts">';
    (state.achievements||[]).forEach(a=>{
      html+='<button class="cp-opt" onclick="pickCondMilestone(\''+a.id+'\')">'+esc(a.name)+(a.unlocked?'（已解锁）':'（未解锁）')+'</button>';
    });
    html+='</div>';
  }else if(p.step==='budget'){
    html='<div class="cp-title">选择预算分类</div><div class="cp-opts">';
    BudgetEngine.categories().forEach(c=>{
      html+='<button class="cp-opt" onclick="pickCondBudgetCat(\''+c.id+'\')">'+esc(c.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='aggregate'){
    html='<div class="cp-title">聚合方式</div><div class="cp-opts">';
    COND_AGGREGATES.forEach(a=>{
      html+='<button class="cp-opt" onclick="pickCondAggregate(\''+a.v+'\')">'+a.n+'</button>';
    });
    html+='</div>';
  }
  el.innerHTML=html;
  if(p.kind==='metric'&&p.step==='days'){
    setTimeout(()=>{const inp=document.getElementById('condPanelDays');if(inp){inp.focus();inp.select();}},0);
  }
}
function openCondMetricPanel(path,anchor){
  const it=condNodeAt(path)||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  condPanel={visible:true,kind:'metric',path:path,anchor:anchor,step:isPointMetric(it.metric)?'metric':'range',range:it.range||'period',days:it.days||7,metric:it.metric||'checkins',targetType:it.targetType||'all',newFilter:it.newFilter||'none',target:it.target||'',aggregate:it.aggregate||'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function openCondOpPanel(path,anchor){
  condPanel={visible:true,kind:'op',path:path,anchor:anchor,step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function pickCondRange(range){
  condPanel.range=range;
  condPanel.step=(range==='recent')?'days':'metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function confirmCondDays(){
  const inp=document.getElementById('condPanelDays');
  condPanel.days=Math.max(1,Math.round(Number(inp&&inp.value)||7));
  condPanel.step='metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondMetric(metric){
  condPanel.metric=metric;
  // 成果点/预算进账指标仅支持「全部 + 本周期」，直接提交
  if(metric==='achievement'||(metric.indexOf('budget_')===0&&metric!=='budget_remaining')){
    if(metric.indexOf('budget_')===0)condPanel.range='period';
    commitCondValue('all','','none','sum');return;
  }
  // 阶段 3 门槛指标：点态无窗口；里程碑/预算分类需要先选实体
  if(isGateMetric(metric)){
    if(metric==='lifetime_achievement'){condPanel.range='total';commitCondValue('all','','none','sum');return;}
    if(isPointMetric(metric))condPanel.range='today';
    if(metric==='milestone_unlocked'){condPanel.step='milestone';renderCondPanel();positionCondPanel(condPanel.anchor);return;}
    if(metric==='budget_remaining'){condPanel.step='budget';renderCondPanel();positionCondPanel(condPanel.anchor);return;}
    if(metric==='domain_activity'){condPanel.step='domain';renderCondPanel();positionCondPanel(condPanel.anchor);return;}
    condPanel.step='targetType';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 阶段 1 指标没有「新增筛选 / 聚合」概念：按主体类型直达
  if(isStage1Metric(metric)){
    if(isPointMetric(metric))condPanel.range='today';
    if(condTargetTypesFor(metric).length===1){commitCondValue('all','','none','sum');return;}
    condPanel.step='targetType';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  condPanel.step='targetType';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondTargetType(tt){
  condPanel.targetType=tt;
  // 阶段 3 门槛指标（仅连续打卡可细分主体）
  if(isGateMetric(condPanel.metric)){
    if(tt==='all'){commitCondValue('all','','none','sum');return;}
    condPanel.step=(tt==='task')?'task':'domain';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 阶段 1 指标：全部直接提交；领域/任务继续选具体实体
  if(isStage1Metric(condPanel.metric)){
    if(tt==='all'){commitCondValue('all','','none','sum');return;}
    condPanel.step=(tt==='task')?'task':'domain';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 单任务：主体即锁定唯一实体，无需新增筛选与聚合
  if(tt==='task'){
    condPanel.newFilter='none';
    condPanel.step='task';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 计数类指标（新增任务/新增领域）：本身已限定「新增」，无需新增筛选/聚合
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    if(tt==='all'){commitCondValue('all','','none','sum');}
    else{condPanel.step='domain';renderCondPanel();positionCondPanel(condPanel.anchor);}
    return;
  }
  // 值类指标（打卡/活力/进度）：全部→新增筛选；按领域→先选领域再新增筛选
  condPanel.step=(tt==='all')?'newFilter':'domain';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondNewFilter(nf){
  condPanel.newFilter=nf;
  condPanel.step='aggregate';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondDomain(id){
  condPanel.target=id;
  // 阶段 3 门槛指标：领域活跃次数按领域读取
  if(isGateMetric(condPanel.metric)){commitCondValue('domain',id,'none','sum');return;}
  // 阶段 1 指标选完领域即完成
  if(isStage1Metric(condPanel.metric)){commitCondValue('domain',id,'none','sum');return;}
  // 计数类指标选完领域即完成；值类指标继续选新增筛选
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    commitCondValue('domain',id,'none','sum');
  }else{
    condPanel.step='newFilter';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
  }
}
function pickCondTask(id){
  commitCondValue('task',id,'none','sum');
}
function pickCondMilestone(id){
  commitCondValue('milestone',id,'none','sum');
}
function pickCondBudgetCat(id){
  commitCondValue('budget',id,'none','sum');
}
function pickCondAggregate(agg){
  commitCondValue(condPanel.targetType,condPanel.target,condPanel.newFilter,agg);
}
function commitCondValue(targetType,target,newFilter,aggregate){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group){
    it.range=condPanel.range;
    if(condPanel.range==='recent')it.days=condPanel.days;else delete it.days;
    it.metric=condPanel.metric;
    it.targetType=targetType;
    if(targetType==='all')delete it.target;else it.target=target;
    it.newFilter=newFilter;
    it.aggregate=aggregate;
  }
  closeCondPanel();
  renderCondTree();
}
function commitCondOp(op){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group)it.op=op;
  closeCondPanel();
  renderCondTree();
}
function closeCondPanel(){
  condPanel.visible=false;
  const el=document.getElementById('condPanel');
  if(el){el.style.display='none';el.innerHTML='';}
}
function editCondValue(path,btn){
  const it=condNodeAt(path);
  if(!it||it.group)return;
  const valChip=btn.closest('.cond-chip-line').querySelector('.cc-value');
  if(!valChip)return;
  const input=document.createElement('input');
  input.type='number';
  input.className='cc-value-input';
  input.value=it.value;
  input.step='0.1';
  let done=false;
  const commit=()=>{
    if(done)return;
    done=true;
    const v=Number(input.value);
    it.value=(v!==undefined&&!isNaN(v))?v:0;
    renderCondTree();
  };
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();commit();}
    else if(e.key==='Escape'){done=true;renderCondTree();}
  });
  input.addEventListener('blur',commit);
  valChip.replaceWith(input);
  input.focus();
  input.select();
}
export function initCondPanelDismiss(){document.addEventListener('click',function(e){
  if(!condPanel.visible)return;
  // 用 composedPath 判定：面板内部点击后按钮可能因 innerHTML 重渲染脱离 DOM，
  // 此时 e.target.closest 会返回 null；composedPath 仍保留派发时的祖先链，可正确识别面板内点击。
  const path=(e.composedPath&&e.composedPath())||[];
  const inPanel=path.some(n=>n&&n.getAttribute&&n.getAttribute('id')==='condPanel');
  const inChip=path.some(n=>n&&n.classList&&n.classList.contains('cc-chip'));
  if(!inPanel&&!inChip)closeCondPanel();
});}
function rewardRowHTML(item){
  item=item||{type:'vitality',amount:10};
  const typeOpts=[['vitality','活力点'],['progress','进度值'],['achievement','成果点'],['card','断更豁免卡'],['archive','归档（结构操作）']]
    .reduce((s,o)=>s+'<option value="'+o[0]+'"'+((item.type||'vitality')===o[0]?' selected':'')+'>'+o[1]+'</option>','');
  const entityOpts=[['task','任务'],['affair','项目'],['chore','杂事']]
    .reduce((s,o)=>s+'<option value="'+o[0]+'"'+((item.entity||'task')===o[0]?' selected':'')+'>'+o[1]+'</option>','');
  const domOpts='<option value="">全部领域</option>'+state.domains.map(d=>'<option value="'+d.id+'"'+((item.domainId||'')===d.id?' selected':'')+'>'+esc(d.name)+'</option>').join('');
  const taskOpts='<option value="">不指定任务</option>'+state.tasks.map(t=>'<option value="'+t.id+'"'+((item.taskId||'')===t.id?' selected':'')+'>'+esc(t.name)+'</option>').join('');
  const isVit=(item.type==='vitality');
  const isProg=(item.type==='progress');
  const isCard=(item.type==='card');
  const isArchive=(item.type==='archive');
  const amtVal=(item.amount===undefined||item.amount===null||item.amount==='')?10:item.amount;
  const capVal=(item.cap===undefined||item.cap===null||item.cap==='')?3:item.cap;
  const idleVal=(item.idleDays===undefined||item.idleDays===null||item.idleDays==='')?14:item.idleDays;
  return '<div class="reward-row">'
    +'<select class="rr-type" onchange="rrTypeChanged(this)">'+typeOpts+'</select>'
    +'<select class="rr-entity" onchange="updateCondPreview()" style="display:'+(isArchive?'':'none')+'" title="归档对象">'+entityOpts+'</select>'
    +'<select class="rr-task" onchange="updateCondPreview()" style="display:'+(isVit?'':'none')+'" title="关联任务（可选）">'+taskOpts+'</select>'
    +'<select class="rr-domain" onchange="updateCondPreview()" style="display:'+(isProg?'':'none')+'" title="关联领域（可选）">'+domOpts+'</select>'
    +'<input type="number" class="rr-amount" oninput="updateCondPreview()" value="'+amtVal+'" min="0" step="0.1" title="数量" style="display:'+(isArchive?'none':'')+'">'
    +'<input type="number" class="rr-idle" oninput="updateCondPreview()" value="'+idleVal+'" min="1" step="1" title="不活跃天数阈值" style="display:'+(isArchive?'':'none')+'">'
    +'<input type="number" class="rr-cap" oninput="updateCondPreview()" value="'+capVal+'" min="1" step="1" style="display:'+(isCard?'':'none')+'" title="豁免卡累计上限">'
    +'<button class="rr-del" onclick="removeRewardRow(this)">×</button>'
    +'</div>';
}
function renderActivityResultDetails(result){
  const box=document.getElementById('activityResultDetails');
  result=result||{};
  const items=(result.items&&result.items.length)?result.items:[{type:'vitality',amount:10}];
  box.innerHTML=items.map(rewardRowHTML).join('');
}
function addRewardRow(){
  const box=document.getElementById('activityResultDetails');
  const tmp=document.createElement('div');
  tmp.innerHTML=rewardRowHTML({type:'vitality',amount:10});
  box.appendChild(tmp.firstChild);
  updateActivitySummary();
  updateCondPreview();
}
function removeRewardRow(btn){
  btn.closest('.reward-row').remove();
  updateActivitySummary();
  updateCondPreview();
}
function rrTypeChanged(sel){
  const row=sel.closest('.reward-row');
  const dom=row.querySelector('.rr-domain');
  const task=row.querySelector('.rr-task');
  const cap=row.querySelector('.rr-cap');
  const amt=row.querySelector('.rr-amount');
  const ent=row.querySelector('.rr-entity');
  const idle=row.querySelector('.rr-idle');
  const m=sel.value;
  const isArchive=(m==='archive');
  task.style.display=(m==='vitality')?'':'none';
  dom.style.display=(m==='progress')?'':'none';
  cap.style.display=(m==='card')?'':'none';
  if(amt)amt.style.display=isArchive?'none':'';
  if(ent)ent.style.display=isArchive?'':'none';
  if(idle)idle.style.display=isArchive?'':'none';
  updateCondPreview();
}
function validateDomain(id){return state.domains.some(d=>d.id===id)?id:'d_default'}
function handleActivitySave(){
  const id=document.getElementById('activityId').value;
  const name=document.getElementById('activityName').value.trim();
  if(!name){toast('请输入活动名称','err');return}
  const period=document.getElementById('activityPeriod').value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  const condition=condDraft;
  const rewardItems=readRewardItems();
  const result={items:rewardItems};
  if(!rewardItems.length){toast('请至少添加一个有效的奖励或结构操作项','err');return}
  if(id){
    const idx=state.activities.findIndex(x=>x.id===id);
    if(idx<0){toast('活动不存在','err');return}
    const prev=state.activities[idx];
    state.activities[idx]={id:id,name:name,enabled:prev.enabled,period:period,anchor:anchor,condition:condition,result:result,lastRun:prev.lastRun};
  }else{
    state.activities.push({id:uid(),name:name,enabled:true,period:period,anchor:anchor,condition:condition,result:result,lastRun:null});
  }
  closeModal('activityModal');
  processActivities(true);
  commit(id?'活动已更新':'活动已创建');
}
function toggleActivity(id,enabled){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  a.enabled=enabled;
  processActivities(true);
  commit(enabled?'活动已开始运行':'活动已停止');
}
let pendingDeleteActivityId=null;
function askDelActivity(id){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  pendingDeleteActivityId=id;
  document.getElementById('activityDeleteMsg').innerHTML='活动「'+esc(a.name)+'」将被删除。<br><span style="color:var(--text-3);font-size:11px">「撤销历史获得」会回收该活动已发放的活力点 / 进度值 / 成果点与豁免卡。</span>';
  openModal('activityDeleteModal');
}
function askDelActivityFromModal(){
  const id=document.getElementById('activityId').value;
  closeModal('activityModal');
  askDelActivity(id);
}
function doDeleteActivity(revoke){
  const id=pendingDeleteActivityId;
  pendingDeleteActivityId=null;
  closeModal('activityDeleteModal');
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  if(revoke)revokeActivityGrants(id);
  state.activities=state.activities.filter(x=>x.id!==id);
  commit(revoke?'活动已删除，历史获得已撤销':'活动已删除');
}
function revokeActivityGrants(actId){
  const logs=state.logs.filter(l=>l.actId===actId);
  let cardUndo=0;
  const txr=Ledger.txn(function(){
    logs.forEach(function(l){
      if(l.src==='reward'){
        const amt=Number(l.amt)||0;
        if(l.st==='vitality')Ledger.post({op:'spend',account:'vitality',delta:-amt,visible:false,reason:{src:'activity-revoke'}});
        else if(l.st==='achievement')Ledger.post({op:'spend',account:'achievement',delta:-amt,visible:false,reason:{src:'activity-revoke'}});
        else if(l.st==='progress'){
          // 按发放时落盘的分配明细逐领域全额退回；旧流水无明细时回退到单一领域
          if(Array.isArray(l.splits)&&l.splits.length){
            l.splits.forEach(function(sp){
              const did=sp.dom||'d_default';
              Ledger.post({op:'spend',account:'progress:'+did,delta:-(Number(sp.amt)||0),visible:false,reason:{src:'activity-revoke',dom:did}});
            });
          }else{
            const did=l.dom||'d_default';
            Ledger.post({op:'spend',account:'progress:'+did,delta:-amt,visible:false,reason:{src:'activity-revoke',dom:did}});
          }
        }
      }else if(l.src==='card-grant'){
        cardUndo+=(typeof l.granted==='number'?l.granted:parseCardGrantAmt(l.desc));
      }
    });
    if(cardUndo>0){
      const cur=state.cards.exemption||0;
      Ledger.post({op:'adjust',account:'card:exemption',target:Math.max(0,cur-cardUndo),visible:false,reason:{src:'activity-revoke'}});
    }
    // 删除已回收流水：奖励记录不存在即代表已撤销，重复调用不会二次退款
    Ledger.removeLogs(function(l){return l.actId!==actId;});
  },{label:'activity-revoke',save:'none',render:false});
  return txr.ok;
}
function parseCardGrantAmt(desc){
  const m=/(\d+)\s*张/.exec(desc||'');return m?parseInt(m[1],10):0;
}
function renderExemptPanel(){
  const box=document.getElementById('exemptUsePanel');
  if(!box)return;
  const cards=state.cards.exemption||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const todayStart=dayStart(now());
  const eligible=state.tasks.filter(t=>{
    if(t.archived)return false;
    const checkedToday=taskCheckedToday(t);
    const exemptToday=!!(t.lastExempt&&t.lastExempt>=todayStart);
    return !checkedToday&&!exemptToday;
  });
  const selOpts=eligible.map(t=>{
    const lastEff=effectiveLastTs(t);
    let gapDays=0;
    if(lastEff)gapDays=dayDiff(todayStart,lastEff);
    const label=t.name+(gapDays>=2?'  ·  已断更'+(gapDays-1)+'天':'');
    return '<option value="'+t.id+'">'+esc(label)+'</option>';
  }).join('');
  const canUse=ruleEnabled&&cards>0&&eligible.length>0;
  box.innerHTML=
    '<div class="act-head"><div class="act-name">断更豁免卡 <span class="badge">剩余 '+cards+' 张</span></div></div>'
    +(ruleEnabled?'':'<div class="sec-note" style="color:var(--danger)">当前没有「发放豁免卡」的运行中活动，请先在上方新建并启用一个奖励豁免卡的周期活动。</div>')
    +(ruleEnabled&&cards<=0?'<div class="sec-note">暂无可用豁免卡，待周期结算自动发放后即可使用。</div>':'')
    +'<div class="reward-row" style="margin-top:10px">'
    +'<select id="exemptTaskSel" style="flex:1">'+(selOpts||'<option value="">暂无可豁免任务</option>')+'</select>'
    +'<button class="btn btn-sm btn-exempt" style="width:auto" onclick="useExemptionFromSel()" '+(canUse?'':'disabled')+'>使用豁免</button>'
    +'</div>'
    +'<div class="sec-note">事前「请假」：今天不打卡仍延续连胜利率；事后「补救」：已断更则清零待扣债。使用不消耗活力、不增加进度。</div>';
}
function useExemptionFromSel(){
  const sel=document.getElementById('exemptTaskSel');
  if(!sel||!sel.value){toast('请先选择要豁免的任务','warn');return;}
  useExemption(sel.value);
}
function renderCycle(){
  const acts=state.activities||[];
  const total=acts.length;
  const enabledActs=acts.filter(a=>a.enabled);
  const bal=state.cards.exemption||0;

  const cardGrants=enabledActs.flatMap(a=>(a.result&&a.result.items||[]).filter(it=>it.type==='card'));
  const cardTotal=cardGrants.reduce((s,it)=>s+(it.amount||0),0);
  const cardCap=cardGrants.length?Math.max.apply(null,cardGrants.map(it=>it.cap||1)):0;
  document.getElementById('cyCardBal').textContent=bal;
  document.getElementById('cyCardSub').textContent=cardGrants.length?('每周期发放 '+cardTotal+' 张'+(cardCap?' · 上限 '+cardCap:'')):'未配置豁免卡活动';

  document.getElementById('cyGranted').textContent=enabledActs.length;
  document.getElementById('cyGrantedSub').textContent='共 '+total+' 个活动'+(enabledActs.length<total?' · 停用 '+(total-enabledActs.length)+' 个':'  ·  全部运行中');

  let next=null;const nextActs=[];
  enabledActs.forEach(a=>{
    const t=cycleNextGrant(a);
    if(t===null)return;
    if(next===null||t<next){next=t;nextActs.length=0;nextActs.push(a);}
    else if(t===next)nextActs.push(a);
  });
  document.getElementById('cyNext').textContent=next!==null?fmtDate(next):'—';
  const nextSub=document.getElementById('cyNextSub');
  nextSub.textContent=next!==null?(nextActs.length===1?('结算「'+nextActs[0].name+'」'):('将结算 '+nextActs.length+' 个活动')):'无运行中的活动';

  const box=document.getElementById('cycleActivities');
  if(!acts.length){
    box.innerHTML='<div class="empty"><p>尚未创建周期活动</p><button class="btn btn-sm" onclick="openActivityModal()">新建活动</button></div>';
  }else{
    box.innerHTML=acts.map(a=>{
      const stateTxt=a.enabled?'运行中':'已停用';
      const stateColor=a.enabled?'var(--progress)':'var(--text-3)';
      return '<div class="rule-card">'
        +'<div class="act-head">'
        +'<div class="act-name">'+esc(a.name)+' <span class="badge">'+periodLabel(a.period)+'</span>'
        +'<span style="font-size:10px;color:'+stateColor+'">'+stateTxt+'</span></div>'
        +'<div class="act-ctrls">'
        +'<label class="switch" title="运行／停止" onclick="event.stopPropagation()"><input type="checkbox" '+(a.enabled?'checked':'')+' onchange="toggleActivity(\''+a.id+'\',this.checked)"><span class="slider"></span></label>'
        +'<span class="act-switch-lbl">'+(a.enabled?'运行':'停止')+'</span>'
        +'<button class="btn btn-sm" onclick="openActivityModal(\''+a.id+'\')">编辑详情</button>'
        +'</div>'
        +'</div>'
        +'<div class="act-meta">'+actMetaLabel(a)+'</div>'
        +'</div>';
    }).join('');
  }

  renderExemptPanel();
}

export function setCondDraft(v){condDraft=v;}

export { condDraft, condDraftUI, condPanel, countCondLeaves, condListAt, condNodeAt, condMetricChipText, condItemRow, condGroupInnerHTML, condGroupHTML, renderCondNodes, renderCondTree, setCondDraftContext, resetCondDraftUI, addCondItem, addCondGroup, removeCondNode, changeGroupMode, onCondModeChange, getCondPanelEl, positionCondPanel, renderCondPanel, openCondMetricPanel, openCondOpPanel, pickCondRange, confirmCondDays, pickCondMetric, pickCondTargetType, pickCondNewFilter, pickCondDomain, pickCondTask, pickCondMilestone, pickCondBudgetCat, pickCondAggregate, commitCondValue, commitCondOp, closeCondPanel, editCondValue, rewardRowHTML, renderActivityResultDetails, addRewardRow, removeRewardRow, rrTypeChanged, validateDomain, handleActivitySave, toggleActivity, pendingDeleteActivityId, askDelActivity, askDelActivityFromModal, doDeleteActivity, revokeActivityGrants, parseCardGrantAmt, renderExemptPanel, useExemptionFromSel, renderCycle };

registerRenderer('cycle', renderCycle);
