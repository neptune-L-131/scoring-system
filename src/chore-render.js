import { claimedChoreIds, choreClaimOf } from './affair-steps.js';
import { checkAchievements } from './business.js';
import { budgetBadgeHTML, budgetBindingHTML, budgetOf, budgetRefOf, commitActionBudget, openBudgetAmountDialog, readBudgetBinding, rememberBudgetDraft, resolveActionBudget, reverseBoundBudget } from './budget-binding.js';
import { choreCycleDueAfter, choreCycleOf, choreMarkCompletion, choreUndoCompletion } from './chore-cycle.js';
import { choreOrderInsert, normalizeChoreTags, sortChoresByOrder, choreTagMatches, choreTagIncludes, choreTagKey, collectChoreTags } from './chore-list.js';
import { runCommand } from './command.js';
import { CHORE_TAG_MAX_COUNT, CHORE_TAG_MAX_LEN } from './constants.js';
import { defaultChoreConfig, normalizeChoreConfig } from './defaults.js';
import { affairToChore, choreToAffair, conversionUndoState, lastConversion, undoConversion } from './entity-convert.js';
import { makeChoreCompletedEvent } from './events.js';
import { markModalClean, rejectFields } from './form-contract.js';
import { Ledger } from './ledger.js';
import { deleteChoreCore, restoreChoreDeletion } from './library.js';
import { closeModal, openModal } from './modal-host.js';
import { commit, save } from './persist.js';
import { dayKey, round2, esc, escAttr, fmt, fmtTime, now, uid } from './pure.js';
import { render } from './render.js';
import { renderPanel } from './render-targets.js';
import { fillDomainChecklist } from './shell.js';
import { state } from './state.js';
import { addDays, dayStart } from './time.js';
import { toast } from './toast.js';
import { choreCfg, choreDailyDecay, choreDoneNow, choreMarkSettled, choreSettlePool, choreProgressParts } from './utils.js';
import { choreCardView } from './view-models.js';
import { actionsRowHTML, dragHandleHTML, emptyHTML, tagHTML, zoneHTML } from './view-primitives.js';

// chore-render.js —— 杂事面板：清单/卡片/弹窗/标签/周期/配置（从 render-work.js 原样抽出，行为不变）

let choreDoneOpen=false;
let choreArchivedOpen=false;
let choreDraftTags=[];
// 最近一次渲染的候选（点击时按索引回填，避免重新计算后错位）
let choreTagSuggestCache=[];
// 待办池情境筛选：模块内临时状态，不写 state，刷新即回到「全部」
let choreTagFilter='';

// ===== 杂事（极简快速清单）=====
// 与「项目」是两个独立入口：杂事只记名称、勾选和可选日期，走批量结算 + 腐化债。
// 超期天数：日期（或创建日）+ 保鲜期之后开始计腐化，当天不算
// 腐化档位：按「超期件数」匹配，返回每件每天的系数
// 批量结算：每 N 件已完成且未结算的杂事发放 Y 活力点（可一次结算多批）
function settleChoreBatches(silent=false){
  const cfg=choreCfg();
  const need=Math.max(1,Math.round(cfg.batchN));
  const pool=choreSettlePool().sort(function(a,b){return a.at-b.at;});
  const batches=Math.floor(pool.length/need);
  if(batches<=0)return 0;
  const used=pool.slice(0,batches*need);
  const gain=round2(batches*cfg.batchY);
  let msg='';
  const r=runCommand({
    label:'chore-batch',save:false,render:false,silentFail:true,
    run:function(){
      // 标记已结算必须与发放入账同一事务：发放失败时不能把杂事吞成“已结算”
      choreMarkSettled(used);
      if(gain>0){
        const target=round2((state.scores.vitality||0)+gain);
        Ledger.post({op:'adjust',account:'vitality',target:target,entry:{st:'vitality',amt:gain,desc:'杂事批量结算：'+used.length+' 件',src:'chore-batch',dom:''},reason:{src:'chore-batch'}});
        if(!silent)msg='批量结算 '+used.length+' 件杂事 · 活力点 +'+fmt(gain);
      }else{
        Ledger.event('杂事批量结算：'+used.length+' 件（当前奖励为 0）','chore-batch');
      }
      return {toast:msg?{msg:msg}:null};
    }
  });
  return r.ok?gain:0;
}
function addChoreFromInput(){
  const inp=document.getElementById('choreInput');
  if(!inp)return;
  const name=inp.value.trim();
  if(!name){toast('请输入杂事内容','err');return;}
  if(!Array.isArray(state.chores))state.chores=[];
  const c={id:uid(),name:name,done:false,doneAt:null,plannedAt:null,createdAt:now(),settled:false,freshDays:null,decayKey:null,tags:[]};
  state.chores.push(c);
  state.choreOrder=choreOrderInsert(state.choreOrder,c.id);
  Ledger.event('新增杂事「'+name+'」','chore-create');
  save();
  inp.value='';inp.focus();
  render();
}
function toggleChoreDone(id,resolved){
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(choreDoneNow(c)){
    // 取消勾选：联动撤销现实账目（当期硬撤 / 跨期冲正），失败整单回滚
    runCommand({
      label:'chore-uncheck',
      failText:'取消失败：现实账目未能撤销',
      run:function(){
        if(c.budgetRef)reverseBoundBudget(c.budgetRef);
        // 进度值零和：按勾选时的领域分摊快照逐领域回退（不按当前配置重算）
        const award=c.progressAward;
        if(award&&Number(award.amount)>0){
          const parts=(Array.isArray(award.parts)&&award.parts.length)?award.parts:[{did:'d_default',amt:Number(award.amount)}];
          const dids=parts.map(function(p){return p.did;});
          Ledger.postSplits({splits:[{domainIds:dids,delta:-Number(award.amount)}],
            entry:{st:'progress',amt:-Number(award.amount),desc:'取消杂事「'+c.name+'」进度',src:'chore-progress-undo',dom:dids.join(','),choreId:c.id},
            reason:{src:'chore-progress-undo',dom:dids.join(',')}});
          delete c.progressAward;
        }
        // 完成历史同步回退：循环杂事把 nextDue 退回本次完成的到期日
        choreUndoCompletion(c);
        c.budgetRef=null;
        // 取消勾选：腐化从今天重新起算；已结算的批次不回退，避免反复领取
        c.decayKey=dayKey(now());
      }
    });
    return;
  }
  const bind=budgetOf(c);
  if(bind&&bind.mode==='prompt'&&(!resolved||resolved.amount==null)){
    openBudgetAmountDialog({
      kind:'chore',id:c.id,entity:c,title:'杂事：'+c.name,
      onConfirm:function(amount){toggleChoreDone(id,{amount:amount});},
      onCancel:function(){runCommand({reject:{reason:'canceled',toast:{msg:'已取消，本次未勾选',type:'warn'}},render:true});}
    });
    return;
  }
  const br=resolveActionBudget(c,{kind:'chore',id:c.id,source:'chore',amount:resolved?resolved.amount:undefined});
  const skipReason=br.status==='skip'?br.reason:'';
  const plan=br.status==='ok'?br.plan:null;
  runCommand({
    label:'chore-check',
    failText:'勾选失败：现实账目未写入',
    // 勾完该行会立刻离开待办、进入默认收起的「已完成」：给一条即时提示，避免被当成误删
    toast:{msg:'已完成「'+c.name+'」，可在「已完成」查看'},
    onFail:function(){if(plan)rememberBudgetDraft('chore',c.id,plan.amount);},
    run:function(tx){
      const at=now();
      // 记完成：一次性杂事与原来一致；循环杂事写入历史并把 nextDue 推进到下一个周期
      const marked=choreMarkCompletion(c,at);
      c.decayKey=dayKey(at);
      // 进度值：勾选即产出（与任务打卡同口径），按 splitCents 精确分摊到领域；
      // 快照 progressAward 供取消勾选时逐分回退，保证零和。批量结算只发活力点，不重复发进度。
      const awardParts=choreProgressParts(c);
      if(awardParts.length){
        const dids=awardParts.map(function(p){return p.did;});
        const total=round2(awardParts.reduce(function(s,p){return s+p.amt;},0));
        Ledger.postSplits({splits:[{domainIds:dids,delta:total}],
          entry:{st:'progress',amt:total,desc:'杂事「'+c.name+'」产出进度',src:'chore-progress',dom:dids.join(','),choreId:c.id},
          reason:{src:'chore-progress',desc:c.name,dom:dids.join(',')}});
        c.progressAward={amount:total,parts:awardParts};
        awardParts.forEach(function(p){checkAchievements(p.did);});
      }else{
        delete c.progressAward;
      }
      let ref=null;
      if(plan){
        const got=commitActionBudget(tx,plan,{choreId:c.id});
        ref=budgetRefOf(got.entry,plan);
        if(c.budget&&c.budget.mode==='prompt')c.budget.lastAmount=plan.amount;
      }
      c.budgetRef=ref;
      settleChoreBatches();
      // 只对用户手工勾选派 chore.completed：项目完成自动判定那条路径（B4 不结算）不派，
      // 否则事件流里的结算原子会从另一头打开双重计奖口子。
      let ev=null;
      if(marked){
        const hist=Array.isArray(c.history)?c.history:[];
        ev=makeChoreCompletedEvent(c,hist.length?hist[hist.length-1]:null);
      }
      return {preToasts:skipReason?[{msg:skipReason,type:'warn'}]:null, events:ev?[ev]:null};
    }
  });
}
function toggleChoreDoneZone(){choreDoneOpen=!choreDoneOpen;renderPanel('work.chores');}
function fmtChoreDate(ts){
  const d=new Date(ts);
  return (d.getMonth()+1)+'/'+d.getDate();
}
const CHORE_UNIT_LABEL={day:'天',week:'周',month:'月'};
// 情境 chip：卡片最多显示前 3 个，其余收成 +n；无标签返回空串（不产生任何节点）。
function choreTagsHTML(tags){
  const list=Array.isArray(tags)?tags:[];
  if(!list.length)return '';
  const shown=list.slice(0,3).map(function(t){return tagHTML('d',esc(t));}).join('');
  const more=list.length>3?'<span class="tag d chore-tag-more">+'+(list.length-3)+'</span>':'';
  return '<span class="chore-tags">'+shown+more+'</span>';
}
// 杂事被某个「已归档」项目的步骤委派：委派关系仍在（choreRef 未动），但项目归档后
// 该杂事回到待办池，这里只做标注提醒，不影响认领与冲突校验的全量口径。
function archivedDelegatedClaim(c){
  if(!c)return null;
  const claim=choreClaimOf(c.id);
  if(!claim)return null;
  const a=(state.affairs||[]).find(function(x){return x&&x.id===claim.affairId;});
  return a&&a.archived?a:null;
}
function choreCardHTML(c,zone){
  const v=choreCardView(c);
  let meta='';
  if(v.plannedAt)meta+='<span class="chore-date">📅 '+fmtChoreDate(v.plannedAt)+'</span>';
  if(v.cycle)meta+='<span class="chore-cycle">🔁 每 '+v.cycle.interval+' '+CHORE_UNIT_LABEL[v.cycle.unit]+' · 下次 '+fmtChoreDate(v.cycle.nextDue)+'</span>';
  if(v.progressAmount>0)meta+='<span class="chore-progress">+'+fmt(v.progressAmount)+' 进度</span>';
  if(v.overdueDays>0)meta+='<span class="chore-overdue">超期 '+v.overdueDays+' 天</span>';
  if(zone==='todo'&&archivedDelegatedClaim(c))meta+='<span class="chore-delegated-archived">委派项目已归档</span>';
  meta+=choreTagsHTML(v.tags);
  return '<div class="card chore-card'+(v.done?' done':'')+(v.overdueDays>0?' overdue':'')+'" data-chore-id="'+v.id+'" data-chore-zone="'+(zone||'todo')+'" onclick="openChoreModal(\''+v.id+'\')">'
    +'<label class="chore-check" onclick="event.stopPropagation()">'
    +'<input type="checkbox"'+(v.done?' checked':'')+' onchange="toggleChoreDone(\''+v.id+'\')">'
    +'</label>'
    +'<div class="chore-main">'
    +'<div class="chore-name">'+esc(v.name)+budgetBadgeHTML(c)+'</div>'
    +(meta?'<div class="chore-meta">'+meta+'</div>':'')
    +'</div>'
    +'<span class="chore-drag" onclick="event.stopPropagation()">'+dragHandleHTML('拖拽排序')+'</span>'
    +'</div>';
}
// 当前筛选键对应的展示文本（取已用情境的首次拼写；找不到时回落为键本身）
function choreTagFilterLabel(options){
  const hit=(options||[]).find(function(it){return it.key===choreTagFilter;});
  return hit?hit.label:choreTagFilter;
}
// 情境筛选条：没有任何情境时返回空串（保证无标签状态下渲染零差异）
function choreTagFilterHTML(options){
  if(!options||!options.length)return '';
  let html='<div class="chore-tag-filter">';
  html+='<button type="button" class="tag d chore-tag-fbtn'+(choreTagFilter?'':' on')+'" onclick="setChoreTagFilter(this.dataset.key)" data-key="">全部</button>';
  options.forEach(function(it){
    html+='<button type="button" class="tag d chore-tag-fbtn'+(choreTagFilter===it.key?' on':'')+'" onclick="setChoreTagFilter(this.dataset.key)" data-key="'+escAttr(it.key)+'">'+esc(it.label)+'</button>';
  });
  return html+'</div>';
}
// 单选：点同一项等于取消；不写 state、不触发保存
function setChoreTagFilter(key){
  const next=String(key==null?'':key);
  choreTagFilter=(!next||next===choreTagFilter)?'':next;
  renderPanel('work.chores');
}
function renderChores(){
  const panel=document.getElementById('chorePanel');
  if(!panel)return;
  const chores=state.chores||[];
  const cfg=choreCfg();
  const order=Array.isArray(state.choreOrder)?state.choreOrder:[];
  const visible=chores.filter(function(c){return !c.archived;});
  // 被委派步骤认领的杂事离开杂事池（引用独占）：复用只读聚合，不在这里重新遍历项目步骤。
  const claimed=claimedChoreIds();
  const archived=sortChoresByOrder(chores.filter(function(c){return c.archived;}),order,null);
  const todoAll=sortChoresByOrder(visible.filter(function(c){return !choreDoneNow(c)&&!claimed.has(c.id);}),order,function(a,b){
    const ap=a.plannedAt||9e15,bp=b.plannedAt||9e15;
    return ap-bp||((b.createdAt||0)-(a.createdAt||0));
  });
  // 情境筛选：不持久化；筛选键失效时自动回到「全部」
  const tagOptions=collectChoreTags(visible,{includeArchived:false});
  if(choreTagFilter&&!tagOptions.some(function(it){return it.key===choreTagFilter;}))choreTagFilter='';
  const todo=choreTagFilter?todoAll.filter(function(c){return choreTagIncludes(c.tags,choreTagFilter);}):todoAll;
  const done=sortChoresByOrder(visible.filter(function(c){return choreDoneNow(c);}),order,function(a,b){return (b.doneAt||0)-(a.doneAt||0);});
  const unsettled=choreSettlePool().length;
  const need=Math.max(1,Math.round(cfg.batchN));
  const rem=unsettled%need;
  const next=rem===0?need:need-rem;
  const readyBatches=Math.floor(unsettled/need);
  const meta=document.getElementById('choreMeta');
  if(meta)meta.textContent=chores.length?('待办 '+todo.length+' · 已完成 '+done.length+(archived.length?' · 已归档 '+archived.length:'')+(choreTagFilter?' · 情境「'+choreTagFilterLabel(tagOptions)+'」':'')):'';
  let html=choreDeleteUndoBarHTML()+'<div class="chore-econ-bar">'
    +'<span>单件不发放活力 · 每完成 <b>'+need+'</b> 件 → <b>+'+fmt(cfg.batchY)+'</b> 活力</span>'
    +'<span>'+(readyBatches>0
      ?('有 '+readyBatches+' 批待入账（'+unsettled+' 件）· 完成下一件即入账')
      :('待入账 '+unsettled+' 件 · 再完成 '+next+' 件可结算'))+'</span>'
    +'</div>';
  html+=choreTagFilterHTML(tagOptions);
  html+=todo.length?todo.map(function(c){return choreCardHTML(c,'todo');}).join('')
    :(choreTagFilter
      ?emptyHTML('affair-empty','没有带「'+esc(choreTagFilterLabel(tagOptions))+'」情境的待办。')
      :emptyHTML('affair-empty','还没有杂事。输入名称回车，即刻创建。'));
  if(done.length){
    html+=zoneHTML({id:'chore-zone-done',collapsed:!choreDoneOpen,onclick:'toggleChoreDoneZone()',title:'已完成',count:done.length,body:done.map(function(c){return choreCardHTML(c,'done');}).join('')});
  }
  if(archived.length){
    html+=zoneHTML({id:'chore-zone-archived',collapsed:!choreArchivedOpen,onclick:'toggleChoreArchivedZone()',title:'已归档',count:archived.length,
      body:archived.map(function(c){
        const tagsLine=choreTagsHTML(c.tags);
        return '<div class="card chore-card" data-chore-id="'+c.id+'" data-chore-zone="archived" style="opacity:.7">'
          +'<div class="chore-row"><div class="chore-main"><span class="chore-name">'+esc(c.name)+'</span>'
          +(tagsLine?'<div class="chore-meta">'+tagsLine+'</div>':'')
          +'</div>'
          +actionsRowHTML('chore-actions',dragHandleHTML('拖拽排序')+'<span class="chore-time">归档于 '+(c.archivedAt?fmtTime(c.archivedAt):'—')+'</span>'
          +'<button class="btn btn-sm" onclick="restoreChore(\''+c.id+'\')">恢复</button>')
          +'</div></div>';
      }).join('')});
  }
  panel.innerHTML=html;
}
function toggleChoreArchivedZone(){choreArchivedOpen=!choreArchivedOpen;renderPanel('work.chores');}
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
  const pAmtEl=document.getElementById('choreProgressAmount');
  if(pAmtEl)pAmtEl.value=isEdit&&typeof c.progressAmount==='number'&&c.progressAmount>0?c.progressAmount:'';
  const pDomEl=document.getElementById('choreProgressDomains');
  if(pDomEl)fillDomainChecklist(pDomEl,(isEdit&&Array.isArray(c.progressDomainIds)&&c.progressDomainIds.length)?c.progressDomainIds:['d_default']);
  const hint=document.getElementById('choreFreshDefaultHint');
  if(hint)hint.textContent=choreCfg().freshDays;
  // 循环设置：一次性杂事只保留开关（字段收起），循环杂事回填原配置
  const cy=choreCycleOf(c);
  const cycleOn=document.getElementById('choreCycleOn');
  if(cycleOn)cycleOn.checked=!!cy;
  const unitEl=document.getElementById('choreCycleUnit');
  if(unitEl)unitEl.value=cy?cy.unit:'day';
  const ivEl=document.getElementById('choreCycleInterval');
  if(ivEl)ivEl.value=cy?cy.interval:1;
  const anEl=document.getElementById('choreCycleAnchor');
  if(anEl)anEl.value=toDateInputValue(cy?cy.anchor:((c&&c.plannedAt)||now()));
  choreCycleToggle();
  choreDraftTags=normalizeChoreTags(c?c.tags:[]);
  renderChoreTags();
  document.getElementById('choreDelBtn').style.display=isEdit?'':'none';
  const moreBox=document.getElementById('choreMore');
  if(moreBox)moreBox.style.display=isEdit?'':'none';
  const convBtn=document.getElementById('choreConvertBtn');
  if(convBtn)convBtn.style.display=isEdit?'':'none';
  // 转换提示常驻在弹窗顶部：可撤销时给按钮，不可撤销时给具体原因，避免入口无声消失。
  const convNotice=document.getElementById('choreConvNotice');
  if(convNotice){
    const last=lastConversion();
    if(!(isEdit&&last&&last.entityId===(c?c.id:''))){
      convNotice.style.display='none';
      convNotice.innerHTML='';
    }else{
      const st=conversionUndoState();
      convNotice.innerHTML=st.ok
        ?'<span>此杂事由项目转换而来</span><span class="conv-notice-hint">本周期内可撤销</span>'
          +'<button type="button" class="btn btn-sm" onclick="choreUndoConversionFromModal()">撤销转换</button>'
        :'<span>此杂事由项目转换而来</span><span class="conv-notice-hint">'+esc(st.reason)+'</span>';
      convNotice.style.display='';
    }
  }
  const budBox=document.getElementById('choreBudgetBind');
  if(budBox)budBox.innerHTML=budgetBindingHTML('chore',c||null);
  if(budBox)budgetBindingModeChange('chore');
  openModal('choreModal');
  markModalClean('choreModal');
  if(!isEdit)setTimeout(function(){document.getElementById('choreName').focus();},50);
}
// 循环开关只切换字段可见性；关闭时保存会清掉 cycle 与 history
function choreCycleToggle(){
  const onEl=document.getElementById('choreCycleOn');
  const box=document.getElementById('choreCycleFields');
  if(box)box.style.display=(onEl&&onEl.checked)?'':'none';
}
// 情境草稿：编辑期间只改内存副本，保存时与原值比较，未变化则不写
function renderChoreTags(){
  const box=document.getElementById('choreTags');
  if(!box)return;
  box.innerHTML=choreDraftTags.map(function(t,i){
    return '<span class="tag d chore-tag">'+esc(t)
      +'<button type="button" class="chore-tag-del" onclick="removeChoreTag('+i+')">×</button></span>';
  }).join('');
  renderChoreTagSuggest();
}
// 候选：全部杂事里的已用情境，按使用次数排序；排除草稿里已有的，按输入做包含匹配。
function choreTagSuggestList(){
  const inp=document.getElementById('choreTagInput');
  const typed=choreTagKey(inp?inp.value:'');
  return collectChoreTags(state.chores, { includeArchived: true }).filter(function(it){
    if(choreDraftTags.some(function(t){ return choreTagMatches(t, it.key); }))return false;
    if(!typed)return true;
    return it.key.indexOf(typed)>=0;
  }).slice(0,8);
}
function renderChoreTagSuggest(){
  const box=document.getElementById('choreTagSuggest');
  if(!box)return;
  const list=choreTagSuggestList();
  choreTagSuggestCache=list;
  box.innerHTML=list.map(function(it,i){
    return '<button type="button" class="tag d chore-tag-sug" onclick="pickChoreTag('+i+')">'+esc(it.label)+'</button>';
  }).join('');
  box.style.display=list.length?'':'none';
}
function pickChoreTag(i){
  const it=choreTagSuggestCache[Math.round(Number(i))];
  if(!it)return;
  if(addChoreTagValue(it.label)){
    const inp=document.getElementById('choreTagInput');
    if(inp)inp.value='';
    renderChoreTagSuggest();
  }
}
// 统一的写入校验：trim / 长度 / 条数 / 按键判重；成功返回 true。
function addChoreTagValue(raw){
  const tag=String(raw==null?'':raw).trim();
  if(!tag)return false;
  if(tag.length>CHORE_TAG_MAX_LEN){toast('情境最多 '+CHORE_TAG_MAX_LEN+' 个字','err');return false;}
  if(choreDraftTags.length>=CHORE_TAG_MAX_COUNT){toast('情境最多 '+CHORE_TAG_MAX_COUNT+' 个','err');return false;}
  if(choreTagIncludes(choreDraftTags, tag)){
    toast('情境「'+tag+'」已存在','warn');
    return false;
  }
  choreDraftTags.push(tag);
  renderChoreTags();
  return true;
}
function addChoreTag(){
  const inp=document.getElementById('choreTagInput');
  if(!inp)return;
  if(addChoreTagValue(inp.value)){
    inp.value='';
    renderChoreTagSuggest();
  }
}
function removeChoreTag(i){
  const k=Math.round(Number(i));
  if(!(k>=0&&k<choreDraftTags.length))return;
  choreDraftTags.splice(k,1);
  renderChoreTags();
}
// 读取循环表单：未勾选返回 {cyclic:false}；配置与原对象一致时原样复用（含 nextDue/lastDue）
function readChoreCycleForm(old,errs){
  const onEl=document.getElementById('choreCycleOn');
  if(!onEl||!onEl.checked)return {cyclic:false,cycle:null};
  const unitEl=document.getElementById('choreCycleUnit');
  const unit=unitEl?String(unitEl.value):'day';
  if(['day','week','month'].indexOf(unit)<0){
    if(errs)errs.push({field:'choreCycleUnit',msg:'循环单位无效'});
    return null;
  }
  const ivEl=document.getElementById('choreCycleInterval');
  const iv=Math.round(Number(ivEl?ivEl.value:''));
  if(!isFinite(iv)||iv<1){
    if(errs)errs.push({field:'choreCycleInterval',msg:'循环间隔需为不小于 1 的整数'});
    return null;
  }
  const anEl=document.getElementById('choreCycleAnchor');
  const raw=anEl?String(anEl.value||''):'';
  const parsed=raw?new Date(raw+'T00:00:00').getTime():NaN;
  if(!isFinite(parsed)){
    if(errs)errs.push({field:'choreCycleAnchor',msg:'请选择循环锚点日期'});
    return null;
  }
  const anchor=dayStart(parsed);
  const oldCy=choreCycleOf(old);
  if(oldCy&&oldCy.unit===unit&&oldCy.interval===iv&&oldCy.anchor===anchor)return {cyclic:true,cycle:oldCy};
  // 新配置：首个到期日不早于今天；锚点在未来时就是锚点本身
  const base={unit:unit,interval:iv,anchor:anchor};
  const today=dayStart(now());
  const nextDue=(today<=anchor)?anchor:choreCycleDueAfter(base,addDays(today,-1));
  return {cyclic:true,cycle:{unit:unit,interval:iv,anchor:anchor,nextDue:nextDue,lastDue:oldCy?oldCy.lastDue:0}};
}
function saveChore(){
  const id=document.getElementById('choreId').value;
  const name=document.getElementById('choreName').value.trim();
  const errs=[];
  if(!name)errs.push({field:'choreName',msg:'请输入杂事名称'});
  const dv=document.getElementById('choreDate').value;
  const plannedAt=dv?new Date(dv+'T00:00:00').getTime():null;
  const fv=String(document.getElementById('choreFreshDays').value).trim();
  let fresh=null;
  if(fv!==''){
    const n=Number(fv);
    if(!isFinite(n))errs.push({field:'choreFreshDays',msg:'保鲜期需为数字'});
    else fresh=Math.max(0,Math.round(n));
  }
  if(!Array.isArray(state.chores))state.chores=[];
  const editing=id?state.chores.find(function(x){return x.id===id;}):null;
  const cyc=readChoreCycleForm(editing,errs);
  // 产出进度值：留空视为 0（不产出）；领域留空回落到默认领域
  const pv=String(document.getElementById('choreProgressAmount').value).trim();
  let pAmt=0;
  if(pv!==''){
    const n=Number(pv);
    if(!isFinite(n)||n<0)errs.push({field:'choreProgressAmount',msg:'产出进度值需为非负数字'});
    else pAmt=round2(n);
  }
  if(errs.length||!cyc){
    const first=rejectFields('choreModal',errs);
    if(!first&&errs.length)toast(errs[0].msg,'err');
    return;
  }
  const pDids=[];
  document.querySelectorAll('#choreProgressDomains .dom-check input:checked').forEach(function(cb){pDids.push(cb.value);});
  const budget=readBudgetBinding('chore');
  if(id){
    const c=editing;
    if(!c)return;
    c.name=name;c.plannedAt=plannedAt;c.freshDays=fresh;
    c.budget=budget;
    c.progressAmount=pAmt;
    c.progressDomainIds=pDids;
    // 循环：配置未变时不动原对象；关闭时清掉循环与完成历史
    if(cyc.cyclic){
      const cur=choreCycleOf(c);
      const next=cyc.cycle;
      if(!cur||cur.unit!==next.unit||cur.interval!==next.interval||cur.anchor!==next.anchor||cur.nextDue!==next.nextDue||cur.lastDue!==next.lastDue)c.cycle=next;
    }else{
      delete c.cycle;
      delete c.history;
    }
    // 标签：与原值逐项一致时不写，避免无意义 diff
    const oldTags=normalizeChoreTags(c.tags);
    if(oldTags.length!==choreDraftTags.length||oldTags.some(function(t,i){return t!==choreDraftTags[i];}))c.tags=choreDraftTags.slice();
    // 日期或保鲜期改动后从今天重新起算腐化，不补扣历史
    c.decayKey=dayKey(now());
    Ledger.event('修改杂事「'+name+'」','chore-edit');
  }else{
    const c={id:uid(),name:name,done:false,doneAt:null,plannedAt:plannedAt,createdAt:now(),settled:false,freshDays:fresh,decayKey:null,budget:budget,budgetRef:null,progressAmount:pAmt,progressDomainIds:pDids,tags:choreDraftTags.slice()};
    if(cyc.cyclic)c.cycle=cyc.cycle;
    state.chores.push(c);
    state.choreOrder=choreOrderInsert(state.choreOrder,c.id);
    Ledger.event('新增杂事「'+name+'」','chore-create');
  }
  closeModal('choreModal');
  commit(id?'杂事已更新':'杂事已创建');
}
// 项目 → 杂事的 UI 入口：有损项目被直接拒绝，原因用 toast 明确展示
function affairConvertToChore(id){
  const r=affairToChore(id);
  if(!r.ok)toast(r.reason||'无法转为杂事','warn');
}
// 杂事编辑弹窗里的「转为项目」：同 id 换表，成功后关闭弹窗（转换本身已 commit + render）
function choreConvertFromModal(){
  const id=document.getElementById('choreId').value;
  if(!id)return;
  const r=choreToAffair(id);
  if(!r.ok){toast(r.reason||'无法转换','warn');return;}
  closeModal('choreModal');
}
// 撤销后弹窗里的杂事已被换回项目，留在旧弹窗会指向不存在的实体，因此成功后直接关闭。
function choreUndoConversionFromModal(){
  const r=undoConversion();
  if(r&&r.ok)closeModal('choreModal');
}
function delChore(){
  const id=document.getElementById('choreId').value;
  const c=(state.chores||[]).find(function(x){return x.id===id;});
  if(!c)return;
  if(!confirm('删除杂事「'+c.name+'」？'))return;
  const r=runCommand({
    label:'chore-del',
    toast:'杂事已删除，可在杂事面板顶部撤销',
    run:function(){return deleteChoreCore(id);}
  });
  if(r.ok)closeModal('choreModal');
}
// ===== 杂事删除撤销条 =====
// 与项目删除撤销条同结构、同样式；没有删除记录时不渲染，不影响对照基线。
function choreDeleteUndoBarHTML(){
  const list=Array.isArray(state.choreDeleteUndo)?state.choreDeleteUndo:[];
  const recs=list.filter(function(rec){return rec&&rec.chore;}).slice().reverse();
  if(!recs.length)return '';
  return '<div class="affair-empty affair-delete-undo"><div class="affair-delete-undo-head">最近删除 · 最多保留 5 条</div>'
    +recs.map(function(rec){
      return '<div class="affair-delete-undo-row">'
        +'<span class="affair-delete-undo-name">已删除「'+esc(rec.chore.name)+'」</span>'
        +'<button class="btn btn-sm" onclick="undoChoreDelete(\''+rec.id+'\')">撤销删除</button>'
        +'<button class="btn btn-sm" onclick="dismissChoreDeleteUndo(\''+rec.id+'\')">忽略</button>'
        +'</div>';
    }).join('')
    +'</div>';
}
function undoChoreDelete(recId){
  runCommand({
    label:'chore-delete-undo',
    toast:'已恢复删除前的杂事',
    run:function(){return restoreChoreDeletion(recId);}
  });
}
function dismissChoreDeleteUndo(recId){
  runCommand({
    label:'chore-delete-dismiss',
    run:function(){
      const list=Array.isArray(state.choreDeleteUndo)?state.choreDeleteUndo:[];
      const i=list.findIndex(function(x){return x&&x.id===recId;});
      if(i<0)return {ok:false,reason:'没有这条删除记录'};
      list.splice(i,1);
      return {ok:true,toast:{msg:'已忽略该撤销提示'}};
    }
  });
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
  markModalClean('choreConfigModal');
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
  // 配置只影响杂事面板的展示口径（choreCfg 仅被 renderChores / 腐化计算读取），局部重绘即可
  save();
  renderPanel('work.chores');
  toast('杂事经济设置已保存，作为所有杂事的默认');
}

function resetChoreUiState(){
  choreDoneOpen=false;
  choreArchivedOpen=false;
  choreTagFilter='';
}

function closeChoreDoneZone(){
  choreDoneOpen=false;
}

export { settleChoreBatches, addChoreFromInput, toggleChoreDone, toggleChoreDoneZone, fmtChoreDate, choreTagsHTML, archivedDelegatedClaim, choreCardHTML, choreTagFilterLabel, choreTagFilterHTML, setChoreTagFilter, renderChores, toggleChoreArchivedZone, restoreChore, toDateInputValue, openChoreModal, choreCycleToggle, renderChoreTags, choreTagSuggestList, renderChoreTagSuggest, pickChoreTag, addChoreTagValue, addChoreTag, removeChoreTag, readChoreCycleForm, saveChore, affairConvertToChore, choreConvertFromModal, choreUndoConversionFromModal, delChore, choreDeleteUndoBarHTML, undoChoreDelete, dismissChoreDeleteUndo, CHORE_CFG_FIELDS, readChoreCfgForm, writeChoreCfgForm, choreCfgInputPreview, openChoreConfigModal, resetChoreConfig, saveChoreConfig, choreDoneOpen, choreArchivedOpen, resetChoreUiState, closeChoreDoneZone };