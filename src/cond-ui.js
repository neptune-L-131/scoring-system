import { BudgetEngine } from './budget.js';
import { COND_ENTITY_KINDS, COND_RANGES } from './constants.js';
import { COND_AGGREGATES, COND_METRICS, COND_NEW_FILTERS, COND_TARGET_TYPES, condNewFilterOptions, condTargetTypesFor, isChoreTagMetric, metricLabel, opLabel, rangeLabel } from './cycle.js';
import { isAssetHoldMetric, isAssetMetric, isEntityMetricFor, isEntityOnlyMetric, isEntityPointMetric, isGateMetric, isPointMetric, isStage1Metric, parseEntityTarget, esc, escAttr, fmt } from './pure.js';
import { collectChoreTags } from './chore-list.js';
import { state } from './state.js';
import { toast } from './toast.js';
// cond-ui.js —— 条件芯片编辑器与点选浮层
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let condDraft={mode:'all',items:[]};
let condDraftUI={box:'activityCondItems',previewId:'condPreview',previewFn:null,afterChange:null};
let condPanel={visible:false,kind:'metric',path:'',step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum',entityKind:''};
// 事件触发模式：条件编辑器提前禁用点态指标与「本周期」范围（与编译期拒绝保持一致）
let condEventMode=false;
export function setCondEventMode(v){condEventMode=!!v;}
export function isCondEventMode(){return condEventMode;}
// 能力开关：entity 目标只在动作流条件里可选。
// 所有入口都经过 setCondDraftContext / resetCondDraftUI，能力在这里统一复位为关闭；
// 只有动作流绑定后再显式调用 setCondEntityAllowed(true)，因此预算规则、商品/里程碑门槛
// 不需要各自写过滤逻辑，也拿不到 entity 目标。
let condAllowEntity=false;
export function setCondEntityAllowed(v){condAllowEntity=!!v;}
export function isCondEntityAllowed(){return condAllowEntity;}
export function refreshCondPanel(){
  if(condPanel&&condPanel.visible){renderCondPanel();positionCondPanel(condPanel.anchor);}
}
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
  const box=document.getElementById(condDraftUI.box||'');
  if(!box)return;
  box.innerHTML=(condDraft.items&&condDraft.items.length)?renderCondNodes(condDraft.items,'',0):'<div class="cond-empty">还没有条件，满足任意情况即触发</div>';
  updateCondPreview();
  if(condDraftUI.afterChange)condDraftUI.afterChange();
}
function setCondDraftContext(draft,box,previewId,previewFn,afterChange){
  condDraft=draft;
  condDraftUI={box:box,previewId:previewId,previewFn:previewFn||null,afterChange:afterChange||null};
  // 入口隔离：每次绑定新入口先关闭 entity 能力，动作流随后显式打开
  condAllowEntity=false;
}
function resetCondDraftUI(){
  condDraftUI={box:'',previewId:'',previewFn:null,afterChange:null};
  condAllowEntity=false;
}
// 事件模式下新增条件默认「今天」，避免一加就落在不可用的「本周期」上
function defaultCondLeaf(){return {range:condEventMode?'today':'period',metric:'checkins',op:'>=',value:1,targetType:'all'};}
function addCondItem(parentPath){condListAt(parentPath).push(defaultCondLeaf());renderCondTree();}
function addCondGroup(parentPath){condListAt(parentPath).push({group:true,mode:'all',items:[defaultCondLeaf()]});renderCondTree();}
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
    html='<div class="cp-title">时间范围</div>';
    if(condEventMode)html+='<div class="cp-note">事件触发按事件发生时刻求值：「本周期」等不到正确窗口，已禁用。</div>';
    html+='<div class="cp-opts">';
    COND_RANGES.forEach(r=>{
      const blocked=condEventMode&&r.v==='period';
      html+='<button class="cp-opt"'+(blocked?' disabled title="事件触发无法确定“本周期”的窗口"':' onclick="pickCondRange(\''+r.v+'\')"')+'>'+r.n+(blocked?'（事件不可用）':'')+'</button>';
    });
    html+='</div>';
  }else if(p.step==='days'){
    html='<div class="cp-title">最近多少天</div><div class="cp-days">'
      +'<input type="number" id="condPanelDays" value="'+p.days+'" min="1" step="1">'
      +'<button class="btn btn-sm" onclick="confirmCondDays()">确定</button></div>';
  }else if(p.step==='metric'){
    html='<div class="cp-title">指标</div>';
    if(condEventMode)html+='<div class="cp-note">事件触发不能使用点态指标（如任务闲置、周期状态）：这些值只在当前时刻快照中有意义，事件发生后无法复现。</div>';
    html+='<div class="cp-opts">';
    COND_METRICS.forEach(m=>{
      // 能力关闭的入口（预算规则 / 商品门槛）不暴露只在单实体目标下才成立的指标
      if(isEntityOnlyMetric(m.v)&&!condAllowEntity)return;
      const blocked=condEventMode&&isPointMetric(m.v);
      html+='<button class="cp-opt"'+(blocked?' disabled title="事件触发不能用点态指标"':' onclick="pickCondMetric(\''+m.v+'\')"')+'>'+m.n+(blocked?'（事件不可用）':'')+'</button>';
    });
    html+='</div>';
  }else if(p.step==='targetType'){
    const entityPointBlocked=condEventMode&&isEntityPointMetric(p.metric);
    html='<div class="cp-title">统计主体</div>';
    if(entityPointBlocked)html+='<div class="cp-note">事件触发按事件发生时刻求值，单个事项的点态指标（如项目进度值）无法稳定复现；请改用周期触发或手动执行。</div>';
    html+='<div class="cp-opts">';
    condTargetTypesFor(p.metric,condAllowEntity).forEach(tt=>{
      const n=(COND_TARGET_TYPES.find(x=>x.v===tt)||{}).n||tt;
      const blocked=entityPointBlocked&&tt==='entity';
      html+='<button class="cp-opt"'+(blocked?' disabled title="事件触发不能用单个事项的点态指标"':' onclick="pickCondTargetType(\''+tt+'\')"')+'>'+n+(blocked?'（事件不可用）':'')+'</button>';
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
  }else if(p.step==='asset'){
    html='<div class="cp-title">选择资产</div>';
    html+='<div class="cp-note">按资产余额与「可见流水＋隐形调整记录」统计；超出保留范围的旧记录不计入。停用或归档的资产仍可取值。</div>';
    html+='<div class="cp-opts">';
    (state.assetDefs||[]).forEach(a=>{
      if(!a)return;
      const tag=a.archived?'（已归档）':(a.enabled===false?'（已停用）':'');
      html+='<button class="cp-opt" onclick="pickCondAsset(\''+esc(a.id)+'\')">'+esc(a.name||a.id)+tag+'</button>';
    });
    html+='</div>';
    if(!(state.assetDefs||[]).length)html+='<div class="cp-note">还没有自定义资产</div>';
  }else if(p.step==='tag'){
    const tags=collectChoreTags(state.chores,{includeArchived:true});
    html='<div class="cp-title">选择情境</div>';
    html+='<div class="cp-note">'+(p.metric==='chore_tag_overdue'
      ?'点态指标：统计当前仍超期且带该情境的杂事；事件触发不可用。'
      :'与「杂事完成数」同一窗口口径；升级前的旧完成记录按升级时的情境归属，之后新增的情境不回溯。')+'</div>';
    html+='<div class="cp-opts">';
    tags.forEach(it=>{
      html+='<button class="cp-opt" onclick="pickCondTag(this.dataset.key)" data-key="'+escAttr(it.key)+'">'+esc(it.label)+'</button>';
    });
    html+='</div>';
    if(!tags.length)html+='<div class="cp-note">还没有任何情境。先给杂事添加情境后再回来。</div>';
  }else if(p.step==='entityKind'){
    const kinds=COND_ENTITY_KINDS.filter(k=>isEntityMetricFor(k,p.metric));
    html='<div class="cp-title">选择事项类型</div><div class="cp-opts">';
    kinds.forEach(k=>{
      html+='<button class="cp-opt" onclick="pickCondEntityKind(\''+k+'\')">'+(k==='affair'?'项目':'杂事')+'</button>';
    });
    html+='</div>';
    if(!kinds.length)html+='<div class="cp-note">当前指标不支持按单个事项统计。</div>';
  }else if(p.step==='entity'){
    const kind=p.entityKind==='chore'?'chore':'affair';
    const word=kind==='affair'?'项目':'杂事';
    const list=condEntityCandidates(kind);
    html='<div class="cp-title">选择'+word+'</div>';
    html+='<div class="cp-note">只列出未归档的'+word+'；已归档的不参与新条件选择。</div>';
    html+='<div class="cp-opts">';
    list.forEach(x=>{
      const done=kind==='affair'?!!x.doneAt:!!x.done;
      html+='<button class="cp-opt" onclick="pickCondEntity(this.dataset.ref)" data-ref="'+escAttr(kind+':'+x.id)+'">'+esc(String(x.name||x.id))+(done?'（已完成）':'')+'</button>';
    });
    html+='</div>';
    if(!list.length)html+='<div class="cp-note">还没有可选的'+word+'。</div>';
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
  const existingEnt=parseEntityTarget(it.target);
  condPanel={visible:true,kind:'metric',path:path,anchor:anchor,step:(isPointMetric(it.metric)||isAssetHoldMetric(it.metric)||(it.targetType==='entity'&&isEntityPointMetric(it.metric)))?'metric':'range',range:it.range||'period',days:it.days||7,metric:it.metric||'checkins',targetType:it.targetType||'all',newFilter:it.newFilter||'none',target:it.target||'',aggregate:it.aggregate||'sum',entityKind:(it.targetType==='entity'&&existingEnt)?existingEnt.kind:''};
  renderCondPanel();
  positionCondPanel(anchor);
}
function openCondOpPanel(path,anchor){
  condPanel={visible:true,kind:'op',path:path,anchor:anchor,step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum',entityKind:''};
  renderCondPanel();
  positionCondPanel(anchor);
}
function pickCondRange(range){
  if(condEventMode&&range==='period'){toast('事件触发不能用「本周期」范围，请改用「总计」或「最近 N 天」','warn');return;}
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
  if(condEventMode&&isPointMetric(metric)){toast('事件触发不能用点态指标：该值在事件发生时刻无法复现','warn');return;}
  condPanel.metric=metric;
  // 成果点/预算进账指标仅支持「全部 + 本周期」，直接提交
  if(metric==='achievement'||(metric.indexOf('budget_')===0&&metric!=='budget_remaining')){
    if(metric.indexOf('budget_')===0)condPanel.range='period';
    commitCondValue('all','','none','sum');return;
  }
  // 自定义资产：主体固定为某一份资产；持有数量是点态值，其余按窗口统计
  if(isAssetMetric(metric)){
    if(metric==='asset_hold')condPanel.range='today';
    condPanel.step='asset';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 情境指标：主体固定为情境，必须在「阶段 1 单主体直达」之前拦截
  if(isChoreTagMetric(metric)){
    condPanel.targetType='tag';
    if(metric==='chore_tag_overdue')condPanel.range='today';
    condPanel.step='tag';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 实体专属指标：候选集只有 entity。同样必须在「阶段 1 单主体直达」之前拦截，
  // 否则 B6 的短路会把它提交成 targetType:'all'（实体语义直接丢失）。
  if(isEntityOnlyMetric(metric)){
    if(!condAllowEntity){toast('当前入口不支持按单个事项统计','warn');return;}
    condPanel.targetType='entity';
    if(isPointMetric(metric))condPanel.range='today';
    condPanel.step='entityKind';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
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
  // 阶段 1 指标没有「新增筛选 / 聚合」概念：按主体类型直达。
  // 直达判据必须是「候选集恰为 ['all']」：只有一个非 all 候选（如 ['entity'] / ['milestone']）
  // 时绝不提交成 all，否则会重演 B6 的实体丢失。
  if(isStage1Metric(metric)){
    if(isPointMetric(metric))condPanel.range='today';
    const types=condTargetTypesFor(metric,condAllowEntity);
    if(types.length===1&&types[0]==='all'){commitCondValue('all','','none','sum');return;}
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
  // 事件模式下单个事项的点态指标没有稳定窗口：与编译期 FLOW_EVENT_POINT_METRIC 同一口径，提前拦住
  if(tt==='entity'&&condEventMode&&isEntityPointMetric(condPanel.metric)){
    toast('事件触发不能用单个事项的点态指标，请改用周期触发或手动执行','warn');
    return;
  }
  condPanel.targetType=tt;
  // entity 必须在阶段 1 的 task/domain 映射之前拦截，否则会被当成领域
  if(tt==='entity'){
    // 实体点态指标（含只在单实体下才点态的 affair_progress）统一按「今天」求值
    if(isEntityPointMetric(condPanel.metric))condPanel.range='today';
    condPanel.step='entityKind';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  if(tt==='tag'){
    condPanel.step='tag';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  if(isAssetMetric(condPanel.metric)){
    condPanel.step='asset';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
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
function pickCondAsset(id){
  commitCondValue('asset',id,'none','sum');
}
// 情境主体：target 存标签键（忽略 @ 与大小写），展示时再反查原样拼写
function pickCondTag(key){
  commitCondValue('tag',String(key==null?'':key),'none','sum');
}
// 实体候选集：项目 / 杂事，默认排除已归档（新建条件选到归档事项几乎不是本意）
function condEntityCandidates(kind){
  const list=kind==='chore'?(state.chores||[]):(state.affairs||[]);
  return list.filter(x=>x&&!x.archived);
}
// 实体主体：两步选择——先定项目/杂事，再选具体个体；target 存 'kind:id'
function pickCondEntityKind(kind){
  if(COND_ENTITY_KINDS.indexOf(kind)<0)return;
  condPanel.entityKind=kind;
  condPanel.targetType='entity';
  condPanel.step='entity';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondEntity(ref){
  const parsed=parseEntityTarget(ref);
  if(!parsed)return;
  condPanel.targetType='entity';
  commitCondValue('entity',parsed.kind+':'+parsed.id,'none','sum');
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

// 条件编辑器预览：各调用方自带预览函数（动作流 / 预算规则 / 商品门槛）
function updateCondPreview(){
  const el=document.getElementById(condDraftUI.previewId||'');
  if(!el)return;
  if(condDraftUI.previewFn)condDraftUI.previewFn(el,condDraft);
}

export function setCondDraft(v){condDraft=v;}

export { condDraft, condDraftUI, condPanel, countCondLeaves, condListAt, condNodeAt, condMetricChipText, condItemRow, condGroupInnerHTML, condGroupHTML, renderCondNodes, renderCondTree, setCondDraftContext, resetCondDraftUI, addCondItem, addCondGroup, removeCondNode, changeGroupMode, getCondPanelEl, positionCondPanel, renderCondPanel, openCondMetricPanel, openCondOpPanel, pickCondRange, confirmCondDays, pickCondMetric, pickCondTargetType, pickCondNewFilter, pickCondDomain, pickCondTask, pickCondMilestone, pickCondBudgetCat, pickCondAsset, pickCondTag, pickCondEntityKind, pickCondEntity, condEntityCandidates, pickCondAggregate, commitCondValue, commitCondOp, closeCondPanel, editCondValue };
