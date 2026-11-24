import { registerRenderer } from './render.js';
import { affairDelegatedSteps, claimedChoreIds, choreClaimOf, ensureAffairStepIds, makeChoreRef, stepChoreOriginLabel, stepChoreRef } from './affair-steps.js';
import { affairAutoCompleteDelegatedChores, affairDeletionChores, deleteAffairCore, delegationCandidates, resolveDelegatedSteps, restoreAffairDeletion } from './affair-delegate.js';
import { choreCfg, choreFreshDays, choreDailyDecay, choreDoneNow, choreMarkSettled, choreSettlePool, choreProgressParts } from './utils.js';
import { choreCycleDueAfter, choreCycleOf, choreMarkCompletion, choreUndoCompletion } from './chore-cycle.js';
import { choreOrderInsert, normalizeChoreTags, sortChoresByOrder, choreTagMatches, choreTagIncludes, choreTagKey, collectChoreTags } from './chore-list.js';
import { checkAchievements, checkIn } from './business.js';
import { BudgetEngine } from './budget.js';
import { budgetBadgeHTML, budgetBindingHTML, budgetOf, budgetRefOf, commitActionBudget, openBudgetAmountDialog, readBudgetBinding, rememberBudgetDraft, resolveActionBudget, reverseBoundBudget } from './budget-binding.js';
import { computeChoreDecay, processChoreDecay } from './chore-core.js';
import { CHORE_CFG_FIELDS, choreDoneOpen, choreArchivedOpen, settleChoreBatches, addChoreFromInput, toggleChoreDone, toggleChoreDoneZone, fmtChoreDate, choreTagsHTML, archivedDelegatedClaim, choreCardHTML, choreTagFilterLabel, choreTagFilterHTML, setChoreTagFilter, renderChores, toggleChoreArchivedZone, restoreChore, toDateInputValue, openChoreModal, choreCycleToggle, renderChoreTags, choreTagSuggestList, renderChoreTagSuggest, pickChoreTag, addChoreTagValue, addChoreTag, removeChoreTag, readChoreCycleForm, saveChore, affairConvertToChore, choreConvertFromModal, choreUndoConversionFromModal, delChore, choreDeleteUndoBarHTML, undoChoreDelete, dismissChoreDeleteUndo, readChoreCfgForm, writeChoreCfgForm, choreCfgInputPreview, openChoreConfigModal, resetChoreConfig, saveChoreConfig, resetChoreUiState, closeChoreDoneZone } from './chore-render.js';
import { STAGE_NAMES, AFFAIR_CURVES, CHORE_TAG_MAX_COUNT, CHORE_TAG_MAX_LEN } from './constants.js';
import { defaultChoreConfig, normalizeChoreConfig } from './defaults.js';
import { todayAgenda } from './entity-kit.js';
// 事件源：手工勾选完成时构造 chore.completed 事件，由事务提交后的 post-commit 派发
import { makeChoreCompletedEvent } from './events.js';
import { affairToChore, choreToAffair, conversionUndoState, lastConversion, undoConversion } from './entity-convert.js';
import { Ledger } from './ledger.js';
import { addDomain, delCollection, delDomain, renameCollection, renameDomain, unlockTask, deleteChoreCore, restoreChoreDeletion } from './library.js';
import { confirmDelAch, confirmDelTask, openAchModal, openTaskModal } from './modals.js';
import { closeModal, openModal } from './modal-host.js';
import { markModalClean, rejectFields } from './form-contract.js';
import { commit, save } from './persist.js';
import { runCommand } from './command.js';
import { calcCheckIn, dayKey, round2, stageCellLabel, stageNetAt, stageSel, taskIsStaged, clone, daysSince, esc, escAttr, fmt, fmtTime, getTaskDomainIds, now, taskHasType, uid, affairSteps, affairTotalSteps, affairDoneSteps, affairLastAdvance, affairCurve, affairCurveType, affairTargetAt, affairIsDone } from './pure.js';
import { render } from './render.js';
import { fillDomainChecklist } from './shell.js';
import { applyStageBar, initStageBars, setStageFromX, stageBarHTML, stageCellFromRatio, updateStageBar } from './stage-bars.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { addDays, dayDiff, dayStart, weekStart } from './time.js';
import { drag, filterByDomain, syncMajorCollapse, toggleCollapse, toggleInline } from './ui-events.js';
import { domainName, domainProgress, totalProgress } from './utils.js';
import { affairCardView, choreCardView, taskCardView } from './view-models.js';
import { ZONE_END, actionsRowHTML, collBodyHTML, collGroupHTML, collHeaderHTML, dragHandleHTML, emptyHTML, tagHTML, zoneHTML, zoneStartHTML } from './view-primitives.js';
import { registerPanelTarget, renderPanel } from './render-targets.js';
import { registerWorkUiState } from './work-ui-state.js';
// render-work.js —— 渲染：打工页（任务/项目/杂事/阶段奖励）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let affairView='list';
let affairCalCursor=null;
let affairCalSelected=null;
let affairDoneOpen=false;
let editAffairSteps=[];
// 项目弹窗三组折叠的展开状态：会话内记住，不落盘。
// 默认展开「基本信息」「步骤与预算」，收起「奖励与成果」——日常最常改的是步骤，
// 奖励/曲线是一次性设定，收起后用标题行摘要兜底。
const AFFAIR_ACC_DEFAULT={basic:true,reward:false,steps:true};
let affairAccState=Object.assign({},AFFAIR_ACC_DEFAULT);
// 打开弹窗时的表单快照，用于 Esc 关闭前的脏检查（空串 = 当前不应触发脏检查）
let affairOpenSnapshot='';
// 任务卡展开状态：只存 id（不存 DOM 引用），供整块重渲染后按 id 还原
let revealedTaskId=null;
// ===== Render: Work =====
// 领域筛选只认当前仍存在的领域：删除领域后残留、或坏存档里的失效 id 一律回落「全部」
function activeFilterDomain(){
  const id=state.filterDomain;
  if(!id)return null;
  return (state.domains||[]).some(d=>d&&d.id===id)?id:null;
}
// 三处分数栏（打工/银行/商店）共用的刷新逻辑
function setScoreCell(id,val){
  const el=document.getElementById(id);
  if(!el)return;
  el.textContent=fmt(val);
  el.classList.toggle('neg',val<0);
}
function renderWork(){
  setScoreCell('wVitality',state.scores.vitality);
  setScoreCell('wProgress',totalProgress());
  setScoreCell('wAchievement',state.scores.achievement);

  // 主入口：今天该做什么（只读聚合，点击仅定位高亮）
  renderTodayAgenda();

  const domCount=state.domains.length;
  document.getElementById('wProgressSub').textContent=domCount>1?domCount+'个领域':'';

  // Domain pills (clickable to filter tasks)
  const dp=document.getElementById('domainPills');
  const filterDomainId=activeFilterDomain();
  let dpHtml=state.domains.map(d=>{
    const val=domainProgress(d.id);
    const isActive=filterDomainId===d.id;
    let pill='<div class="domain-pill'+(isActive?' active':'')+'" onclick="filterByDomain(\''+d.id+'\')" style="cursor:pointer"><span class="dp-dot"></span>'+esc(d.name)+' <span class="dp-val">'+fmt(val)+'</span>';
    if(d.id!=='d_default'){
      pill+='<span class="dp-mgmt" onclick="event.stopPropagation()"><button onclick="renameDomain(\''+d.id+'\')" title="重命名">✎</button><button class="dp-del" onclick="delDomain(\''+d.id+'\')" title="删除">×</button></span>';
    }
    pill+='</div>';
    return pill;
  }).join('');
  dpHtml+='<div class="domain-pill add" onclick="toggleInline(\'domAddInline\')">+ 领域</div>';
  // inline add for domain
  dpHtml+='<div class="inline-add" id="domAddInline" style="display:none;margin-top:6px;width:100%">'
    +'<input type="text" id="domAddName" placeholder="输入领域名称" maxlength="20" autocomplete="off">'
    +'<button class="btn btn-sm" onclick="addDomain()">添加</button></div>';
  dp.innerHTML=dpHtml;

  renderChores();
  renderAffairs();
  syncMajorCollapse();

  renderWorkTasks();
}

// 任务面板：按集合分组的任务卡 + 归档区（work.tasks 的独立入口）
function renderWorkTasks(){
  const filterDomainId=activeFilterDomain();
  // Task groups by collection
  const tg=document.getElementById('taskGroups');
  if(!state.tasks.length){
    tg.innerHTML='<div class="empty"><p>还没有任务，创建一个开始积累分数</p><button class="btn btn-sm" onclick="openTaskModal()">新建任务</button></div>';
  }else{
    let html='';
    state.collections.forEach(c=>{
      const tasks=state.tasks.filter(t=>!t.archived&&t.collectionId===c.id&&(!filterDomainId||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(filterDomainId)));
      const isCollapsed=(state.collapsedColls||[]).includes(c.id);
      let actions=dragHandleHTML('拖拽集合');
      actions+='<button onclick="openTaskModal(null,\''+c.id+'\')">+ 任务</button>';
      if(c.id!=='c_default'){
        actions+='<button onclick="renameCollection(\''+c.id+'\')">重命名</button><button onclick="delCollection(\''+c.id+'\')">删除</button>';
      }
      let body='';
      if(tasks.length===0){
        body+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无任务 · 拖拽 ⋮⋮ 按钮可排序</p></div>';
      }else{
        body+=tasks.map(t=>taskCardHTML(t,c.id)).join('');
      }
      html+=collGroupHTML('coll-group','data-coll-id="'+c.id+'"',isCollapsed,
        collHeaderHTML({onclick:"toggleCollapse('collection','"+c.id+"')",name:esc(c.name),count:tasks.length,countLabel:'个任务',actions:actions})
        +collBodyHTML(body));
    });
    // Tasks without valid collection
    const noColl=state.tasks.filter(t=>!t.archived&&!state.collections.find(c=>c.id===t.collectionId)&&(!filterDomainId||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(filterDomainId)));
    if(noColl.length){
      html+=collGroupHTML('coll-group','data-coll-id="_none"',false,
        collHeaderHTML({onclick:"toggleCollapse('collection','_none')",name:'未分类',count:noColl.length,countLabel:'个任务',actions:dragHandleHTML('拖拽集合')})
        +collBodyHTML(noColl.map(t=>taskCardHTML(t,'_none')).join('')));
    }
    tg.innerHTML=html;
  }

  // Archive section
  const archived=state.tasks.filter(t=>t.archived);
  const am=document.getElementById('archiveMeta');
  if(am)am.textContent=archived.length?'（'+archived.length+'个任务）':'';
  const ab=document.getElementById('archiveGroups');
  if(ab){
    if(archived.length===0){
      ab.innerHTML='<div class="empty" style="padding:12px"><p style="margin:0;color:var(--text-3)">连续两周未打卡的任务将自动归档至此</p></div>';
    }else{
      const isCollapsed=(state.collapsedColls||[]).includes('_archive');
      ab.innerHTML=collGroupHTML('coll-group','data-coll-id="_archive"',isCollapsed,
        collHeaderHTML({onclick:"toggleCollapse('collection','_archive')",name:'已归档',count:archived.length,countLabel:'个任务'})
        +collBodyHTML(archived.map(t=>{
          const cost=3;
          const canUnlock=(state.scores.vitality||0)>=cost;
          return '<div class="card" style="opacity:.7">'
            +'<div class="card-top"><div>'+(taskHasType(t,'progress')?tagHTML('p','进度值'):'')+(taskHasType(t,'vitality')?tagHTML('v','活力点'):'')+'<span class="card-title">'+esc(t.name)+'</span></div>'
            +actionsRowHTML('card-actions','<button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button>')
            +'</div>'
            +'<div class="card-meta"><span>打卡 '+(t.checkInCount||0)+' 次</span><span>归档于 '+(t.archivedAt?fmtTime(t.archivedAt):'—')+'</span></div>'
            +'<div class="card-bottom"><div class="preview"><span style="color:var(--text-3)">需 '+cost+' 活力点解锁</span></div><button class="btn btn-sm btn-exempt" onclick="unlockTask(\''+t.id+'\')" '+(canUnlock?'':'disabled')+'>解锁</button></div>'
            +'</div>';
        }).join('')));
    }
  }
}

// ===== 项目（原「事务」完整结构） =====
function frSameDay(ts1,ts2){const a=new Date(ts1),b=new Date(ts2);return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
function fmtClock(ts){const d=new Date(ts);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function fmtPlan(ts){const d=new Date(ts);return (d.getMonth()+1)+'/'+d.getDate()+' '+fmtClock(ts);}
function fmtDateCal(ts){const d=new Date(ts),wd=['日','一','二','三','四','五','六'];return (d.getMonth()+1)+'月'+d.getDate()+'日 周'+wd[d.getDay()];}
function toLocalInput(ts){if(!ts)return '';const d=new Date(ts);const p=function(x){return String(x).padStart(2,'0');};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());}
function fromLocalInput(v){if(!v)return null;const t=new Date(v).getTime();return isNaN(t)?null:t;}
// ===== 项目奖励曲线（10 格累计比例，格 9 恒为 100）=====
let editAffairCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
function affairTags(a){
  const v=affairCardView(a);
  return tagHTML(v.tagKind,esc(v.tagText));
}
// ===== 项目预设 =====
let editPresetCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
function renderAffairPresetsHTML(){
  const presets=state.affairPresets||[];
  let h='<div class="affair-presets">'
    +'<div class="affair-presets-head"><span class="affair-presets-title">预设</span>'
    +'<button class="btn btn-sm" onclick="openPresetModal()">＋ 新建预设</button></div>';
  if(presets.length){
    h+='<div class="affair-preset-chips">'+presets.map(function(p){
      return '<span class="affair-preset-chip" onclick="openPresetModal(\''+p.id+'\')">'+esc(p.name)+'<b>+'+fmt(p.totalReward)+'</b></span>';
    }).join('')+'</div>';
  }else{
    h+='<div class="affair-presets-empty">没有预设。新建后，可在新建项目时一键套用总奖励与曲线。</div>';
  }
  h+='</div>';
  return h;
}
function applyAffairPreset(){
  const sel=document.getElementById('affairPresetSel');
  const p=state.affairPresets.find(function(x){return x.id===sel.value;});
  if(!p)return;
  document.getElementById('affairReward').value=p.totalReward;
  editAffairCurve={type:p.curve.type,values:(p.curve.values||AFFAIR_CURVES.even).slice()};
  setAffairCurve(editAffairCurve.type);
  document.getElementById('affairAchEnabled').checked=!!(p.ach&&p.ach.enabled);
  document.getElementById('affairAchAmount').value=(p.ach&&p.ach.amount)?p.ach.amount:1;
  toggleAffairAch();
}
function openPresetModal(id){
  document.getElementById('presetId').value=id||'';
  const del=document.getElementById('presetDelBtn');
  if(id){
    const p=state.affairPresets.find(function(x){return x.id===id;});
    if(!p)return;
    document.getElementById('presetModalTitle').textContent='编辑预设';
    document.getElementById('presetName').value=p.name;
    document.getElementById('presetReward').value=p.totalReward;
    editPresetCurve={type:p.curve.type,values:(p.curve.values||AFFAIR_CURVES.even).slice()};
    setPresetCurve(editPresetCurve.type);
    document.getElementById('presetAchEnabled').checked=!!(p.ach&&p.ach.enabled);
    document.getElementById('presetAchAmount').value=(p.ach&&p.ach.amount)?p.ach.amount:1;
    togglePresetAch();
    if(del)del.style.display='';
  }else{
    document.getElementById('presetModalTitle').textContent='新建预设';
    document.getElementById('presetName').value='';
    document.getElementById('presetReward').value='';
    editPresetCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
    setPresetCurve('even');
    document.getElementById('presetAchEnabled').checked=false;
    document.getElementById('presetAchAmount').value=1;
    togglePresetAch();
    if(del)del.style.display='none';
  }
  openModal('presetModal');
  markModalClean('presetModal');
  setTimeout(function(){document.getElementById('presetName').focus();},50);
}
function presetCurvePreview(){
  const total=Number(document.getElementById('presetReward').value)||0;
  const vals=editPresetCurve.values;
  let pts='';
  for(let i=0;i<10;i++){pts+='<b>'+(i+1)+'</b><i>'+fmt(round2(vals[i]/100*total))+'</i>';}
  return pts;
}
function presetCurveRefresh(){const p=document.getElementById('presetCurvePreview');if(p)p.innerHTML=presetCurvePreview();}
function setPresetCurve(type){
  editPresetCurve.type=type;
  document.querySelectorAll('#presetCurveRow .curve-btn').forEach(function(b){b.classList.toggle('on',b.dataset.curve===type);});
  if(type!=='custom'&&AFFAIR_CURVES[type])editPresetCurve.values=AFFAIR_CURVES[type].slice();
  const custom=document.getElementById('presetCurveCustom');
  if(custom){custom.style.display=(type==='custom')?'':'none';if(type==='custom')renderPresetCurveCustom();}
  const prev=document.getElementById('presetCurvePreview');
  if(prev)prev.innerHTML=presetCurvePreview();
}
function renderPresetCurveCustom(){
  const cont=document.getElementById('presetCurveCustom');
  if(!cont)return;
  cont.innerHTML=editPresetCurve.values.map(function(v,i){
    return '<label class="curve-cell"><span>'+(i+1)+'</span><input type="number" min="0" max="100" step="1" value="'+v+'" data-i="'+i+'" oninput="presetCurveInput('+i+',this.value)"></label>';
  }).join('');
}
function presetCurveInput(i,v){
  const n=Number(v);if(!isNaN(n))editPresetCurve.values[i]=Math.max(0,Math.min(100,n));
  const prev=document.getElementById('presetCurvePreview');
  if(prev)prev.innerHTML=presetCurvePreview();
}
function getPresetCurve(){
  const values=editPresetCurve.values.slice();
  values[9]=100;
  return {type:editPresetCurve.type,values:values};
}
function togglePresetAch(){
  const on=document.getElementById('presetAchEnabled').checked;
  const row=document.getElementById('presetAchAmountRow');
  if(row)row.style.display=on?'':'none';
}
function savePreset(){
  const id=document.getElementById('presetId').value;
  const name=document.getElementById('presetName').value.trim();
  const rewardRaw=Number(document.getElementById('presetReward').value);
  const rewardInvalid=!isNaN(rewardRaw)&&rewardRaw<0;
  const errs=[];
  if(!name)errs.push({field:'presetName',msg:'请输入预设名称'});
  if(rewardInvalid)errs.push({field:'presetReward',msg:'总奖励需 ≥ 0'});
  if(errs.length){const first=rejectFields('presetModal',errs);if(!first)toast(errs[0].msg,'err');return;}
  let totalReward=isNaN(rewardRaw)||rewardRaw<0?0:rewardRaw;
  const curve=getPresetCurve();
  const achEnabled=document.getElementById('presetAchEnabled').checked;
  const achAmount=Math.max(0,Number(document.getElementById('presetAchAmount').value)||0);
  const ach={enabled:achEnabled,amount:achEnabled?achAmount:0};
  if(id){
    const p=state.affairPresets.find(function(x){return x.id===id;});
    if(!p)return;
    p.name=name;p.totalReward=totalReward;p.curve=curve;p.ach=ach;
  }else{
    state.affairPresets.push({id:uid(),name:name,totalReward:totalReward,curve:curve,ach:ach});
  }
  save();
  closeModal('presetModal');
  toast(id?'预设已更新':'预设已创建');
  render();
}
function delPreset(id){
  const p=state.affairPresets.find(function(x){return x.id===id;});
  if(!p)return;
  if(!confirm('删除预设「'+p.name+'」？'))return;
  state.affairPresets=state.affairPresets.filter(function(x){return x.id!==id;});
  save();
  closeModal('presetModal');
  toast('预设已删除');
  render();
}

function renderAffairs(){
  const panel=document.getElementById('affairPanel');
  if(!panel)return;
  const affairs=state.affairs||[];
  const active=affairs.filter(function(a){return !a.archived;});
  const archived=affairs.filter(function(a){return a.archived;});
  const meta=document.getElementById('affairMeta');
  if(meta){
    const open=active.filter(function(a){return !a.doneAt;}).length;
    meta.textContent=affairs.length?('共'+affairs.length+' · 未完成'+open+(archived.length?' · 已归档'+archived.length:'')):'';
  }
  let html=renderAffairPresetsHTML();
  html+=affairDeleteUndoBarHTML();
  // 1. 进行中区（有步骤未全完成，或已开始推进的无步骤事务）
  const inProg=active.filter(function(a){return !a.doneAt&&(affairTotalSteps(a)>0||(a.currentCell||0)>0);})
    .sort(function(a,b){return (b.totalReward||0)-(a.totalReward||0)||affairLastAdvance(a)-affairLastAdvance(b);});
  html+=affairZoneStart('inprog','进行中',inProg.length,'');
  html+=inProg.length?inProg.map(affairInProgressCardHTML).join(''):'<div class="affair-empty">暂无进行中的项目</div>';
  html+=AFFAIR_ZONE_END;
  // 2. 日程区（列表/日历视图切换只影响本区呈现）
  const schedCount=affairUnits().length;
  html+=affairZoneStart('schedule','日程',schedCount,'<button class="affair-view-toggle" onclick="event.stopPropagation();toggleAffairView()">'+(affairView==='cal'?'列表':'日历')+'</button>');
  html+=(affairView==='cal')?renderAffairCalendar():renderAffairSchedule();
  html+=AFFAIR_ZONE_END;
  // 3. 草稿区（无步骤、未安排、尚未推进）
  const drafts=active.filter(function(a){return !a.doneAt&&!a.plannedAt&&affairTotalSteps(a)===0&&(a.currentCell||0)===0;})
    .sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);});
  html+=affairZoneStart('draft','草稿',drafts.length,'');
  html+=drafts.length?drafts.map(affairDraftCardHTML).join(''):'<div class="affair-empty">没有草稿</div>';
  html+=AFFAIR_ZONE_END;
  // 4. 已完成（折叠组，默认收起，置于最底部）
  const done=active.filter(function(a){return affairIsDone(a);});
  html+=doneZoneHTML(done);
  // 5. 已归档（规则归档的项目集中在此，可单独恢复）
  if(archived.length){
    html+=zoneHTML({id:'affair-zone-archived',collapsed:true,onclick:"toggleAffairZone('archived')",title:'已归档',count:archived.length,
      body:archived.map(function(a){
        return '<div class="card affair-card" style="opacity:.7">'
          +'<div class="affair-row"><div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span></div>'
          +actionsRowHTML('affair-actions','<span class="affair-time">归档于 '+(a.archivedAt?fmtTime(a.archivedAt):'—')+'</span>'
          +'<button class="btn btn-sm" onclick="restoreAffair(\''+a.id+'\')">恢复</button>')
          +'</div></div>';
      }).join('')});
  }
  panel.innerHTML=html;
}

function affairStatusLine(a){
  const total=a.totalReward||0;
  if(affairIsDone(a)){
    let s='已完成 · +'+fmt(total);
    if(a.ach&&a.ach.enabled&&a.ach.amount)s+=' · +'+fmt(a.ach.amount)+' 成果';
    return s;
  }
  let s='当前格 +'+fmt(a.alreadyGiven||0);
  const t=affairTotalSteps(a);
  if(t>0)s+=' · 已完成 '+affairDoneSteps(a)+'/'+t+' 步';
  if(a.ach&&a.ach.enabled&&a.ach.amount)s+=' · (+'+fmt(a.ach.amount)+' 成果)';
  return s;
}
function affairAxisHTML(a){
  const cell=a.currentCell||0;
  const draggable=(affairTotalSteps(a)===0&&!a.doneAt);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  return '<div class="affair-axis'+(draggable?' draggable':'')+'" data-affair-id="'+a.id+'"'+(draggable?'':' style="pointer-events:none"')+'>'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'</div>';
}
function affairZoneStart(key,title,count,extra){
  const collapsed=(state.affairCollapsed||[]).indexOf(key)>=0;
  return zoneStartHTML({id:'affair-zone-'+key,collapsed:collapsed,onclick:"toggleAffairZone('"+key+"')",title:title,count:count,extra:extra});
}
const AFFAIR_ZONE_END=ZONE_END;
function doneZoneHTML(done){
  const collapsed=!affairDoneOpen;
  return zoneHTML({id:'affair-zone-done',collapsed:collapsed,onclick:'toggleAffairDone()',title:'已完成',count:done.length,body:done.length?done.map(affairDoneCardHTML).join(''):emptyHTML('affair-empty','无')});
}
function toggleAffairZone(key){
  const arr=state.affairCollapsed||[];
  const i=arr.indexOf(key);
  if(i>=0)arr.splice(i,1);else arr.push(key);
  state.affairCollapsed=arr;
  save();
  const el=document.getElementById('affair-zone-'+key);
  if(el)el.classList.toggle('collapsed',arr.indexOf(key)>=0);
}
function affairMoreBtn(a){
  return '<button class="btn btn-sm affair-more" onclick="toggleAffairMenu(event,\''+a.id+'\')">⋯</button>';
}
// 只在确实可撤销时出现；不可撤销时整颗按钮不渲染，避免每张卡挂一个灰按钮。
function affairUndoBtnHTML(a){
  if(!affairCanUndo(a))return '';
  return '<button class="btn btn-sm affair-undo" title="撤销最近一次推进（最多保留最近 5 步）" onclick="event.stopPropagation();affairUndoAction(\''+a.id+'\')">↺ 撤销</button>';
}
let affairMenuTarget=null;
function toggleAffairMenu(e,id){
  e.stopPropagation();
  if(affairMenuTarget===id){closeAffairMenu();return;}
  affairMenuTarget=id;
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  let menu=document.getElementById('affairMenu');
  if(!menu){menu=document.createElement('div');menu.id='affairMenu';menu.className='affair-menu';document.body.appendChild(menu);}
  const canUndo=affairCanUndo(a);
  const lastConv=lastConversion();
  const convState=(lastConv&&lastConv.entityId===id)?conversionUndoState():null;
  let convItem='';
  if(convState){
    convItem=convState.ok
      ?'<button onclick="undoConversion();closeAffairMenu()">撤销转换</button>'
      :'<button disabled title="'+escAttr(convState.reason)+'">撤销转换（不可用）</button>';
  }
  menu.innerHTML=
    '<button onclick="openAffairModal(\''+id+'\');closeAffairMenu()">编辑</button>'
    +'<button onclick="affairConvertToChore(\''+id+'\');closeAffairMenu()">转为杂事</button>'
    +convItem
    +(canUndo
      ?'<button onclick="affairUndoAction(\''+id+'\');closeAffairMenu()">撤销上一步</button>'
      :'<button disabled title="没有可撤销的推进记录（最多保留最近 5 步）">撤销上一步</button>')
    +'<button class="danger" onclick="delAffair(\''+id+'\');closeAffairMenu()">删除</button>';
  const r=e.currentTarget.getBoundingClientRect();
  menu.style.display='block';
  menu.style.left=Math.max(8,Math.min(r.right-110,window.innerWidth-118))+'px';
  menu.style.top=(r.bottom+4)+'px';
}
function closeAffairMenu(){
  affairMenuTarget=null;
  const m=document.getElementById('affairMenu');
  if(m)m.style.display='none';
}
export function initAffairMenuDismiss(){
  document.addEventListener('click',function(e){
    if(!affairMenuTarget)return;
    const menu=document.getElementById('affairMenu');
    const path=(e.composedPath&&e.composedPath())||[];
    if(path.indexOf(menu)>=0)return;
    closeAffairMenu();
  });
  // 菜单位置按打开时的 rect 写死，滚动后会与按钮脱位：滚动/缩放时直接收起。
  // capture:true 也能收到内层滚动容器的 scroll 事件（scroll 不冒泡）。
  window.addEventListener('scroll',function(){if(affairMenuTarget)closeAffairMenu();},{capture:true,passive:true});
  window.addEventListener('resize',function(){if(affairMenuTarget)closeAffairMenu();});
}

function affairInProgressCardHTML(a){
  const stall=a.startedAt&&daysSince(a.startedAt)>3;
  return '<div class="card affair-card'+(stall?' stalled':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+budgetBadgeHTML(a)+'</div>'
    +actionsRowHTML('affair-actions',affairMoreBtn(a)
    +affairUndoBtnHTML(a)
    +'<button class="btn btn-sm btn-checkin" onclick="advanceAffairStep(\''+a.id+'\')">完成下一步</button>',true)
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairScheduleCardHTML(a,opts){
  const late=opts&&opts.late;
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+budgetBadgeHTML(a)+'</div>'
    +actionsRowHTML('affair-actions',affairMoreBtn(a)
    +'<span class="affair-time">'+(opts&&opts.time?opts.time:fmtPlan(a.plannedAt))+'</span>'
    +affairUndoBtnHTML(a)
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffair(\''+a.id+'\')">完成</button>',true)
    +'</div>'
    +'</div>';
}

function affairDraftCardHTML(a){
  return '<div class="card affair-card" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+budgetBadgeHTML(a)+'</div>'
    +actionsRowHTML('affair-actions','<button class="btn btn-sm" onclick="openAffairPlanModal(\''+a.id+'\')">计划</button>'
    +affairUndoBtnHTML(a)
    +affairMoreBtn(a),true)
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairDoneCardHTML(a){
  return '<div class="card affair-card done" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+budgetBadgeHTML(a)+'</div>'
    +actionsRowHTML('affair-actions',affairMoreBtn(a)
    +affairUndoBtnHTML(a)
    +'<span class="affair-time">✓ '+fmtTime(a.doneAt)+'</span>',true)
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

// 执行单元：有时间且未完成的条目（有时间的步骤各自成条；否则事务整体成条）
function affairUnits(){
  const out=[];
  (state.affairs||[]).forEach(function(a){
    if(a.doneAt||a.archived)return;
    const steps=affairSteps(a);
    const timed=[];
    steps.forEach(function(s,i){if(!s.doneAt&&s.plannedAt)timed.push({kind:'step',affair:a,step:s,index:i,ts:s.plannedAt});});
    if(timed.length>0){for(let k=0;k<timed.length;k++)out.push(timed[k]);}
    else if(a.plannedAt){out.push({kind:'affair',affair:a,step:null,index:-1,ts:a.plannedAt});}
  });
  return out;
}
function affairStepUnitCardHTML(u,opts){
  const a=u.affair,s=u.step,i=u.index;
  const late=opts&&opts.late;
  // 委派步骤：引用的杂事已完成时给一条可见提示，但绝不自动写 step.doneAt。
  // 项目进度由用户判断，杂事只是从属信号（与 B4 方向相反，见 affair-delegate.js 注释）。
  const ref=stepChoreRef(s);
  const chore=ref?(state.chores||[]).find(function(c){return c&&c.id===ref.id;}):null;
  const hint=(ref&&chore&&!s.doneAt&&choreDoneNow(chore))
    ?'<span class="affair-step-delegate-hint">委派的杂事已完成</span>':'';
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(s.text)+'</span></div>'
    +actionsRowHTML('affair-actions','<span class="affair-time">'+(opts&&opts.time?opts.time:fmtClock(u.ts))+'</span>'
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffairStep(\''+a.id+'\','+i+')">完成</button>',true)
    +'</div>'
    +'<div class="affair-meta"><span class="affair-sub">'+esc(a.name)+' · 第 '+(i+1)+'/'+affairTotalSteps(a)+' 步</span>'+hint+'</div>'
    +'</div>';
}

// ===== 打工页主入口：今天该做什么 =====
// 只读聚合视图：分组口径全部来自 todayAgenda() 的 bucket 字段（overdue / today / active），
// 渲染层只负责分组与文字；点击某条仅“定位到对应卡片 + 短暂高亮”，不写任何状态。
const AGENDA_GROUPS=[
  {key:'overdue',title:'已逾期',cls:'is-overdue'},
  {key:'today',title:'今天到期',cls:'is-today'},
  {key:'active',title:'进行中',cls:'is-active'}
];
const AGENDA_KIND_LABEL={task:'任务',affair:'项目',chore:'杂事'};

function agendaWhenText(it){
  if(it.overdue&&it.dueAt){
    const n=-dayDiff(it.dueAt,now());
    return n>1?'逾期 '+n+' 天':'逾期';
  }
  if(it.dueAt)return fmtClock(it.dueAt);
  return it.kind==='task'?'待打卡':'';
}

function agendaRowHTML(it){
  const args="'"+it.kind+"','"+String(it.id).replace(/['\\]/g,'')+"'";
  const sub=it.subtitle?'<span class="agenda-row-sub">'+esc(it.subtitle)+'</span>':'';
  const when=agendaWhenText(it);
  return '<div class="agenda-row" onclick="jumpToAgendaItem('+args+')" title="定位到这张卡片">'
    +'<span class="agenda-row-tag">'+AGENDA_KIND_LABEL[it.kind]+'</span>'
    +'<span class="agenda-row-name">'+esc(it.title)+'</span>'
    +sub
    +(when?'<span class="agenda-row-when">'+when+'</span>':'')
    +'</div>';
}

function agendaBlockHTML(){
  const items=todayAgenda();
  const doneN=items.filter(function(x){return x.status==='done';}).length;
  const todo=items.filter(function(x){return x.status!=='done';});
  let groups='';
  AGENDA_GROUPS.forEach(function(g){
    const list=todo.filter(function(it){return it.bucket===g.key;});
    if(!list.length)return; // 空分组直接省略，不留空白区块
    groups+='<div class="agenda-group '+g.cls+'">'
      +'<div class="agenda-group-head"><span class="agenda-group-name">'+g.title+'</span><span class="agenda-group-count">'+list.length+'</span></div>'
      +list.map(agendaRowHTML).join('')
      +'</div>';
  });
  let body;
  if(groups){
    body='<div class="agenda-scroll">'+groups+'</div>';
  }else{
    body='<div class="agenda-empty">'+(doneN?'今天的待办都已完成':'今天没有到期或待推进的事项')+'</div>';
  }
  return '<div class="agenda-panel">'
    +'<div class="agenda-panel-head"><span class="agenda-title">今天该做什么</span>'
    +'<span class="agenda-summary">'+todo.length+' 项待办'+(doneN?' · 已完成 '+doneN:'')+'</span></div>'
    +body
    +'</div>';
}

function renderTodayAgenda(){
  const box=document.getElementById('todayAgenda');
  if(!box)return;
  // 整块重写 innerHTML 会让内部滚动容器回到顶部：先记住位置，写回后再恢复。
  // 只处理「同样的内容重渲染」这一种情况，不做局部 diff。
  const prev=box.querySelector('.agenda-scroll');
  const scrollTop=prev?prev.scrollTop:0;
  box.innerHTML=agendaBlockHTML();
  if(scrollTop>0){
    const next=box.querySelector('.agenda-scroll');
    if(next)next.scrollTop=scrollTop;
  }
}

function agendaSelector(kind,id){
  const safe=String(id).replace(/["\\]/g,'');
  if(kind==='task')return '.task-card[data-task-id="'+safe+'"]';
  if(kind==='chore')return '.chore-card[data-chore-id="'+safe+'"]';
  return '.affair-card[data-affair-id="'+safe+'"]';
}

// 目标可能被折叠容器（大区 / 集合 / 项目分区）隐藏：逐层展开。
// 只改本次 DOM 视图，不写入 state，下一次正常渲染会回到用户原来的折叠状态。
function revealAgendaTarget(kind,id){
  const find=function(){
    if(kind==='affair'){
      const sched=document.querySelector('#affair-zone-schedule '+agendaSelector(kind,id));
      if(sched)return sched;
    }
    return document.querySelector(agendaSelector(kind,id));
  };
  let el=find();
  if(el)return el;
  const majorId=kind==='task'?'major_task':(kind==='chore'?'major_chore':'major_affair');
  const major=document.getElementById(majorId);
  if(major&&major.classList.contains('collapsed'))major.classList.remove('collapsed');
  el=find();
  if(el)return el;
  const scopeId=kind==='task'?'taskGroups':(kind==='chore'?'chorePanel':'affairPanel');
  const scope=document.getElementById(scopeId);
  if(scope&&scope.querySelectorAll){
    scope.querySelectorAll('.collapsed').forEach(function(n){n.classList.remove('collapsed');});
  }
  return find();
}

let agendaHitTimer=null;
function jumpToAgendaItem(kind,id){
  if(!id)return;
  const el=revealAgendaTarget(kind,id);
  if(!el){toast('这条事项的卡片当前没有显示（可能被折叠或在日历视图）','err');return;}
  if(typeof el.scrollIntoView==='function')el.scrollIntoView({behavior:'smooth',block:'center'});
  el.classList.add('agenda-hit');
  if(agendaHitTimer)clearTimeout(agendaHitTimer);
  agendaHitTimer=setTimeout(function(){el.classList.remove('agenda-hit');agendaHitTimer=null;},1800);
}

function renderAffairSchedule(){
  const units=affairUnits();
  const nowTs=now();
  const todayStart=dayStart(nowTs);
  const tomorrowStart=addDays(todayStart,1);
  const dayAfter=addDays(todayStart,2);
  const weekEnd=addDays(weekStart(nowTs,1),7);
  function bucket(ts){
    if(ts<todayStart)return 'overdue';   // 逾期项单列，不再混进“今天”
    if(ts<tomorrowStart)return 'today';
    if(ts<dayAfter)return 'tomorrow';
    if(ts<weekEnd)return 'week';
    return 'later';
  }
  const defs=[{key:'overdue',title:'逾期'},{key:'today',title:'今天'},{key:'tomorrow',title:'明天'},{key:'week',title:'本周'},{key:'later',title:'之后'}];
  let html='';
  defs.forEach(function(d){
    const items=units.filter(function(u){return bucket(u.ts)===d.key;}).sort(function(a,b){return a.ts-b.ts;});
    if(items.length===0)return; // 空分组不占位，避免把有内容的卡片挤出首屏
    html+='<div class="affair-day-group'+(d.key==='overdue'?' overdue':'')+'">'
      +'<div class="affair-day-title">'+d.title+' <span class="affair-zone-count">'+items.length+'</span></div>'
      +items.map(function(u){
        const late=u.ts<todayStart;
        const timeOnly=(d.key==='today'||d.key==='tomorrow')?fmtClock(u.ts):fmtPlan(u.ts);
        if(u.kind==='step')return affairStepUnitCardHTML(u,{late:late,time:timeOnly});
        return affairScheduleCardHTML(u.affair,{late:late,time:timeOnly});
      }).join('')
      +'</div>';
  });
  // 整个日程为空时合并成一行提示
  return html||'<div class="affair-empty">日程暂无安排</div>';
}

function renderAffairCalendar(){
  const units=affairUnits();
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  const y=affairCalCursor.y,m=affairCalCursor.m;
  const todayTs=dayStart(now());
  const first=new Date(y,m,1);
  const firstDow=(first.getDay()+6)%7; // 周一=0
  const startTs=addDays(first.getTime(),-firstDow);
  let html='<div class="cal-head">'
    +'<button class="cal-nav" onclick="affairCalShift(-1)">◀</button>'
    +'<div class="cal-title">'+y+'年'+(m+1)+'月</div>'
    +'<button class="cal-nav" onclick="affairCalShift(1)">▶</button>'
    +'</div>';
  html+='<div class="cal-grid">';
  ['一','二','三','四','五','六','日'].forEach(function(w){html+='<div class="cal-dow">'+w+'</div>';});
  for(let i=0;i<42;i++){
    const ts=addDays(startTs,i);
    const d=new Date(ts);
    const inMonth=d.getMonth()===m;
    const isToday=ts===todayTs;
    const count=units.filter(function(u){return frSameDay(u.ts,ts);}).length;
    const sel=affairCalSelected&&frSameDay(ts,affairCalSelected);
    let dots='';
    for(let k=0;k<Math.min(count,3);k++)dots+='<i class="cal-dot"></i>';
    html+='<div class="cal-cell'+(inMonth?'':' out')+(isToday?' today':'')+(sel?' sel':'')+'" onclick="affairSelectDay('+ts+')">'
      +'<span class="cal-num">'+d.getDate()+'</span>'
      +(count?'<span class="cal-dots">'+dots+'</span>':'')
      +'</div>';
  }
  html+='</div>';
  // 选中日详情
  html+='<div class="cal-day-detail">';
  if(affairCalSelected){
    const selTs=affairCalSelected;
    const items=units.filter(function(u){return frSameDay(u.ts,selTs);}).sort(function(a,b){return a.ts-b.ts;});
    html+='<div class="cal-day-head">'+fmtDateCal(selTs)+'</div>';
    if(items.length===0){
      html+='<div class="affair-empty">这一天没有安排</div>';
    }else{
      html+=items.map(function(u){
        const late=u.ts<todayTs;
        if(u.kind==='step')return affairStepUnitCardHTML(u,{late:late,time:fmtClock(u.ts)});
        return affairScheduleCardHTML(u.affair,{late:late,time:fmtClock(u.ts)});
      }).join('');
    }
  }
  html+='</div>';
  return html;
}

// ===== 事务：交互 =====
function addAffairFromInput(){
  const inp=document.getElementById('affairInput');
  if(!inp)return;
  const name=inp.value.trim();
  if(!name){toast('请输入项目名称','err');return;}
  state.affairs.push({id:uid(),name:name,totalReward:0.1,curve:{type:'even',values:AFFAIR_CURVES.even.slice()},currentCell:0,alreadyGiven:0,domainId:null,plannedAt:null,steps:[],ach:{enabled:false,amount:0},createdAt:now(),startedAt:null,doneAt:null});
  Ledger.event('创建项目「'+name+'」','affair-create');
  save();
  inp.value='';
  inp.focus();
  render();
}

// ===== 事务结算（历史最高水位）=====
function applyAffairValue(a,amt,desc){
  if(!amt||amt<=0)return;
  if(a.domainId){
    Ledger.grant('progress:'+a.domainId,amt,{src:'affair',desc:desc,dom:a.domainId,affairId:a.id});
    checkAchievements(a.domainId);
  }else{
    Ledger.grant('vitality',amt,{src:'affair',desc:desc,affairId:a.id});
  }
  return amt;
}
function reverseAffairValue(a,amt,desc){
  if(!amt||amt<=0)return;
  if(a.domainId){
    Ledger.spend('progress:'+a.domainId,amt,{src:'affair',desc:desc,dom:a.domainId,affairId:a.id});
  }else{
    Ledger.spend('vitality',amt,{src:'affair',desc:desc,affairId:a.id});
  }
}
// 推进 currentCell 并按水位结算；到达格 9 视为完成 + 发放成果点
function affairApplyProgress(a,cell,opts){
  opts=opts||{};
  cell=Math.max(0,Math.min(9,Math.round(cell)));
  let doneToast=null;
  runCommand({
    label:'affair-progress',save:false,render:false,silentFail:true,
    run:function(tx){
      a.currentCell=cell;
      if(cell>0&&!a.startedAt)a.startedAt=now();
      // 现实预算先于本笔收益入账（先扣后收）
      if(opts.plan){
        const got=commitActionBudget(tx,opts.plan,{affairId:a.id,affairAdvanceId:opts.advanceId||''});
        if(opts.snap)opts.snap.budgetRef=budgetRefOf(got.entry,opts.plan);
        if(a.budget&&a.budget.mode==='prompt')a.budget.lastAmount=opts.plan.amount;
      }
      const target=affairTargetAt(a,cell);
      const diff=round2(target-(a.alreadyGiven||0));
      if(diff>0){
        applyAffairValue(a,diff,'项目「'+a.name+'」进度结算');
        a.alreadyGiven=round2(target);
      }
      if(cell>=9&&!a.doneAt){
        a.doneAt=now();
        // B4：项目完成时把当前未完成的委派杂事一并判定完成。
        // 只写完成态、不做结算（不发活力点/进度/不走现实预算、不进结算池），
        // 口径与理由见 affair-delegate.js 的 affairAutoCompleteDelegatedChores。
        const autoDone=affairAutoCompleteDelegatedChores(a,a.doneAt);
        // 记在本次快照上：撤销这一步时只回退这批被自动判定的杂事完成态
        if(autoDone.length&&opts.snap){
          opts.snap.autoChores={ts:a.doneAt,ids:autoDone.map(function(x){return x.id;})};
        }
        const autoTip=autoDone.length?(' · 自动完成 '+autoDone.length+' 项委派杂事'):'';
        if(a.ach&&a.ach.enabled&&a.ach.amount>0){
          Ledger.grant('achievement',a.ach.amount,{src:'affair',desc:'完成项目「'+a.name+'」',affairId:a.id});
          doneToast={msg:'项目「'+a.name+'」完成 · 成果点 +'+fmt(a.ach.amount)+autoTip,type:'warn'};
        }else{
          doneToast={msg:'项目「'+a.name+'」已完成'+autoTip};
        }
      }
      return {toast:doneToast};
    }
  });
}

// ===== 撤销（快照持久化到 state，限量保留）=====
const AFFAIR_UNDO_LIMIT=5;
function affairCanUndo(a){const s=(state.affairUndo&&state.affairUndo[a.id]);return !!(s&&s.length);}
function affairPushUndo(a){
  if(!state.affairUndo)state.affairUndo={};
  const stack=state.affairUndo[a.id]||(state.affairUndo[a.id]=[]);
  // 懒补齐 stepId：写进 state.steps，随外层事务的 save 一起落盘。
  // 不能只留在内存里——下一次 parseState 会用落盘内容重建，补出来的 id 就丢了。
  ensureAffairStepIds(a);
  // 步骤完成态也要进快照：只存 currentCell/alreadyGiven 无法回退 s.doneAt，
  // 撤销后步骤仍显示已完成，与项目进度不一致。
  // B5：步骤按 stepId 对齐（不再按下标）。窗口内增删/改名步骤时，下标会错位到别的步骤上。
  // 委派杂事同理：项目完成时自动判定的完成态（B4）也要能同批回退，
  // 否则撤销项目完成后杂事仍显示已完成。这里只存完成相关字段，且只存被委派的那几条；
  // 真正回退哪些由 affairApplyProgress 写回的 autoChores 决定（避免误伤用户手点的完成）。
  stack.push({
    cell:a.currentCell||0,given:a.alreadyGiven||0,doneAt:a.doneAt||null,startedAt:a.startedAt||null,
    steps:(a.steps||[]).map(function(s){return s?{id:s.stepId||'',doneAt:s.doneAt||null}:null;}),
    budgetRef:null,
    chorePre:affairDelegatedChoresBrief(a),
    autoChores:null
  });
  if(stack.length>AFFAIR_UNDO_LIMIT)stack.shift();
  return stack[stack.length-1];
}
// 回填步骤完成态：新快照按 stepId 找同一步骤；旧快照（无 id）只在步骤数未变时按下标，
// 结构已变则整段跳过——宁可少回退，也不把 doneAt 写到错误的步骤上。
function undoStepDoneAt(a,snapSteps){
  if(!Array.isArray(snapSteps)||!Array.isArray(a.steps))return;
  const byId=new Map();
  snapSteps.forEach(function(e){if(e&&typeof e.id==='string'&&e.id)byId.set(e.id,e);});
  if(byId.size){
    a.steps.forEach(function(s){
      if(!s||typeof s.stepId!=='string')return;
      const e=byId.get(s.stepId);
      if(e)s.doneAt=e.doneAt;
    });
    return;
  }
  if(snapSteps.length===a.steps.length){
    a.steps.forEach(function(s,i){if(s&&snapSteps[i])s.doneAt=snapSteps[i].doneAt;});
  }
}
// 委派杂事的完成态快照（只读）：{id,done,doneAt,settled,cycle}
function affairDelegatedChoresBrief(a){
  const byId=new Map();
  (state.chores||[]).forEach(function(c){if(c&&typeof c.id==='string'&&c.id)byId.set(c.id,c);});
  const seen=new Set();
  const out=[];
  affairDelegatedSteps(a).forEach(function(d){
    if(seen.has(d.choreId))return;
    seen.add(d.choreId);
    const c=byId.get(d.choreId);
    if(!c)return;
    out.push({id:c.id,done:!!c.done,doneAt:c.doneAt||null,settled:!!c.settled,cycle:c.cycle?clone(c.cycle):null});
  });
  return out;
}
// 撤销 B4 自动判定：只处理本批被自动完成的杂事（用户手点后的完成不会被误删）
function undoAutoChores(batch,pre){
  const byId=new Map();
  (state.chores||[]).forEach(function(c){if(c&&typeof c.id==='string'&&c.id)byId.set(c.id,c);});
  const preById=new Map((pre||[]).map(function(p){return [p.id,p];}));
  const ts=Number(batch.ts)||0;
  batch.ids.forEach(function(cid){
    const c=byId.get(cid);
    if(!c)return;
    if(ts>0&&Array.isArray(c.history)){
      c.history=c.history.filter(function(e){return !e||Number(e.ts)!==ts;});
    }
    const p=preById.get(cid);
    if(!p)return;
    c.done=!!p.done;
    c.doneAt=p.doneAt||null;
    c.settled=!!p.settled;
    if(p.cycle)c.cycle=clone(p.cycle);
  });
}
function affairUndoAction(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const stack=(state.affairUndo&&state.affairUndo[a.id])||[];
  if(!stack.length){
    return runCommand({reject:{reason:'empty',toast:{msg:'没有可撤销的操作',type:'warn'}}});
  }
  runCommand({
    label:'affair-undo',silentFail:true,
    toast:{msg:'已撤销「'+a.name+'」'},
    run:function(){
      // 弹栈放进事务：失败回滚时快照会随 state 一起还原，不会被白白弹掉
      const st=(state.affairUndo&&state.affairUndo[a.id])||[];
      const snap=st.pop();
      if(!snap)return;
      const revoked=round2((a.alreadyGiven||0)-(snap.given||0));
      // 联动撤销现实账目：当期硬撤、跨期冲正；失败则整单回滚
      if(snap.budgetRef)reverseBoundBudget(snap.budgetRef);
      if(revoked>0)reverseAffairValue(a,revoked,'撤销项目「'+a.name+'」推进');
      if(!!a.doneAt&&!snap.doneAt&&a.ach&&a.ach.enabled&&a.ach.amount>0){
        Ledger.grant('achievement',-a.ach.amount,{src:'affair',desc:'撤销项目「'+a.name+'」成果点',affairId:a.id});
      }
      a.currentCell=snap.cell;a.alreadyGiven=snap.given;a.doneAt=snap.doneAt;a.startedAt=snap.startedAt;
      undoStepDoneAt(a,snap.steps);
      // B4：回退本次被自动判定完成的委派杂事——先删掉那条自动写入的完成历史
      // （ts 与本批一致；用户之后手点的完成不会被误删），再还原完成态与循环游标。
      if(snap.autoChores&&Array.isArray(snap.autoChores.ids)&&snap.autoChores.ids.length){
        undoAutoChores(snap.autoChores,snap.chorePre);
      }
    }
  });
}

// 项目动作的预算闸门：临时金额弹窗必须在 Ledger.txn 之前完成
function affairBudgetGate(a,resolved,again,onCancel){
  const bind=budgetOf(a);
  if(bind&&bind.mode==='prompt'&&(!resolved||resolved.amount==null)){
    openBudgetAmountDialog({
      kind:'affair',id:a.id,entity:a,title:'项目推进：'+a.name,
      onConfirm:function(amount){again({amount:amount});},
      onCancel:onCancel||function(){toast('已取消项目推进','warn');}
    });
    return{status:'prompt'};
  }
  const br=resolveActionBudget(a,{
    kind:'affair',id:a.id,source:'affair',
    amount:resolved?resolved.amount:undefined
  });
  if(br.status==='skip')toast(br.reason,'warn');
  return{status:'ok',plan:br.status==='ok'?br.plan:null,amount:br.status==='ok'?br.amount:0};
}
function _completeAffairStep(a,s,resolved){
  const gate=affairBudgetGate(a,resolved,function(r){_completeAffairStep(a,s,r);});
  if(gate.status==='prompt')return;
  // 步骤完成态与进度结算必须同生共死：任何一笔发放失败时，s.doneAt 也不能留下
  runCommand({
    label:'affair-step',silentFail:true,
    onFail:function(){if(gate.plan)rememberBudgetDraft('affair',a.id,gate.plan.amount);},
    run:function(tx){
      const snap=affairPushUndo(a);
      s.doneAt=now();
      const steps=affairSteps(a);
      const allDone=steps.every(function(x){return x.doneAt;});
      affairApplyProgress(a,allDone?9:Math.min(8,(a.currentCell||0)+1),{plan:gate.plan,snap:snap});
    }
  });
}
function advanceAffairStep(id,resolved){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a||a.doneAt)return;
  const next=affairSteps(a).find(function(s){return !s.doneAt;});
  if(!next){
    const gate=affairBudgetGate(a,resolved,function(r){advanceAffairStep(id,r);});
    if(gate.status==='prompt')return;
    // 快照在事务内压栈：发放失败回滚时连 undo 栈一起还原，避免留下无效快照
    runCommand({
      label:'affair-complete',silentFail:true,
      onFail:function(){if(gate.plan)rememberBudgetDraft('affair',a.id,gate.plan.amount);},
      run:function(tx){
        const snap=affairPushUndo(a);
        affairApplyProgress(a,9,{plan:gate.plan,snap:snap});
      }
    });
    return;
  }
  _completeAffairStep(a,next,resolved);
}
function completeAffair(id,resolved){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt)return runCommand({reject:{reason:'done',toast:{msg:'该项目已完成',type:'warn'}}});
  const gate=affairBudgetGate(a,resolved,function(r){completeAffair(id,r);});
  if(gate.status==='prompt')return;
  runCommand({
    label:'affair-complete',silentFail:true,
    onFail:function(){if(gate.plan)rememberBudgetDraft('affair',a.id,gate.plan.amount);},
    run:function(tx){
      const snap=affairPushUndo(a);
      affairApplyProgress(a,9,{plan:gate.plan,snap:snap});
    }
  });
}
function completeAffairStep(id,idx,resolved){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt){toast('该项目已完成','warn');return;}
  const steps=affairSteps(a);
  const s=steps[idx];
  if(!s){toast('步骤不存在','warn');return;}
  if(s.doneAt){toast('该步骤已完成','warn');return;}
  _completeAffairStep(a,s,resolved);
}

// ===== 无步骤事务：进度轴拖拽推进 =====
function initAffairAxes(){
  const THRESH=8;
  document.querySelectorAll('.affair-axis.draggable').forEach(function(axis){
    const track=axis.querySelector('.stage-track');
    if(!track||track._affairBound)return;
    track._affairBound=true;
    const id=axis.dataset.affairId;
    let startX=0,startY=0,startCell=0,pid=null;
    let dragging=false,pushed=false,dragSnap=null,lastCell=0;
    // 拖进度轴后，浏览器仍可能补发一次 click；吞掉它，避免顺手打开项目弹窗
    let suppressClick=false;
    function setCellFromX(clientX){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      const rect=track.getBoundingClientRect();
      if(!rect.width)return;
      let p=(clientX-rect.left)/rect.width;
      p=Math.max(0,Math.min(1,p));
      const cell=stageCellFromRatio(p);
      // 设计意图：事务进度轴只允许向后推进，向前拖动不生效。
      if(cell<=startCell)return;
      if(!pushed){dragSnap=affairPushUndo(a);pushed=true;}
      lastCell=cell;
      // 拖拽期间只结算虚拟收益；现实账目在松手时按“一次手势一笔”补记。
      // 带上本次手势的快照：拖到第 9 格时会自动判定委派杂事，撤销要能一起回退。
      affairApplyProgress(a,cell,{snap:dragSnap});
      const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';
    }
    function finishDragBudget(a,snap,resolved){
      const gate=affairBudgetGate(a,resolved,function(r){finishDragBudget(a,snap,r);},function(){
        toast('已取消，本次拖拽进度已回退','warn');
        affairUndoAction(a.id);
      });
      if(gate.status==='prompt')return;
      if(!gate.plan){commit();return;}
      const txr=Ledger.txn(function(tx){
        const got=commitActionBudget(tx,gate.plan,{affairId:a.id,affairAdvanceId:''});
        snap.budgetRef=budgetRefOf(got.entry,gate.plan);
        if(a.budget&&a.budget.mode==='prompt')a.budget.lastAmount=gate.plan.amount;
      },{label:'affair-drag-budget',save:'none',render:false});
      if(!txr.ok){rememberBudgetDraft('affair',a.id,gate.plan.amount);return;}
      commit();
    }
    track.addEventListener('pointerdown',function(e){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      startCell=a.currentCell||0;
      dragging=false;pushed=false;dragSnap=null;lastCell=startCell;
      suppressClick=false;
      // 与任务阶段条一致：按下即捕获指针，离开窄带后继续跟手
      if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
    });
    track.addEventListener('pointermove',function(e){
      if(pid===null||e.pointerId!==pid)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(!dragging){
        if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
        // 方向判定只表示“开始拖动”，不终止整个手势
        if(Math.abs(dx)<=Math.abs(dy))return;
        dragging=true;
        suppressClick=true;
      }
      e.preventDefault();
      setCellFromX(e.clientX);
    });
    function end(e){
      if(pid===null||e.pointerId!==pid)return;
      if(track.releasePointerCapture){try{track.releasePointerCapture(pid);}catch(err){}}
      pid=null;
      const a=state.affairs.find(function(x){return x.id===id;});
      const snap=dragSnap;
      dragging=false;pushed=false;dragSnap=null;
      if(!a||!snap){return;}
      if(lastCell>startCell)finishDragBudget(a,snap,undefined);
      else commit();
      lastCell=startCell;
    }
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
    // 捕获阶段拦下拖拽后补发的 click，行为与排序把手一致
    track.addEventListener('click',function(e){
      if(!suppressClick)return;
      suppressClick=false;
      e.preventDefault();
      e.stopPropagation();
    },true);
  });
}

function openAffairPlanModal(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  document.getElementById('affairPlanId').value=id;
  document.getElementById('affairPlanInput').value=a.plannedAt?toLocalInput(a.plannedAt):'';
  openModal('affairPlanModal');
  markModalClean('affairPlanModal');
}

function saveAffairPlan(){
  const id=document.getElementById('affairPlanId').value;
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const v=document.getElementById('affairPlanInput').value;
  if(!v){
    const first=rejectFields('affairPlanModal',[{field:'affairPlanInput',msg:'请选择日期时间'}]);
    if(!first)toast('请选择日期时间','err');
    return;
  }
  a.plannedAt=fromLocalInput(v);
  save();
  closeModal('affairPlanModal');
  toast('已规划项目「'+a.name+'」');
  render();
}

// ===== 项目弹窗：折叠分组、摘要、脏检查 =====
const AFFAIR_CURVE_NAMES={even:'平均',lateHeavy:'后重',earlyHeavy:'前重',allAtEnd:'全押后',custom:'自定义'};
const AFFAIR_ACC_IDS={basic:'affairAccBasic',reward:'affairAccReward',steps:'affairAccSteps'};

function affairAccGroup(key){
  const id=AFFAIR_ACC_IDS[key];
  return id?document.getElementById(id):null;
}
function applyAffairAccState(){
  Object.keys(AFFAIR_ACC_IDS).forEach(function(k){
    const el=affairAccGroup(k);
    if(el&&el.classList)el.classList.toggle('open',!!affairAccState[k]);
  });
}
// 内联入口：切换分组并记住本次会话的选择
function toggleAffairAcc(key){
  if(!(key in AFFAIR_ACC_IDS))return;
  affairAccState[key]=!affairAccState[key];
  applyAffairAccState();
}
// 校验失败时把目标分组强行展开（不改变用户对其它分组的记忆）
function expandAffairAcc(key){
  if(!(key in AFFAIR_ACC_IDS))return;
  affairAccState[key]=true;
  applyAffairAccState();
}
// 折叠标题行的摘要：收起后仍能看出这一组里装了什么
function affairAccSummaryRefresh(){
  const basicSum=document.getElementById('affairAccBasicSum');
  if(basicSum){
    const nameEl=document.getElementById('affairName');
    const name=nameEl?String(nameEl.value||'').trim():'';
    const timeEl=document.getElementById('affairPlannedAt');
    let planned='';
    if(timeEl&&timeEl.value){planned='🕒 '+fmtPlan(fromLocalInput(timeEl.value));}
    basicSum.textContent=[name||'未命名',planned].filter(Boolean).join(' · ');
  }
  const rewardSum=document.getElementById('affairAccRewardSum');
  if(rewardSum){
    const rEl=document.getElementById('affairReward');
    const total=rEl?Number(rEl.value):0;
    const parts=[total>0?('总奖励 '+fmt(total)):'未设置奖励'];
    parts.push(AFFAIR_CURVE_NAMES[editAffairCurve.type]||'自定义');
    const achEl=document.getElementById('affairAchEnabled');
    if(achEl&&achEl.checked)parts.push('成果点');
    rewardSum.textContent=parts.join(' · ');
  }
  const stepsSum=document.getElementById('affairAccStepsSum');
  if(stepsSum)stepsSum.textContent=editAffairSteps.length?(editAffairSteps.length+' 步'):'暂无步骤';
}
function affairFieldValue(id){
  const el=document.getElementById(id);
  return el?String(el.value==null?'':el.value):'';
}
function affairFieldChecked(id){
  const el=document.getElementById(id);
  return !!(el&&el.checked);
}
// 表单快照只用于判断“有没有未保存改动”，不参与保存与数据形状
function affairFormSnapshot(){
  return JSON.stringify({
    name:affairFieldValue('affairName'),
    reward:affairFieldValue('affairReward'),
    domain:affairFieldValue('affairDomain'),
    plannedAt:affairFieldValue('affairPlannedAt'),
    ach:affairFieldChecked('affairAchEnabled'),
    achAmount:affairFieldValue('affairAchAmount'),
    curve:editAffairCurve,
    steps:editAffairSteps,
    budget:readBudgetBinding('affair')
  });
}
function affairIsDirty(){
  return affairOpenSnapshot!==''&&affairFormSnapshot()!==affairOpenSnapshot;
}
// 关闭项目弹窗：有未保存改动时先确认；force=true 用于保存成功、删除成功等已提交路径
function closeAffairModal(force){
  if(!force&&affairIsDirty()){
    if(!confirm('项目还有未保存的修改，确定放弃并关闭？'))return false;
  }
  affairOpenSnapshot='';
  closeModal('affairModal');
  return true;
}
function requestAffairModalClose(){
  return closeAffairModal(false);
}

function openAffairModal(id){
  document.getElementById('affairId').value=id||'';
  const sel=document.getElementById('affairDomain');
  let dHtml='<option value="">不关联（记活力点）</option>';
  dHtml+=state.domains.map(function(d){return '<option value="'+d.id+'">'+esc(d.name)+'</option>';}).join('');
  sel.innerHTML=dHtml;
  const psSel=document.getElementById('affairPresetSel');
  if(psSel){
    psSel.innerHTML='<option value="">不套用</option>'+state.affairPresets.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+'</option>';}).join('');
    psSel.value='';
  }
  const delBtn=document.getElementById('affairDelBtn');
  if(id){
    const a=state.affairs.find(function(x){return x.id===id;});
    if(!a)return;
    document.getElementById('affairModalTitle').textContent='编辑项目';
    document.getElementById('affairName').value=a.name;
    document.getElementById('affairReward').value=(a.totalReward===undefined?'':a.totalReward);
    document.getElementById('affairPlannedAt').value=a.plannedAt?toLocalInput(a.plannedAt):'';
    sel.value=a.domainId||'';
    editAffairSteps=clone(a.steps||[]);
    editAffairCurve={type:affairCurveType(a),values:affairCurve(a).slice()};
    setAffairCurve(editAffairCurve.type);
    document.getElementById('affairAchEnabled').checked=!!(a.ach&&a.ach.enabled);
    document.getElementById('affairAchAmount').value=(a.ach&&a.ach.amount)?a.ach.amount:1;
    toggleAffairAch();
    if(delBtn)delBtn.style.display='';
  }else{
    document.getElementById('affairModalTitle').textContent='新建项目';
    document.getElementById('affairName').value='';
    document.getElementById('affairReward').value='';
    document.getElementById('affairPlannedAt').value='';
    sel.value='';
    editAffairSteps=[];
    editAffairCurve={type:'even',values:AFFAIR_CURVES.even.slice()};
    setAffairCurve('even');
    document.getElementById('affairAchEnabled').checked=false;
    document.getElementById('affairAchAmount').value=1;
    toggleAffairAch();
    if(delBtn)delBtn.style.display='none';
  }
  renderAffairSteps();
  const budBox=document.getElementById('affairBudgetBind');
  if(budBox)budBox.innerHTML=budgetBindingHTML('affair',id?state.affairs.find(function(x){return x.id===id;}):null);
  if(budBox)budgetBindingModeChange('affair');
  applyAffairAccState();
  affairAccSummaryRefresh();
  affairOpenSnapshot=affairFormSnapshot();
  openModal('affairModal');
  setTimeout(function(){document.getElementById('affairName').focus();},50);
}

function handleAffairSave(){
  const id=document.getElementById('affairId').value;
  const name=document.getElementById('affairName').value.trim();
  const rewardRaw=Number(document.getElementById('affairReward').value);
  const rewardInvalid=!isNaN(rewardRaw)&&rewardRaw<0;
  let totalReward=isNaN(rewardRaw)||rewardRaw<0?0:rewardRaw;
  const curve=getAffairCurve();
  const achEnabled=document.getElementById('affairAchEnabled').checked;
  const achAmount=Math.max(0,Number(document.getElementById('affairAchAmount').value)||0);
  const domainId=document.getElementById('affairDomain').value||null;
  const plannedAt=fromLocalInput(document.getElementById('affairPlannedAt').value);
  const steps=readAffairSteps();
  if(!name||rewardInvalid){
    // 校验失败时展开所在分组并聚焦字段，避免错误被折叠藏起来
    expandAffairAcc('basic');
    const errs=[];
    if(!name)errs.push({field:'affairName',msg:'请输入项目名称'});
    if(rewardInvalid)errs.push({field:'affairReward',msg:'总奖励需 ≥ 0'});
    const first=rejectFields('affairModal',errs);
    if(!first)toast(errs[0].msg,'err');
    return;
  }
  const budget=readBudgetBinding('affair');
  const ach={enabled:achEnabled,amount:achEnabled?achAmount:0};
  // 步骤委派（引用已有杂事 / 就地新建）与项目本身必须在同一条事务里落盘：
  // 候选校验失败不下发任何写入；就地新建的杂事由 Ledger 快照随事务一起回滚。
  const r=runCommand({
    label:id?'affair-edit':'affair-create',
    run:function(){
      const resolved=resolveDelegatedSteps(id,steps);
      if(!resolved.ok)return {ok:false,reason:resolved.reason};
      const finalSteps=resolved.steps;
      if(id){
        const a=state.affairs.find(function(x){return x.id===id;});
        if(!a)return {ok:false,reason:'项目已不存在'};
        a.name=name;a.totalReward=totalReward;a.curve=curve;a.ach=ach;a.domainId=domainId;
        if(!a.doneAt)a.plannedAt=plannedAt;
        a.steps=finalSteps;
        a.budget=budget;
        Ledger.event('修改项目「'+name+'」','affair-edit');
      }else{
        state.affairs.push({id:uid(),name:name,totalReward:totalReward,curve:curve,currentCell:0,alreadyGiven:0,domainId:domainId,plannedAt:plannedAt,steps:finalSteps,ach:ach,createdAt:now(),startedAt:null,doneAt:null,budget:budget});
        Ledger.event('创建项目「'+name+'」','affair-create');
      }
      return {toast:{msg:id?'项目已更新':'项目已创建'}};
    }
  });
  if(!r.ok){
    // 步骤/委派校验失败时展开步骤分组，让错误原因有可定位的落点
    const stepIssue=editAffairSteps.some(function(s){
      return !!(s&&(stepChoreRef(s)||(typeof s.pendingChoreName==='string'&&s.pendingChoreName.trim())));
    });
    if(stepIssue)expandAffairAcc('steps');
    return;
  }
  affairOpenSnapshot='';
  closeModal('affairModal');
}

// 删除项目：有未完成的委派杂事时，先让用户选「回杂事池」还是「一起删除」；
// 没有委派杂事时保持原来的确认删除流程。
function delAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const chores=affairDeletionChores(a);
  if(!chores.length){
    if(!confirm('删除项目「'+a.name+'」？'))return;
    applyAffairDelete(id,false);
    return;
  }
  openAffairDeleteModal(a,chores);
}
// 选择面板：沿用现有模态外观；取消（关闭）不产生任何写入。
function openAffairDeleteModal(a,chores){
  const idEl=document.getElementById('affairDeleteId');
  if(idEl)idEl.value=a.id;
  const titleEl=document.getElementById('affairDeleteTitle');
  if(titleEl)titleEl.textContent='删除项目「'+a.name+'」';
  const hintEl=document.getElementById('affairDeleteHint');
  if(hintEl)hintEl.textContent='该项目有 '+chores.length+' 条未完成的委派杂事。回杂事池会保留它们；一起删除会把它们从杂事池移除。';
  const listEl=document.getElementById('affairDeleteChores');
  if(listEl){
    listEl.innerHTML=chores.map(function(c){
      return '<li><span>'+esc(c.name)+'</span>'+(c.archived?'<i>已归档</i>':'')+'</li>';
    }).join('');
  }
  openModal('affairDeleteModal');
}
function cancelAffairDelete(){
  closeModal('affairDeleteModal');
}
function confirmAffairDelete(mode){
  const el=document.getElementById('affairDeleteId');
  const id=el?el.value:'';
  closeModal('affairDeleteModal');
  if(!id)return;
  applyAffairDelete(id,mode==='purge');
}
// 两个分支共用同一条命令入口：项目与委派杂事要么一起删除，要么都不动。
function applyAffairDelete(id,purge){
  const r=runCommand({
    label:purge?'affair-del-with-chores':'affair-del',
    toast:purge?'项目与委派杂事已删除，可在面板顶部撤销':'项目已删除，可在面板顶部撤销',
    run:function(){return deleteAffairCore(id,purge?'purge':'pool');}
  });
  if(r.ok)closeAffairModal(true);
  return r;
}
// 恢复被规则归档的项目（归档是可逆状态，不消耗资产）
function restoreAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a||!a.archived)return;
  a.archived=false;delete a.archivedAt;
  Ledger.event('恢复项目「'+a.name+'」','affair-restore',{affairId:a.id});
  commit('已恢复项目「'+a.name+'」');
}

// ===== B5 二：删除撤销条 =====
// 删除后项目卡片消失，撤销入口只能放在面板顶部；没有删除记录时不渲染（不影响对照基线）。
// 数据层本就保留最近 5 条，这里把 5 条全部露出，不扩大上限。
function affairDeleteUndoBarHTML(){
  const list=Array.isArray(state.affairDeleteUndo)?state.affairDeleteUndo:[];
  const recs=list.filter(function(rec){return rec&&rec.affair;}).slice().reverse();
  if(!recs.length)return '';
  return '<div class="affair-empty affair-delete-undo"><div class="affair-delete-undo-head">最近删除 · 最多保留 5 条</div>'
    +recs.map(function(rec){
      const n=Array.isArray(rec.chores)?rec.chores.length:0;
      return '<div class="affair-delete-undo-row">'
        +'<span class="affair-delete-undo-name">已删除「'+esc(rec.affair.name)+'」'+(n?'（含 '+n+' 条杂事）':'')+'</span>'
        +'<button class="btn btn-sm" onclick="undoAffairDelete(\''+rec.id+'\')">撤销删除</button>'
        +'<button class="btn btn-sm" onclick="dismissAffairDeleteUndo(\''+rec.id+'\')">忽略</button>'
        +'</div>';
    }).join('')
    +'</div>';
}
function undoAffairDelete(recId){
  runCommand({
    label:'affair-delete-undo',
    toast:'已恢复删除前的内容',
    run:function(){return restoreAffairDeletion(recId);}
  });
}
function dismissAffairDeleteUndo(recId){
  const list=Array.isArray(state.affairDeleteUndo)?state.affairDeleteUndo:[];
  const i=list.findIndex(function(x){return x&&x.id===recId;});
  if(i<0)return;
  list.splice(i,1);
  commit();
}

function renderAffairSteps(){
  const cont=document.getElementById('affairSteps');
  if(!cont)return;
  if(editAffairSteps.length===0){
    cont.innerHTML='<div class="affair-step-empty">暂无步骤（可选填，保存后可直接「完成」整个项目）</div>';
    affairAccSummaryRefresh();
    return;
  }
  const affairIdEl=document.getElementById('affairId');
  const affairId=affairIdEl?affairIdEl.value:'';
  const last=editAffairSteps.length-1;
  cont.innerHTML=editAffairSteps.map(function(s,i){
    const t=s.plannedAt?toLocalInput(s.plannedAt):'';
    const badge=s.plannedAt?('🕒 '+fmtPlan(s.plannedAt)):'';
    return '<div class="affair-step-row">'
      +'<div class="affair-step-main">'
      +'<button type="button" class="affair-step-move" title="上移" aria-label="上移步骤 '+(i+1)+'"'+(i===0?' disabled':'')+' onclick="affairMoveStep('+i+',-1)">↑</button>'
      +'<button type="button" class="affair-step-move" title="下移" aria-label="下移步骤 '+(i+1)+'"'+(i===last?' disabled':'')+' onclick="affairMoveStep('+i+',1)">↓</button>'
      +'<input type="text" class="affair-step-input" data-i="'+i+'" value="'+escAttr(s.text||'')+'" placeholder="步骤 '+(i+1)+'" maxlength="60" oninput="affairStepInput('+i+',this.value)">'
      +'<button type="button" class="btn btn-sm btn-danger affair-step-del" title="删除步骤" aria-label="删除步骤 '+(i+1)+'" onclick="affairRemoveStep('+i+')">×</button>'
      +'</div>'
      +'<div class="affair-step-sub">'
      +'<input type="datetime-local" class="affair-step-time" value="'+t+'" title="单独安排本步骤执行时间（可选）" oninput="affairStepTime('+i+',this.value)">'
      +'<span class="affair-step-time-badge" id="affairStepBadge'+i+'">'+badge+'</span>'
      +affairStepDelegateHTML(s,i,affairId)
      +'</div>'
      +'</div>';
  }).join('');
  affairAccSummaryRefresh();
}
// 步骤行的「委派杂事」入口：已是委派步骤时显示引用与解除，纯步骤时给出候选下拉 + 就地新建。
function affairStepDelegateHTML(s,i,affairId){
  const ref=stepChoreRef(s);
  if(ref){
    const c=(state.chores||[]).find(function(x){return x.id===ref.id;});
    // 委派的杂事已完成：只在步骤本身还没完成时提示（已完成的步骤再提示只是噪音），
    // 且只做展示，不写 doneAt（项目进度由用户判断，见 affair-delegate.js 的不对称说明）。
    const doneHint=(c&&!s.doneAt&&choreDoneNow(c))
      ?'<span class="affair-step-delegate-hint">委派的杂事已完成</span>':'';
    return '<div class="affair-step-delegate on">'
      +'<span class="affair-step-chore-badge">🔗 '+esc(c?c.name:'（杂事已不存在）')+'<i>'+stepChoreOriginLabel(ref.origin)+'</i></span>'
      +doneHint
      +'<button type="button" class="btn btn-sm" onclick="affairStepUndelegate('+i+')">解除委派</button>'
      +'</div>';
  }
  const pending=(typeof s.pendingChoreName==='string')?s.pendingChoreName.trim():'';
  if(pending){
    return '<div class="affair-step-delegate on">'
      +'<span class="affair-step-chore-badge pending">＋ '+esc(pending)+'<i>保存后创建</i></span>'
      +'<button type="button" class="btn btn-sm" onclick="affairStepUndelegate('+i+')">取消</button>'
      +'</div>';
  }
  const cands=delegationCandidates(affairId,editAffairSteps,i);
  return '<div class="affair-step-delegate">'
    +'<select class="affair-step-chore" onchange="affairStepDelegateExisting('+i+',this.value)">'
    +'<option value="">委派到已有杂事…</option>'
    +cands.map(function(c){return '<option value="'+escAttr(c.id)+'">'+esc(c.name)+'</option>';}).join('')
    +'</select>'
    +'<button type="button" class="btn btn-sm" title="新建一条杂事并委派给此步骤" onclick="affairStepDelegateNew('+i+')">＋<span class="affair-delegate-new-label"> 新建</span></button>'
    +'</div>';
}
// 以下三个动作只改编辑草稿；保存时由 resolveDelegatedSteps 在同一个事务里落盘。
function affairStepDelegateExisting(i,choreId){
  const s=editAffairSteps[i];
  const id=String(choreId||'').trim();
  if(!s||!id)return;
  const ref=makeChoreRef(id,'existing');
  if(!ref)return;
  s.choreRef=ref;
  delete s.pendingChoreName;
  renderAffairSteps();
}
function affairStepDelegateNew(i){
  const s=editAffairSteps[i];
  if(!s)return;
  const raw=window.prompt('新杂事名称',(s.text||'').trim());
  if(raw===null)return;
  const name=String(raw).trim();
  if(!name){toast('请输入杂事名称','err');return;}
  s.pendingChoreName=name;
  delete s.choreRef;
  renderAffairSteps();
}
function affairStepUndelegate(i){
  const s=editAffairSteps[i];
  if(!s)return;
  delete s.choreRef;
  delete s.pendingChoreName;
  renderAffairSteps();
}
function affairStepInput(i,v){if(editAffairSteps[i])editAffairSteps[i].text=v;}
function affairStepTime(i,v){
  if(!editAffairSteps[i])return;
  editAffairSteps[i].plannedAt=fromLocalInput(v);
  const b=document.getElementById('affairStepBadge'+i);
  if(b)b.textContent=editAffairSteps[i].plannedAt?('🕒 '+fmtPlan(editAffairSteps[i].plannedAt)):'';
}
function affairAddStep(){editAffairSteps.push({stepId:uid(),text:'',doneAt:null,plannedAt:null});renderAffairSteps();}
// 上下移动步骤：整体交换步骤对象，stepId / doneAt / 委派引用都跟着走
function affairMoveStep(i,delta){
  const j=i+(Number(delta)||0);
  if(i<0||i>=editAffairSteps.length||j<0||j>=editAffairSteps.length)return;
  const tmp=editAffairSteps[i];
  editAffairSteps[i]=editAffairSteps[j];
  editAffairSteps[j]=tmp;
  renderAffairSteps();
}
function affairRemoveStep(i){editAffairSteps.splice(i,1);renderAffairSteps();}
function readAffairSteps(){
  // 委派步骤的引用随步骤一起保存：编辑名称/时间时不能把 choreRef 冲掉（否则杂事会被动回池）。
  // stepId 同理必须保留：丢了会让同一步骤在两次快照之间换身份，撤销就对不上。
  // pendingChoreName 只是编辑草稿：保存时由 resolveDelegatedSteps 换成真实杂事 id 后删除。
  const seen=Object.create(null);
  return editAffairSteps.filter(function(s){return s&&s.text&&s.text.trim();})
    .map(function(s){
      // 老存档里没 id 的步骤在这里补一次；保存即落盘，之后跨读档保持同一个 id。
      let sid=typeof s.stepId==='string'?s.stepId.trim():'';
      if(!sid||seen[sid]){sid=uid();}
      seen[sid]=true;
      const out={stepId:sid,text:s.text.trim(),doneAt:s.doneAt||null,plannedAt:s.plannedAt||null};
      const ref=stepChoreRef(s);
      if(ref)out.choreRef={id:ref.id,origin:ref.origin};
      const pending=typeof s.pendingChoreName==='string'?s.pendingChoreName.trim():'';
      if(pending&&!ref)out.pendingChoreName=pending;
      return out;
    });
}
function affairCurvePreview(){
  const total=Number(document.getElementById('affairReward').value)||0;
  const vals=editAffairCurve.values;
  let pts='';
  for(let i=0;i<10;i++){pts+='<b>'+(i+1)+'</b><i>'+fmt(round2(vals[i]/100*total))+'</i>';}
  return pts;
}
function affairCurveRefresh(){
  const p=document.getElementById('affairCurvePreview');
  if(p)p.innerHTML=affairCurvePreview();
  affairAccSummaryRefresh();
}
function setAffairCurve(type){
  editAffairCurve.type=type;
  document.querySelectorAll('#affairCurveRow .curve-btn').forEach(function(b){b.classList.toggle('on',b.dataset.curve===type);});
  if(type!=='custom'&&AFFAIR_CURVES[type])editAffairCurve.values=AFFAIR_CURVES[type].slice();
  const custom=document.getElementById('affairCurveCustom');
  if(custom){custom.style.display=(type==='custom')?'':'none';if(type==='custom')renderAffairCurveCustom();}
  const prev=document.getElementById('affairCurvePreview');
  if(prev)prev.innerHTML=affairCurvePreview();
}
function renderAffairCurveCustom(){
  const cont=document.getElementById('affairCurveCustom');
  if(!cont)return;
  cont.innerHTML=editAffairCurve.values.map(function(v,i){
    return '<label class="curve-cell"><span>'+(i+1)+'</span><input type="number" min="0" max="100" step="1" value="'+v+'" data-i="'+i+'" oninput="affairCurveInput('+i+',this.value)"></label>';
  }).join('');
}
function affairCurveInput(i,v){
  const n=Number(v);if(!isNaN(n))editAffairCurve.values[i]=Math.max(0,Math.min(100,n));
  const prev=document.getElementById('affairCurvePreview');
  if(prev)prev.innerHTML=affairCurvePreview();
}
function getAffairCurve(){
  const type=editAffairCurve.type;
  const values=editAffairCurve.values.slice();
  values[9]=100;
  return {type:type,values:values};
}
function toggleAffairAch(){
  const on=document.getElementById('affairAchEnabled').checked;
  const row=document.getElementById('affairAchAmountRow');
  if(row)row.style.display=on?'':'none';
  affairAccSummaryRefresh();
}
// 以下四个动作只改项目面板的展示状态（affairView / affairDoneOpen / affairCalCursor / affairCalSelected
// 仅在 renderAffairs 内被读取），不写账、不改分数，局部重绘即可。
function toggleAffairView(){affairView=(affairView==='cal'?'list':'cal');affairCalSelected=null;renderPanel('work.affairs');}
function toggleAffairDone(){affairDoneOpen=!affairDoneOpen;renderPanel('work.affairs');}
function affairSelectDay(ts){affairCalSelected=ts;renderPanel('work.affairs');}
function affairCalShift(d){
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  let y=affairCalCursor.y,m=affairCalCursor.m+d;
  if(m<0){m=11;y--;}else if(m>11){m=0;y++;}
  affairCalCursor={y:y,m:m};
  affairCalSelected=null;
  renderPanel('work.affairs');
}

function taskCardHTML(t,collId){
  const v=taskCardView(t);
  const c=v.checkIn;
  const s=v.skip;
  const staged=v.staged;
  const hasV=v.hasV;
  const hasP=v.hasP;
  const posClass=hasP?'pos p':'pos';
  const typeTag=v.typeTags.map(function(x){return tagHTML(x.kind,x.text);}).join('');
  const sign=v.sign;
  const cost=v.cost;
  // Use effective streak for display consistency with calcCheckIn
  const curStreak=v.streak;

  // Preview: show check-in result and skip penalty
  let prev='';
  prev+='<span style="color:var(--text-2)">打卡</span> <span class="'+posClass+'">'+sign+fmt(c.net)+'</span>';
  if(c.bonus>0)prev+=' <span class="'+posClass+'">(连胜'+c.newStreak+'天 +'+fmt(c.bonus)+')</span>';
  if(c.debt>0)prev+=' <span class="neg">(抵扣待扣债-'+fmt(c.debt)+')</span>';
  if(cost>0)prev+=' <span class="neg">(活力-'+fmt(cost)+')</span>';

  if(s.debt>0){
    prev+='　<span style="color:var(--text-2)">不打卡</span> <span class="neg">待扣债+'+fmt(s.debt)+'</span>';
  }else if(c.isFirst){
    prev+='　<span style="color:var(--text-3)">不打卡：无惩罚</span>';
  }else if(c.gapDays<=0){
    prev+='　<span style="color:var(--text-3)">已打卡</span>';
  }else if(c.gapDays===1){
    prev+='　<span style="color:var(--text-3)">今日未打卡，明日累积待扣债</span>';
  }else{
    prev+='　<span style="color:var(--text-3)">已断更'+(c.gapDays-1)+'天</span>';
  }

  const domTags=!v.isV?v.domainNames.map(function(n){return tagHTML('d',esc(n));}).join(''):'';
  const streakTag=curStreak>0?tagHTML('d','连胜'+curStreak+'天'):'';

  // Exemption asset eligibility
  const canExempt=v.exemption.canExempt;
  const exemptLabel=v.exemption.label;
  const exemptBtn=canExempt
    ?'<button class="btn btn-sm btn-exempt" title="消耗 1 个配置了「任务豁免」的资产" onclick="useTaskExemption(\''+t.id+'\')">豁免·'+exemptLabel+'</button>'
    :'';

  const checkinBtn=v.checkedToday
    ?'<button class="btn btn-sm btn-checkin" disabled title="今日已打卡，明天再来">今日已打卡</button>'
    :'<button class="btn btn-sm btn-checkin" onclick="checkIn(\''+t.id+'\')" '+(cost>0&&state.scores.vitality<cost?'title="活力点不足，将进入负值（贷款）"':'')+'>打卡</button>';
  return '<div class="card task-card'+(revealedTaskId===t.id?' revealed':'')+'" data-task-id="'+t.id+'" data-coll-id="'+(collId||'')+'">'
    +'<div class="task-row">'
    +'<div class="task-title-wrap">'
    +(hasV?'<span class="tdot v" title="活力点"></span>':'')+(hasP?'<span class="tdot p" title="进度值"></span>':'')
    +'<span class="card-title">'+esc(t.name)+'</span>'+budgetBadgeHTML(t)
    +'</div>'
    +actionsRowHTML('task-row-actions',dragHandleHTML('拖拽排序')+checkinBtn)
    +'</div>'
    +(staged?'<div class="task-stage-row">'+stageBarHTML(t)+'</div>':'')
    +'<div class="task-extra">'
    +'<div class="card-top">'
    +'<div>'+typeTag+domTags+streakTag+'</div>'
    +actionsRowHTML('card-actions',dragHandleHTML('拖拽排序')+'<button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button>')
    +'</div>'
    +'<div class="card-meta">'
    +'<span>初始 <b>'+fmt(t.initialValue)+'</b></span>'
    +'<span>利率 <b>'+fmt(t.interestRate)+'%</b>/连胜天</span>'
    +'<span>债率 <b>'+fmt(t.debtRate)+'%</b>/断更天</span>'
    +(cost>0?'<span style="color:var(--vitality)">活力消耗 <b>'+fmt(cost)+'</b></span>':'')
    +'<span>打卡 <b>'+(t.checkInCount||0)+'</b>次</span>'
    +'<span>上次 <b>'+fmtTime(t.lastCheckIn)+'</b></span>'
    +'</div>'
    +'<div class="card-bottom">'
    +(staged?stageBarHTML(t):'<div class="preview">'+prev+'</div>')
    +checkinBtn
    +exemptBtn
    +'</div>'
    +'</div>'
    +'</div>';
}

// ===== 任务卡片：点击标题展开详情，再点标题收起；点页面空白处也收起 =====
// 展开状态只记 id（revealedTaskId）：整块重渲染后 taskCardHTML 会按 id 补回 revealed 类，
// 不再依赖会被 innerHTML 重写丢弃的 DOM 引用。
function initTaskReveal(){
  document.addEventListener('click',function(e){
    const title=e.target.closest?e.target.closest('.task-title-wrap'):null;
    if(title){
      const card=title.closest('.task-card');
      if(!card)return;
      const id=card.dataset?String(card.dataset.taskId||''):'';
      const wasOpen=!!id&&id===revealedTaskId;
      closeTaskReveal();
      if(!wasOpen){card.classList.add('revealed');revealedTaskId=id||null;}
      return;
    }
    // 点卡片内的操作按钮/详情区不收起；点卡片外空白处、或切换到另一张卡片时收起
    const card=e.target.closest?e.target.closest('.task-card'):null;
    const id=card&&card.dataset?String(card.dataset.taskId||''):'';
    if(!card||!revealedTaskId||id!==revealedTaskId)closeTaskReveal();
  });
  // 长按卡片不弹系统右键/文本选择菜单（卡片已 user-select:none，这里兜底）
  document.addEventListener('contextmenu',function(e){
    if(e.target.closest&&e.target.closest('.task-card'))e.preventDefault();
  });
}
function closeTaskReveal(){
  revealedTaskId=null;
  document.querySelectorAll('.task-card.revealed').forEach(function(c){c.classList.remove('revealed');});
}

function achCardHTML(a,domId){
  const prog=domainProgress(a.domainId);
  // 门槛为 0 时避免 0/0 产生 NaN 宽度
  const pct=a.threshold>0?Math.min(100,(prog/a.threshold)*100):(prog>0?100:0);
  return '<div class="card" data-ach-id="'+a.id+'" data-dom-id="'+(domId||a.domainId)+'">'
    +'<div class="card-top">'
    +'<div>'+tagHTML('a','成果')+'<span class="card-title">'+(a.unlocked?'✓ ':'')+esc(a.name)+'</span></div>'
    +actionsRowHTML('card-actions',dragHandleHTML('拖拽排序')+'<button onclick="openAchModal(\''+a.id+'\')">编辑</button><button class="del" onclick="confirmDelAch(\''+a.id+'\')">删除</button>')
    +'</div>'
    +'<div class="card-meta">'
    +'<span>领域 <b>'+esc(domainName(a.domainId))+'</b></span>'
    +'<span>门槛 <b>'+fmt(a.threshold)+'</b></span>'
    +'<span>奖励 <b>'+fmt(a.points)+'</b>成果点</span>'
    +(a.unlocked?'<span style="color:var(--achievement)">已解锁 · '+fmtTime(a.unlockedAt)+'</span>':'<span>当前 '+fmt(prog)+'/'+fmt(a.threshold)+'</span>')
    +'</div>'
    +(a.unlocked?'':'<div class="prog-bar"><div class="prog-fill" style="width:'+pct+'%"></div></div>')
    +'</div>';
}

registerWorkUiState({
  reset:function(){affairView='list';affairCalCursor=null;affairCalSelected=null;affairDoneOpen=false;revealedTaskId=null;resetChoreUiState();},
  closeChoreDoneZone:closeChoreDoneZone
});

export { affairView, affairCalCursor, affairCalSelected, affairDoneOpen, choreDoneOpen, choreArchivedOpen, editAffairSteps, setScoreCell, renderWork, frSameDay, fmtClock, fmtPlan, fmtDateCal, toLocalInput, fromLocalInput, editAffairCurve, affairTags, editPresetCurve, renderAffairPresetsHTML, applyAffairPreset, openPresetModal, presetCurvePreview, presetCurveRefresh, setPresetCurve, renderPresetCurveCustom, presetCurveInput, getPresetCurve, togglePresetAch, savePreset, delPreset, renderAffairs, affairStatusLine, affairAxisHTML, affairZoneStart, AFFAIR_ZONE_END, doneZoneHTML, toggleAffairZone, affairMoreBtn, affairMenuTarget, toggleAffairMenu, closeAffairMenu, affairInProgressCardHTML, affairScheduleCardHTML, affairDraftCardHTML, affairDoneCardHTML, affairUnits, affairStepUnitCardHTML, renderTodayAgenda, jumpToAgendaItem, renderAffairSchedule, renderAffairCalendar, addAffairFromInput, applyAffairValue, reverseAffairValue, affairApplyProgress, AFFAIR_UNDO_LIMIT, affairCanUndo, affairPushUndo, affairUndoAction, _completeAffairStep, advanceAffairStep, completeAffair, completeAffairStep, initAffairAxes, openAffairPlanModal, saveAffairPlan, openAffairModal, toggleAffairAcc, affairAccSummaryRefresh, affairIsDirty, closeAffairModal, requestAffairModalClose, handleAffairSave, delAffair, undoAffairDelete, dismissAffairDeleteUndo, affairDeleteUndoBarHTML, undoChoreDelete, dismissChoreDeleteUndo, choreDeleteUndoBarHTML, openAffairDeleteModal, cancelAffairDelete, confirmAffairDelete, restoreAffair, renderAffairSteps, affairStepDelegateHTML, affairStepDelegateExisting, affairStepDelegateNew, affairStepUndelegate, affairStepInput, affairStepTime, affairAddStep, affairMoveStep, affairRemoveStep, readAffairSteps, affairCurvePreview, affairCurveRefresh, setAffairCurve, renderAffairCurveCustom, affairCurveInput, getAffairCurve, toggleAffairAch, toggleAffairView, toggleAffairDone, affairSelectDay, affairCalShift, settleChoreBatches, computeChoreDecay, processChoreDecay, addChoreFromInput, toggleChoreDone, toggleChoreDoneZone, fmtChoreDate, choreCardHTML, renderChores, setChoreTagFilter, toggleChoreArchivedZone, restoreChore, toDateInputValue, openChoreModal, saveChore, choreCycleToggle, renderChoreTags, renderChoreTagSuggest, pickChoreTag, addChoreTag, removeChoreTag, readChoreCycleForm, affairConvertToChore, choreConvertFromModal, choreUndoConversionFromModal, delChore, CHORE_CFG_FIELDS, readChoreCfgForm, writeChoreCfgForm, choreCfgInputPreview, openChoreConfigModal, resetChoreConfig, saveChoreConfig, stageBarHTML, taskCardHTML, applyStageBar, updateStageBar, setStageFromX, initStageBars, initTaskReveal, achCardHTML };

registerRenderer('work', renderWork);
registerRenderer('stageBars', initStageBars);
registerRenderer('affairAxes', initAffairAxes);

// 面板级重绘入口（S3-B：能力已可用，现有调用点仍只走全量 render()）
registerPanelTarget('work', renderWork);
registerPanelTarget('work.tasks', renderWorkTasks);
registerPanelTarget('work.chores', renderChores);
registerPanelTarget('work.affairs', renderAffairs);
