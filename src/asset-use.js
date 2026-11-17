// asset-use.js —— 资产使用入口（阶段 5 第一步）
//
// 职责：把「用资产做事」从周期活动配置里解耦出来。
// - 资产定义声明 useRecipe（当前只有 task-exempt）后，任务卡/豁免面板都能直接发起一次
//   可见、可干跑、可撤销的资产运行；
// - 运行本身复用 flow-engine 的 runAssetUse（同一事务、同一 journal、同一整单撤销）；
// - 未配置配方的存量用户仍走旧的 useExemption（活动驱动）路径，保证行为不变。
import { exemptionActivity } from './conditions.js';
import { useExemption } from './business.js';
import { dryRunAssetUse, runAssetUse } from './flow-engine.js';
import { save } from './persist.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';

function cardBalance(assetId) {
  return Number((state.cards || {})[assetId]) || 0;
}

// 可用资产：启用、未归档、配置了任务豁免配方且余额够 1 次
function usableExemptAssets() {
  return (state.assetDefs || []).filter(function (d) {
    return d && d.enabled !== false && !d.archived
      && d.useRecipe && d.useRecipe.type === 'task-exempt'
      && cardBalance(d.id) >= Math.max(1, Number(d.useRecipe.cost) || 1);
  });
}

function legacyExemptAvailable() {
  const act = exemptionActivity();
  return !!(act && act.enabled) && (state.cards.exemption || 0) > 0;
}

function errText(err) {
  const code = (err && err.code) || '';
  if (code === 'FLOW_TASK_CHECKED') return '今日已打卡，无需豁免';
  if (code === 'FLOW_TASK_EXEMPTED') return '今日已豁免';
  if (code === 'FLOW_TASK_ARCHIVED') return '任务已归档，请先解锁';
  if (code === 'FLOW_INSUFFICIENT') return '资产余额不足';
  if (code === 'FLOW_ASSET_DISABLED') return '资产已停用';
  if (code === 'FLOW_ASSET_ARCHIVED') return '资产已归档';
  if (code === 'FLOW_NO_USE_RECIPE') return '该资产没有配置使用配方';
  if (code === 'FLOW_INPUT_MISSING') return '缺少要豁免的任务';
  if (code === 'FLOW_COMPILE_FAILED') return '配方校验失败';
  return '资产使用失败';
}

function pickAsset(candidates) {
  if (candidates.length === 1) return candidates[0];
  const lines = candidates.map(function (d, i) {
    return (i + 1) + '. ' + d.name + '（余额 ' + cardBalance(d.id) + '）';
  }).join('\n');
  const ans = window.prompt('有多个可用于豁免的资产，请选择：\n' + lines + '\n\n输入序号：', '1');
  if (ans === null) return null;
  const idx = parseInt(ans, 10) - 1;
  if (!(idx >= 0 && idx < candidates.length)) {
    toast('未选择有效的资产', 'warn');
    return null;
  }
  return candidates[idx];
}

// 预览：直接跑一次克隆态，把“将要发生什么”展示给用户；不改真实 state
function previewText(def, taskId) {
  const t = (state.tasks || []).find(function (x) { return x && x.id === taskId; });
  if (!t) return '';
  const report = dryRunAssetUse(def.id, { taskId: taskId });
  if (!report || !report.ok || report.error) {
    return '';
  }
  const acc = (report.accounts || []).find(function (a) { return a.key === 'card:' + def.id; }) || null;
  const before = acc ? acc.before : cardBalance(def.id);
  const after = acc ? acc.after : Math.max(0, before - 1);
  return '使用「' + (def.name || def.id) + '」豁免任务「' + t.name + '」？\n\n'
    + '消耗：' + (def.name || def.id) + ' ' + (def.useRecipe.cost || 1) + ' 个（余额 ' + before + ' → ' + after + '）\n'
    + '待扣债：' + (Number(t.pendingDebt) || 0) + ' → 0\n'
    + '今日不再计入断更（可继续维持连胜利率）\n\n'
    + '确认后会留下一条运行记录，可在「周期 → 动作流 → 运行记录」整单撤销。';
}

// 对外入口：任务卡按钮与豁免面板共用
function useTaskExemption(taskId, assetId) {
  const candidates = usableExemptAssets();
  let def = null;
  if (assetId) {
    def = candidates.find(function (d) { return d.id === assetId; }) || null;
    if (!def) {
      toast('所选资产当前不可用（未启用、已归档、无配方或余额不足）', 'err');
      return { ok: false, error: { code: 'FLOW_ASSET_UNAVAILABLE' } };
    }
  } else if (candidates.length) {
    def = pickAsset(candidates);
    if (!def) return { ok: false, canceled: true };
  } else if (legacyExemptAvailable()) {
    // 存量活动驱动路径：行为与旧版完全一致
    useExemption(taskId);
    return { ok: true, legacy: true };
  } else {
    toast('没有可用的豁免资产：请先在「资产定义」里配置「任务豁免」使用配方', 'err');
    return { ok: false, error: { code: 'FLOW_NO_USE_RECIPE' } };
  }

  const text = previewText(def, taskId);
  if (!text) {
    toast(errText(null) || '预览失败', 'err');
    return { ok: false, error: { code: 'FLOW_DRY_RUN_ERROR' } };
  }
  if (!window.confirm(text)) return { ok: false, canceled: true };

  const r = runAssetUse(def.id, { taskId: taskId });
  if (!r || !r.ok) {
    toast(errText(r && r.error), 'err');
    return r || { ok: false };
  }
  save();
  render();
  const t = (state.tasks || []).find(function (x) { return x && x.id === taskId; });
  toast('已用「' + (def.name || def.id) + '」豁免「' + (t ? t.name : taskId) + '」');
  return r;
}

// 豁免面板：显式选择资产后调用（面板本身已有下拉）
function useExemptionFromPanel(taskId, assetId) {
  if (!taskId) {
    toast('请先选择要豁免的任务', 'warn');
    return { ok: false };
  }
  return useTaskExemption(taskId, assetId || '');
}

export { usableExemptAssets, legacyExemptAvailable, useTaskExemption, useExemptionFromPanel };
