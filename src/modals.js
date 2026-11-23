import { openModal, closeModal } from './modal-host.js';
import { BudgetEngine } from './budget.js';
import { budgetBindingHTML, budgetBindingModeChange, readBudgetBinding } from './budget-binding.js';
import { gateConditionOf, normalizeCondition } from './cond-model.js';
import { condDraft, renderCondTree, setCondDraft, setCondDraftContext } from './cond-ui.js';
import { evalNode } from './conditions.js';
import { COND_METRIC_KEYS, PRODUCT_EXEC_MAX_PER_PERIOD, STAGE_NAMES } from './constants.js';
import { defaultProductGate } from './defaults.js';
import { gateFailReasons, validProductTier } from './gate.js';
import { describeFlowAtom } from './flow-atoms.js';
import { flowAtomLabels } from './flow-ui.js';
import { delAch, delProd, delTask, fillShopCatSelect, pendingTaskSave, productGateContext, saveAchData, saveProdData, saveTaskData } from './library.js';
import { normalizeProductGate } from './normalize.js';
import { round4, round2, stageRewards, taskIsStaged, esc, escAttr, fmt, getTaskDomainIds, taskScoreTypes, currencyOf } from './pure.js';
import { fillCollectionSelect, fillDomainChecklist, fillDomainSelect, getCheckedDomainIds } from './shell.js';
import { markModalClean, rejectFields } from './form-contract.js';
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
  setTaskAccordion('accTaskBasic',true);
  setTaskAccordion('accTaskType',true);
  setTaskAccordion('accTaskNum',false);
  setTaskAccordion('accTaskStage',false);
  updateTaskAccSummaries();
  const budBox=document.getElementById('taskBudgetBind');
  if(budBox)budBox.innerHTML=budgetBindingHTML('task',taskForStage);
  if(budBox)budgetBindingModeChange('task');
  openModal('taskModal');
  markModalClean('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}

// ===== 任务弹窗：数值滑动条 + 分区摘要 =====
const TASK_SLIDERS={taskInitial:{min:0,max:100},taskInterest:{min:0,max:50},taskDebt:{min:0,max:50},taskCost:{min:0,max:100}};
// 填充条与滑块共用同一个比例：--slide-p 驱动 CSS 里的可见 thumb
function applySliderVisual(track,ratio){
  const pct=(Math.max(0,Math.min(1,ratio))*100)+'%';
  const fill=track.querySelector('.slide-fill');
  if(fill)fill.style.width=pct;
  track.style.setProperty('--slide-p',pct);
}
function refreshTaskSliders(){
  document.querySelectorAll('.slide-track').forEach(function(track){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    const v=Math.max(r.min,Math.min(r.max,Number(input.value)||0));
    applySliderVisual(track,(v-r.min)/(r.max-r.min));
  });
}
function bindTaskSliders(){
  let cur=null,curPid=null;
  function setFromX(track,clientX){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const rect=track.getBoundingClientRect();
    if(!rect.width)return;
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    let ratio=(clientX-rect.left)/rect.width;
    ratio=Math.max(0,Math.min(1,ratio));
    let v=r.min+ratio*(r.max-r.min);
    v=Math.round(v*10)/10;
    v=Math.max(r.min,Math.min(r.max,v));
    input.value=v;
    applySliderVisual(track,ratio);
  }
  document.querySelectorAll('.slide-track').forEach(function(track){
    track.addEventListener('pointerdown',function(e){
      cur=track;curPid=e.pointerId;
      track.classList.add('dragging');
      if(track.setPointerCapture){try{track.setPointerCapture(e.pointerId);}catch(err){}}
      setFromX(track,e.clientX);
    });
    track.addEventListener('pointermove',function(e){
      if(cur!==track||e.pointerId!==curPid)return;
      setFromX(track,e.clientX);
    });
    function end(e){
      if(cur!==track||e.pointerId!==curPid)return;
      cur=null;curPid=null;
      track.classList.remove('dragging');
    }
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
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
  const metaEl=document.getElementById('accTaskBasicSum');
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

  const errs=[];
  if(!name)errs.push({field:'taskName',msg:'请输入任务名称'});
  if(isNaN(initialValue)||initialValue<0)errs.push({field:'taskInitial',msg:'初始数值需 ≥ 0'});
  if(isNaN(interestRate)||interestRate<0)errs.push({field:'taskInterest',msg:'利率需 ≥ 0'});
  if(isNaN(debtRate)||debtRate<0)errs.push({field:'taskDebt',msg:'债率需 ≥ 0'});
  if(isNaN(vitalityCost)||vitalityCost<0)errs.push({field:'taskCost',msg:'活力点花费需 ≥ 0'});
  if(errs.length){
    // 数值错误在收起的「数值规则」里：先展开，错误才可见
    if(errs.some(e=>e.field!=='taskName'))setTaskAccordion('accTaskNum',true);
    const first=rejectFields('taskModal',errs);
    if(!first)toast(errs[0].msg,'err');
    return;
  }

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
  markModalClean('achModal');
  setTimeout(()=>document.getElementById('achName').focus(),50);
}

function handleAchSave(){
  const id=document.getElementById('achId').value;
  const name=document.getElementById('achName').value.trim();
  const threshold=parseFloat(document.getElementById('achThreshold').value);
  const points=parseFloat(document.getElementById('achPoints').value);
  const domainId=document.getElementById('achDomain').value;

  const errs=[];
  if(!name)errs.push({field:'achName',msg:'请输入里程碑名称'});
  if(isNaN(threshold)||threshold<0)errs.push({field:'achThreshold',msg:'门槛需 ≥ 0'});
  if(isNaN(points)||points<=0)errs.push({field:'achPoints',msg:'成果点需 > 0'});
  if(errs.length){const first=rejectFields('achModal',errs);if(!first)toast(errs[0].msg,'err');return}

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

// 商品「资产定价 / 购买赠送」：老商品默认为空，渲染与行为不变
function fillProdAssetSelects(selectedPriceId, selectedGrantId){
  const defs=(state.assetDefs||[]).filter(function(d){return d&&d.enabled!==false&&!d.archived;});
  const priceSel=document.getElementById('prodAssetPriceId');
  const grantSel=document.getElementById('prodGrantAssetId');
  if(priceSel){
    priceSel.innerHTML='<option value="">不消耗资产</option>'+defs.map(function(d){
      return '<option value="'+escAttr(d.id)+'"'+(d.id===selectedPriceId?' selected':'')+'>'+esc(d.name)+'</option>';
    }).join('');
    priceSel.value=defs.some(function(d){return d.id===selectedPriceId;})?selectedPriceId:'';
  }
  if(grantSel){
    grantSel.innerHTML='<option value="">不赠送资产</option>'+defs.map(function(d){
      return '<option value="'+escAttr(d.id)+'"'+(d.id===selectedGrantId?' selected':'')+'>'+esc(d.name)+'</option>';
    }).join('');
    grantSel.value=defs.some(function(d){return d.id===selectedGrantId;})?selectedGrantId:'';
  }
}
function onProdAssetPriceChange(){
  const sel=document.getElementById('prodAssetPriceId');
  const has=!!(sel&&sel.value);
  const amt=document.getElementById('prodAssetPriceAmt');
  if(amt){amt.disabled=!has; if(!has)amt.value=1;}
  // 资产定价商品：禁止贷款与现实预算联动（双保险：saveProdData/buyProduct 也会拦）
  const bud=document.getElementById('prodBudgetCategory');
  if(bud){bud.disabled=has; if(has)bud.value='';}
  const budAmt=document.getElementById('prodBudgetAmount');
  if(budAmt){budAmt.disabled=has; if(has)budAmt.value=0;}
  const debt=document.getElementById('prodDebtRate');
  if(debt){debt.disabled=has; if(has)debt.value=0;}
  onProdBudgetChange();
}

// 执行权：可选“已启用的周期/手动动作流”（事件触发流会与购买事件重复执行，不允许绑定）
function execFlowChoices(){
  return (state.flows||[]).filter(function(f){
    return f&&f.id&&f.enabled!==false&&!f.invalid&&!(f.trigger&&f.trigger.type==='event');
  });
}
function fillProdExecFlowSelect(selected){
  const sel=document.getElementById('prodExecFlow');
  if(!sel)return;
  const list=execFlowChoices();
  sel.innerHTML='<option value="">请选择动作流</option>'+list.map(function(f){
    return '<option value="'+escAttr(f.id)+'"'+(f.id===selected?' selected':'')+'>'+esc(f.name||f.id)+'</option>';
  }).join('');
  sel.value=list.some(function(f){return f.id===selected;})?selected:'';
}
function execPreviewHTML(flow){
  if(!flow)return '<div class="flow-note">选择动作流后，这里会说明「买一次会发生什么」。</div>';
  const lines=[];
  function walk(list){
    (list||[]).forEach(function(s){
      if(!s)return;
      if(s.kind==='branch'){
        lines.push('<div class="flow-run-step"><span class="flow-step-idx">分支</span>条件分支 · 满足/否则各走一侧</div>');
        walk(s.then);
        walk(s.else);
      }else{
        lines.push('<div class="flow-run-step"><span class="flow-step-idx">'+(lines.length+1)+'</span>'+
          esc(describeFlowAtom(s.atom,s.params||{},flowAtomLabels()))+'</div>');
      }
    });
  }
  walk(flow.steps);
  if(!lines.length)return '<div class="flow-note">该动作流没有步骤，购买后不会产生效果。</div>';
  return '<div class="flow-col-title">买一次会发生什么</div>'+lines.join('');
}
function onProdKindChange(){
  const sel=document.getElementById('prodKind');
  const kind=sel?sel.value:'normal';
  const box=document.getElementById('prodExecBox');
  if(box)box.style.display=kind==='exec'?'block':'none';
  const flowSel=document.getElementById('prodExecFlow');
  const flow=flowSel&&flowSel.value?(state.flows||[]).find(function(f){return f&&f.id===flowSel.value;}):null;
  const pv=document.getElementById('prodExecPreview');
  if(pv)pv.innerHTML=execPreviewHTML(flow);
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
    const ap=p.assetPrice||null;
    const ga=(p.grants||[]).find(function(g){return g.kind==='asset';})||null;
    const gc=(p.grants||[]).find(function(g){return g.kind==='currency';})||null;
    document.getElementById('prodAssetPriceAmt').value=ap?ap.amount:1;
    document.getElementById('prodGrantAssetAmt').value=ga?ga.amount:0;
    document.getElementById('prodGrantCurrency').value=gc?gc.account:'';
    document.getElementById('prodGrantCurrencyAmt').value=gc?gc.amount:0;
    fillProdAssetSelects(ap?ap.assetId:'',ga?ga.assetId:'');
  }else{
    title.textContent='上架商品';
    document.getElementById('prodName').value='';
    document.getElementById('prodDesc').value='';
    document.getElementById('prodPrice').value=10;
    document.getElementById('prodStock').value=-1;
    document.getElementById('prodDebtRate').value=0;
    fillProdBudgetSelect('');
    document.getElementById('prodBudgetAmount').value=0;
    document.getElementById('prodAssetPriceAmt').value=1;
    document.getElementById('prodGrantAssetAmt').value=0;
    document.getElementById('prodGrantCurrency').value='';
    document.getElementById('prodGrantCurrencyAmt').value=0;
    fillProdAssetSelects('','');
  }
  const curExec=id?((state.products.find(x=>x.id===id)||{}).exec||null):null;
  fillProdExecFlowSelect(curExec?curExec.flowId:'');
  document.getElementById('prodKind').value=curExec?'exec':'normal';
  document.getElementById('prodExecMax').value=curExec?curExec.maxPerPeriod:1;
  document.getElementById('prodExecPeriod').value=curExec?curExec.period:'week';
  onProdKindChange();
  renderProdGateEditor(gate,validProductTier(document.getElementById('prodTier').value));
  onProdBudgetChange();
  onProdAssetPriceChange();
  onProdTierChange();
  openModal('prodModal');
  markModalClean('prodModal');
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
  const hint=document.getElementById('prodBudgetHint');
  if(hint)hint.textContent='仅支出 · 按该分类的币种（'+currencyOf(cat)+'）计入本期已花';
}

function handleProdSave(){
  const id=document.getElementById('prodId').value;
  const name=document.getElementById('prodName').value.trim();
  const desc=document.getElementById('prodDesc').value.trim();
  const priceRaw=parseFloat(document.getElementById('prodPrice').value);
  const stock=parseInt(document.getElementById('prodStock').value,10);
  let debtRate=parseFloat(document.getElementById('prodDebtRate').value);
  const categoryId=document.getElementById('prodCategory').value;
  const tier=validProductTier(document.getElementById('prodTier').value);
  const assetPriceId=document.getElementById('prodAssetPriceId').value;
  const assetPriceAmt=parseInt(document.getElementById('prodAssetPriceAmt').value,10);
  const grantAssetId=document.getElementById('prodGrantAssetId').value;
  const grantAssetAmt=parseInt(document.getElementById('prodGrantAssetAmt').value,10);
  const grantCurrency=document.getElementById('prodGrantCurrency').value;
  const grantCurrencyAmt=parseFloat(document.getElementById('prodGrantCurrencyAmt').value);
  const hasAssetPrice=!!assetPriceId;

  const errs=[];
  if(!name)errs.push({field:'prodName',msg:'请输入商品名称'});
  if(hasAssetPrice){
    if(isNaN(priceRaw)||priceRaw<0)errs.push({field:'prodPrice',msg:'价格需 ≥ 0（有资产定价时可填 0）'});
  }else if(isNaN(priceRaw)||priceRaw<0.1)errs.push({field:'prodPrice',msg:'价格需 ≥ 0.1'});
  if(hasAssetPrice&&(isNaN(assetPriceAmt)||assetPriceAmt<1))errs.push({field:'prodAssetPriceAmt',msg:'资产定价数量需 ≥ 1'});
  if(isNaN(stock)||stock<-1)errs.push({field:'prodStock',msg:'库存需 ≥ -1'});
  if(hasAssetPrice){debtRate=0;}
  if(isNaN(debtRate)||debtRate<0)errs.push({field:'prodDebtRate',msg:'债率需 ≥ 0'});
  if(errs.length){const first=rejectFields('prodModal',errs);if(!first)toast(errs[0].msg,'err');return}

  let gate=defaultProductGate();
  if(tier!=='daily'){
    const cond=normalizeCondition({mode:condDraft.mode,items:condDraft.items});
    const condErr=validateGateCondition(cond);
    if(condErr){toast(condErr,'err');return;}
    gate.condition=cond;
    syncLegacyGateFields(gate,cond);
  }

  // 现实预算联动：资产定价商品一律不联动
  let budget={categoryId:'',amount:0};
  const budSel=document.getElementById('prodBudgetCategory');
  const budCatId=hasAssetPrice?'':(budSel?budSel.value:'');
  if(budCatId){
    const budCat=BudgetEngine.category(budCatId);
    if(!budCat||!budCat.enabled||budCat.archived){toast('绑定的预算分类不可用，请重新选择','err');return}
    const budAmt=parseFloat(document.getElementById('prodBudgetAmount').value);
    if(isNaN(budAmt)||budAmt<=0){toast('绑定预算后，现实金额需大于 0','err');return}
    budget={categoryId:budCatId,amount:round4(budAmt)};
  }

  // 资产定价 / 赠送
  let assetPrice=null;
  if(hasAssetPrice){
    const def=(state.assetDefs||[]).find(function(d){return d&&d.id===assetPriceId;});
    if(!def||def.enabled===false||def.archived){toast('资产定价绑定的资产不可用，请重新选择','err');return}
    assetPrice={assetId:assetPriceId,amount:assetPriceAmt};
  }
  const grants=[];
  if(grantAssetId){
    if(isNaN(grantAssetAmt)||grantAssetAmt<1){toast('赠送资产数量需 ≥ 1','err');return}
    const def=(state.assetDefs||[]).find(function(d){return d&&d.id===grantAssetId;});
    if(!def||def.enabled===false||def.archived){toast('赠送资产不可用，请重新选择','err');return}
    grants.push({kind:'asset',assetId:grantAssetId,amount:grantAssetAmt});
  }
  if(grantCurrency){
    if(isNaN(grantCurrencyAmt)||grantCurrencyAmt<=0){toast('赠送货币数量需大于 0','err');return}
    grants.push({kind:'currency',account:grantCurrency,amount:round4(grantCurrencyAmt)});
  }
  // 自循环防护：赠送同一资产且不少于消耗 = 免费刷资产
  if(assetPrice&&grants.some(function(g){return g.kind==='asset'&&g.assetId===assetPrice.assetId&&g.amount>=assetPrice.amount;})){
    toast('赠送资产不能覆盖资产定价本身（会形成自循环）','err');return;
  }

  // 执行权：绑定一条可用的动作流，并限定每周期购买次数
  let exec=null;
  const kindSel=document.getElementById('prodKind');
  if(kindSel&&kindSel.value==='exec'){
    const flowId=document.getElementById('prodExecFlow').value;
    const flow=(state.flows||[]).find(function(f){return f&&f.id===flowId;});
    if(!flow){toast('请选择要兑换的动作流','err');return}
    if(flow.enabled===false||flow.invalid){toast('该动作流已停用或无效，请重新选择','err');return}
    if(flow.trigger&&flow.trigger.type==='event'){toast('事件触发流不能作为执行权（会与购买事件重复执行）','err');return}
    const max=parseInt(document.getElementById('prodExecMax').value,10);
    if(isNaN(max)||max<1||max>PRODUCT_EXEC_MAX_PER_PERIOD){
      toast('每周期最多购买次数需为 1–'+PRODUCT_EXEC_MAX_PER_PERIOD,'err');return;
    }
    const period=document.getElementById('prodExecPeriod').value;
    if(['day','week','month'].indexOf(period)<0){toast('周期不合法','err');return}
    if(!hasAssetPrice&&!(priceRaw>=0.1)){toast('执行权商品需要货币或资产定价','err');return}
    exec={flowId:flowId,maxPerPeriod:max,period:period};
  }
  saveProdData({id:id||null,name:name,desc:desc,price:priceRaw,stock:stock,debtRate:debtRate,categoryId:categoryId,tier:tier,gate:gate,budget:budget,assetPrice:assetPrice,grants:grants,exec:exec});
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

export { editTypes, editStage, openTaskModal, TASK_SLIDERS, refreshTaskSliders, bindTaskSliders, updateTaskAccSummaries, setTaskAccordion, applyScoreTypePicks, toggleScoreType, onStageEnabled, onStageInput, stageRowHTML, renderStageRows, toggleStageParam, applyStagePreset, runStagePreset, generateStage, genArith, genDecr, handleTaskSave, openAchModal, handleAchSave, onProdGateModeChange, updateProdTierHint, prodGatePreviewFn, validateGateCondition, syncLegacyGateFields, renderProdGateEditor, onProdTierChange, openProdModal, fillProdBudgetSelect, onProdBudgetChange, fillProdAssetSelects, onProdAssetPriceChange, onProdKindChange, handleProdSave, confirmDelTask, confirmDelAch, confirmDelProd };
