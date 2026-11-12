import { openModal, closeModal } from './modal-host.js';
import { BudgetEngine } from './budget.js';
import { budgetBindingHTML, budgetBindingModeChange, readBudgetBinding } from './budget-binding.js';
import { gateConditionOf, normalizeCondition } from './cond-model.js';
import { condDraft, renderCondTree, setCondDraft, setCondDraftContext } from './cond-ui.js';
import { evalNode } from './conditions.js';
import { COND_METRIC_KEYS, STAGE_NAMES } from './constants.js';
import { defaultProductGate } from './defaults.js';
import { gateFailReasons, validProductTier } from './gate.js';
import { delAch, delProd, delTask, fillShopCatSelect, pendingTaskSave, productGateContext, saveAchData, saveProdData, saveTaskData } from './library.js';
import { normalizeProductGate } from './normalize.js';
import { round4, round2, stageRewards, taskIsStaged, esc, escAttr, fmt, getTaskDomainIds, taskScoreTypes } from './pure.js';
import { fillCollectionSelect, fillDomainChecklist, fillDomainSelect, getCheckedDomainIds } from './shell.js';
import { render } from './render.js';
import { saveStagePresets, stagePresets, state } from './state.js';
import { toast } from './toast.js';
import { domainName } from './utils.js';
// modals.js —— 各类弹窗（任务/成就/商品/指标/活动/项目/阶段奖励/门槛）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let editTypes=['vitality'];
let editStage={enabled:false,v:[],p:[],dirtyV:false,dirtyP:false,last:0};
// ===== Modals =====

function openTaskModal(id,presetCollId){
  const title=document.getElementById('taskModalTitle');
  document.getElementById('taskId').value='';
  fillCollectionSelect(document.getElementById('taskCollection'),presetCollId||'c_default');
  fillDomainChecklist(document.getElementById('taskDomainList'),['d_default']);
  if(id){
    const t=state.tasks.find(x=>x.id===id);
    if(!t)return;
    title.textContent='编辑任务';
    document.getElementById('taskId').value=id;
    document.getElementById('taskName').value=t.name;
    document.getElementById('taskDesc').value=t.description||'';
    document.getElementById('taskInitial').value=t.initialValue;
    document.getElementById('taskInterest').value=t.interestRate;
    document.getElementById('taskDebt').value=t.debtRate;
    document.getElementById('taskCost').value=t.vitalityCost||0;
    fillCollectionSelect(document.getElementById('taskCollection'),t.collectionId||'c_default');
    fillDomainChecklist(document.getElementById('taskDomainList'),getTaskDomainIds(t));
    editTypes=taskScoreTypes(t).slice();
    applyScoreTypePicks();
    // Always offer recalculation when editing; hint reflects whether history exists
    const hasHistory=(t.checkInCount||0)>0||state.logs.some(l=>l.src==='checkin'&&l.taskId===t.id);
    document.getElementById('recalcFG').style.display='block';
    document.getElementById('recalcHint').textContent=hasHistory?('用新参数重放全部 '+(t.checkInCount||0)+' 次打卡记录'):'该任务暂无打卡历史';
    document.getElementById('taskRecalc').checked=false;
  }else{
    title.textContent='新建任务';
    document.getElementById('taskName').value='';
    document.getElementById('taskDesc').value='';
    document.getElementById('taskInitial').value=10;
    document.getElementById('taskInterest').value=10;
    document.getElementById('taskDebt').value=5;
    document.getElementById('taskCost').value=0;
    editTypes=['vitality'];
    applyScoreTypePicks();
    document.getElementById('recalcFG').style.display='none';
  }
  // 初始化阶段奖励编辑状态
  const taskForStage=id?state.tasks.find(x=>x.id===id):null;
  const sr=taskForStage&&taskForStage.stageRewards;
  editStage={enabled:!!sr,v:Array.isArray(sr&&sr.v)?sr.v.slice():[],p:Array.isArray(sr&&sr.p)?sr.p.slice():[],dirtyV:false,dirtyP:false,last:(sr&&typeof sr.last==='number')?sr.last:0};
  const stageCb=document.getElementById('taskStageEnabled');
  if(stageCb)stageCb.checked=editStage.enabled;
  if(editStage.enabled){const rf=document.getElementById('recalcFG');if(rf)rf.style.display='none';}
  renderStageRows();
  refreshTaskSliders();
  setTaskAccordion('accTaskType',true);
  setTaskAccordion('accTaskNum',false);
  setTaskAccordion('accTaskMeta',false);
  setTaskAccordion('accTaskStage',false);
  updateTaskAccSummaries();
  const budBox=document.getElementById('taskBudgetBind');
  if(budBox)budBox.innerHTML=budgetBindingHTML('task',taskForStage);
  if(budBox)budgetBindingModeChange('task');
  openModal('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}

// ===== 任务弹窗：数值滑动条 + 分区摘要 =====
const TASK_SLIDERS={taskInitial:{min:0,max:100},taskInterest:{min:0,max:50},taskDebt:{min:0,max:50},taskCost:{min:0,max:100}};
function refreshTaskSliders(){
  document.querySelectorAll('.slide-track').forEach(function(track){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    const v=Math.max(r.min,Math.min(r.max,Number(input.value)||0));
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(((v-r.min)/(r.max-r.min))*100)+'%';
  });
}
function bindTaskSliders(){
  let cur=null;
  function setFromX(track,clientX){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const rect=track.getBoundingClientRect();
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    let ratio=(clientX-rect.left)/rect.width;
    ratio=Math.max(0,Math.min(1,ratio));
    let v=r.min+ratio*(r.max-r.min);
    v=Math.round(v*10)/10;
    v=Math.max(r.min,Math.min(r.max,v));
    input.value=v;
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(ratio*100)+'%';
  }
  document.querySelectorAll('.slide-track').forEach(function(track){
    track.addEventListener('pointerdown',function(e){
      cur=track;
      if(track.setPointerCapture){try{track.setPointerCapture(e.pointerId);}catch(err){}}
      setFromX(track,e.clientX);
    });
    track.addEventListener('pointermove',function(e){
      if(cur===track)setFromX(track,e.clientX);
    });
    track.addEventListener('pointerup',function(){cur=null;});
    track.addEventListener('pointercancel',function(){cur=null;});
  });
  document.addEventListener('input',function(e){
    const id=e.target&&e.target.id;
    if(id&&TASK_SLIDERS[id]){refreshTaskSliders();updateTaskAccSummaries();}
  });
  const collSel=document.getElementById('taskCollection');
  if(collSel)collSel.addEventListener('change',updateTaskAccSummaries);
}
function updateTaskAccSummaries(){
  const tsEl=document.getElementById('accTaskTypeSum');
  if(tsEl){
    const v=editTypes.indexOf('vitality')>=0,p=editTypes.indexOf('progress')>=0;
    let s=(v&&p)?'活力+进度':(p?'进度值':'活力点');
    try{
      if(p){const ds=getCheckedDomainIds();s+=' · '+ds.map(domainName).join('、');}
    }catch(err){}
    tsEl.textContent=s;
  }
  const numEl=document.getElementById('accTaskNumSum');
  if(numEl){
    const g=function(id){const el=document.getElementById(id);return el?el.value:'';};
    numEl.textContent='初始'+g('taskInitial')+' · 利率'+g('taskInterest')+'% · 债率'+g('taskDebt')+'% · 花'+g('taskCost');
  }
  const metaEl=document.getElementById('accTaskMetaSum');
  if(metaEl){
    const sel=document.getElementById('taskCollection');
    metaEl.textContent=(sel&&sel.selectedOptions&&sel.selectedOptions.length)?sel.selectedOptions[0].text:'';
  }
  const stageEl=document.getElementById('accTaskStageSum');
  if(stageEl){
    stageEl.textContent=editStage.enabled?'5 档':'未配置';
  }
}
function setTaskAccordion(id,open){
  const el=document.getElementById(id);
  if(el)el.classList.toggle('open',open);
}

function applyScoreTypePicks(){
  document.getElementById('tpV').classList.toggle('sel',editTypes.indexOf('vitality')>=0);
  document.getElementById('tpP').classList.toggle('sel',editTypes.indexOf('progress')>=0);
  document.getElementById('domainFG').style.display=editTypes.indexOf('progress')>=0?'block':'none';
  renderStageRows();
  updateTaskAccSummaries();
}
function toggleScoreType(type){
  const i=editTypes.indexOf(type);
  if(i>=0){
    if(editTypes.length===1){toast('至少选择一种分值类型','warn');return;}
    editTypes.splice(i,1);
  }else{
    editTypes.push(type);
  }
  applyScoreTypePicks();
}

// ===== 阶段奖励：编辑界面 =====
function onStageEnabled(){
  const cb=document.getElementById('taskStageEnabled');
  editStage.enabled=!!cb.checked;
  if(editStage.enabled){
    const base=parseFloat(document.getElementById('taskInitial').value)||0;
    if(!Array.isArray(editStage.v)||editStage.v.length!==5)editStage.v=[base,base,base,base,base];
    if(!Array.isArray(editStage.p)||editStage.p.length!==5)editStage.p=[base,base,base,base,base];
    editStage.dirtyV=false;editStage.dirtyP=false;
  }
  renderStageRows();
  updateTaskAccSummaries();
}
function onStageInput(type){
  if(type==='vitality')editStage.dirtyV=true;else editStage.dirtyP=true;
  updateTaskAccSummaries();
}
function stageRowHTML(type,label){
  const vals=type==='vitality'?editStage.v:editStage.p;
  const inputs=STAGE_NAMES.map((n,i)=>
    '<div class="stage-cell"><span class="stage-cell-name">'+n+'</span>'
    +'<input type="number" id="stage_'+type+'_'+i+'" value="'+((vals[i]!==undefined&&vals[i]!==null)?vals[i]:'')+'" step="0.1" min="0" oninput="onStageInput(\''+type+'\')"></div>'
  ).join('');
  return '<div class="stage-row">'
    +'<div class="stage-row-head"><span class="stage-row-title">'+label+'</span>'
    +'<div class="sp-group">'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'arith\',\''+type+'\')">等差</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'arith\',\''+type+'\')">▾</button></div>'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'decr\',\''+type+'\')">缓增</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'decr\',\''+type+'\')">▾</button></div>'
    +'</div></div>'
    +'<div class="stage-inputs">'+inputs+'</div>'
    +'<div class="sp-panel" id="sp_panel_'+type+'" style="display:none"></div>'
    +'</div>';
}
function renderStageRows(){
  const cont=document.getElementById('taskStageRows');
  if(!cont)return;
  if(!editStage.enabled){cont.innerHTML='';return;}
  const hasV=editTypes.indexOf('vitality')>=0;
  const hasP=editTypes.indexOf('progress')>=0;
  let html='';
  if(hasV)html+=stageRowHTML('vitality','活力点');
  if(hasP)html+=stageRowHTML('progress','进度值');
  cont.innerHTML=html;
}
function toggleStageParam(kind,type){
  const panel=document.getElementById('sp_panel_'+type);
  if(!panel)return;
  const showing=panel.style.display!=='none'&&panel.dataset.kind===kind;
  if(kind==='arith'){
    panel.innerHTML='<div class="sp-param"><label>步长 %</label><input type="number" id="sp_arith_step" value="'+stagePresets.stepPct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'arith\',\''+type+'\')">生成</button>';
    panel.dataset.kind='arith';
  }else{
    panel.innerHTML='<div class="sp-param"><label>总增幅 %</label><input type="number" id="sp_decr_gain" value="'+stagePresets.decreasePct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'decr\',\''+type+'\')">生成</button>';
    panel.dataset.kind='decr';
  }
  panel.style.display=showing?'none':'block';
}
function applyStagePreset(kind,type){
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function runStagePreset(kind,type){
  if(kind==='arith'){
    stagePresets.stepPct=Number(document.getElementById('sp_arith_step').value)||0;
  }else{
    stagePresets.decreasePct=Number(document.getElementById('sp_decr_gain').value)||0;
  }
  saveStagePresets();
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function generateStage(kind,type,params){
  const isV=(type==='vitality');
  let hasVals=false;
  for(let i=0;i<5;i++){const el=document.getElementById('stage_'+type+'_'+i);if(el&&el.value!==''){hasVals=true;break;}}
  if(hasVals&&!window.confirm('这会覆盖当前的 5 个数值，继续吗？'))return;
  const base=parseFloat(document.getElementById('taskInitial').value)||0;
  const vals=kind==='arith'?genArith(base,params.stepPct):genDecr(base,params.decreasePct);
  if(isV){editStage.v=vals;editStage.dirtyV=false;}else{editStage.p=vals;editStage.dirtyP=false;}
  for(let i=0;i<5;i++){
    const el=document.getElementById('stage_'+type+'_'+i);
    if(el)el.value=fmt(vals[i]);
  }
  updateTaskAccSummaries();
}
function genArith(base,stepPct){
  const step=Math.max(0,Number(stepPct)||0)/100;
  return STAGE_NAMES.map((_,n)=>round2(base*(1+step*n)));
}
function genDecr(base,gainPct){
  const total=base*Math.max(0,Number(gainPct)||0)/100;
  const r=0.5,sum=1+r+r*r+r*r*r;
  const d1=total/sum;
  const vals=[round2(base)];
  for(let k=1;k<5;k++){
    let inc=0;
    for(let i=0;i<k;i++)inc+=d1*Math.pow(r,i);
    vals.push(round2(base+inc));
  }
  return vals;
}

function handleTaskSave(){
  const id=document.getElementById('taskId').value;
  const name=document.getElementById('taskName').value.trim();
  const description=document.getElementById('taskDesc').value.trim();
  const initialValue=parseFloat(document.getElementById('taskInitial').value);
  const interestRate=parseFloat(document.getElementById('taskInterest').value);
  const debtRate=parseFloat(document.getElementById('taskDebt').value);
  const vitalityCost=parseFloat(document.getElementById('taskCost').value);
  const collectionId=document.getElementById('taskCollection').value;
  const domainIds=getCheckedDomainIds();

  if(!name){toast('请输入任务名称','err');return}
  if(isNaN(initialValue)||initialValue<0){toast('初始数值需 ≥ 0','err');return}
  if(isNaN(interestRate)||interestRate<0){toast('利率需 ≥ 0','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}
  if(isNaN(vitalityCost)||vitalityCost<0){toast('活力点花费需 ≥ 0','err');return}

  // 阶段奖励
  let stageRewards=null;
  if(editStage.enabled){
    const hasV=editTypes.indexOf('vitality')>=0;
    const hasP=editTypes.indexOf('progress')>=0;
    const readRow=function(type){
      const arr=[];
      for(let i=0;i<5;i++){
        const el=document.getElementById('stage_'+type+'_'+i);
        let v=el?parseFloat(el.value):NaN;
        if(isNaN(v)||v<0)v=0;
        arr.push(round2(v));
      }
      return arr;
    };
    stageRewards={last:editStage.last!==undefined?editStage.last:0};
    if(hasV)stageRewards.v=readRow('vitality');
    if(hasP)stageRewards.p=readRow('progress');
  }

  const prevTask=id?state.tasks.find(x=>x.id===id):null;
  const wasStaged=prevTask&&taskIsStaged(prevTask);
  const recalc=id?((document.getElementById('taskRecalc').checked)&&!wasStaged&&!editStage.enabled):false;
  const saved=saveTaskData({id:id||null,name:name,description:description,scoreTypes:editTypes.slice(),domainIds:domainIds,collectionId:collectionId,initialValue:initialValue,interestRate:interestRate,debtRate:debtRate,vitalityCost:vitalityCost,stageRewards:stageRewards,recalc:recalc,budget:readBudgetBinding('task')});
  if(!saved){
    // 触发领域变更弹窗时 pendingTaskSave 有值，属于等待用户选择，不算失败
    if(!pendingTaskSave)toast('保存失败：历史数据重算未完成，参数未修改','err');
    return;
  }
  closeModal('taskModal');
  toast(id?(recalc?'任务已更新，历史数据已重算':'任务已更新'):'任务已创建');
  render();
}

function openAchModal(id,presetDomId){
  const title=document.getElementById('achModalTitle');
  document.getElementById('achId').value='';
  fillDomainSelect(document.getElementById('achDomain'),presetDomId||'d_default');
  if(id){
    const a=state.achievements.find(x=>x.id===id);
    if(!a)return;
    title.textContent='编辑里程碑';
    document.getElementById('achId').value=id;
    document.getElementById('achName').value=a.name;
    document.getElementById('achThreshold').value=a.threshold;
    document.getElementById('achPoints').value=a.points;
    fillDomainSelect(document.getElementById('achDomain'),a.domainId);
  }else{
    title.textContent='新建里程碑';
    document.getElementById('achName').value='';
    document.getElementById('achThreshold').value=100;
    document.getElementById('achPoints').value=1;
  }
  openModal('achModal');
  setTimeout(()=>document.getElementById('achName').focus(),50);
}

function handleAchSave(){
  const id=document.getElementById('achId').value;
  const name=document.getElementById('achName').value.trim();
  const threshold=parseFloat(document.getElementById('achThreshold').value);
  const points=parseFloat(document.getElementById('achPoints').value);
  const domainId=document.getElementById('achDomain').value;

  if(!name){toast('请输入里程碑名称','err');return}
  if(isNaN(threshold)||threshold<0){toast('门槛需 ≥ 0','err');return}
  if(isNaN(points)||points<=0){toast('成果点需 > 0','err');return}

  saveAchData({id:id||null,name:name,domainId:domainId,threshold:threshold,points:points});
  closeModal('achModal');
  toast(id?'里程碑已更新':'里程碑已设定');
  render();
}

// ===== 商品门槛编辑器（通用条件树）=====
// 条件树与周期活动共用 condDraft / renderCondTree / evalNode，不另起一套求值器。
function onProdGateModeChange(){
  const sel=document.getElementById('prodGateMode');
  condDraft.mode=sel&&sel.value==='any'?'any':'all';
  renderCondTree();
}
function updateProdTierHint(tier){
  const t=tier||validProductTier((document.getElementById('prodTier')||{}).value);
  const hint=document.getElementById('prodTierHint');
  if(!hint)return;
  hint.textContent=t==='daily'
    ?'支付币种：活力点 · 无门槛'
    :t==='quality'
      ?'支付币种：成果点 · 需满足下方门槛条件'
      :'支付币种：成果点 · 需满足下方门槛条件（专属级通常绑定里程碑）';
}
// 配置时即时预览：当前状态下条件是否满足，以及失败的具体条目
function prodGatePreviewFn(el){
  const tier=validProductTier((document.getElementById('prodTier')||{}).value);
  if(tier==='daily'){el.innerHTML='';return;}
  const node={group:true,mode:condDraft.mode==='any'?'any':'all',items:condDraft.items||[]};
  if(!(condDraft.items||[]).length){
    el.innerHTML='<span class="cp-badge">预览</span>未设置门槛条件：所有用户均可购买。';
    return;
  }
  const act={period:'week'};
  const ts=Date.now();
  const ok=evalNode(node,act,ts);
  const reasons=ok?[]:gateFailReasons(node,act,ts);
  el.innerHTML='<span class="cp-badge">预览</span>'+esc(ok?'按当前状态，条件已满足，可购买。':('按当前状态，条件未满足：'+reasons.join('；')));
}
// 门槛条件校验：引用必须存在，数值必须有限；空条件代表“无门槛”
function validateGateCondition(cond){
  const walk=function(items){
    for(let i=0;i<(items||[]).length;i++){
      const n=items[i];
      if(n&&n.group){
        const err=walk(n.items);
        if(err)return err;
        continue;
      }
      if(!n||COND_METRIC_KEYS.indexOf(n.metric)<0)return '存在无效的门槛指标';
      if(!isFinite(Number(n.value)))return '门槛数值不合法';
      if(n.metric==='milestone_unlocked'){
        if(!n.target||!state.achievements.some(function(a){return a.id===n.target;}))return '请为「里程碑已解锁」选择里程碑';
      }else if(n.metric==='budget_remaining'){
        const c=n.target?BudgetEngine.category(n.target):null;
        if(!c||c.archived)return '请为「预算剩余」选择有效的预算分类';
      }else if(n.metric==='domain_activity'){
        if(!n.target||!state.domains.some(function(d){return d.id===n.target;}))return '请为「领域活跃次数」选择领域';
      }
    }
    return null;
  };
  return walk(cond&&cond.items);
}
// 把能无损表达的叶子同步回三段式字段，保证旧导出/旧读取路径仍可解释
function syncLegacyGateFields(gate,cond){
  const g=gate||defaultProductGate();
  g.minLifetime=0;
  g.activity={domainId:'',days:0,times:0};
  g.milestoneId='';
  if(!cond||cond.mode!=='all')return g;
  (cond.items||[]).forEach(function(n){
    if(!n||n.group)return;
    if(n.metric==='lifetime_achievement')g.minLifetime=Math.max(0,Math.round(Number(n.value)||0));
    else if(n.metric==='domain_activity'&&n.targetType==='domain'&&n.target&&n.range==='recent'){
      g.activity={domainId:n.target,days:Math.max(1,Math.round(Number(n.days)||7)),times:Math.max(0,Math.round(Number(n.value)||0))};
    }else if(n.metric==='milestone_unlocked'&&n.targetType==='milestone'&&n.target)g.milestoneId=n.target;
  });
  return g;
}
function renderProdGateEditor(gate,tier){
  setCondDraft(gateConditionOf(gate,tier));
  const modeSel=document.getElementById('prodGateMode');
  if(modeSel)modeSel.value=condDraft.mode==='any'?'any':'all';
  setCondDraftContext(condDraft,'prodGateCondItems','prodGatePreview',prodGatePreviewFn,function(){updateProdTierHint(tier);});
  renderCondTree();
}

function onProdTierChange(){
  const sel=document.getElementById('prodTier');
  const tier=validProductTier(sel?sel.value:'daily');
  const box=document.getElementById('prodGateBox');
  if(box)box.style.display=tier==='daily'?'none':'block';
  updateProdTierHint(tier);
  if(tier!=='daily')prodGatePreviewFn(document.getElementById('prodGatePreview')||{innerHTML:''});
}

function openProdModal(id,presetCatId){
  const title=document.getElementById('prodModalTitle');
  document.getElementById('prodId').value='';
  fillShopCatSelect(document.getElementById('prodCategory'),presetCatId||'sc_default');
  document.getElementById('prodTier').value='daily';
  let gate=defaultProductGate();
  if(id){
    const p=state.products.find(x=>x.id===id);
    if(!p)return;
    title.textContent='编辑商品';
    document.getElementById('prodId').value=id;
    document.getElementById('prodName').value=p.name;
    document.getElementById('prodDesc').value=p.desc||'';
    document.getElementById('prodPrice').value=p.price;
    document.getElementById('prodStock').value=p.stock;
    document.getElementById('prodDebtRate').value=p.debtRate||0;
    fillShopCatSelect(document.getElementById('prodCategory'),p.categoryId||'sc_default');
    document.getElementById('prodTier').value=validProductTier(p.tier);
    gate=normalizeProductGate(p.gate,productGateContext());
    const bp=(p.budget&&p.budget.categoryId)?p.budget:{categoryId:'',amount:0};
    fillProdBudgetSelect(bp.categoryId);
    document.getElementById('prodBudgetAmount').value=bp.amount||0;
  }else{
    title.textContent='上架商品';
    document.getElementById('prodName').value='';
    document.getElementById('prodDesc').value='';
    document.getElementById('prodPrice').value=10;
    document.getElementById('prodStock').value=-1;
    document.getElementById('prodDebtRate').value=0;
    fillProdBudgetSelect('');
    document.getElementById('prodBudgetAmount').value=0;
  }
  renderProdGateEditor(gate,validProductTier(document.getElementById('prodTier').value));
  onProdBudgetChange();
  onProdTierChange();
  openModal('prodModal');
  setTimeout(()=>document.getElementById('prodName').focus(),50);
}

// 商品「现实预算联动」：未绑定分类时整组收起，绑定后才显示金额
function fillProdBudgetSelect(selected){
  const sel=document.getElementById('prodBudgetCategory');
  if(!sel)return;
  const cats=BudgetEngine.categories();
  sel.innerHTML='<option value="">不绑定现实预算</option>'+cats.map(function(c){
    return '<option value="'+escAttr(c.id)+'"'+(c.id===selected?' selected':'')+'>'+esc(c.name)+(c.enabled?'':'（已停用）')+(c.archived?'（已归档）':'')+'</option>';
  }).join('');
  if(selected&&cats.some(function(c){return c.id===selected;}))sel.value=selected;
  else sel.value='';
}
function onProdBudgetChange(){
  const sel=document.getElementById('prodBudgetCategory');
  const fg=document.getElementById('prodBudgetAmountFG');
  const cat=sel&&sel.value?BudgetEngine.category(sel.value):null;
  if(fg)fg.style.display=cat?'':'none';
  const amt=document.getElementById('prodBudgetAmount');
  if(!cat&&amt)amt.value=0;
}

function handleProdSave(){
  const id=document.getElementById('prodId').value;
  const name=document.getElementById('prodName').value.trim();
  const desc=document.getElementById('prodDesc').value.trim();
  const price=parseFloat(document.getElementById('prodPrice').value);
  const stock=parseInt(document.getElementById('prodStock').value,10);
  const debtRate=parseFloat(document.getElementById('prodDebtRate').value);
  const categoryId=document.getElementById('prodCategory').value;
  const tier=validProductTier(document.getElementById('prodTier').value);

  if(!name){toast('请输入商品名称','err');return}
  if(isNaN(price)||price<0.1){toast('价格需 ≥ 0.1','err');return}
  if(isNaN(stock)||stock<-1){toast('库存需 ≥ -1','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}

  let gate=defaultProductGate();
  if(tier!=='daily'){
    const cond=normalizeCondition({mode:condDraft.mode,items:condDraft.items});
    const condErr=validateGateCondition(cond);
    if(condErr){toast(condErr,'err');return;}
    gate.condition=cond;
    syncLegacyGateFields(gate,cond);
  }

  // 现实预算联动：绑定分类时金额必须 > 0，且分类需存在/启用/未归档
  let budget={categoryId:'',amount:0};
  const budSel=document.getElementById('prodBudgetCategory');
  const budCatId=budSel?budSel.value:'';
  if(budCatId){
    const budCat=BudgetEngine.category(budCatId);
    if(!budCat||!budCat.enabled||budCat.archived){toast('绑定的预算分类不可用，请重新选择','err');return}
    const budAmt=parseFloat(document.getElementById('prodBudgetAmount').value);
    if(isNaN(budAmt)||budAmt<=0){toast('绑定预算后，现实金额需大于 0','err');return}
    budget={categoryId:budCatId,amount:round4(budAmt)};
  }

  saveProdData({id:id||null,name:name,desc:desc,price:price,stock:stock,debtRate:debtRate,categoryId:categoryId,tier:tier,gate:gate,budget:budget});
  closeModal('prodModal');
  toast(id?'商品已更新':'商品已上架');
  render();
}

function confirmDelTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(t&&confirm('删除任务「'+t.name+'」？\n（已获得的积分不会消失，可在银行流水撤销此操作）')){delTask(id);toast('任务已删除');render()}
}
function confirmDelAch(id){
  const a=state.achievements.find(x=>x.id===id);
  if(a&&confirm('删除里程碑「'+a.name+'」？\n（已获得的成果点不会消失，可在银行流水撤销此操作）')){delAch(id);toast('里程碑已删除');render()}
}
function confirmDelProd(id){
  const p=state.products.find(x=>x.id===id);
  if(p&&confirm('删除商品「'+p.name+'」？\n（可在银行流水撤销此操作）')){delProd(id);toast('商品已删除');render()}
}

export { editTypes, editStage, openTaskModal, TASK_SLIDERS, refreshTaskSliders, bindTaskSliders, updateTaskAccSummaries, setTaskAccordion, applyScoreTypePicks, toggleScoreType, onStageEnabled, onStageInput, stageRowHTML, renderStageRows, toggleStageParam, applyStagePreset, runStagePreset, generateStage, genArith, genDecr, handleTaskSave, openAchModal, handleAchSave, onProdGateModeChange, updateProdTierHint, prodGatePreviewFn, validateGateCondition, syncLegacyGateFields, renderProdGateEditor, onProdTierChange, openProdModal, fillProdBudgetSelect, onProdBudgetChange, handleProdSave, confirmDelTask, confirmDelAch, confirmDelProd };
