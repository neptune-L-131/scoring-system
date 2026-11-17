// asset-ui.js —— 阶段 4 S8：资产定义管理界面
//
// 只负责「定义层」的增删改查、边界校验与说明展示：
// - 不触发任何动作流执行，不调用 FlowEngine / dryRun / undoFlowRun；
// - 余额写入仍走既有账务/清空入口，这里只做资产定义的编辑与状态切换；
// - 内置豁免卡的定义由归一化层固定，本模块对它的修改一律明确拒绝并给出可见文案。
import { ASSET_VERSION } from './constants.js';
import { openModal, closeModal } from './modal-host.js';
import { isValidAssetId } from './normalize.js';
import { save } from './persist.js';
import { esc, escAttr, fmt, now } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { periodKeyOf } from './time.js';

const NAME_MAX = 20;
const ID_HINT = '资产 ID 不合法：需小写字母开头，仅含小写字母/数字/下划线，长度 3–32';
const BUILTIN_LOCKED = '内置资产「断更豁免卡」由系统固定，不能改名、改上限或删除';

function fail(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra || {});
}

function optionalInt(raw) {
  if (raw === null || raw === undefined) return { empty: true };
  const s = String(raw).trim();
  if (!s) return { empty: true };
  const n = Number(s);
  if (!isFinite(n) || !Number.isInteger(n) || n < 0) return { invalid: true };
  return { value: n };
}

// 使用配方：目前只有「任务豁免」一种；固定消耗 1 张本资产
function useRecipeFromDraft(d) {
  const type = String((d && d.useType) || 'none');
  if (type !== 'task-exempt') return null;
  return { v: 1, type: 'task-exempt', cost: 1 };
}

// 纯校验：不读写 DOM、不写 state。ctx = { defs, balance, periodIssued, builtin, originalId }
function validateAssetDraft(draft, ctx) {
  const d = draft || {};
  const c = ctx || {};
  const defs = Array.isArray(c.defs) ? c.defs : [];
  const originalId = c.originalId ? String(c.originalId) : '';
  const builtin = c.builtin === true || originalId === 'exemption';

  if (builtin) return fail('ASSET_BUILTIN_LOCKED', BUILTIN_LOCKED);

  let id = originalId;
  if (!originalId) {
    id = String(d.id === null || d.id === undefined ? '' : d.id).trim();
    if (!id) return fail('ASSET_ID_REQUIRED', '请填写资产 ID');
    if (!isValidAssetId(id)) return fail('ASSET_ID_INVALID', ID_HINT);
    if (id === 'exemption') return fail('ASSET_ID_RESERVED', '「exemption」是内置资产 ID，请换一个');
    if (defs.some(x => x && x.id === id)) {
      return fail('ASSET_ID_DUP', '已存在 ID 为「' + id + '」的资产，请换一个');
    }
  }

  const name = String(d.name === null || d.name === undefined ? '' : d.name).trim();
  if (!name) return fail('ASSET_NAME_REQUIRED', '请填写资产名称');
  if (name.length > NAME_MAX) return fail('ASSET_NAME_TOO_LONG', '资产名称最多 ' + NAME_MAX + ' 个字符');
  const dupName = defs.find(x => x && x.id !== id && String(x.name || '').trim() === name);
  if (dupName) return fail('ASSET_NAME_DUP', '已存在同名资产「' + name + '」，请换一个名称');

  const unit = String(d.unit === null || d.unit === undefined ? '' : d.unit).trim() || '张';

  const balance = Number(c.balance) || 0;
  const maxBalanceRaw = optionalInt(d.maxBalance);
  if (maxBalanceRaw.invalid) {
    return fail('ASSET_MAX_BALANCE_INVALID', '余额上限需为不小于 0 的整数，留空表示不限制');
  }
  const maxBalance = maxBalanceRaw.empty ? null : maxBalanceRaw.value;
  if (maxBalance !== null && balance > maxBalance) {
    return fail('ASSET_MAX_BALANCE_BELOW_BALANCE', '余额上限不能低于当前余额（当前余额 ' + fmt(balance) + '）');
  }

  const maxIssuedRaw = optionalInt(d.maxIssuedPerPeriod);
  if (maxIssuedRaw.invalid) {
    return fail('ASSET_MAX_ISSUED_INVALID', '单期发放上限需为不小于 0 的整数，留空表示不限制');
  }
  const maxIssuedPerPeriod = maxIssuedRaw.empty ? null : maxIssuedRaw.value;
  const issued = Number(c.periodIssued) || 0;
  if (maxIssuedPerPeriod !== null && issued > maxIssuedPerPeriod) {
    return fail('ASSET_MAX_ISSUED_BELOW_METER', '单期发放上限不能低于本期已发放数量（本期已发 ' + fmt(issued) + '）');
  }

  const cycleRaw = String(d.cycle === undefined || d.cycle === null ? 'week' : d.cycle);
  if (cycleRaw !== 'week' && cycleRaw !== 'month') {
    return fail('ASSET_CYCLE_INVALID', '发放周期只能是每周或每月');
  }
  const anchorNum = Number(d.anchor === undefined || d.anchor === null ? 1 : d.anchor);
  if (!isFinite(anchorNum) || !Number.isInteger(anchorNum) || anchorNum < 1 || anchorNum > 7) {
    return fail('ASSET_ANCHOR_INVALID', '周期起始日必须是 1–7 的整数');
  }

  return {
    ok: true,
    value: {
      id: id,
      name: name,
      unit: unit,
      maxBalance: maxBalance,
      maxIssuedPerPeriod: maxIssuedPerPeriod,
      issuePeriod: { cycle: cycleRaw, anchor: anchorNum },
      useRecipe: useRecipeFromDraft(d),
    },
  };
}

function assetDefOf(assetId) {
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  return defs.find(x => x && x.id === assetId) || null;
}

function balanceOf(assetId) {
  return Number((state.cards || {})[assetId]) || 0;
}

function periodKeyOfDef(def) {
  const ip = (def && def.issuePeriod) || {};
  return periodKeyOf({ period: ip.cycle === 'month' ? 'month' : 'week', anchor: ip.anchor || 1 }, now());
}

function issuedThisPeriod(def) {
  const by = state.ext && state.ext.assetMeters && state.ext.assetMeters.byAsset;
  const bucket = (by && by[def.id]) || {};
  const m = bucket[periodKeyOfDef(def)] || {};
  return Number(m.issued) || 0;
}

// 引用扫描：动作流步骤 + 周期活动发卡动作项。只读，不执行任何流。
function assetReferencesOf(assetId) {
  const refs = [];
  (Array.isArray(state.flows) ? state.flows : []).forEach(function (f) {
    if (!f) return;
    (Array.isArray(f.steps) ? f.steps : []).forEach(function (s, i) {
      if (!s || (s.atom !== 'asset.grant' && s.atom !== 'asset.spend')) return;
      const p = s.params || {};
      if (p.assetId !== assetId) return;
      refs.push({
        kind: 'flow',
        name: String(f.name || f.id || '未命名动作流'),
        stepLabel: String(s.id || ('#' + (i + 1))),
        action: s.atom === 'asset.grant' ? '发放' : '消耗',
      });
    });
  });
  (Array.isArray(state.activities) ? state.activities : []).forEach(function (a) {
    if (!a || !a.result || !Array.isArray(a.result.items)) return;
    a.result.items.forEach(function (it, i) {
      if (!it || it.type !== 'card' || it.card !== assetId) return;
      refs.push({
        kind: 'activity',
        name: String(a.name || a.id || '未命名活动'),
        stepLabel: '动作项 ' + (i + 1),
        action: '发放',
      });
    });
  });
  // 商品：资产定价消耗 / 购买赠送
  (Array.isArray(state.products) ? state.products : []).forEach(function (p) {
    if (!p) return;
    if (p.assetPrice && p.assetPrice.assetId === assetId) {
      refs.push({ kind: 'product', name: String(p.name || p.id || '未命名商品'), stepLabel: '资产定价', action: '消耗' });
    }
    (Array.isArray(p.grants) ? p.grants : []).forEach(function (g) {
      if (!g || g.kind !== 'asset' || g.assetId !== assetId) return;
      refs.push({ kind: 'product', name: String(p.name || p.id || '未命名商品'), stepLabel: '购买赠送', action: '赠送' });
    });
  });
  return refs;
}

function attrId(id) {
  return escAttr(String(id)).replace(/'/g, '&#39;');
}

function refsHTML(assetId) {
  const refs = assetReferencesOf(assetId);
  if (!refs.length) return '<div class="asset-refs">未被动作流或周期活动引用</div>';
  const parts = refs.map(function (r) {
    if (r.kind === 'flow') {
      return '动作流「' + esc(r.name) + '」步骤 ' + esc(r.stepLabel) + '（' + esc(r.action) + '，执行到该步骤会失败）';
    }
    return '周期活动「' + esc(r.name) + '」' + esc(r.stepLabel) + '（发放，活动仍会按余额上限发放，请在活动中移除）';
  });
  return '<div class="asset-refs">引用：' + parts.join('；') + '</div>';
}

function assetRowHTML(def) {
  const id = String(def.id || '');
  const name = String(def.name || id);
  const unit = String(def.unit || '张');
  const builtin = id === 'exemption';
  const archived = !!def.archived;
  const enabled = def.enabled !== false;
  const balance = balanceOf(id);
  const issued = issuedThisPeriod(def);
  const ip = def.issuePeriod || {};
  const cycleText = ip.cycle === 'month' ? '每月' : '每周 · 周' + ['一', '二', '三', '四', '五', '六', '日'][Math.min(7, Math.max(1, Number(ip.anchor) || 1)) - 1] + '起算';
  const status = archived ? '已归档' : (enabled ? '启用中' : '已停用');
  const statusCls = archived ? 'archived' : (enabled ? 'on' : 'off');
  const maxBal = (def.maxBalance === null || def.maxBalance === undefined) ? '不限' : fmt(def.maxBalance);
  const maxIssued = (def.maxIssuedPerPeriod === null || def.maxIssuedPerPeriod === undefined) ? '不限' : fmt(def.maxIssuedPerPeriod);

  let ops = '';
  if (builtin) {
    ops = '<div class="asset-ops">'
      + '<button class="btn btn-sm" onclick="openAssetModal(\'' + attrId(id) + '\')">配置使用配方</button>'
      + '</div>'
      + '<div class="asset-locked">内置资产：名称、单位、上限与周期由系统固定，不可改名或删除</div>';
  } else {
    ops = '<div class="asset-ops">'
      + '<button class="btn btn-sm" onclick="openAssetModal(\'' + attrId(id) + '\')">编辑</button>';
    if (archived) {
      ops += '<button class="btn btn-sm" onclick="unarchiveAssetDef(\'' + attrId(id) + '\')">恢复</button>';
    } else {
      ops += '<button class="btn btn-sm" onclick="toggleAssetEnabled(\'' + attrId(id) + '\')">'
        + (enabled ? '停用' : '启用') + '</button>'
        + '<button class="btn btn-sm" onclick="archiveAssetDef(\'' + attrId(id) + '\')">归档</button>';
    }
    ops += '<button class="btn btn-sm btn-danger" onclick="delAssetDef(\'' + attrId(id) + '\')">删除</button>'
      + '</div>';
  }

  let stateNote = '';
  if (archived) {
    stateNote = '<div class="asset-note">已归档：不会再发放或消耗；引用它的动作流步骤会失败。余额 ' + fmt(balance) + ' ' + esc(unit) + ' 冻结保留。</div>';
  } else if (!enabled) {
    stateNote = '<div class="asset-note">已停用：不会再发放或消耗；引用它的动作流步骤会失败。余额 ' + fmt(balance) + ' ' + esc(unit) + ' 冻结保留，不会被系统回收。</div>';
  }

  return '<div class="asset-item' + (archived ? ' is-archived' : '') + '">'
    + '<div class="asset-head">'
    + '<span class="asset-name">' + esc(name) + '</span>'
    + '<span class="asset-tag ' + statusCls + '">' + status + '</span>'
    + (builtin ? '<span class="asset-tag builtin">内置</span>' : '')
    + '<span class="asset-balance">余额 ' + fmt(balance) + ' ' + esc(unit) + '</span>'
    + '</div>'
    + '<div class="asset-meta">ID ' + esc(id) + ' · 余额上限 ' + maxBal + ' · 单期发放上限 ' + maxIssued
    + ' · ' + cycleText + ' · 本期已发 ' + fmt(issued)
    + ' · 使用配方 ' + (def.useRecipe && def.useRecipe.type === 'task-exempt' ? '任务豁免（消耗 ' + fmt(def.useRecipe.cost || 1) + '）' : '无')
    + '</div>'
    + stateNote
    + refsHTML(id)
    + ops
    + '</div>';
}

function renderAssetDefs() {
  const el = document.getElementById('assetDefsList');
  if (!el) return;
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  if (!defs.length) {
    el.innerHTML = '<div class="empty" style="padding:16px"><p style="margin:0">暂无资产定义</p></div>';
    return;
  }
  el.innerHTML = defs.map(assetRowHTML).join('');
}

function fieldValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function setReadOnly(id, ro) {
  const el = document.getElementById(id);
  if (el) el.readOnly = !!ro;
}

function setHint(msg) {
  const el = document.getElementById('assetFormHint');
  if (el) el.textContent = msg || '';
}

function openAssetModal(assetId) {
  const def = assetId ? assetDefOf(assetId) : null;
  const builtin = !!def && def.id === 'exemption';
  const title = document.getElementById('assetModalTitle');
  if (title) title.textContent = def ? '编辑资产' : '新建资产';
  setFieldValue('assetOriginalId', def ? def.id : '');
  setFieldValue('assetId', def ? def.id : '');
  setFieldValue('assetName', def ? def.name : '');
  setFieldValue('assetUnit', def ? def.unit : '张');
  setFieldValue('assetMaxBalance', def && def.maxBalance !== null && def.maxBalance !== undefined ? def.maxBalance : '');
  setFieldValue('assetMaxIssued', def && def.maxIssuedPerPeriod !== null && def.maxIssuedPerPeriod !== undefined ? def.maxIssuedPerPeriod : '');
  setFieldValue('assetCycle', def && def.issuePeriod && def.issuePeriod.cycle === 'month' ? 'month' : 'week');
  setFieldValue('assetAnchor', def && def.issuePeriod ? String(def.issuePeriod.anchor || 1) : '1');
  setFieldValue('assetUse', def && def.useRecipe && def.useRecipe.type === 'task-exempt' ? 'task-exempt' : 'none');
  // 编辑时 ID 不可改；内置资产整组定义由系统固定
  setReadOnly('assetId', !!def);
  setReadOnly('assetName', builtin);
  setReadOnly('assetUnit', builtin);
  setReadOnly('assetMaxBalance', builtin);
  setReadOnly('assetMaxIssued', builtin);
  const cycleEl = document.getElementById('assetCycle');
  if (cycleEl) cycleEl.disabled = builtin;
  const anchorEl = document.getElementById('assetAnchor');
  if (anchorEl) anchorEl.disabled = builtin;
  setHint(builtin ? '内置资产由系统固定：名称、单位、上限与周期不可修改。使用配方可自行开启或关闭。' : '');
  openModal('assetModal');
}

function handleAssetSave() {
  const originalId = String(fieldValue('assetOriginalId') || '');
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  const existing = originalId ? assetDefOf(originalId) : null;
  if (originalId && !existing) {
    const lost = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    setHint(lost.message);
    toast(lost.message, 'err');
    return lost;
  }
  // 内置资产的语义字段锁定，但「使用配方」是用户配置项，允许单独修改
  if (originalId === 'exemption') {
    const lockedChanged = fieldValue('assetName').trim() !== existing.name
      || fieldValue('assetUnit').trim() !== existing.unit
      || Number(fieldValue('assetMaxBalance')) !== existing.maxBalance
      || Number(fieldValue('assetMaxIssued')) !== existing.maxIssuedPerPeriod
      || fieldValue('assetCycle') !== (existing.issuePeriod && existing.issuePeriod.cycle)
      || Number(fieldValue('assetAnchor')) !== (existing.issuePeriod && existing.issuePeriod.anchor);
    if (lockedChanged) {
      const locked = fail('ASSET_BUILTIN_LOCKED', '内置资产的名称、单位、上限与周期不可修改；只能调整使用配方');
      setHint(locked.message);
      toast(locked.message, 'err');
      return locked;
    }
    existing.useRecipe = useRecipeFromDraft({ useType: fieldValue('assetUse') });
    existing.updatedAt = now();
    save();
    render();
    closeModal('assetModal');
    const message = existing.useRecipe ? '已开启内置资产的「任务豁免」使用配方' : '已关闭内置资产的使用配方';
    toast(message);
    return { ok: true, message: message };
  }
  const balance = originalId ? balanceOf(originalId) : 0;
  const ctx = {
    defs: defs,
    balance: balance,
    periodIssued: existing ? issuedThisPeriod(existing) : 0,
    builtin: originalId === 'exemption',
    originalId: originalId,
  };
  const res = validateAssetDraft({
    id: fieldValue('assetId'),
    name: fieldValue('assetName'),
    unit: fieldValue('assetUnit'),
    maxBalance: fieldValue('assetMaxBalance'),
    maxIssuedPerPeriod: fieldValue('assetMaxIssued'),
    cycle: fieldValue('assetCycle'),
    anchor: fieldValue('assetAnchor'),
    useType: fieldValue('assetUse'),
  }, ctx);

  if (!res.ok) {
    setHint(res.message);
    toast(res.message, 'err');
    return res;
  }

  const v = res.value;
  const ts = now();
  if (existing) {
    existing.name = v.name;
    existing.unit = v.unit;
    existing.maxBalance = v.maxBalance;
    existing.maxIssuedPerPeriod = v.maxIssuedPerPeriod;
    existing.issuePeriod = v.issuePeriod;
    existing.useRecipe = v.useRecipe;
    existing.updatedAt = ts;
  } else {
    defs.push({
      v: ASSET_VERSION,
      id: v.id,
      name: v.name,
      unit: v.unit,
      maxBalance: v.maxBalance,
      maxIssuedPerPeriod: v.maxIssuedPerPeriod,
      issuePeriod: v.issuePeriod,
      useRecipe: v.useRecipe,
      enabled: true,
      archived: false,
      origin: 'user',
      createdAt: ts,
      updatedAt: ts,
    });
    if (!state.cards || typeof state.cards !== 'object') state.cards = { exemption: 0 };
    state.cards[v.id] = 0;
  }

  save();
  render();
  closeModal('assetModal');
  const message = existing ? '已保存资产「' + v.name + '」' : '已新建资产「' + v.name + '」';
  toast(message);
  return { ok: true, message: message, value: v };
}

function guardBuiltin(def) {
  if (def.id === 'exemption') return fail('ASSET_BUILTIN_LOCKED', BUILTIN_LOCKED);
  return null;
}

function toggleAssetEnabled(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
  const locked = guardBuiltin(def);
  if (locked) { toast(locked.message, 'err'); return locked; }
  if (def.archived) {
    const r = fail('ASSET_ARCHIVED', '「' + def.name + '」已归档，请先恢复再修改启用状态');
    toast(r.message, 'err');
    return r;
  }
  const balance = balanceOf(def.id);
  if (def.enabled !== false) {
    if (balance > 0) {
      const r = fail('ASSET_BALANCE_NOT_ZERO', '「' + def.name + '」仍有余额 ' + fmt(balance) + '，请先把余额消耗或清零后再停用');
      toast(r.message, 'err');
      return r;
    }
    def.enabled = false;
    def.updatedAt = now();
    save();
    render();
    const refs = assetReferencesOf(def.id);
    const message = refs.length
      ? '已停用「' + def.name + '」：有 ' + refs.length + ' 处引用，执行到相关步骤会失败'
      : '已停用「' + def.name + '」，不会再发放或消耗';
    toast(message, refs.length ? 'warn' : undefined);
    return { ok: true, message: message };
  }
  def.enabled = true;
  def.updatedAt = now();
  save();
  render();
  const message = '已启用「' + def.name + '」';
  toast(message);
  return { ok: true, message: message };
}

function archiveAssetDef(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
  const locked = guardBuiltin(def);
  if (locked) { toast(locked.message, 'err'); return locked; }
  if (def.archived) {
    const r = fail('ASSET_ALREADY_ARCHIVED', '「' + def.name + '」已经归档');
    toast(r.message, 'err');
    return r;
  }
  const balance = balanceOf(def.id);
  if (balance > 0) {
    const r = fail('ASSET_BALANCE_NOT_ZERO', '「' + def.name + '」仍有余额 ' + fmt(balance) + '，请先把余额消耗或清零后再归档');
    toast(r.message, 'err');
    return r;
  }
  def.archived = true;
  def.updatedAt = now();
  save();
  render();
  const refs = assetReferencesOf(def.id);
  const message = refs.length
    ? '已归档「' + def.name + '」：有 ' + refs.length + ' 处引用，执行到相关步骤会失败'
    : '已归档「' + def.name + '」';
  toast(message, refs.length ? 'warn' : undefined);
  return { ok: true, message: message };
}

function unarchiveAssetDef(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
  const locked = guardBuiltin(def);
  if (locked) { toast(locked.message, 'err'); return locked; }
  if (!def.archived) {
    const r = fail('ASSET_NOT_ARCHIVED', '「' + def.name + '」未归档');
    toast(r.message, 'err');
    return r;
  }
  def.archived = false;
  def.updatedAt = now();
  save();
  render();
  const message = '已恢复「' + def.name + '」' + (def.enabled === false ? '，当前仍为停用状态，可点击启用' : '');
  toast(message, def.enabled === false ? 'warn' : undefined);
  return { ok: true, message: message };
}

function delAssetDef(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
  const locked = guardBuiltin(def);
  if (locked) { toast(locked.message, 'err'); return locked; }
  const balance = balanceOf(def.id);
  if (balance > 0) {
    const r = fail('ASSET_BALANCE_NOT_ZERO', '「' + def.name + '」仍有余额 ' + fmt(balance) + '，请先清零后再删除');
    toast(r.message, 'err');
    return r;
  }
  const refs = assetReferencesOf(def.id);
  const flowRefs = refs.filter(r => r.kind === 'flow');
  if (flowRefs.length) {
    const r = fail('ASSET_REFERENCED_BY_FLOW', '「' + def.name + '」仍被 ' + flowRefs.length + ' 条动作流引用，请先在流里改用其他资产或删除相关步骤');
    toast(r.message, 'err');
    return r;
  }
  const actRefs = refs.filter(r => r.kind === 'activity');
  if (actRefs.length) {
    const r = fail('ASSET_REFERENCED_BY_ACTIVITY', '「' + def.name + '」仍被 ' + actRefs.length + ' 个周期活动引用，请先从活动中移除对应动作项');
    toast(r.message, 'err');
    return r;
  }

  state.assetDefs = (Array.isArray(state.assetDefs) ? state.assetDefs : []).filter(d => !d || d.id !== def.id);
  if (state.cards && typeof state.cards === 'object') delete state.cards[def.id];
  const meters = state.ext && state.ext.assetMeters && state.ext.assetMeters.byAsset;
  if (meters && typeof meters === 'object') delete meters[def.id];
  save();
  render();
  const message = '已删除资产「' + def.name + '」';
  toast(message);
  return { ok: true, message: message };
}

export {
  validateAssetDraft, assetReferencesOf, renderAssetDefs,
  openAssetModal, handleAssetSave, toggleAssetEnabled,
  archiveAssetDef, unarchiveAssetDef, delAssetDef,
};
