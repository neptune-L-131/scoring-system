// form-contract.js —— 编辑弹窗的统一表单契约（只做 DOM，不写 state、不落盘）
//
// 契约：
// 1) 校验错误显示在字段下方（.field-err），并聚焦第一个错误；toast 只报结果。
// 2) 编辑类弹窗在打开时记录快照；取消 / 遮罩 / Esc 关闭前做脏检查。
// 3) 关闭只有一个入口 requestModalClose，确认类弹窗也走同一入口（无快照 = 直接关）。
//
// 新弹窗接入方式：打开完成后调用 markModalClean(id)，取消按钮写 requestModalClose('id')。
const EDIT_MODALS = {
  taskModal: 1,
  presetModal: 1,
  affairPlanModal: 1,
  choreModal: 1,
  choreConfigModal: 1,
  achModal: 1,
  metricModal: 1,
  assetModal: 1,
  flowModal: 1,
  prodModal: 1,
  budgetCatModal: 1,
};

// 动态容器没有表单控件的 value，额外把 innerHTML 纳入快照
const WATCH = {
  choreModal: ['choreTags'],
  flowModal: ['flowCondItems', 'flowStepList'],
};

const snapshots = {};
const closeHooks = {};

function byId(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function isEditingModal(id) {
  return !!EDIT_MODALS[id];
}

function controlSnapshot(id) {
  const bg = byId(id);
  if (!bg || typeof bg.querySelectorAll !== 'function') return '';
  const parts = [];
  const list = bg.querySelectorAll('input,select,textarea');
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!el) continue;
    const type = el.type || '';
    if (type === 'button' || type === 'submit') continue;
    const key = el.id || el.name || ('#' + i);
    const val = (type === 'checkbox' || type === 'radio') ? String(!!el.checked) : String(el.value == null ? '' : el.value);
    parts.push(key + '=' + val);
  }
  (WATCH[id] || []).forEach(function (cid) {
    const box = byId(cid);
    if (box) parts.push(cid + '#' + String(box.innerHTML || ''));
  });
  return parts.join('|');
}

// 打开弹窗、填完表单后调用：把当前状态记为“未修改”
function markModalClean(id) {
  if (isEditingModal(id)) snapshots[id] = controlSnapshot(id);
}

function clearModalMark(id) {
  delete snapshots[id];
}

function modalIsDirty(id) {
  if (!isEditingModal(id)) return false;
  if (!(id in snapshots)) return false;
  return controlSnapshot(id) !== snapshots[id];
}

// 某些弹窗关闭时需要清理内存草稿（如动作流），由所属模块注册
function registerModalCloseHook(id, fn) {
  if (typeof fn === 'function') closeHooks[id] = fn;
}

// 唯一关闭入口：脏检查 → 关闭。返回 false 表示用户取消了关闭。
function requestModalClose(id, force) {
  if (!force && modalIsDirty(id)) {
    const ask = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm('关闭会丢失未保存的修改，确定关闭？')
      : true;
    if (!ask) return false;
  }
  delete snapshots[id];
  if (closeHooks[id]) {
    closeHooks[id]();
    return true;
  }
  const bg = byId(id);
  if (bg && bg.classList) bg.classList.remove('show');
  return true;
}

const ERR_CLASS = 'field-err';

function errorHost(field) {
  if (!field) return null;
  if (field.closest) {
    const fg = field.closest('.fg');
    if (fg) return fg;
  }
  return field.parentNode || null;
}

// 清掉本弹窗的所有字段错误（再次提交时先清，避免旧提示残留）
function clearFieldErrors(modalId) {
  const bg = byId(modalId);
  if (!bg || typeof bg.querySelectorAll !== 'function') return;
  const errs = bg.querySelectorAll('.' + ERR_CLASS);
  for (let i = 0; i < errs.length; i++) {
    const n = errs[i];
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }
  const bad = bg.querySelectorAll('.invalid');
  for (let i = 0; i < bad.length; i++) {
    const n = bad[i];
    if (n && n.classList) n.classList.remove('invalid');
    if (n && n.removeAttribute) n.removeAttribute('aria-invalid');
  }
}

function setFieldError(fieldId, msg) {
  const field = byId(fieldId);
  const host = errorHost(field);
  if (!field || !host) return false;
  let err = host.querySelector ? host.querySelector('.' + ERR_CLASS) : null;
  if (!err) {
    if (typeof document === 'undefined' || !document.createElement) return false;
    err = document.createElement('div');
    err.className = ERR_CLASS;
    if (host.appendChild) host.appendChild(err);
  }
  err.textContent = msg;
  if (field.classList) field.classList.add('invalid');
  if (field.setAttribute) field.setAttribute('aria-invalid', 'true');
  return true;
}

function focusField(fieldId) {
  const el = byId(fieldId);
  if (!el) return;
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  if (el.focus) el.focus();
}

// 统一校验失败出口：清旧错误 → 逐项标注 → 聚焦第一个 → 返回第一个错误字段（无则 null）
// 有字段可标注时不再 toast，避免同一错误出现两次。
function rejectFields(modalId, items) {
  clearFieldErrors(modalId);
  let first = null;
  (items || []).forEach(function (it) {
    if (!it || !it.field) return;
    if (setFieldError(it.field, it.msg) && !first) first = it.field;
  });
  if (first) focusField(first);
  return first;
}

export {
  isEditingModal,
  markModalClean,
  clearModalMark,
  modalIsDirty,
  registerModalCloseHook,
  requestModalClose,
  clearFieldErrors,
  setFieldError,
  focusField,
  rejectFields,
};
