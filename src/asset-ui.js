// asset-ui.js —— 阶段 4 S8：资产定义管理界面
//
// 只负责「定义层」的增删改查、边界校验与说明展示：
// - 不触发任何动作流执行，不调用 FlowEngine / dryRun / undoFlowRun；
// - 余额写入仍走既有账务/清空入口，这里只做资产定义的编辑与状态切换；
// - 所有资产（含默认播种的示例）在编辑权限与操作入口上完全一致。
import { ASSET_VERSION } from './constants.js';
import { runCommand } from './command.js';
import { openModal, closeModal } from './modal-host.js';
import { markModalClean, rejectFields } from './form-contract.js';
import { isValidAssetId } from './normalize.js';
import { save } from './persist.js';
import { assetLogMeta, clone, esc, escAttr, fmt, now, uid } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { periodKeyOf } from './time.js';

const NAME_MAX = 20;
const ID_HINT = '资产 ID 不合法：需小写字母开头，仅含小写字母/数字/下划线，长度 3–32';

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

// 纯校验：不读写 DOM、不写 state。ctx = { defs, balance, periodIssued, originalId }
function validateAssetDraft(draft, ctx) {
  const d = draft || {};
  const c = ctx || {};
  const defs = Array.isArray(c.defs) ? c.defs : [];
  const originalId = c.originalId ? String(c.originalId) : '';

  let id = originalId;
  if (!originalId) {
    id = String(d.id === null || d.id === undefined ? '' : d.id).trim();
    if (!id) return fail('ASSET_ID_REQUIRED', '请填写资产 ID');
    if (!isValidAssetId(id)) return fail('ASSET_ID_INVALID', ID_HINT);
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

// 引用扫描：动作流步骤 + 商品。只读，不执行任何流。
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
  if (!refs.length) return '<div class="asset-refs">未被动作流或商品引用</div>';
  const parts = refs.map(function (r) {
    if (r.kind === 'flow') {
      return '动作流「' + esc(r.name) + '」步骤 ' + esc(r.stepLabel) + '（' + esc(r.action) + '，执行到该步骤会失败）';
    }
    return '商品「' + esc(r.name) + '」' + esc(r.stepLabel) + '（' + esc(r.action) + '，请先在商品中调整）';
  });
  return '<div class="asset-refs">引用：' + parts.join('；') + '</div>';
}

// 最近资产流水：类别/来源/去向三个可选字段；旧流水缺字段时按「未知」呈现
function recentFlowsHTML(assetId) {
  const list = (state.logs || []).filter(function (l) {
    return l && l.st === 'card' && l.card === assetId;
  }).slice(0, 3);
  if (!list.length) return '';
  const lines = list.map(function (l) {
    const m = assetLogMeta(l);
    return '· ' + esc(l.desc || '（无说明）') + '（类别 ' + esc(m.catName) + '，来源 ' + esc(m.from) + '，去向 ' + esc(m.to) + '）';
  });
  return '<div class="asset-refs">最近流水：<br>' + lines.join('<br>') + '</div>';
}

function assetRowHTML(def) {
  const id = String(def.id || '');
  const name = String(def.name || id);
  const unit = String(def.unit || '张');
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

  let ops = '<div class="asset-ops">'
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
    + '<span class="asset-balance">余额 ' + fmt(balance) + ' ' + esc(unit) + '</span>'
    + '</div>'
    + '<div class="asset-meta">ID ' + esc(id) + ' · 余额上限 ' + maxBal + ' · 单期发放上限 ' + maxIssued
    + ' · ' + cycleText + ' · 本期已发 ' + fmt(issued)
    + ' · 使用配方 ' + (def.useRecipe && def.useRecipe.type === 'task-exempt' ? '任务豁免（消耗 ' + fmt(def.useRecipe.cost || 1) + '）' : '无')
    + '</div>'
    + stateNote
    + refsHTML(id)
    + recentFlowsHTML(id)
    + ops
    + '</div>';
}

function renderAssetDefs() {
  const el = document.getElementById('assetDefsList');
  if (!el) return;
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  const bar = assetDeleteUndoBarHTML();
  if (!defs.length) {
    el.innerHTML = bar + '<div class="empty" style="padding:16px"><p style="margin:0">暂无资产定义</p></div>';
    return;
  }
  el.innerHTML = bar + defs.map(assetRowHTML).join('');
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
  // 编辑时 ID 不可改（对所有资产一致）；新建留空则保存时自动生成
  setReadOnly('assetId', !!def);
  const adv = document.getElementById('accAssetAdvanced');
  if (adv) adv.classList.remove('open');
  setHint('');
  openModal('assetModal');
  markModalClean('assetModal');
}

// 自动生成一个满足 isValidAssetId 且未被占用的默认 ID（只用于新建）
function nextAssetId(defs) {
  for (let i = 0; i < 50; i++) {
    const id = 'a_' + Math.random().toString(36).slice(2, 8);
    if (isValidAssetId(id) && !defs.some(function (x) { return x && x.id === id; })) return id;
  }
  return 'a_' + String(Date.now()).slice(-8);
}

const ASSET_ERR_FIELD = {
  ASSET_NOT_FOUND: 'assetId',
  ASSET_ID_REQUIRED: 'assetId',
  ASSET_ID_INVALID: 'assetId',
  ASSET_ID_DUP: 'assetId',
  ASSET_NAME_REQUIRED: 'assetName',
  ASSET_NAME_TOO_LONG: 'assetName',
  ASSET_NAME_DUP: 'assetName',
  ASSET_MAX_BALANCE_INVALID: 'assetMaxBalance',
  ASSET_MAX_BALANCE_BELOW_BALANCE: 'assetMaxBalance',
  ASSET_MAX_ISSUED_INVALID: 'assetMaxIssued',
  ASSET_MAX_ISSUED_BELOW_METER: 'assetMaxIssued',
  ASSET_CYCLE_INVALID: 'assetCycle',
  ASSET_ANCHOR_INVALID: 'assetAnchor',
};

function assetFieldError(code, msg) {
  const field = ASSET_ERR_FIELD[code];
  if (field && field === 'assetId') {
    const adv = document.getElementById('accAssetAdvanced');
    if (adv) adv.classList.add('open');
  }
  const first = field ? rejectFields('assetModal', [{ field: field, msg: msg }]) : null;
  if (!first) toast(msg, 'err');
}

function handleAssetSave() {
  const originalId = String(fieldValue('assetOriginalId') || '');
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  const existing = originalId ? assetDefOf(originalId) : null;
  if (originalId && !existing) {
    const lost = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    setHint(lost.message);
    assetFieldError(lost.code, lost.message);
    return lost;
  }
  // 新建且未填 ID：自动生成，旧资产 ID 不受影响
  const rawId = String(fieldValue('assetId') || '').trim();
  const draftId = originalId ? originalId : (rawId || nextAssetId(defs));
  if (!originalId && !rawId) setFieldValue('assetId', draftId);
  const balance = originalId ? balanceOf(originalId) : 0;
  const ctx = {
    defs: defs,
    balance: balance,
    periodIssued: existing ? issuedThisPeriod(existing) : 0,
    originalId: originalId,
  };
  const res = validateAssetDraft({
    id: draftId,
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
    assetFieldError(res.code, res.message);
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
    if (!state.cards || typeof state.cards !== 'object') state.cards = {};
    state.cards[v.id] = 0;
  }

  save();
  render();
  closeModal('assetModal');
  const message = existing ? '已保存资产「' + v.name + '」' : '已新建资产「' + v.name + '」';
  toast(message);
  return { ok: true, message: message, value: v };
}

function toggleAssetEnabled(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
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

// ===== 资产定义删除撤销 =====
// 与项目/杂事删除同构：删除前快照定义、原下标、余额键与资产计量；
// 余额 > 0 的删除在入口已被拒绝，因此快照里余额恒为 0，撤销恢复的是「定义 + 空余额键 + 计量」。
const ASSET_DELETE_UNDO_LIMIT = 5;
function assetDeleteUndoList() {
  if (!Array.isArray(state.assetDeleteUndo)) state.assetDeleteUndo = [];
  return state.assetDeleteUndo;
}
function makeAssetDeleteUndo(def) {
  const cards = state.cards && typeof state.cards === 'object' ? state.cards : null;
  const meters = state.ext && state.ext.assetMeters && state.ext.assetMeters.byAsset;
  const meterHad = !!(meters && typeof meters === 'object' && Object.prototype.hasOwnProperty.call(meters, def.id));
  return {
    v: 1,
    id: uid(),
    at: now(),
    def: clone(def),
    index: (Array.isArray(state.assetDefs) ? state.assetDefs : []).indexOf(def),
    cardHad: !!(cards && Object.prototype.hasOwnProperty.call(cards, def.id)),
    cardValue: cards ? Number(cards[def.id]) || 0 : 0,
    meterHad: meterHad,
    meter: meterHad ? clone(meters[def.id]) : null,
  };
}
function pushAssetDeleteUndo(rec) {
  const list = assetDeleteUndoList();
  list.push(rec);
  while (list.length > ASSET_DELETE_UNDO_LIMIT) list.shift();
}
function restoreAssetDeletion(recId) {
  const list = assetDeleteUndoList();
  const at = list.findIndex(r => r && r.id === recId);
  if (at < 0) return { ok: false, reason: '没有可恢复的删除记录' };
  const rec = list[at];
  const def = rec && rec.def;
  if (!def || typeof def !== 'object' || Array.isArray(def) || !def.id) {
    return { ok: false, reason: '删除记录已损坏' };
  }
  // 冲突校验先于任何写入：同 id 已被占用则整笔拒绝，避免覆盖现有定义。
  if (assetDefOf(def.id)) return { ok: false, reason: '资产「' + def.id + '」已存在，无法恢复' };
  if (!Array.isArray(state.assetDefs)) state.assetDefs = [];
  let index = Number(rec.index);
  if (!isFinite(index)) index = state.assetDefs.length;
  index = Math.max(0, Math.min(Math.floor(index), state.assetDefs.length));
  state.assetDefs.splice(index, 0, clone(def));
  if (rec.cardHad) {
    if (!state.cards || typeof state.cards !== 'object') state.cards = {};
    state.cards[def.id] = Number(rec.cardValue) || 0;
  }
  if (rec.meterHad) {
    const meters = state.ext && state.ext.assetMeters && state.ext.assetMeters.byAsset;
    if (meters && typeof meters === 'object') meters[def.id] = clone(rec.meter || {});
  }
  list.splice(at, 1);
  return { ok: true, id: def.id };
}
function assetDeleteUndoBarHTML() {
  const list = Array.isArray(state.assetDeleteUndo) ? state.assetDeleteUndo : [];
  const recs = list.filter(r => r && r.def).slice().reverse();
  if (!recs.length) return '';
  return '<div class="affair-empty affair-delete-undo"><div class="affair-delete-undo-head">最近删除 · 最多保留 5 条</div>'
    + recs.map(function (rec) {
      return '<div class="affair-delete-undo-row">'
        + '<span class="affair-delete-undo-name">已删除「' + esc(rec.def.name) + '」</span>'
        + '<button class="btn btn-sm" onclick="undoAssetDelete(\'' + rec.id + '\')">撤销删除</button>'
        + '<button class="btn btn-sm" onclick="dismissAssetDeleteUndo(\'' + rec.id + '\')">忽略</button>'
        + '</div>';
    }).join('')
    + '</div>';
}
function undoAssetDelete(recId) {
  runCommand({
    label: 'asset-delete-undo',
    toast: '已恢复删除前的资产定义与余额',
    run: function () { return restoreAssetDeletion(recId); },
  });
}
function dismissAssetDeleteUndo(recId) {
  runCommand({
    label: 'asset-delete-dismiss',
    run: function () {
      const list = assetDeleteUndoList();
      const i = list.findIndex(r => r && r.id === recId);
      if (i < 0) return { ok: false, reason: '没有这条删除记录' };
      list.splice(i, 1);
      return { ok: true, toast: { msg: '已忽略该撤销提示' } };
    },
  });
}

function delAssetDef(assetId) {
  const def = assetDefOf(assetId);
  if (!def) {
    const r = fail('ASSET_NOT_FOUND', '资产定义不存在或已被删除');
    toast(r.message, 'err');
    return r;
  }
  const balance = balanceOf(def.id);
  // 非零即拦：正余额和负余额都必须先清零（负数同样不是可删除的干净状态）。
  if (balance !== 0) {
    const r = fail('ASSET_BALANCE_NOT_ZERO', '「' + def.name + '」余额为 ' + fmt(balance) + '，需清零后才能删除');
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
  // 商品引用（资产定价消耗 / 购买赠送）与流引用同一口径：结构性引用一律拦。
  // 历史流水（logs[].card）只是记账痕迹，不拦住删除。
  const productRefs = refs.filter(r => r.kind === 'product');
  if (productRefs.length) {
    const r = fail('ASSET_REFERENCED_BY_PRODUCT', '「' + def.name + '」仍被 ' + productRefs.length + ' 个商品引用，请先在商品里改用其他资产或移除相关定价/赠送');
    toast(r.message, 'err');
    return r;
  }
  // 既有语义保持不变：仍有余额、被动作流引用时不允许删除。
  // 删除与快照写入放在同一事务里，任何失败整单回滚。
  return runCommand({
    label: 'asset-def-del',
    run: function () {
      const rec = makeAssetDeleteUndo(def);
      state.assetDefs = (Array.isArray(state.assetDefs) ? state.assetDefs : []).filter(d => !d || d.id !== def.id);
      if (state.cards && typeof state.cards === 'object') delete state.cards[def.id];
      const meters = state.ext && state.ext.assetMeters && state.ext.assetMeters.byAsset;
      if (meters && typeof meters === 'object') delete meters[def.id];
      pushAssetDeleteUndo(rec);
      return { ok: true, toast: { msg: '已删除资产「' + def.name + '」，可在资产面板顶部撤销' } };
    },
  });
}

export {
  validateAssetDraft, assetReferencesOf, renderAssetDefs,
  openAssetModal, handleAssetSave, toggleAssetEnabled,
  archiveAssetDef, unarchiveAssetDef, delAssetDef,
  undoAssetDelete, dismissAssetDeleteUndo, assetDeleteUndoBarHTML, restoreAssetDeletion,
  ASSET_DELETE_UNDO_LIMIT,
};
