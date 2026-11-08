import { registerRenderer } from './render.js';
import { choreCfg, choreFreshDays, choreBaseTs, choreOverdueDays, choreTierRate, choreDailyDecay, choreUnsettled } from './utils.js';
import { checkAchievements, checkIn, useExemption } from './business.js';
import { exemptionActivity } from './conditions.js';
import { STAGE_NAMES, AFFAIR_CURVES } from './constants.js';
import { defaultChoreConfig, normalizeChoreConfig } from './defaults.js';
import { Ledger } from './ledger.js';
import { addDomain, delCollection, delDomain, renameCollection, renameDomain, unlockTask } from './library.js';
import { confirmDelAch, confirmDelTask, openAchModal, openTaskModal } from './modals.js';
import { closeModal, openModal } from './modal-host.js';
import { commit, save } from './persist.js';
import { calcCheckIn, calcSkip, dayKey, dayStartTs, weekStartTs, toNum, round2, stageCellLabel, stageNetAt, stageSel, taskIsStaged, clone, daysSince, esc, escAttr, fmt, fmtTime, getTaskDomainIds, now, taskCheckedToday, taskHasType, taskScoreTypes, uid, affairSteps, affairTotalSteps, affairDoneSteps, affairLastAdvance, affairCurve, affairCurveType, affairTargetAt, affairIsDone } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { drag, filterByDomain, syncMajorCollapse, toggleCollapse, toggleInline } from './ui-events.js';
import { domainName, domainProgress, totalProgress } from './utils.js';
// render-work.js —— 渲染：打工页（任务/项目/杂事/阶段奖励）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let affairView='list';
let affairCalCursor=null;
let affairCalSelected=null;
let affairDoneOpen=false;
let choreDoneOpen=false;
let choreArchivedOpen=false;
let editAffairSteps=[];
// ===== Render: Work =====
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

  const domCount=state.domains.length;
  document.getElementById('wProgressSub').textContent=domCount>1?domCount+'个领域':'';

  // Domain pills (clickable to filter tasks)
  const dp=document.getElementById('domainPills');
  let dpHtml=state.domains.map(d=>{
    const val=domainProgress(d.id);
    const isActive=state.filterDomain===d.id;
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

  // Task groups by collection
  const tg=document.getElementById('taskGroups');
  if(!state.tasks.length){
    tg.innerHTML='<div class="empty"><p>还没有任务，创建一个开始积累分数</p><button class="btn btn-sm" onclick="openTaskModal()">新建任务</button></div>';
  }else{
    let html='';
    state.collections.forEach(c=>{
      const tasks=state.tasks.filter(t=>!t.archived&&t.collectionId===c.id&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
      const isCollapsed=(state.collapsedColls||[]).includes(c.id);
      html+='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="'+c.id+'">';
      // Header (clickable to toggle collapse)
      html+='<div class="coll-header" onclick="toggleCollapse(\'collection\',\''+c.id+'\')">';
      html+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(c.name)+' <span class="coll-count">'+tasks.length+'个任务</span></div>';
      html+='<div class="coll-actions" onclick="event.stopPropagation()">';
      html+='<span class="drag-handle" title="拖拽集合">⋮⋮</span>';
      html+='<button onclick="openTaskModal(null,\''+c.id+'\')">+ 任务</button>';
      if(c.id!=='c_default'){
        html+='<button onclick="renameCollection(\''+c.id+'\')">重命名</button><button onclick="delCollection(\''+c.id+'\')">删除</button>';
      }
      html+='</div>';
      html+='</div>';
      // Body (collapsible)
      html+='<div class="coll-body">';
      if(tasks.length===0){
        html+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无任务 · 拖拽 ⋮⋮ 按钮可排序</p></div>';
      }else{
        html+=tasks.map(t=>taskCardHTML(t,c.id)).join('');
      }
      html+='</div>';
      html+='</div>';
    });
    // Tasks without valid collection
    const noColl=state.tasks.filter(t=>!t.archived&&!state.collections.find(c=>c.id===t.collectionId)&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
    if(noColl.length){
      html+='<div class="coll-group" data-coll-id="_none"><div class="coll-header" onclick="toggleCollapse(\'collection\',\'_none\')"><div class="coll-name"><span class="coll-toggle">▼</span>未分类 <span class="coll-count">'+noColl.length+'个任务</span></div><div class="coll-actions" onclick="event.stopPropagation()"><span class="drag-handle" title="拖拽集合">⋮⋮</span></div></div>';
      html+='<div class="coll-body">'+noColl.map(t=>taskCardHTML(t,'_none')).join('')+'</div>';
      html+='</div>';
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
      ab.innerHTML='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="_archive">'
        +'<div class="coll-header" onclick="toggleCollapse(\'collection\',\'_archive\')">'
        +'<div class="coll-name"><span class="coll-toggle">▼</span>已归档 <span class="coll-count">'+archived.length+'个任务</span></div>'
        +'</div>'
        +'<div class="coll-body">'+archived.map(t=>{
          const cost=3;
          const canUnlock=(state.scores.vitality||0)>=cost;
          return '<div class="card" style="opacity:.7">'
            +'<div class="card-top"><div>'+(taskHasType(t,'progress')?'<span class="tag p">进度值</span>':'')+(taskHasType(t,'vitality')?'<span class="tag v">活力点</span>':'')+'<span class="card-title">'+esc(t.name)+'</span></div>'
            +'<div class="card-actions"><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div></div>'
            +'<div class="card-meta"><span>打卡 '+(t.checkInCount||0)+' 次</span><span>归档于 '+(t.archivedAt?fmtTime(t.archivedAt):'—')+'</span></div>'
            +'<div class="card-bottom"><div class="preview"><span style="color:var(--text-3)">需 '+cost+' 活力点解锁</span></div><button class="btn btn-sm btn-exempt" onclick="unlockTask(\''+t.id+'\')" '+(canUnlock?'':'disabled')+'>解锁</button></div>'
            +'</div>';
        }).join('')+'</div></div>';
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
  if(a.domainId)return '<span class="tag p">'+esc(domainName(a.domainId))+'</span>';
  return '<span class="tag v">活力点</span>';
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
  if(!name){toast('请输入预设名称','err');return;}
  let totalReward=Number(document.getElementById('presetReward').value);
  if(isNaN(totalReward)||totalReward<0)totalReward=0;
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
    html+='<div class="affair-zone collapsed" id="affair-zone-archived">'
      +'<div class="affair-zone-title" onclick="toggleAffairZone(\'archived\')">'
      +'<span class="coll-toggle">▼</span>已归档 <span class="affair-zone-count">'+archived.length+'</span></div>'
      +'<div class="affair-zone-body">'
      +archived.map(function(a){
        return '<div class="card affair-card" style="opacity:.7">'
          +'<div class="affair-row"><div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span></div>'
          +'<div class="affair-actions"><span class="affair-time">归档于 '+(a.archivedAt?fmtTime(a.archivedAt):'—')+'</span>'
          +'<button class="btn btn-sm" onclick="restoreAffair(\''+a.id+'\')">恢复</button></div></div>'
          +'</div>';
      }).join('')
      +'</div></div>';
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
  return '<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="affair-zone-'+key+'">'
    +'<div class="affair-zone-title" onclick="toggleAffairZone(\''+key+'\')">'
    +'<span class="coll-toggle">▼</span>'+title+' <span class="affair-zone-count">'+count+'</span>'
    +(extra||'')
    +'</div>'
    +'<div class="affair-zone-body">';
}
const AFFAIR_ZONE_END='</div></div>';
function doneZoneHTML(done){
  const collapsed=!affairDoneOpen;
  return '<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="affair-zone-done">'
    +'<div class="affair-zone-title" onclick="toggleAffairDone()">'
    +'<span class="coll-toggle">▼</span>已完成 <span class="affair-zone-count">'+done.length+'</span></div>'
    +'<div class="affair-zone-body">'+(done.length?done.map(affairDoneCardHTML).join(''):'<div class="affair-empty">无</div>')+'</div>'
    +'</div>';
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
  menu.innerHTML=
    '<button onclick="openAffairModal(\''+id+'\');closeAffairMenu()">编辑</button>'
    +(canUndo
      ?'<button onclick="affairUndoAction(\''+id+'\');closeAffairMenu()">撤销上一步</button>'
      :'<button disabled>撤销上一步</button>')
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
export function initAffairMenuDismiss(){document.addEventListener('click',function(e){
  if(!affairMenuTarget)return;
  const menu=document.getElementById('affairMenu');
  const path=(e.composedPath&&e.composedPath())||[];
  if(path.indexOf(menu)>=0)return;
  closeAffairMenu();
});}

function affairInProgressCardHTML(a){
  const stall=a.startedAt&&daysSince(a.startedAt)>3;
  return '<div class="card affair-card'+(stall?' stalled':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<button class="btn btn-sm btn-checkin" onclick="advanceAffairStep(\''+a.id+'\')">完成下一步</button>'
    +'</div>'
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairScheduleCardHTML(a,opts){
  const late=opts&&opts.late;
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<span class="affair-time">'+(opts&&opts.time?opts.time:fmtPlan(a.plannedAt))+'</span>'
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffair(\''+a.id+'\')">完成</button>'
    +'</div>'
    +'</div>'
    +'</div>';
}

function affairDraftCardHTML(a){
  return '<div class="card affair-card" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +'<button class="btn btn-sm" onclick="openAffairPlanModal(\''+a.id+'\')">计划</button>'
    +affairMoreBtn(a)
    +'</div>'
    +'</div>'
    +affairAxisHTML(a)
    +'<div class="affair-meta">'+affairStatusLine(a)+'</div>'
    +'</div>';
}

function affairDoneCardHTML(a){
  return '<div class="card affair-card done" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(a.name)+'</span>'+affairTags(a)+'</div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +affairMoreBtn(a)
    +'<span class="affair-time">✓ '+fmtTime(a.doneAt)+'</span>'
    +'</div>'
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
  return '<div class="card affair-card'+(late?' late':'')+'" data-affair-id="'+a.id+'" onclick="openAffairModal(\''+a.id+'\')">'
    +'<div class="affair-row">'
    +'<div class="affair-name-wrap"><span class="affair-name">'+esc(s.text)+'</span></div>'
    +'<div class="affair-actions" onclick="event.stopPropagation()">'
    +'<span class="affair-time">'+(opts&&opts.time?opts.time:fmtClock(u.ts))+'</span>'
    +'<button class="btn btn-sm btn-checkin" onclick="completeAffairStep(\''+a.id+'\','+i+')">完成</button>'
    +'</div>'
    +'</div>'
    +'<div class="affair-meta"><span class="affair-sub">'+esc(a.name)+' · 第 '+(i+1)+'/'+affairTotalSteps(a)+' 步</span></div>'
    +'</div>';
}

function renderAffairSchedule(){
  const units=affairUnits();
  const nowTs=Date.now();
  const todayStart=dayStartTs(nowTs);
  const tomorrowStart=todayStart+864e5;
  const dayAfter=tomorrowStart+864e5;
  const weekEnd=weekStartTs(1,nowTs)+7*864e5;
  function bucket(ts){
    if(ts<tomorrowStart)return 'today';
    if(ts<dayAfter)return 'tomorrow';
    if(ts<weekEnd)return 'week';
    return 'later';
  }
  const defs=[{key:'today',title:'今天'},{key:'tomorrow',title:'明天'},{key:'week',title:'本周'},{key:'later',title:'之后'}];
  let html='';
  defs.forEach(function(d){
    const items=units.filter(function(u){return bucket(u.ts)===d.key;}).sort(function(a,b){return a.ts-b.ts;});
    html+='<div class="affair-day-group">'
      +'<div class="affair-day-title">'+d.title+' <span class="affair-zone-count">'+items.length+'</span></div>';
    if(items.length===0){
      html+='<div class="affair-empty">无</div>';
    }else{
      html+=items.map(function(u){
        const late=u.ts<todayStart;
        const timeOnly=(d.key==='today'||d.key==='tomorrow')?fmtClock(u.ts):fmtPlan(u.ts);
        if(u.kind==='step')return affairStepUnitCardHTML(u,{late:late,time:timeOnly});
        return affairScheduleCardHTML(u.affair,{late:late,time:timeOnly});
      }).join('');
    }
    html+='</div>';
  });
  return html;
}

function renderAffairCalendar(){
  const units=affairUnits();
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  const y=affairCalCursor.y,m=affairCalCursor.m;
  const todayTs=dayStartTs(Date.now());
  const first=new Date(y,m,1);
  const firstDow=(first.getDay()+6)%7; // 周一=0
  const startTs=first.getTime()-firstDow*864e5;
  let html='<div class="cal-head">'
    +'<button class="cal-nav" onclick="affairCalShift(-1)">◀</button>'
    +'<div class="cal-title">'+y+'年'+(m+1)+'月</div>'
    +'<button class="cal-nav" onclick="affairCalShift(1)">▶</button>'
    +'</div>';
  html+='<div class="cal-grid">';
  ['一','二','三','四','五','六','日'].forEach(function(w){html+='<div class="cal-dow">'+w+'</div>';});
  for(let i=0;i<42;i++){
    const ts=startTs+i*864e5;
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
function affairApplyProgress(a,cell){
  cell=Math.max(0,Math.min(9,Math.round(cell)));
  Ledger.txn(function(){
    a.currentCell=cell;
    if(cell>0&&!a.startedAt)a.startedAt=now();
    const target=affairTargetAt(a,cell);
    const diff=round2(target-(a.alreadyGiven||0));
    if(diff>0){
      applyAffairValue(a,diff,'项目「'+a.name+'」进度结算');
      a.alreadyGiven=round2(target);
    }
    if(cell>=9&&!a.doneAt){
      a.doneAt=now();
      if(a.ach&&a.ach.enabled&&a.ach.amount>0){
        Ledger.grant('achievement',a.ach.amount,{src:'affair',desc:'完成项目「'+a.name+'」',affairId:a.id});
        toast('项目「'+a.name+'」完成 · 成果点 +'+fmt(a.ach.amount),'warn');
      }else{
        toast('项目「'+a.name+'」已完成');
      }
    }
  },{label:'affair-progress',save:'none',render:false});
}

// ===== 撤销（快照持久化到 state，限量保留）=====
const AFFAIR_UNDO_LIMIT=5;
function affairCanUndo(a){const s=(state.affairUndo&&state.affairUndo[a.id]);return !!(s&&s.length);}
function affairPushUndo(a){
  if(!state.affairUndo)state.affairUndo={};
  const stack=state.affairUndo[a.id]||(state.affairUndo[a.id]=[]);
  // 步骤完成态也要进快照：只存 currentCell/alreadyGiven 无法回退 s.doneAt，
  // 撤销后步骤仍显示已完成，与项目进度不一致。
  stack.push({
    cell:a.currentCell||0,given:a.alreadyGiven||0,doneAt:a.doneAt||null,startedAt:a.startedAt||null,
    steps:(a.steps||[]).map(function(s){return s?{doneAt:s.doneAt||null}:null;})
  });
  if(stack.length>AFFAIR_UNDO_LIMIT)stack.shift();
}
function affairUndoAction(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const stack=(state.affairUndo&&state.affairUndo[a.id])||[];
  const snap=stack.pop();
  if(!snap){toast('没有可撤销的操作','warn');return;}
  const revoked=round2((a.alreadyGiven||0)-(snap.given||0));
  const txr=Ledger.txn(function(){
    if(revoked>0)reverseAffairValue(a,revoked,'撤销项目「'+a.name+'」推进');
    if(!!a.doneAt&&!snap.doneAt&&a.ach&&a.ach.enabled&&a.ach.amount>0){
      Ledger.grant('achievement',-a.ach.amount,{src:'affair',desc:'撤销项目「'+a.name+'」成果点',affairId:a.id});
    }
    a.currentCell=snap.cell;a.alreadyGiven=snap.given;a.doneAt=snap.doneAt;a.startedAt=snap.startedAt;
    if(Array.isArray(snap.steps)&&Array.isArray(a.steps)){
      a.steps.forEach(function(s,i){if(s&&snap.steps[i])s.doneAt=snap.steps[i].doneAt;});
    }
  },{label:'affair-undo',save:'none',render:false});
  if(!txr.ok)return;
  commit('已撤销「'+a.name+'」');
}

function _completeAffairStep(a,s){
  // 步骤完成态与进度结算必须同生共死：任何一笔发放失败时，s.doneAt 也不能留下
  const txr=Ledger.txn(function(){
    affairPushUndo(a);
    s.doneAt=now();
    const steps=affairSteps(a);
    const allDone=steps.every(function(x){return x.doneAt;});
    affairApplyProgress(a,allDone?9:Math.min(8,(a.currentCell||0)+1));
  },{label:'affair-step',save:'none',render:false});
  if(!txr.ok)return;
  commit();
}
function advanceAffairStep(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a||a.doneAt)return;
  const next=affairSteps(a).find(function(s){return !s.doneAt;});
  if(!next){
    // 快照必须在事务内压栈：发放失败回滚时连 undo 栈一起还原，避免留下无效快照
    const txr=Ledger.txn(function(){affairPushUndo(a);affairApplyProgress(a,9);},{label:'affair-complete',save:'none',render:false});
    if(!txr.ok)return;
    commit();
    return;
  }
  _completeAffairStep(a,next);
}
function completeAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt){toast('该项目已完成','warn');return;}
  const txr=Ledger.txn(function(){affairPushUndo(a);affairApplyProgress(a,9);},{label:'affair-complete',save:'none',render:false});
  if(!txr.ok)return;
  commit();
}
function completeAffairStep(id,idx){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(a.doneAt){toast('该项目已完成','warn');return;}
  const steps=affairSteps(a);
  const s=steps[idx];
  if(!s){toast('步骤不存在','warn');return;}
  if(s.doneAt){toast('该步骤已完成','warn');return;}
  _completeAffairStep(a,s);
}

// ===== 无步骤事务：进度轴拖拽推进 =====
function initAffairAxes(){
  const THRESH=8;
  document.querySelectorAll('.affair-axis.draggable').forEach(function(axis){
    const track=axis.querySelector('.stage-track');
    if(!track||track._affairBound)return;
    track._affairBound=true;
    const id=axis.dataset.affairId;
    let startX=0,startY=0,startCell=0,pid=0;
    let dragging=false,decided=false,abandoned=false,pushed=false;
    function setCellFromX(clientX){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      const rect=track.getBoundingClientRect();
      let p=(clientX-rect.left)/rect.width;
      p=Math.max(0,Math.min(1,p));
      let cell=Math.floor(p*10);if(cell>9)cell=9;if(cell<0)cell=0;
      if(cell<=startCell)return;
      if(!pushed){affairPushUndo(a);pushed=true;}
      affairApplyProgress(a,cell);
      const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';
    }
    track.addEventListener('pointerdown',function(e){
      const a=state.affairs.find(function(x){return x.id===id;});
      if(!a||a.doneAt)return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      startCell=a.currentCell||0;
      dragging=false;decided=false;abandoned=false;pushed=false;
    });
    track.addEventListener('pointermove',function(e){
      if(e.pointerId!==pid||decided)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
      if(Math.abs(dx)>Math.abs(dy)){
        decided=true;dragging=true;
        if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
        e.preventDefault();
        setCellFromX(e.clientX);
      }else{
        decided=true;abandoned=true;
      }
    });
    function end(e){
      if(e&&e.pointerId!==pid)return;
      if(pushed){commit();}
      dragging=false;decided=false;abandoned=false;pushed=false;
    }
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
  });
}

function openAffairPlanModal(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  document.getElementById('affairPlanId').value=id;
  document.getElementById('affairPlanInput').value=a.plannedAt?toLocalInput(a.plannedAt):'';
  openModal('affairPlanModal');
}

function saveAffairPlan(){
  const id=document.getElementById('affairPlanId').value;
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  const v=document.getElementById('affairPlanInput').value;
  if(!v){toast('请选择日期时间','err');return;}
  a.plannedAt=fromLocalInput(v);
  save();
  closeModal('affairPlanModal');
  toast('已规划项目「'+a.name+'」');
  render();
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
  openModal('affairModal');
  setTimeout(function(){document.getElementById('affairName').focus();},50);
}

function handleAffairSave(){
  const id=document.getElementById('affairId').value;
  const name=document.getElementById('affairName').value.trim();
  let totalReward=Number(document.getElementById('affairReward').value);
  if(isNaN(totalReward)||totalReward<0)totalReward=0;
  const curve=getAffairCurve();
  const achEnabled=document.getElementById('affairAchEnabled').checked;
  const achAmount=Math.max(0,Number(document.getElementById('affairAchAmount').value)||0);
  const domainId=document.getElementById('affairDomain').value||null;
  const plannedAt=fromLocalInput(document.getElementById('affairPlannedAt').value);
  const steps=readAffairSteps();
  if(!name){toast('请输入项目名称','err');return;}
  const ach={enabled:achEnabled,amount:achEnabled?achAmount:0};
  if(id){
    const a=state.affairs.find(function(x){return x.id===id;});
    if(!a)return;
    a.name=name;a.totalReward=totalReward;a.curve=curve;a.ach=ach;a.domainId=domainId;
    if(!a.doneAt)a.plannedAt=plannedAt;
    a.steps=steps;
    Ledger.event('修改项目「'+name+'」','affair-edit');
  }else{
    state.affairs.push({id:uid(),name:name,totalReward:totalReward,curve:curve,currentCell:0,alreadyGiven:0,domainId:domainId,plannedAt:plannedAt,steps:steps,ach:ach,createdAt:now(),startedAt:null,doneAt:null});
    Ledger.event('创建项目「'+name+'」','affair-create');
  }
  save();
  closeModal('affairModal');
  toast(id?'项目已更新':'项目已创建');
  render();
}

function delAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a)return;
  if(!confirm('删除项目「'+a.name+'」？'))return;
  state.affairs=state.affairs.filter(function(x){return x.id!==id;});
  Ledger.event('删除项目「'+a.name+'」','affair-del');
  save();
  closeModal('affairModal');
  toast('项目已删除');
  render();
}
// 恢复被规则归档的项目（归档是可逆状态，不消耗资产）
function restoreAffair(id){
  const a=state.affairs.find(function(x){return x.id===id;});
  if(!a||!a.archived)return;
  a.archived=false;delete a.archivedAt;
  Ledger.event('恢复项目「'+a.name+'」','affair-restore',{affairId:a.id});
  commit('已恢复项目「'+a.name+'」');
}

function renderAffairSteps(){
  const cont=document.getElementById('affairSteps');
  if(!cont)return;
  if(editAffairSteps.length===0){
    cont.innerHTML='<div class="affair-step-empty">暂无步骤（可选填，保存后可直接「完成」整个项目）</div>';
    return;
  }
  cont.innerHTML=editAffairSteps.map(function(s,i){
    const t=s.plannedAt?toLocalInput(s.plannedAt):'';
    const badge=s.plannedAt?('🕒 '+fmtPlan(s.plannedAt)):'';
    return '<div class="affair-step-row">'
      +'<div class="affair-step-line">'
      +'<input type="text" class="affair-step-input" data-i="'+i+'" value="'+escAttr(s.text||'')+'" placeholder="步骤 '+(i+1)+'" maxlength="60" oninput="affairStepInput('+i+',this.value)">'
      +'<button type="button" class="btn btn-sm btn-danger" onclick="affairRemoveStep('+i+')">×</button>'
      +'</div>'
      +'<div class="affair-step-line">'
      +'<input type="datetime-local" class="affair-step-time" value="'+t+'" title="单独安排本步骤执行时间（可选）" oninput="affairStepTime('+i+',this.value)">'
      +'<span class="affair-step-time-badge" id="affairStepBadge'+i+'">'+badge+'</span>'
      +'</div>'
      +'</div>';
  }).join('');
}
function affairStepInput(i,v){if(editAffairSteps[i])editAffairSteps[i].text=v;}
function affairStepTime(i,v){
  if(!editAffairSteps[i])return;
  editAffairSteps[i].plannedAt=fromLocalInput(v);
  const b=document.getElementById('affairStepBadge'+i);
  if(b)b.textContent=editAffairSteps[i].plannedAt?('🕒 '+fmtPlan(editAffairSteps[i].plannedAt)):'';
}
function affairAddStep(){editAffairSteps.push({text:'',doneAt:null,plannedAt:null});renderAffairSteps();}
function affairRemoveStep(i){editAffairSteps.splice(i,1);renderAffairSteps();}
function readAffairSteps(){
  return editAffairSteps.filter(function(s){return s&&s.text&&s.text.trim();})
    .map(function(s){return {text:s.text.trim(),doneAt:s.doneAt||null,plannedAt:s.plannedAt||null};});
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
}
function toggleAffairView(){affairView=(affairView==='cal'?'list':'cal');affairCalSelected=null;render();}
function toggleAffairDone(){affairDoneOpen=!affairDoneOpen;render();}
function affairSelectDay(ts){affairCalSelected=ts;render();}
function affairCalShift(d){
  if(!affairCalCursor){const n=new Date();affairCalCursor={y:n.getFullYear(),m:n.getMonth()};}
  let y=affairCalCursor.y,m=affairCalCursor.m+d;
  if(m<0){m=11;y--;}else if(m>11){m=0;y++;}
  affairCalCursor={y:y,m:m};
  affairCalSelected=null;
  render();
}

// ===== 杂事（极简快速清单）=====
// 与「项目」是两个独立入口：杂事只记名称、勾选和可选日期，走批量结算 + 腐化债。
// 超期天数：日期（或创建日）+ 保鲜期之后开始计腐化，当天不算
// 腐化档位：按「超期件数」匹配，返回每件每天的系数
// 批量结算：每 N 件已完成且未结算的杂事发放 Y 活力点（可一次结算多批）
function settleChoreBatches(silent=false){
  const cfg=choreCfg();
  const need=Math.max(1,Math.round(cfg.batchN));
  const pool=choreUnsettled().sort(function(a,b){return (a.doneAt||0)-(b.doneAt||0);});
  const batches=Math.floor(pool.length/need);
  if(batches<=0)return 0;
  const used=pool.slice(0,batches*need);
  const gain=round2(batches*cfg.batchY);
  const txr=Ledger.txn(function(){
    // 标记已结算必须与发放入账同一事务：发放失败时不能把杂事吞成“已结算”
    used.forEach(function(c){c.settled=true;});
    if(gain>0){
      const target=round2((state.scores.vitality||0)+gain);
      Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:gain,desc:'杂事批量结算：'+used.length+' 件',src:'chore-batch',dom:''},reason:{src:'chore-batch'}});
      if(!silent)toast('批量结算 '+used.length+' 件杂事 · 活力点 +'+fmt(gain));
    }else{
      Ledger.event('杂事批量结算：'+used.length+' 件（当前奖励为 0）','chore-batch');
    }
  },{label:'chore-batch',save:'none',render:false});
  return txr.ok?gain:0;
}
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
    const deadline=choreBaseTs(c)+Math.round(choreFreshDays(c))*864e5;
    let start=deadline+864e5;
    if(c.decayKey){
      const p=String(c.decayKey).split('-');
      const last=new Date(Number(p[0]),Number(p[1])-1,Number(p[2])).getTime();
      if(isFinite(last))start=Math.max(start,last+864e5);
    }
    const days=Math.round((today-start)/864e5)+1;
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
  const txr=Ledger.txn(function(){
    const target=round2((state.scores.vitality||0)-r.total);
    Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:-r.total,desc:'杂事腐化债：'+r.charged+' 件超期，累计 '+r.dueDays+' 天',src:'chore-decay',dom:''},reason:{src:'chore-decay'}});
    r.overdue.forEach(function(c){c.decayKey=dayKey(r.today);});
  },{label:'chore-decay',save:silent?'none':undefined,render:false});
  return txr.ok?r.total:0;
}
function addChoreFromInput(){
  const inp=document.getElementById('choreInput');
  if(!inp)return;
  const name=inp.value.trim();
  if(!name){toast('请输入杂事内容','err');return;}
  if(!Array.isArray(state.chores))state.chores=[];
  state.chores.push({id:uid(),name:name,done:false,doneAt:null,plannedAt:null,createdAt:now(),settled:false,freshDays:null,decayKey:null});
  Ledger.event('新增杂事「'+name+'」','chore-create');
  save();
  inp.value='';inp.focus();
  render();
}
function toggleChoreDone(id){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(c.done){
    c.done=false;c.doneAt=null;
    // 取消勾选：腐化从今天重新起算；已结算的批次不回退，避免反复领取
    c.decayKey=dayKey(now());
  }else{
    c.done=true;c.doneAt=now();
    c.decayKey=dayKey(now());
    settleChoreBatches();
  }
  commit();
}
function toggleChoreDoneZone(){choreDoneOpen=!choreDoneOpen;render();}
function fmtChoreDate(ts){
  const d=new Date(ts);
  return (d.getMonth()+1)+'/'+d.getDate();
}
function choreCardHTML(c){
  const overdue=choreOverdueDays(c);
  let meta='';
  if(c.plannedAt)meta+='<span class="chore-date">📅 '+fmtChoreDate(c.plannedAt)+'</span>';
  if(overdue>0)meta+='<span class="chore-overdue">超期 '+overdue+' 天</span>';
  return '<div class="card chore-card'+(c.done?' done':'')+(overdue>0?' overdue':'')+'" data-chore-id="'+c.id+'" onclick="openChoreModal(\''+c.id+'\')">'
    +'<label class="chore-check" onclick="event.stopPropagation()">'
    +'<input type="checkbox"'+(c.done?' checked':'')+' onchange="toggleChoreDone(\''+c.id+'\')">'
    +'</label>'
    +'<div class="chore-main">'
    +'<div class="chore-name">'+esc(c.name)+'</div>'
    +(meta?'<div class="chore-meta">'+meta+'</div>':'')
    +'</div>'
    +'</div>';
}
function renderChores(){
  const panel=document.getElementById('chorePanel');
  if(!panel)return;
  const chores=state.chores||[];
  const cfg=choreCfg();
  const visible=chores.filter(function(c){return !c.archived;});
  const archived=chores.filter(function(c){return c.archived;});
  const todo=visible.filter(function(c){return !c.done;}).sort(function(a,b){
    const ap=a.plannedAt||9e15,bp=b.plannedAt||9e15;
    return ap-bp||((b.createdAt||0)-(a.createdAt||0));
  });
  const done=visible.filter(function(c){return c.done;}).sort(function(a,b){return (b.doneAt||0)-(a.doneAt||0);});
  const unsettled=choreUnsettled().length;
  const need=Math.max(1,Math.round(cfg.batchN));
  const rem=unsettled%need;
  const next=rem===0?need:need-rem;
  const readyBatches=Math.floor(unsettled/need);
  const meta=document.getElementById('choreMeta');
  if(meta)meta.textContent=chores.length?('待办 '+todo.length+' · 已完成 '+done.length+(archived.length?' · 已归档 '+archived.length:'')):'';
  let html='<div class="chore-econ-bar">'
    +'<span>单件不发放活力 · 每完成 <b>'+need+'</b> 件 → <b>+'+fmt(cfg.batchY)+'</b> 活力</span>'
    +'<span>'+(readyBatches>0
      ?('有 '+readyBatches+' 批待入账（'+unsettled+' 件）· 完成下一件即入账')
      :('待入账 '+unsettled+' 件 · 再完成 '+next+' 件可结算'))+'</span>'
    +'</div>';
  html+=todo.length?todo.map(choreCardHTML).join(''):'<div class="affair-empty">还没有杂事。输入名称回车，即刻创建。</div>';
  if(done.length){
    const collapsed=!choreDoneOpen;
    html+='<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="chore-zone-done">'
      +'<div class="affair-zone-title" onclick="toggleChoreDoneZone()">'
      +'<span class="coll-toggle">▼</span>已完成 <span class="affair-zone-count">'+done.length+'</span></div>'
      +'<div class="affair-zone-body">'+done.map(choreCardHTML).join('')+'</div>'
      +'</div>';
  }
  if(archived.length){
    const collapsed=!choreArchivedOpen;
    html+='<div class="affair-zone'+(collapsed?' collapsed':'')+'" id="chore-zone-archived">'
      +'<div class="affair-zone-title" onclick="toggleChoreArchivedZone()">'
      +'<span class="coll-toggle">▼</span>已归档 <span class="affair-zone-count">'+archived.length+'</span></div>'
      +'<div class="affair-zone-body">'
      +archived.map(function(c){
        return '<div class="card chore-card" style="opacity:.7">'
          +'<div class="chore-row"><div class="chore-main"><span class="chore-name">'+esc(c.name)+'</span></div>'
          +'<div class="chore-actions"><span class="chore-time">归档于 '+(c.archivedAt?fmtTime(c.archivedAt):'—')+'</span>'
          +'<button class="btn btn-sm" onclick="restoreChore(\''+c.id+'\')">恢复</button></div></div>'
          +'</div>';
      }).join('')
      +'</div></div>';
  }
  panel.innerHTML=html;
}
function toggleChoreArchivedZone(){choreArchivedOpen=!choreArchivedOpen;renderChores();}
function restoreChore(id){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c||!c.archived)return;
  c.archived=false;delete c.archivedAt;
  Ledger.event('恢复杂事「'+c.name+'」','chore-restore',{choreId:c.id});
  commit('已恢复杂事「'+c.name+'」');
}
// 杂事编辑：名称、可选日期、可选覆盖保鲜期
function toDateInputValue(ts){
  if(!ts)return '';
  const d=new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function openChoreModal(id){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  const isEdit=!!c;
  document.getElementById('choreModalTitle').textContent=isEdit?'编辑杂事':'新建杂事';
  document.getElementById('choreId').value=isEdit?c.id:'';
  document.getElementById('choreName').value=isEdit?c.name:'';
  document.getElementById('choreDate').value=isEdit&&c.plannedAt?toDateInputValue(c.plannedAt):'';
  document.getElementById('choreFreshDays').value=isEdit&&typeof c.freshDays==='number'?c.freshDays:'';
  const hint=document.getElementById('choreFreshDefaultHint');
  if(hint)hint.textContent=choreCfg().freshDays;
  document.getElementById('choreDelBtn').style.display=isEdit?'':'none';
  openModal('choreModal');
  if(!isEdit)setTimeout(function(){document.getElementById('choreName').focus();},50);
}
function saveChore(){
  const id=document.getElementById('choreId').value;
  const name=document.getElementById('choreName').value.trim();
  if(!name){toast('请输入杂事名称','err');return;}
  const dv=document.getElementById('choreDate').value;
  const plannedAt=dv?new Date(dv+'T00:00:00').getTime():null;
  const fv=String(document.getElementById('choreFreshDays').value).trim();
  let fresh=null;
  if(fv!==''){
    const n=Number(fv);
    if(!isFinite(n)){toast('保鲜期需为数字','err');return;}
    fresh=Math.max(0,Math.round(n));
  }
  if(!Array.isArray(state.chores))state.chores=[];
  if(id){
    const c=state.chores.find(function(x){return x.id===id;});
    if(!c)return;
    c.name=name;c.plannedAt=plannedAt;c.freshDays=fresh;
    // 日期或保鲜期改动后从今天重新起算腐化，不补扣历史
    c.decayKey=dayKey(now());
    Ledger.event('修改杂事「'+name+'」','chore-edit');
  }else{
    state.chores.push({id:uid(),name:name,done:false,doneAt:null,plannedAt:plannedAt,createdAt:now(),settled:false,freshDays:fresh,decayKey:null});
    Ledger.event('新增杂事「'+name+'」','chore-create');
  }
  closeModal('choreModal');
  commit(id?'杂事已更新':'杂事已创建');
}
function delChore(){
  const id=document.getElementById('choreId').value;
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(!confirm('删除杂事「'+c.name+'」？'))return;
  state.chores=state.chores.filter(function(x){return x.id!==id;});
  // 删除类日志应记为 chore-delete（此前误用了 chore-create）
  Ledger.event('删除杂事「'+c.name+'」','chore-delete');
  closeModal('choreModal');
  commit('杂事已删除');
}
// 杂事经济设置（统一入口；设置后作为所有杂事的默认）
// 表单字段与配置键的映射：读写表单都走这张表，避免 8 个字段散落三处
const CHORE_CFG_FIELDS={
  freshDays:'choreCfgFresh',
  batchN:'choreCfgN',
  batchY:'choreCfgY',
  tier1Max:'choreCfgT1Max',
  tier1Rate:'choreCfgT1Rate',
  tier2Max:'choreCfgT2Max',
  tier2Rate:'choreCfgT2Rate',
  tier3Rate:'choreCfgT3Rate'
};
function readChoreCfgForm(){
  const raw={};
  Object.keys(CHORE_CFG_FIELDS).forEach(function(k){
    const el=document.getElementById(CHORE_CFG_FIELDS[k]);
    if(el)raw[k]=el.value;
  });
  return normalizeChoreConfig(raw);
}
function writeChoreCfgForm(cfg){
  Object.keys(CHORE_CFG_FIELDS).forEach(function(k){
    const el=document.getElementById(CHORE_CFG_FIELDS[k]);
    if(el)el.value=cfg[k];
  });
}
function choreCfgInputPreview(){
  const cont=document.getElementById('choreCfgPreview');
  if(!cont)return;
  const cfg=readChoreCfgForm();
  const ex1=choreDailyDecay(cfg.tier1Max,cfg);
  const ex2=choreDailyDecay(cfg.tier2Max,cfg);
  const ex3=choreDailyDecay(cfg.tier2Max+1,cfg);
  cont.innerHTML='超期 '+cfg.tier1Max+' 件 → '+fmt(ex1)+' 活力/天 · 超期 '+cfg.tier2Max+' 件 → '+fmt(ex2)+' 活力/天 · 超期 '+(cfg.tier2Max+1)+' 件及以上 → '+fmt(ex3)+' 活力/天';
}
function openChoreConfigModal(){
  writeChoreCfgForm(choreCfg());
  choreCfgInputPreview();
  openModal('choreConfigModal');
}
function resetChoreConfig(){
  writeChoreCfgForm(defaultChoreConfig());
  choreCfgInputPreview();
}
function saveChoreConfig(){
  const cfg=readChoreCfgForm();
  state.choreConfig=cfg;
  // 规则收紧/放宽后，腐化债从今天重新起算，避免追溯补扣
  (state.chores||[]).forEach(function(c){
    if(!c.done)c.decayKey=dayKey(now());
  });
  closeModal('choreConfigModal');
  commit('杂事经济设置已保存，作为所有杂事的默认');
}

function stageBarHTML(t){
  const cell=stageSel(t);
  const hasV=taskHasType(t,'vitality');
  const hasP=taskHasType(t,'progress');
  // 阶段预览显示实际结算值：档位值 + 连胜利息 - 待扣债
  const c=calcCheckIn(t);
  let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,c):stageNetAt(t,'progress',cell,c));
  reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,c))+' 进度'):(hasV?' 活力':' 进度');
  const label=stageCellLabel(cell);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  const anchorLabels=STAGE_NAMES.map((n,k)=>'<span'+(k===(cell>>1)?' class="on"':'')+' style="left:'+(k*20)+'%">'+n+'</span>').join('');
  let curStreak=t.streak||0;if(curStreak===0&&t.lastCheckIn)curStreak=1;
  let meta='';if(c.bonus>0)meta+='利息+'+fmt(c.bonus);
  if(curStreak>0)meta+=(meta?' · ':'')+'连胜'+curStreak+'天';
  const pend=t.pendingDebt||0;if(pend>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend);
  return '<div class="stage-bar" data-tid="'+t.id+'">'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'<div class="stage-labels">'+anchorLabels+'</div>'
    +'<div class="stage-preview">'+label+' · '+reward+(meta?' · '+meta:'')+'</div>'
    +'</div>';
}

function taskCardHTML(t,collId){
  const c=calcCheckIn(t);
  const s=calcSkip(t);
  const staged=taskIsStaged(t);
  const types=taskScoreTypes(t);
  const hasV=types.indexOf('vitality')>=0;
  const hasP=types.indexOf('progress')>=0;
  const isV=!hasP;
  const name=hasV&&hasP?'活力+进度':(hasP?'进度值':'活力点');
  const posClass=hasP?'pos p':'pos';
  const typeTag=hasV&&hasP
    ?'<span class="tag v">活力点</span><span class="tag p">进度值</span>'
    :(hasP?'<span class="tag p">进度值</span>':'<span class="tag v">活力点</span>');
  const sign=c.net>=0?'+':'';
  const cost=t.vitalityCost||0;
  // Use effective streak for display consistency with calcCheckIn
  let curStreak=t.streak||0;
  if(curStreak===0&&t.lastCheckIn)curStreak=1;

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

  const domTags=!isV?getTaskDomainIds(t).map(did=>'<span class="tag d">'+esc(domainName(did))+'</span>').join(''):'';
  const streakTag=curStreak>0?'<span class="tag d">连胜'+curStreak+'天</span>':'';

  // Exemption card eligibility
  const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const checkedToday=taskCheckedToday(t);
  const exemptToday=!!(t.lastExempt&&new Date(t.lastExempt)>=todayStart);
  const cards=(state.cards&&state.cards.exemption)||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const canExempt=ruleEnabled&&cards>0&&!checkedToday&&!exemptToday;
  const exemptLabel=c.gapDays>=2?'补救':'请假';
  const exemptBtn=canExempt
    ?'<button class="btn btn-sm btn-exempt" title="剩余豁免卡 '+cards+' 张" onclick="useExemption(\''+t.id+'\')">豁免·'+exemptLabel+'</button>'
    :'';

  const checkinBtn=checkedToday
    ?'<button class="btn btn-sm btn-checkin" disabled title="今日已打卡，明天再来">今日已打卡</button>'
    :'<button class="btn btn-sm btn-checkin" onclick="checkIn(\''+t.id+'\')" '+(cost>0&&state.scores.vitality<cost?'title="活力点不足，将进入负值（贷款）"':'')+'>打卡</button>';
  return '<div class="card task-card" data-task-id="'+t.id+'" data-coll-id="'+(collId||'')+'">'
    +'<div class="task-row">'
    +'<div class="task-title-wrap">'
    +(hasV?'<span class="tdot v" title="活力点"></span>':'')+(hasP?'<span class="tdot p" title="进度值"></span>':'')
    +'<span class="card-title">'+esc(t.name)+'</span>'
    +'</div>'
    +'<div class="task-row-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span>'+checkinBtn+'</div>'
    +'</div>'
    +(staged?'<div class="task-stage-row">'+stageBarHTML(t)+'</div>':'')
    +'<div class="task-extra">'
    +'<div class="card-top">'
    +'<div>'+typeTag+domTags+streakTag+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div>'
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
    +'</div>'
    +'</div>'
    +'</div>';
}

// ===== 阶段奖励：卡片进度条拖拽 =====
// 单个进度条实例的显示更新（滑块位置 / 档位名高亮 / 数值预览）
function applyStageBar(bar,t,cell){
  if(!bar)return;
  const track=bar.querySelector('.stage-track');
  if(track){const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';}
  bar.querySelectorAll('.stage-labels span').forEach(function(n,k){n.classList.toggle('on',k===(cell>>1));});
  const preview=bar.querySelector('.stage-preview');
  if(preview){
    const hasV=taskHasType(t,'vitality'),hasP=taskHasType(t,'progress');
    const cc=calcCheckIn(t);
    let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,cc):stageNetAt(t,'progress',cell,cc));
    reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,cc))+' 进度'):(hasV?' 活力':' 进度');
    let cs=t.streak||0;if(cs===0&&t.lastCheckIn)cs=1;
    let meta='';if(cc.bonus>0)meta+='利息+'+fmt(cc.bonus);
    if(cs>0)meta+=(meta?' · ':'')+'连胜'+cs+'天';
    const pend2=t.pendingDebt||0;if(pend2>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend2);
    preview.textContent=stageCellLabel(cell)+' · '+reward+(meta?' · '+meta:'');
  }
}
// 同一任务在卡片中存在两个进度条实例（长按展开前 / 展开后），统一按 state 中的唯一值刷新
function updateStageBar(track,tid,cell){
  const t=state.tasks.find(x=>x.id===tid);if(!t)return;
  document.querySelectorAll('.stage-bar[data-tid="'+tid+'"]').forEach(function(bar){
    applyStageBar(bar,t,cell);
  });
}
function setStageFromX(track,tid,clientX){
  const t=state.tasks.find(x=>x.id===tid);if(!t||!taskIsStaged(t))return;
  const rect=track.getBoundingClientRect();
  let p=(clientX-rect.left)/rect.width;
  p=Math.max(0,Math.min(1,p));
  let cell=Math.floor(p*10);if(cell>9)cell=9;if(cell<0)cell=0; // 吸附到 10 个格位 0..9
  if(t.stageRewards)t.stageRewards.last=cell;
  updateStageBar(track,tid,cell);
}
function initStageBars(){
  const THRESH=8;
  document.querySelectorAll('.stage-bar[data-tid]').forEach(function(bar){
    const track=bar.querySelector('.stage-track');
    if(!track||track._stageBound)return;
    track._stageBound=true;
    const tid=bar.dataset.tid;
    let startX=0,startY=0,pid=0;
    let dragging=false,decided=false,abandoned=false,dirty=false;
    track.addEventListener('pointerdown',function(e){
      if(!state.tasks.find(x=>x.id===tid))return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
    track.addEventListener('pointermove',function(e){
      if(e.pointerId!==pid||decided)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
      if(Math.abs(dx)>Math.abs(dy)){
        decided=true;dragging=true;
        if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
        e.preventDefault();
        setStageFromX(track,tid,e.clientX);
        dirty=true;
      }else{
        decided=true;abandoned=true;
      }
    });
    track.addEventListener('pointerup',function(e){
      if(e.pointerId!==pid)return;
      if(dirty)save();
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
    track.addEventListener('pointercancel',function(e){
      if(e.pointerId!==pid)return;
      dragging=false;decided=false;abandoned=false;dirty=false;
    });
  });
}

// ===== 任务卡片：长按 1 秒浮现详情，3 秒后自动淡出 =====
let taskReveal={card:null,timer:null,startX:0,startY:0};
function initTaskReveal(){
  document.addEventListener('pointerdown',function(e){
    const card=e.target.closest?e.target.closest('.task-card'):null;
    if(!card)return;
    // 不拦截交互控件（拖拽把手/按钮等）
    if(e.target.closest&&e.target.closest('.drag-handle,.card-actions,button,a,input,select,textarea,.task-extra,.stage-bar'))return;
    taskReveal.card=card;
    taskReveal.startX=e.clientX;taskReveal.startY=e.clientY;
    clearTimeout(taskReveal.timer);
    taskReveal.timer=setTimeout(function(){showTaskExtra(card);},1000);
  });
  document.addEventListener('pointermove',function(e){
    if(!taskReveal.card)return;
    if(Math.abs(e.clientX-taskReveal.startX)>12||Math.abs(e.clientY-taskReveal.startY)>12){
      clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;
    }
  });
  ['pointerup','pointercancel'].forEach(function(ev){
    document.addEventListener(ev,function(){
      if(taskReveal.card){clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;}
    });
  });
  // 阻止长按触发系统右键/文本选择菜单
  document.addEventListener('contextmenu',function(e){
    if(e.target.closest&&e.target.closest('.task-card'))e.preventDefault();
  });
}
function showTaskExtra(card){
  card.classList.add('revealed');
  clearTimeout(card._taskHideTimer);
  card._taskHideTimer=setTimeout(function(){card.classList.remove('revealed');},3000);
}

function achCardHTML(a,domId){
  const prog=domainProgress(a.domainId);
  // 门槛为 0 时避免 0/0 产生 NaN 宽度
  const pct=a.threshold>0?Math.min(100,(prog/a.threshold)*100):(prog>0?100:0);
  return '<div class="card" data-ach-id="'+a.id+'" data-dom-id="'+(domId||a.domainId)+'">'
    +'<div class="card-top">'
    +'<div><span class="tag a">成果</span><span class="card-title">'+(a.unlocked?'✓ ':'')+esc(a.name)+'</span></div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openAchModal(\''+a.id+'\')">编辑</button><button class="del" onclick="confirmDelAch(\''+a.id+'\')">删除</button></div>'
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

export function resetWorkUiState(){affairView='list';affairCalCursor=null;affairCalSelected=null;affairDoneOpen=false;choreDoneOpen=false;}
export function closeChoreDoneZone(){choreDoneOpen=false;}

export { affairView, affairCalCursor, affairCalSelected, affairDoneOpen, choreDoneOpen, choreArchivedOpen, editAffairSteps, setScoreCell, renderWork, frSameDay, fmtClock, fmtPlan, fmtDateCal, toLocalInput, fromLocalInput, editAffairCurve, affairTags, editPresetCurve, renderAffairPresetsHTML, applyAffairPreset, openPresetModal, presetCurvePreview, presetCurveRefresh, setPresetCurve, renderPresetCurveCustom, presetCurveInput, getPresetCurve, togglePresetAch, savePreset, delPreset, renderAffairs, affairStatusLine, affairAxisHTML, affairZoneStart, AFFAIR_ZONE_END, doneZoneHTML, toggleAffairZone, affairMoreBtn, affairMenuTarget, toggleAffairMenu, closeAffairMenu, affairInProgressCardHTML, affairScheduleCardHTML, affairDraftCardHTML, affairDoneCardHTML, affairUnits, affairStepUnitCardHTML, renderAffairSchedule, renderAffairCalendar, addAffairFromInput, applyAffairValue, reverseAffairValue, affairApplyProgress, AFFAIR_UNDO_LIMIT, affairCanUndo, affairPushUndo, affairUndoAction, _completeAffairStep, advanceAffairStep, completeAffair, completeAffairStep, initAffairAxes, openAffairPlanModal, saveAffairPlan, openAffairModal, handleAffairSave, delAffair, restoreAffair, renderAffairSteps, affairStepInput, affairStepTime, affairAddStep, affairRemoveStep, readAffairSteps, affairCurvePreview, affairCurveRefresh, setAffairCurve, renderAffairCurveCustom, affairCurveInput, getAffairCurve, toggleAffairAch, toggleAffairView, toggleAffairDone, affairSelectDay, affairCalShift, settleChoreBatches, computeChoreDecay, processChoreDecay, addChoreFromInput, toggleChoreDone, toggleChoreDoneZone, fmtChoreDate, choreCardHTML, renderChores, toggleChoreArchivedZone, restoreChore, toDateInputValue, openChoreModal, saveChore, delChore, CHORE_CFG_FIELDS, readChoreCfgForm, writeChoreCfgForm, choreCfgInputPreview, openChoreConfigModal, resetChoreConfig, saveChoreConfig, stageBarHTML, taskCardHTML, applyStageBar, updateStageBar, setStageFromX, initStageBars, taskReveal, initTaskReveal, showTaskExtra, achCardHTML };

registerRenderer('work', renderWork);
registerRenderer('stageBars', initStageBars);
registerRenderer('affairAxes', initAffairAxes);
