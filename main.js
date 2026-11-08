import { STATS_VERSION } from './src/constants.js';
import { registerBudgetPreflightPolicy } from './src/budget.js';
import { handleActivitySave, initCondPanelDismiss } from './src/cond-ui.js';
import { maybeBackupReminder } from './src/data.js';
import { devAuditLogWrites, runConsistencyChecks } from './src/debug.js';
import { schedulerTick } from './src/entities.js';
import { registerAchievementLifetimePolicy, registerProductGatePolicy } from './src/gate.js';
import { Ledger } from './src/ledger.js';
import { handleMetricSave } from './src/library.js';
import { bindTaskSliders, handleAchSave, handleProdSave, handleTaskSave } from './src/modals.js';
import { loadIssue } from './src/normalize.js';
import { save, initPersistHooks } from './src/persist.js';
import { initPWA, loadStateFromStorage, showLoadBanner } from './src/pwa.js';
import { handleAffairSave, initTaskReveal, saveAffairPlan, saveChore, saveChoreConfig, savePreset, initAffairMenuDismiss } from './src/render-work.js';
import { render } from './src/render.js';
import { runStartupProcessors } from './src/startup.js';
import { setState, state, initStagePresets } from './src/state.js';
import { seedCalibrationShadow } from './src/stats.js';
import { initTheme } from './src/theme.js';
import { initDrag } from './src/ui-events.js';
import { toast } from './src/toast.js';
// main.js —— 启动入口：初始化顺序、window 全局名挂载
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。
// 启动副作用（原先散落在各模块顶层）

// ===== Init =====
async function init(){
  setState(await loadStateFromStorage());
  if(loadIssue){
    if(loadIssue.type==='timeout'||loadIssue.type==='read-error'){
      showLoadBanner(loadIssue.type);
      toast(loadIssue.type==='timeout'
        ?'读取本地存档超时：本次已暂停写入，避免空白数据覆盖原存档。请点顶部「重试读取」'
        :'无法读取本地存档：本次已暂停写入，避免覆盖原存档。请点顶部「重试读取」','err');
    }else{
      toast(loadIssue.type==='salvaged'
        ?'检测到数据不完整，已自动修复并恢复可读部分（原始内容已备份）'
        :'本地数据已损坏，已重置（原始内容已备份）','err');
      if(loadIssue.type==='corrupt'){const rb=document.getElementById('recoverBar');if(rb)rb.style.display='flex';}
    }
  }
  maybeBackupReminder();
  // 申请持久化存储，降低浏览器自动清理 IndexedDB 的风险
  try{
    if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
  }catch(e){}
  const n=new Date(),wd=['日','一','二','三','四','五','六'];
  document.getElementById('todayDate').textContent=
    n.getFullYear()+'.'+String(n.getMonth()+1).padStart(2,'0')+'.'+String(n.getDate()).padStart(2,'0')+' 周'+wd[n.getDay()];

  // Ensure default domain/collection/shopCategory exist
  if(!state.domains.find(d=>d.id==='d_default'))state.domains.unshift({id:'d_default',name:'默认'});
  if(!state.collections.find(c=>c.id==='c_default'))state.collections.unshift({id:'c_default',name:'默认'});
  if(!state.shopCategories.find(c=>c.id==='sc_default'))state.shopCategories.unshift({id:'sc_default',name:'默认'});

  // 能力雷达指标为纯自定义：未创建指标时不显示任何指标
  if(!Array.isArray(state.metrics))state.metrics=[];

  // 旧存档/首次启用统计计数器：从当前日志重建一次（之后靠写入时增量累加）
  // 同时校准 invisible/evicted，使“余额 vs 流水合计”自检对历史隐形操作也能通过
  if(!state.ext.stats||state.ext.stats.version!==STATS_VERSION||!state.ext.stats.daily){
    const hadShadow=Array.isArray(state.ext.shadow)&&state.ext.shadow.length>0;
    Ledger.rebuildStats();
    if(!hadShadow)seedCalibrationShadow();
  }

  document.querySelectorAll('.modal-bg').forEach(bg=>{
    bg.addEventListener('click',e=>{if(e.target===bg)bg.classList.remove('show')});
  });

  // 模态保存按钮集中登记，新增模态只需在此表加一行
  const MODAL_SAVERS={
    taskSaveBtn:handleTaskSave,
    achSaveBtn:handleAchSave,
    prodSaveBtn:handleProdSave,
    metricSaveBtn:handleMetricSave,
    activitySaveBtn:handleActivitySave,
    affairSaveBtn:handleAffairSave,
    affairPlanSaveBtn:saveAffairPlan,
    presetSaveBtn:savePreset,
    choreSaveBtn:saveChore,
    choreCfgSaveBtn:saveChoreConfig
  };
  Object.keys(MODAL_SAVERS).forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.addEventListener('click',MODAL_SAVERS[id]);
  });
  // 任意模态内按 Enter 触发该模态右下角主按钮（不再逐模态重复绑定）
  document.querySelectorAll('.modal-bg').forEach(bg=>{
    bg.addEventListener('keydown',e=>{
      if(e.key!=='Enter'||!e.target||e.target.tagName!=='INPUT')return;
      e.preventDefault();
      const btn=bg.querySelector('.modal-foot .btn:last-child');
      if(btn)btn.click();
    });
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')document.querySelectorAll('.modal-bg.show').forEach(m=>m.classList.remove('show'));
  });

  runStartupProcessors();
  save();
  setInterval(schedulerTick,60000);
  initDrag();
  initTaskReveal();
  bindTaskSliders();
  initPWA();
  devAuditLogWrites();
  runConsistencyChecks();
  render();
}

// ===== 浏览器全局名 =====
// ES modules 不再共享全局作用域，而 index.html 与渲染模板里的内联事件处理器
// 仍以 onclick="goTab('bank')" 的形式按名字查找。启动时把这些名字显式挂回 window。
// 新增内联处理器时，把函数名补进 __HANDLERS__ 即可（缺名会 console.warn）。
import * as m_cond_model from './src/cond-model.js';
import * as m_state from './src/state.js';
import * as m_theme from './src/theme.js';
import * as m_normalize from './src/normalize.js';
import * as m_persist from './src/persist.js';
import * as m_utils from './src/utils.js';
import * as m_stats from './src/stats.js';
import * as m_ledger from './src/ledger.js';
import * as m_gate from './src/gate.js';
import * as m_budget from './src/budget.js';
import * as m_conditions from './src/conditions.js';
import * as m_entities from './src/entities.js';
import * as m_business from './src/business.js';
import * as m_library from './src/library.js';
import * as m_shell from './src/shell.js';
import * as m_render_work from './src/render-work.js';
import * as m_render_bank from './src/render-bank.js';
import * as m_render_shop from './src/render-shop.js';
import * as m_render_budget from './src/render-budget.js';
import * as m_cycle from './src/cycle.js';
import * as m_cond_ui from './src/cond-ui.js';
import * as m_ui_events from './src/ui-events.js';
import * as m_undo from './src/undo.js';
import * as m_modals from './src/modals.js';
import * as m_modal_host from './src/modal-host.js';
import * as m_data from './src/data.js';
import * as m_pwa from './src/pwa.js';
import * as m_debug from './src/debug.js';
import * as m_startup from './src/startup.js';

const __ALL__ = Object.assign({},
  m_state, m_theme, m_normalize, m_persist, m_utils, m_stats, m_ledger, m_gate, m_budget,
  m_cond_model,
  m_conditions, m_entities, m_business, m_library, m_shell, m_render_work, m_render_bank,
  m_render_shop, m_render_budget, m_cycle, m_cond_ui, m_ui_events, m_undo, m_modals,
  m_data, m_pwa, m_debug, m_startup, m_modal_host);

const __HANDLERS__ = ["activityPeriodChanged","addAffairFromInput","addChoreFromInput","addCollection","addCondGroup","addCondItem","addDomain","addRewardRow","addShopCategory","advanceAffairStep","affairAddStep","affairCalShift","affairCurveInput","affairCurveRefresh","affairRemoveStep","affairSelectDay","affairStepInput","affairStepTime","affairUndoAction","applyAffairPreset","applyStagePreset","askDelActivityFromModal","attemptRecovery","budCondModeChange","budRuleAccountChanged","budRuleAdd","budRuleDelete","budRuleKindChanged","budRuleModeChanged","budRuleMove","buyProduct","cancelDomainChange","changeGroupMode","changeSoldoutCat","checkIn","choreCfgInputPreview","clearDataResults","clearEverything","closeModal","commitCondOp","completeAffair","completeAffairStep","confirmCondDays","confirmDelAch","confirmDelBudgetCategory","confirmDelProd","confirmDelTask","confirmReverseBudgetEntry","delAffair","delChore","delCollection","delDomain","delPreset","delShopCategory","dismissBudgetAnchorNotice","doDeleteActivity","editCondValue","exportData","filterByDomain","goTab","hideChartTip","importData","installApp","manualAdjustBalance","onCondModeChange","onProdBudgetChange","onProdGateModeChange","onProdTierChange","onStageEnabled","onStageInput","openAchModal","openActivityModal","openAffairModal","openAffairPlanModal","openBudgetCatModal","openChoreConfigModal","openChoreModal","openCondMetricPanel","openCondOpPanel","openMetricModal","openModal","openPresetModal","openProdModal","openQuickRecordModal","openTaskModal","pickCondAggregate","pickCondBudgetCat","pickCondDomain","pickCondMetric","pickCondMilestone","pickCondNewFilter","pickCondRange","pickCondTargetType","pickCondTask","presetCurveInput","presetCurveRefresh","qrConfirm","qrToggleTopup","removeCondNode","removeRewardRow","renameCollection","renameDomain","renameShopCategory","renderQuickPreview","resetChoreConfig","resolveDomainChange","restoreAffair","restoreChore","retryLoadStorage","rrTypeChanged","runStagePreset","saveBudgetCategory","setAffairCurve","setPresetCurve","showChartTip","syncBudgetAnchorVisibility","toggleAcc","toggleActivity","toggleAffairAch","toggleAffairDone","toggleAffairMenu","toggleAffairZone","toggleChartSeries","toggleChoreArchivedZone","toggleChoreDone","toggleChoreDoneZone","toggleCollapse","toggleInline","toggleMajor","togglePresetAch","toggleScoreType","toggleShadowList","toggleStageParam","toggleTheme","toggleTrendMode","undoLog","unlockTask","updateCondPreview","useExemption","useExemptionFromSel"];
__HANDLERS__.forEach(function(name){
  const fn = __ALL__[name];
  if (typeof fn === 'function') window[name] = fn;
  else console.warn('[main] 内联事件处理器缺失：' + name);
});

// ===== 启动：原先散落在模块顶层的副作用，按原顺序执行 =====
initTheme();
initStagePresets();
initPersistHooks();
registerAchievementLifetimePolicy();
registerProductGatePolicy();
registerBudgetPreflightPolicy();
initAffairMenuDismiss();
initCondPanelDismiss();

init();

export { init };
