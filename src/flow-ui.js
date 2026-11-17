// flow-ui.js —— 阶段 4 动作流前台（S9）：流编辑器、干跑面板、运行历史与整单撤销
//
// 边界：
// 1. 只做 UI：配置编辑、试跑展示、历史展示、显式执行与撤销入口；
// 2. 编辑器只开放 FLOW_ATOMS 的 7 个原子，参数按原子白名单复制，不提供任意字段写入；
// 3. 保存只落配置，绝不执行；执行必须由用户显式点击并二次确认；
// 4. 试跑复用 FlowEngine.dryRun，撤销复用 FlowEngine.undoFlowRun，不另造账务语义。
import {
  FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_ASSET, FLOW_ATOM_MAX_CURRENCY,
  FLOW_ATOM_NOTE_MAX_LEN, FLOW_MAX_DEPTH, FLOW_MAX_STEPS, FLOW_RUN_KEEP,
  FLOW_VERSION, LOG_MAX,
} from './constants.js';
import { deleteMigratedFlow } from './activity-migrate.js';
import { FLOW_ATOMS, FLOW_ATOM_IDS, assetPeriodKeyOf, describeFlowAtom } from './flow-atoms.js';
import { FlowEngine, FLOW_REVERSERS } from './flow-engine.js';
import { normalizeCondition } from './cond-model.js';
import { condNodeLabel, metricLabel } from './cycle.js';
import { isCondEventMode, refreshCondPanel, renderCondTree, resetCondDraftUI, setCondDraftContext, setCondEventMode } from './cond-ui.js';
import { EVENT_KINDS } from './events.js';
import { closeModal, openModal } from './modal-host.js';
import { normalizeFlow } from './normalize.js';
import { save } from './persist.js';
import { cardName, esc, escAttr, fmt, isPointMetric, now, uid } from './pure.js';
import { registerRenderer, render } from './render.js';
import { state } from './state.js';
import { accountLabel } from './stats.js';
import { toast } from './toast.js';
import { domainName } from './utils.js';

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,15}$/;

// 分支条件只用基础聚合指标，避免目标类型/筛选器缺失导致恒 false
const BRANCH_METRICS = [
  { id: 'checkins', name: '打卡次数' },
  { id: 'vitality', name: '活力点' },
  { id: 'progress', name: '进度值' },
  { id: 'achievement', name: '成果点' },
];
const BRANCH_RANGES = [
  { id: 'period', name: '本周期' },
  { id: 'total', name: '累计' },
  { id: 'recent', name: '最近 N 天' },
  { id: 'today', name: '今天' },
];
const BRANCH_OPS = ['>=', '>', '<=', '<'];

const UNDO_TEXT = {
  ALREADY: '这次运行已经撤销过，不能重复撤销',
  NOT_FOUND: '找不到这次运行记录（可能已超出最近 ' + FLOW_RUN_KEEP + ' 次保留窗口）',
  NO_JOURNAL: '缺少撤销凭证（该记录由旧版本写入），无法整单撤销',
  LOG_TRIMMED: '相关流水已被裁剪（日志只保留最近 ' + LOG_MAX + ' 条），无法定位并回滚',
  NO_REVERSER: '存在没有撤销实现的步骤原子，无法整单撤销',
  BUSY: '正在执行其他写操作，请稍后再试',
};

let flowDraft = null;
let flowEditingId = '';
let flowModalOpen = false;
let dryResult = null;
let dryFlowId = '';
let undoMsg = {};
let stepSeq = 0;

// ===== 基础工具 =====
function clone(v) {
  try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}
function fieldValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}
function setField(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v === undefined || v === null ? '' : String(v);
}
function getChecked(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}
function setChecked(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}
function showEl(id, on) {
  const el = document.getElementById(id);
  if (el && el.style) el.style.display = on ? '' : 'none';
}
function flowsOf() {
  return Array.isArray(state.flows) ? state.flows : [];
}
// flowRuns.recent 存的是运行 id，记录本体在 byId
function recentRuns() {
  const bucket = state.ext && state.ext.flowRuns;
  if (!bucket) return [];
  const ids = Array.isArray(bucket.recent) ? bucket.recent : [];
  const byId = bucket.byId || {};
  return ids.map(function (id) { return byId[id] || null; }).filter(function (r) { return !!r; });
}
function findFlow(id) {
  return flowsOf().find(function (f) { return f && f.id === id; }) || null;
}
function findDef(id) {
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  return defs.find(function (d) { return d && d.id === id; }) || null;
}
function usableAssets() {
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  return defs.filter(function (d) { return d && d.enabled !== false && !d.archived; });
}
function firstUsableAssetId() {
  const list = usableAssets();
  return list.length ? list[0].id : '';
}
function atomName(atom) {
  const a = FLOW_ATOMS[atom];
  return a && a.name ? a.name : atom;
}
function fail(code, message) {
  return { ok: false, code: code, message: message };
}
function periodText(period, anchor) {
  if (period === 'day') return '每天';
  if (period === 'month') return '每月 ' + (Number(anchor) || 1) + ' 号';
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return '每周' + (names[(Number(anchor) || 1) - 1] || '一');
}
function flowTriggerText(flow) {
  const t = flow.trigger || {};
  if (t.type === 'event') return t.event && t.event.kind === 'purchase' ? '购买时触发' : '打卡时触发';
  return t.type === 'manual' ? '手动触发' : periodText(t.period, t.anchor);
}
function fmtRunTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return mm + '/' + dd + ' ' + hh + ':' + mi;
}
function attrId(v) {
  return escAttr(String(v === undefined || v === null ? '' : v));
}

// ===== 草稿与步骤树 =====
function defaultParams(atom) {
  if (atom === 'currency.grant' || atom === 'currency.spend') return { account: 'vitality', amount: '1', desc: '' };
  if (atom === 'asset.grant' || atom === 'asset.spend') return { assetId: firstUsableAssetId(), amount: '1', desc: '' };
  if (atom === 'entity.archiveIdle') return { kind: 'task', idleDays: '30', desc: '' };
  if (atom === 'log.note') return { desc: '' };
  return {};
}
function collectIds(list, out) {
  (list || []).forEach(function (s) {
    if (!s) return;
    if (s.id) out.add(String(s.id));
    if (s.as) out.add(String(s.as));
    collectIds(s.then, out);
    collectIds(s.else, out);
  });
}
function nextStepId() {
  const used = new Set();
  collectIds(flowDraft ? flowDraft.steps : [], used);
  // 单调递增：默认分支在推入前就为子步骤取 id，单靠扫描会撞号
  stepSeq += 1;
  while (used.has('s' + stepSeq)) stepSeq += 1;
  return 's' + stepSeq;
}
function defaultStep(atom) {
  return { id: nextStepId(), atom: atom, params: defaultParams(atom) };
}
function defaultBranchLeaf() {
  // 事件触发模式下分支条件默认「今天」，否则默认「本周期」
  return { range: isCondEventMode() ? 'today' : 'period', days: 7, metric: 'checkins', op: '>=', value: 1, targetType: 'all', newFilter: 'none' };
}
function defaultBranch() {
  const step = { id: nextStepId(), kind: 'branch', when: { mode: 'all', items: [defaultBranchLeaf()] }, then: [], else: [] };
  step.then.push({ id: nextStepId(), atom: 'log.note', params: { desc: '动作流记录' } });
  return step;
}
function splitPath(path) {
  const parts = String(path || '').split('/').filter(function (x) { return x !== ''; });
  const index = Number(parts.pop());
  return { parent: parts.join('/'), index: index };
}
function stepListAt(parent) {
  if (!flowDraft) return null;
  if (!parent) return flowDraft.steps;
  const segs = String(parent).split('/');
  let list = flowDraft.steps;
  for (let i = 0; i + 1 < segs.length; i += 2) {
    const node = list[Number(segs[i])];
    if (!node) return null;
    list = segs[i + 1] === 'then' ? node.then : node.else;
    if (!Array.isArray(list)) return null;
  }
  return list;
}
function stepAt(path) {
  const p = splitPath(path);
  const list = stepListAt(p.parent);
  return list && list[p.index] ? list[p.index] : null;
}
function pathDepth(parent) {
  return String(parent || '').split('/').filter(function (x) { return x === 'then' || x === 'else'; }).length;
}
function countSteps(list) {
  let n = 0;
  (list || []).forEach(function (s) {
    n += 1;
    if (s && s.kind === 'branch') n += countSteps(s.then) + countSteps(s.else);
  });
  return n;
}

// ===== 校验 =====
function knownAccount(account) {
  if (account === 'vitality' || account === 'achievement') return true;
  if (typeof account === 'string' && account.indexOf('progress:') === 0) {
    const id = account.slice(9);
    return (state.domains || []).some(function (d) { return d && d.id === id; });
  }
  return false;
}
function validateBranchLeaf(when) {
  const items = when && Array.isArray(when.items) ? when.items : [];
  const leaf = items[0];
  if (!leaf) return fail('FLOW_BAD_PARAMS', '条件分支需要设置一个条件');
  if (!BRANCH_METRICS.some(function (m) { return m.id === leaf.metric; })) {
    return fail('FLOW_BAD_PARAMS', '条件分支的指标不在开放范围内');
  }
  if (!BRANCH_RANGES.some(function (r) { return r.id === leaf.range; })) {
    return fail('FLOW_BAD_PARAMS', '条件分支的范围不合法');
  }
  if (BRANCH_OPS.indexOf(leaf.op) < 0) return fail('FLOW_BAD_PARAMS', '条件分支的运算符不合法');
  if (!isFinite(Number(leaf.value))) return fail('FLOW_BAD_PARAMS', '条件分支的数值必须是数字');
  if (leaf.range === 'recent') {
    const d = Number(leaf.days);
    if (!Number.isInteger(d) || d < 1 || d > 365) return fail('FLOW_BAD_PARAMS', '条件分支的最近天数必须是 1–365 的整数');
  }
  return null;
}
function validateStepParams(atom, params, id) {
  const p = params || {};
  if (atom === 'currency.grant' || atom === 'currency.spend') {
    if (!p.account) return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」请选择账户');
    const splitAll = atom === 'currency.grant' && p.split === 'allDomains';
    if (splitAll) {
      if (p.account !== 'progress') return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」只有进度账户支持全部领域均分');
      if (!(state.domains || []).some(d => d && d.id)) return fail('FLOW_INVALID_ACCOUNT', '步骤「' + id + '」当前没有可分摊的领域');
    } else if (p.account === 'progress') {
      return fail('FLOW_INVALID_ACCOUNT', '步骤「' + id + '」进度账户需要选择具体领域');
    } else if (!knownAccount(p.account)) {
      return fail('FLOW_INVALID_ACCOUNT', '步骤「' + id + '」的账户「' + p.account + '」不存在');
    }
    if (p.taskId !== undefined && p.account !== 'vitality') {
      return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」只有活力账户支持指定任务');
    }
    const amt = Number(p.amount);
    if (!isFinite(amt) || amt <= 0) return fail('FLOW_INVALID_AMOUNT', '步骤「' + id + '」的金额必须大于 0');
    if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) return fail('FLOW_INVALID_AMOUNT', '步骤「' + id + '」的金额最多两位小数');
    if (amt > FLOW_ATOM_MAX_CURRENCY) return fail('FLOW_AMOUNT_LIMIT', '步骤「' + id + '」单步金额不能超过 ' + FLOW_ATOM_MAX_CURRENCY);
    return null;
  }
  if (atom === 'asset.grant' || atom === 'asset.spend') {
    if (!p.assetId) return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」请选择资产');
    const def = findDef(p.assetId);
    if (!def) return fail('FLOW_ASSET_UNKNOWN', '步骤「' + id + '」引用的资产「' + p.assetId + '」不存在');
    if (def.enabled === false) return fail('FLOW_ASSET_DISABLED', '步骤「' + id + '」引用的资产「' + (def.name || def.id) + '」已停用');
    if (def.archived) return fail('FLOW_ASSET_ARCHIVED', '步骤「' + id + '」引用的资产「' + (def.name || def.id) + '」已归档');
    const amt = Number(p.amount);
    if (!Number.isInteger(amt) || amt < 1) return fail('FLOW_INVALID_AMOUNT', '步骤「' + id + '」的资产数量必须是正整数');
    if (p.cap !== undefined) {
      const cap = Number(p.cap);
      if (!Number.isInteger(cap) || cap < 1) return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」的上限必须是正整数');
    }
    let max = FLOW_ATOM_MAX_ASSET;
    // 带 cap 的发放复刻活动语义，不受资产周期上限压缩
    if (atom === 'asset.grant' && p.cap === undefined && def.maxIssuedPerPeriod !== null && def.maxIssuedPerPeriod !== undefined) {
      max = Math.min(max, Number(def.maxIssuedPerPeriod));
    }
    if (amt > max) return fail('FLOW_AMOUNT_LIMIT', '步骤「' + id + '」的资产数量不能超过 ' + max);
    return null;
  }
  if (atom === 'entity.archiveIdle') {
    if (['task', 'affair', 'chore'].indexOf(p.kind) < 0) return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」的归档类型只能是任务/项目/杂事');
    const d = Number(p.idleDays);
    if (!Number.isInteger(d) || d < 1 || d > FLOW_ATOM_IDLE_DAYS_MAX) {
      return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」的不活跃天数必须是 1–' + FLOW_ATOM_IDLE_DAYS_MAX + ' 的整数');
    }
    return null;
  }
  if (atom === 'log.note') {
    const desc = String(p.desc || '').trim();
    if (!desc) return fail('FLOW_BAD_PARAMS', '步骤「' + id + '」请填写记录内容');
    if (desc.length > FLOW_ATOM_NOTE_MAX_LEN) return fail('FLOW_NOTE_TOO_LONG', '步骤「' + id + '」的记录最多 ' + FLOW_ATOM_NOTE_MAX_LEN + ' 个字符');
    return null;
  }
  return null;
}
function validateStepList(list, depth, seen) {
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (!s || typeof s !== 'object') return fail('FLOW_BAD_STEP', '第 ' + (i + 1) + ' 个步骤格式不正确');
    const id = String(s.id || '');
    if (!STEP_ID_RE.test(id)) return fail('FLOW_BAD_STEP', '步骤 ID「' + id + '」不合法');
    if (seen.has(id)) return fail('FLOW_BAD_STEP', '步骤 ID「' + id + '」重复');
    seen.add(id);
    if (s.kind === 'branch') {
      if (depth + 1 > FLOW_MAX_DEPTH) return fail('FLOW_DEPTH_LIMIT', '条件分支嵌套不能超过 ' + FLOW_MAX_DEPTH + ' 层');
      if (!Array.isArray(s.then) || !s.then.length) return fail('FLOW_BAD_STEP', '分支「' + id + '」的「满足时」至少要有一个步骤');
      const we = validateBranchLeaf(s.when);
      if (we) return we;
      const e1 = validateStepList(s.then, depth + 1, seen);
      if (e1) return e1;
      const e2 = validateStepList(Array.isArray(s.else) ? s.else : [], depth + 1, seen);
      if (e2) return e2;
      continue;
    }
    if (!FLOW_ATOMS[s.atom]) return fail('FLOW_UNKNOWN_ATOM', '步骤「' + id + '」的原子不在开放范围内');
    const pe = validateStepParams(s.atom, s.params, id);
    if (pe) return pe;
  }
  return null;
}
// 事件触发只承诺“事件发生那一刻”，点态指标与「本周期」范围在此时没有稳定窗口
function walkCondLeavesUI(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.items)) node.items.forEach(function (n) { walkCondLeavesUI(n, fn); });
  if (typeof node.metric === 'string' && node.metric) fn(node);
}
function eventCondBlockText(when) {
  let msg = '';
  walkCondLeavesUI(when, function (it) {
    if (msg) return;
    if (isPointMetric(it.metric)) {
      msg = '事件触发不能使用点态指标「' + metricLabel(it.metric) + '」：事件时刻没有稳定取值，请改用周期触发';
    } else if (it.range === 'period') {
      msg = '事件触发不能用「本周期」范围：事件落在周期中途时无法确定窗口，请改用周期触发';
    }
  });
  return msg;
}
export function validateFlowDraft(draft) {
  if (!draft) return fail('FLOW_INVALID_DEF', '动作流草稿不存在');
  const name = String(draft.name || '').trim();
  if (!name) return fail('FLOW_NAME_REQUIRED', '请填写动作流名称');
  if (name.length > 40) return fail('FLOW_NAME_TOO_LONG', '动作流名称最多 40 个字符');
  const trig = draft.trigger || {};
  if (trig.type !== 'manual' && trig.type !== 'period' && trig.type !== 'event') {
    return fail('FLOW_BAD_TRIGGER', '触发方式只能是手动、周期或事件');
  }
  if (trig.type === 'period') {
    if (['day', 'week', 'month'].indexOf(trig.period) < 0) return fail('FLOW_BAD_TRIGGER', '周期只能是每天/每周/每月');
    const anchor = Number(trig.anchor);
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 7) return fail('FLOW_BAD_TRIGGER', '周期锚点必须是 1–7 的整数');
  }
  if (trig.type === 'event') {
    const kind = trig.event && trig.event.kind;
    if (EVENT_KINDS.indexOf(kind) < 0) return fail('FLOW_BAD_TRIGGER', '事件触发只能选择打卡或购买');
    const blocked = eventCondBlockText(draft.condition);
    if (blocked) return fail('FLOW_EVENT_BAD_CONDITION', blocked);
    let branchMsg = '';
    (function walk(list) {
      (Array.isArray(list) ? list : []).forEach(function (s) {
        if (branchMsg || !s || typeof s !== 'object') return;
        if (s.kind === 'branch') {
          branchMsg = eventCondBlockText(s.when);
          walk(s.then);
          walk(s.else);
        }
      });
    })(draft.steps);
    if (branchMsg) return fail('FLOW_EVENT_BAD_CONDITION', branchMsg);
  }
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  if (!steps.length) return fail('FLOW_NO_STEPS', '请至少添加一个步骤');
  const total = countSteps(steps);
  if (total > FLOW_MAX_STEPS) return fail('FLOW_STEP_LIMIT', '步骤总数不能超过 ' + FLOW_MAX_STEPS + '（当前 ' + total + '）');
  const se = validateStepList(steps, 0, new Set());
  if (se) return se;
  return {
    ok: true,
    name: name,
    trigger: trig.type === 'event'
      ? { type: 'event', event: { kind: trig.event.kind }, period: 'week', anchor: 1 }
      : {
        type: trig.type,
        period: trig.type === 'period' ? trig.period : 'week',
        anchor: trig.type === 'period' ? Number(trig.anchor) : 1,
      },
  };
}

// ===== 保存用净化：只复制原子白名单参数 =====
function sanitizeWhen(when) {
  const items = when && Array.isArray(when.items) ? when.items : [];
  const leaf = items[0] || defaultBranchLeaf();
  const out = {
    range: leaf.range,
    metric: leaf.metric,
    op: leaf.op,
    value: Number(leaf.value),
    targetType: 'all',
    newFilter: 'none',
  };
  if (leaf.range === 'recent') out.days = Number(leaf.days);
  return out;
}
export function sanitizeFlowSteps(list) {
  return (list || []).map(function (s) {
    if (s && s.kind === 'branch') {
      const out = {
        id: String(s.id),
        kind: 'branch',
        when: normalizeCondition({ mode: 'all', items: [sanitizeWhen(s.when)] }),
        then: sanitizeFlowSteps(s.then),
      };
      const els = sanitizeFlowSteps(s.else);
      if (els.length) out.else = els;
      return out;
    }
    const atom = s && s.atom;
    const allowed = FLOW_ATOMS[atom] ? FLOW_ATOMS[atom].params : [];
    const src = (s && s.params) || {};
    const params = {};
    allowed.forEach(function (k) {
      if (k === 'amount' || k === 'idleDays' || k === 'cap') {
        // 未填写的数值型参数直接省略：Number('') === 0 会把可选参数写成 0
        const raw = src[k];
        if (raw === undefined || raw === null || String(raw).trim() === '') return;
        const n = Number(String(raw).trim());
        if (isFinite(n)) params[k] = n;
      } else if (src[k] !== undefined && String(src[k]).trim() !== '') {
        params[k] = String(src[k]).trim();
      }
    });
    const out = { id: String(s.id), atom: atom, params: params };
    if (s.as && STEP_ID_RE.test(String(s.as))) out.as = String(s.as);
    // 编辑器不提供步骤级条件入口，但已有配置原样保留，避免编辑时静默丢语义
    if (s.when && Array.isArray(s.when.items) && s.when.items.length) out.when = normalizeCondition(s.when);
    return out;
  });
}

const COMPILE_ERR_TEXT = {
  FLOW_INVALID_DEF: '动作流定义不完整',
  FLOW_BAD_TRIGGER: '触发方式配置不合法',
  FLOW_NO_STEPS: '请至少添加一个步骤',
  FLOW_BAD_STEP: '步骤配置不合法',
  FLOW_UNKNOWN_ATOM: '存在不在开放范围内的原子',
  FLOW_BAD_PARAMS: '步骤参数不合法',
  FLOW_AMOUNT_LIMIT: '单步数量超过上限',
  FLOW_INVALID_ACCOUNT: '步骤引用了不存在的账户',
  FLOW_ASSET_UNKNOWN: '步骤引用了不存在的资产',
  FLOW_ASSET_DISABLED: '步骤引用了已停用的资产',
  FLOW_ASSET_ARCHIVED: '步骤引用了已归档的资产',
  FLOW_STEP_LIMIT: '步骤数量超过上限',
  FLOW_DEPTH_LIMIT: '条件分支嵌套超过上限',
  FLOW_REF_NAME_CONFLICT: '步骤 ID 与输出别名冲突',
  FLOW_REACHECK_ORDER: '「复核成就」必须作为最后一个顶层步骤且只能出现一次',
  FLOW_BAD_REF: '金额引用配置不合法',
  FLOW_REF_DEFAULT_REQUIRED: '分支内输出被引用时必须提供默认值',
  FLOW_EVENT_POINT_METRIC: '事件触发不能使用点态指标（事件时刻没有稳定取值）',
  FLOW_EVENT_PERIOD_RANGE: '事件触发不能使用「本周期」范围条件（事件时刻等不到正确窗口）',
};
function compileErrorText(errors) {
  const e = (errors && errors[0]) || {};
  const base = COMPILE_ERR_TEXT[e.code] || ('动作流无法编译（' + (e.code || 'UNKNOWN') + '）');
  const where = e.stepId ? ('步骤「' + e.stepId + '」') : '';
  const detail = e.detail ? ('：' + e.detail) : '';
  return where + base + detail;
}
function buildCandidate() {
  const v = validateFlowDraft(flowDraft);
  if (!v.ok) return v;
  const existing = flowEditingId ? findFlow(flowEditingId) : null;
  const ts = now();
  const candidate = normalizeFlow({
    v: existing ? existing.v : FLOW_VERSION,
    id: existing ? existing.id : uid(),
    name: v.name,
    enabled: flowDraft.enabled !== false,
    invalid: false,
    trigger: v.trigger,
    condition: normalizeCondition(flowDraft.condition),
    settleWhenConditionFalse: flowDraft.settleWhenConditionFalse === true,
    editorMode: (existing ? existing.editorMode : flowDraft.editorMode) === 'simple' ? 'simple' : 'advanced',
    migratedFromActivity: existing ? existing.migratedFromActivity : (flowDraft.migratedFromActivity || ''),
    limits: existing ? existing.limits : {},
    steps: sanitizeFlowSteps(flowDraft.steps),
    lastRun: existing ? existing.lastRun : null,
    lastEventKey: existing ? existing.lastEventKey : '',
    createdAt: existing && existing.createdAt ? existing.createdAt : ts,
    updatedAt: ts,
  });
  const compiled = FlowEngine.compile(candidate);
  if (!compiled.ok) {
    return { ok: false, code: compiled.errors[0] ? compiled.errors[0].code : 'FLOW_COMPILE_FAILED', message: compileErrorText(compiled.errors) };
  }
  return { ok: true, flow: candidate };
}

// ===== 条件编辑器复用 =====
function flowCondPreview(el, draft) {
  if (!el) return;
  const items = draft && Array.isArray(draft.items) ? draft.items : [];
  if (!items.length) {
    el.textContent = '条件：无条件（每次触发都会执行）';
    return;
  }
  el.textContent = '条件：' + items.map(function (n) { return condNodeLabel(n); }).join(draft.mode === 'any' ? ' 或 ' : ' 且 ');
}
function bindFlowCond() {
  if (!flowDraft) return;
  setCondDraftContext(flowDraft.condition, 'flowCondItems', 'flowCondPreview', flowCondPreview, function () {});
}
function setFlowHint(msg, ok) {
  const el = document.getElementById('flowFormHint');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'asset-form-hint' + (msg ? (ok ? ' ok' : ' err') : '');
}

// ===== 编辑器渲染 =====
function joinPath(parent, i) {
  return parent ? parent + '/' + i : String(i);
}
function optionsHTML(list, current, withId) {
  return list.map(function (o) {
    return '<option value="' + attrId(withId ? o.id : o.value) + '"' + ((withId ? o.id : o.value) === current ? ' selected' : '') + '>' +
      esc(withId ? o.name : o.label) + '</option>';
  }).join('');
}
function accountOptions() {
  const list = [
    { id: 'vitality', name: '活力点' },
    { id: 'achievement', name: '成果点' },
  ];
  (state.domains || []).forEach(function (d) {
    if (d && d.id) list.push({ id: 'progress:' + d.id, name: '进度·' + domainName(d.id) });
  });
  return list;
}
function assetOptions() {
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  return defs.map(function (d) {
    const tag = d.enabled === false ? '（已停用）' : d.archived ? '（已归档）' : '';
    return { id: d.id, name: (d.name || d.id) + tag };
  });
}
function paramsHTML(atom, params, path) {
  const p = params || {};
  if (atom === 'currency.grant' || atom === 'currency.spend') {
    const accts = accountOptions();
    if (atom === 'currency.grant' && p.split === 'allDomains') accts.unshift({ id: 'progress', name: '进度·全部领域均分' });
    return '<label>账户<select onchange="flowStepParamChanged(\'' + path + '\',\'account\',this.value)">' +
      optionsHTML(accts, p.account || 'vitality', true) + '</select></label>' +
      '<label>金额<input type="number" min="0.01" max="' + FLOW_ATOM_MAX_CURRENCY + '" step="0.01" value="' + escAttr(p.amount === undefined ? '1' : p.amount) + '" onchange="flowStepParamChanged(\'' + path + '\',\'amount\',this.value)"></label>' +
      (atom === 'currency.grant'
        ? '<label>领域<select onchange="flowStepSplitChanged(\'' + path + '\',this.value)"><option value=""' + (p.split === 'allDomains' ? '' : ' selected') + '>跟随账户</option><option value="allDomains"' + (p.split === 'allDomains' ? ' selected' : '') + '>全部领域均分</option></select></label>' +
          '<label>任务 ID（可选）<input type="text" maxlength="64" value="' + escAttr(p.taskId || '') + '" onchange="flowStepParamChanged(\'' + path + '\',\'taskId\',this.value)"></label>'
        : '') +
      '<label>备注<input type="text" maxlength="120" value="' + escAttr(p.desc || '') + '" onchange="flowStepParamChanged(\'' + path + '\',\'desc\',this.value)"></label>';
  }
  if (atom === 'asset.grant' || atom === 'asset.spend') {
    return '<label>资产<select onchange="flowStepParamChanged(\'' + path + '\',\'assetId\',this.value)">' +
      optionsHTML(assetOptions(), p.assetId || '', true) + '</select></label>' +
      '<label>数量<input type="number" min="1" max="' + FLOW_ATOM_MAX_ASSET + '" step="1" value="' + escAttr(p.amount === undefined ? '1' : p.amount) + '" onchange="flowStepParamChanged(\'' + path + '\',\'amount\',this.value)"></label>' +
      (atom === 'asset.grant'
        ? '<label>上限（可选）<input type="number" min="1" max="999" step="1" value="' + escAttr(p.cap === undefined ? '' : p.cap) + '" onchange="flowStepParamChanged(\'' + path + '\',\'cap\',this.value)"></label>'
        : '') +
      '<label>备注<input type="text" maxlength="120" value="' + escAttr(p.desc || '') + '" onchange="flowStepParamChanged(\'' + path + '\',\'desc\',this.value)"></label>';
  }
  if (atom === 'entity.archiveIdle') {
    const kinds = [{ id: 'task', name: '任务' }, { id: 'affair', name: '项目' }, { id: 'chore', name: '杂事' }];
    return '<label>类型<select onchange="flowStepParamChanged(\'' + path + '\',\'kind\',this.value)">' +
      optionsHTML(kinds, p.kind || 'task', true) + '</select></label>' +
      '<label>不活跃天数<input type="number" min="1" max="' + FLOW_ATOM_IDLE_DAYS_MAX + '" step="1" value="' + escAttr(p.idleDays === undefined ? '30' : p.idleDays) + '" onchange="flowStepParamChanged(\'' + path + '\',\'idleDays\',this.value)"></label>' +
      '<label>备注<input type="text" maxlength="120" value="' + escAttr(p.desc || '') + '" onchange="flowStepParamChanged(\'' + path + '\',\'desc\',this.value)"></label>';
  }
  if (atom === 'log.note') {
    return '<label>记录内容<input type="text" maxlength="' + FLOW_ATOM_NOTE_MAX_LEN + '" value="' + escAttr(p.desc || '') + '" onchange="flowStepParamChanged(\'' + path + '\',\'desc\',this.value)"></label>';
  }
  return '<div class="flow-step-none">此原子无需参数</div>';
}
function stepHeadHTML(label, path, extra) {
  return '<div class="flow-step-head"><span class="flow-step-no">' + esc(label) + '</span>' + (extra || '') +
    '<button class="btn btn-sm" onclick="flowStepMove(\'' + path + '\',-1)" title="上移">↑</button>' +
    '<button class="btn btn-sm" onclick="flowStepMove(\'' + path + '\',1)" title="下移">↓</button>' +
    '<button class="btn btn-sm btn-danger" onclick="flowStepDelete(\'' + path + '\')">删除</button></div>';
}
function stepRowHTML(s, path, depth) {
  if (s && s.kind === 'branch') return branchRowHTML(s, path, depth);
  const atom = s && FLOW_ATOMS[s.atom] ? s.atom : FLOW_ATOM_IDS[0];
  const select = '<select onchange="flowStepAtomChanged(\'' + path + '\',this.value)">' +
    FLOW_ATOM_IDS.map(function (id) {
      return '<option value="' + attrId(id) + '"' + (id === atom ? ' selected' : '') + '>' + esc(atomName(id)) + '</option>';
    }).join('') + '</select>';
  return '<div class="flow-step">' + stepHeadHTML('原子步骤', path, select) +
    '<div class="flow-step-params">' + paramsHTML(atom, s ? s.params : {}, path) + '</div></div>';
}
function branchLeaf(when) {
  const items = when && Array.isArray(when.items) ? when.items : [];
  return items[0] || defaultBranchLeaf();
}
function branchRowHTML(s, path, depth) {
  const leaf = branchLeaf(s.when);
  const rangeSel = '<label>范围<select onchange="flowStepParamChanged(\'' + path + '\',\'whenRange\',this.value)">' +
    BRANCH_RANGES.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === leaf.range ? ' selected' : '') + '>' + esc(r.name) + '</option>';
    }).join('') + '</select></label>';
  const days = leaf.range === 'recent'
    ? '<label>天数<input type="number" min="1" max="365" step="1" value="' + escAttr(leaf.days || 7) + '" onchange="flowStepParamChanged(\'' + path + '\',\'whenDays\',this.value)"></label>'
    : '';
  const metricSel = '<label>指标<select onchange="flowStepParamChanged(\'' + path + '\',\'whenMetric\',this.value)">' +
    BRANCH_METRICS.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === leaf.metric ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('') + '</select></label>';
  const opSel = '<label>运算符<select onchange="flowStepParamChanged(\'' + path + '\',\'whenOp\',this.value)">' +
    BRANCH_OPS.map(function (o) {
      return '<option value="' + o + '"' + (o === leaf.op ? ' selected' : '') + '>' + esc(o) + '</option>';
    }).join('') + '</select></label>';
  const value = '<label>数值<input type="number" step="1" value="' + escAttr(leaf.value === undefined ? 1 : leaf.value) + '" onchange="flowStepParamChanged(\'' + path + '\',\'whenValue\',this.value)"></label>';
  return '<div class="flow-step flow-branch">' + stepHeadHTML('条件分支', path, '') +
    '<div class="flow-branch-when">满足条件 ' + rangeSel + days + metricSel + opSel + value + '</div>' +
    '<div class="flow-branch-cols">' +
    '<div class="flow-branch-col"><div class="flow-col-title">满足时执行</div>' + stepListHTML(s.then, path + '/then', depth + 1) + '</div>' +
    '<div class="flow-branch-col"><div class="flow-col-title">否则（可留空）</div>' + stepListHTML(s.else || [], path + '/else', depth + 1) + '</div>' +
    '</div></div>';
}
function stepListHTML(list, parent, depth) {
  const rows = (list || []).map(function (s, i) { return stepRowHTML(s, joinPath(parent, i), depth); }).join('');
  const addBranch = depth < FLOW_MAX_DEPTH
    ? '<button class="btn btn-sm" onclick="flowAddBranch(\'' + parent + '\')">+ 条件分支</button>'
    : '';
  return (rows || '<div class="flow-step-none">还没有步骤</div>') +
    '<div class="flow-step-actions"><button class="btn btn-sm" onclick="flowAddStep(\'' + parent + '\')">+ 添加步骤</button>' + addBranch + '</div>';
}
export function renderFlowSteps() {
  const box = document.getElementById('flowStepList');
  if (!box || !flowDraft) return;
  box.innerHTML = stepListHTML(flowDraft.steps, '', 0);
}

// ===== 流列表 / 干跑 / 历史渲染 =====
function flowCondSummary(flow) {
  const items = flow.condition && Array.isArray(flow.condition.items) ? flow.condition.items : [];
  if (!items.length) return '无条件';
  return items.map(function (n) { return condNodeLabel(n); }).join(flow.condition.mode === 'any' ? ' 或 ' : ' 且 ');
}
function stepSummary(s) {
  if (!s) return '';
  if (s.kind === 'branch') {
    const leaf = branchLeaf(s.when);
    const metric = BRANCH_METRICS.find(function (m) { return m.id === leaf.metric; });
    const range = BRANCH_RANGES.find(function (r) { return r.id === leaf.range; });
    return '条件分支：' + (range ? range.name : leaf.range) + (metric ? metric.name : leaf.metric) + ' ' + leaf.op + ' ' + leaf.value;
  }
  return describeFlowAtom(s.atom, s.params || {});
}
function flowCardHTML(flow) {
  const enabled = flow.enabled !== false && !flow.invalid;
  const tag = flow.invalid
    ? '<span class="flow-tag off">定义异常</span>'
    : (enabled ? '<span class="flow-tag on">运行中</span>' : '<span class="flow-tag off">已停用</span>');
  const modeTag = flow.editorMode === 'simple' ? '<span class="flow-tag">简易</span>' : '';
  const eventFlow = !!(flow.trigger && flow.trigger.type === 'event');
  const onNote = eventFlow ? '打卡/购买成功提交后自动执行一次；每次运行都可在下方整单撤销。' : '到点会自动执行；每次运行都可在下方整单撤销。';
  const offNote = eventFlow ? '已停用：打卡/购买后不会执行；开启后才生效。' : '已停用：不会自动执行；新建的流默认停用，启用后才按周期运行。';
  const deleteBtn = flow.migratedFromActivity
    ? '<button class="btn btn-sm btn-danger" onclick="deleteMigratedFlowConfig(\'' + attrId(flow.id) + '\')">删除</button>'
    : '';
  const steps = (flow.steps || []).map(function (s, i) {
    return '<div class="flow-step-line"><span class="flow-step-idx">' + (i + 1) + '</span>' + esc(stepSummary(s)) + '</div>';
  }).join('') || '<div class="flow-step-none">还没有步骤</div>';
  return '<div class="flow-item">' +
    '<div class="flow-head"><div class="flow-title">' + esc(flow.name || '未命名动作流') + tag + modeTag + '</div>' +
    '<div class="flow-ops">' +
    '<button class="btn btn-sm" onclick="openFlowModal(\'' + attrId(flow.id) + '\')">编辑</button>' +
    '<button class="btn btn-sm" onclick="dryRunFlow(\'' + attrId(flow.id) + '\')">试跑</button>' +
    '<button class="btn btn-sm btn-primary" onclick="executeFlow(\'' + attrId(flow.id) + '\')"' + (enabled && !eventFlow ? '' : ' disabled') + (eventFlow ? ' title="事件触发流不能手动执行"' : '') + '>立即执行</button>' +
    deleteBtn +
    '<label class="flow-switch" title="' + (eventFlow ? '启用后打卡/购买提交时会自动执行' : '启用后才会按周期自动执行') + '"><input type="checkbox"' + (enabled ? ' checked' : '') + ' onchange="toggleFlowEnabled(\'' + attrId(flow.id) + '\')"><span></span></label>' +
    '</div></div>' +
    '<div class="flow-meta">' + esc(flowTriggerText(flow)) + ' · 条件：' + esc(flowCondSummary(flow)) + ' · ' + countSteps(flow.steps) + ' 个步骤</div>' +
    '<div class="flow-steps">' + steps + '</div>' +
    '<div class="flow-note">' + (enabled ? onNote : offNote) + '</div>' +
    '</div>';
}
function warningText(w) {
  if (!w) return '';
  if (w.code === 'NEGATIVE_BALANCE') {
    return '账户「' + accountLabel(w.key || w.account || '') + '」执行后将出现负余额：' + fmt(w.before) + ' → ' + fmt(w.after);
  }
  if (w.code === 'ASSET_OVER_CAP') {
    return '资产「' + (w.label || w.name || w.assetId || '') + '」执行后将超过余额上限 ' +
      fmt(w.maxBalance) + '：执行后 ' + fmt(w.after);
  }
  return w.message || w.code || '未知告警';
}
function dryReportHTML(rep) {
  if (!rep) return '';
  const head = '<div class="flow-dry-head"><div class="flow-dry-title">试跑结果' +
    (rep.flowName ? '：' + esc(rep.flowName) : '') + '</div><div class="flow-note">按手动执行预演 · 与真实执行使用同一执行器 · 不写入存档、不占周期额度</div></div>';
  if (rep.ok === false) {
    return '<div class="flow-dry">' + head + '<div class="flow-warn">' + esc(flowErrorText(rep.error || rep)) + '</div></div>';
  }
  if (rep.error) {
    return '<div class="flow-dry">' + head + '<div class="flow-warn">' + esc(flowErrorText(rep.error)) + '</div></div>';
  }
  if (rep.skipped) {
    const why = rep.skipped === 'condition-false' ? '条件不成立：本次不会执行，也不会写入任何数据。' : '本周期已执行过（或次数已用满）：本次不会执行。';
    return '<div class="flow-dry">' + head + '<div class="flow-warn">' + esc(why) + '</div></div>';
  }
  const accounts = rep.accounts || [];
  const entries = rep.entries || [];
  const assets = rep.assets || [];
  const warnings = rep.warnings || [];
  const accRows = accounts.map(function (a) {
    return '<tr><td>' + esc(a.label || accountLabel(a.key)) + '</td><td>' + fmt(a.before) + '</td><td>' + fmt(a.after) + '</td><td>' + (a.delta >= 0 ? '+' : '') + fmt(a.delta) + '</td></tr>';
  }).join('');
  const accTable = accRows
    ? '<table class="flow-table"><thead><tr><th>账户</th><th>执行前</th><th>执行后</th><th>变化</th></tr></thead><tbody>' + accRows + '</tbody></table>'
    : '<div class="flow-step-none">不会改变任何账户余额</div>';
  const entryList = entries.length
    ? entries.slice(0, 20).map(function (e) {
      const amt = Number(e.amt);
      return '<li>' + (isFinite(amt) && amt !== 0 ? (amt > 0 ? '+' : '') + fmt(amt) + ' · ' : '') + esc(e.desc || e.message || '') + '</li>';
    }).join('') + (entries.length > 20 ? '<li>… 其余 ' + (entries.length - 20) + ' 条</li>' : '')
    : '<li>不会写入流水</li>';
  const assetRows = assets.map(function (a) {
    const max = a.maxIssuedPerPeriod === null || a.maxIssuedPerPeriod === undefined ? '不限' : fmt(a.maxIssuedPerPeriod);
    return '<tr><td>' + esc(a.name || a.assetId) + '</td><td>' + fmt(a.balanceBefore) + ' → ' + fmt(a.balanceAfter) + '</td><td>' + fmt(a.issued) + ' / ' + max + '</td><td>' + fmt(a.spent) + '</td><td>' + fmt(a.runs) + '</td></tr>';
  }).join('');
  const assetTable = assetRows
    ? '<table class="flow-table"><thead><tr><th>资产</th><th>余额（前 → 后）</th><th>本期已发 / 上限</th><th>本期已消耗</th><th>本期运行</th></tr></thead><tbody>' + assetRows + '</tbody></table>'
    : '';
  const warnHTML = warnings.length
    ? warnings.map(function (w) { return '<div class="flow-warn">' + esc(warningText(w)) + '</div>'; }).join('')
    : '<div class="flow-ok">未发现负余额或越界告警</div>';
  const totals = rep.totals || {};
  return '<div class="flow-dry">' + head +
    '<div class="flow-dry-sec"><div class="flow-col-title">账户前后值</div>' + accTable + '</div>' +
    '<div class="flow-dry-sec"><div class="flow-col-title">将写入流水（' + entries.length + ' 条）</div><ul class="flow-entry-list">' + entryList + '</ul></div>' +
    (assetTable ? '<div class="flow-dry-sec"><div class="flow-col-title">资产额度消耗</div>' + assetTable + '</div>' : '') +
    '<div class="flow-dry-sec"><div class="flow-col-title">告警</div>' + warnHTML + '</div>' +
    '<div class="flow-note">本次预演：发放 ' + fmt(totals.granted || 0) + ' · 扣除 ' + fmt(totals.spent || 0) +
    ' · 资产发放 ' + fmt(totals.assetGranted || 0) + ' · 资产消耗 ' + fmt(totals.assetSpent || 0) +
    ' · 步骤 ' + fmt(totals.steps || 0) + '</div></div>';
}
function runStepLine(s) {
  if (!s) return '';
  if (s.kind === 'branch') {
    return '<div class="flow-run-step"><span class="flow-step-idx">' + esc(s.stepId || '') + '</span>条件分支 · ' +
      (s.pass ? '走「满足」分支' : '走「否则」分支') + '</div>';
  }
  const detail = s.pass ? describeFlowAtom(s.atom, s.input || {}) : '条件不成立，未执行';
  return '<div class="flow-run-step"><span class="flow-step-idx">' + esc(s.stepId || '') + '</span>' +
    esc(atomName(s.atom)) + ' · ' + esc(detail) + (s.pass ? '' : ' <span class="flow-tag off">跳过</span>') + '</div>';
}
export function flowUndoBlockReason(rec) {
  if (!rec) return UNDO_TEXT.NOT_FOUND;
  if (rec.status === 'reversed') return UNDO_TEXT.ALREADY;
  const journal = rec.journal;
  if (!journal || !journal.v) return UNDO_TEXT.NO_JOURNAL;
  const logById = {};
  (state.logs || []).forEach(function (l) { if (l && l.id) logById[l.id] = l; });
  const logIds = Array.isArray(journal.logIds) ? journal.logIds : [];
  const missing = logIds.some(function (id) { return !logById[id]; });
  if (missing || (rec.journalLogId && !logById[rec.journalLogId])) return UNDO_TEXT.LOG_TRIMMED;
  const noRev = (journal.steps || []).some(function (s) { return s && s.kind !== 'branch' && !FLOW_REVERSERS[s.atom]; });
  if (noRev) return UNDO_TEXT.NO_REVERSER;
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  for (let i = 0; i < (journal.assets || []).length; i += 1) {
    const a = journal.assets[i];
    const def = defs.find(function (d) { return d && d.id === a.assetId; });
    if (!def) return '资产「' + (a.assetId || '') + '」的定义已被删除，无法恢复额度';
    const pk = assetPeriodKeyOf(def, now());
    if (a.periodKey && pk !== a.periodKey) {
      return '资产「' + (def.name || a.assetId) + '」已跨发放周期（原周期 ' + a.periodKey + '，当前 ' + pk + '），无法撤销';
    }
    const cur = Number((state.cards || {})[a.assetId]) || 0;
    if (Number(a.delta) > 0 && cur < Number(a.delta)) {
      return '资产「' + (def.name || a.assetId) + '」发放的 ' + fmt(a.delta) + ' 已被消耗（当前余额 ' + fmt(cur) + '），无法撤销';
    }
  }
  const steps = journal.steps || [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s || s.kind === 'branch' || s.atom !== 'entity.archiveIdle') continue;
    const kind = (s.input && s.input.kind) || 'task';
    const list = kind === 'affair' ? (state.affairs || []) : kind === 'chore' ? (state.chores || []) : (state.tasks || []);
    const ids = (s.output && s.output.ids) || [];
    const lost = ids.some(function (id) { return !list.some(function (x) { return x && x.id === id; }); });
    if (lost) return '被归档的实体已被删除，无法恢复';
  }
  const achIds = logIds.map(function (id) { return logById[id]; }).filter(function (l) { return l && l.achId; }).map(function (l) { return l.achId; });
  const achLost = achIds.some(function (id) { return !(state.achievements || []).some(function (a) { return a && a.id === id; }); });
  if (achLost) return '被归档的实体或成就已被删除，无法恢复';
  return '';
}
function runCardHTML(rec) {
  if (!rec) return '';
  const reversed = rec.status === 'reversed';
  const tag = reversed ? '<span class="flow-tag off">已撤销</span>' : '<span class="flow-tag on">可撤销</span>';
  const trig = rec.trigger === 'manual' ? '手动' : (rec.trigger === 'event' ? '事件' : '周期');
  const journal = rec.journal;
  const steps = journal && Array.isArray(journal.steps) ? journal.steps.map(runStepLine).join('') : '<div class="flow-step-none">没有可展示的步骤明细</div>';
  const accounts = journal && Array.isArray(journal.accounts) ? journal.accounts : [];
  const accLine = accounts.map(function (a) {
    return '<span class="flow-run-acc">' + esc(a.label || accountLabel(a.key)) + ' ' + fmt(a.before) + ' → ' + fmt(a.after) + '</span>';
  }).join('');
  const assets = journal && Array.isArray(journal.assets) ? journal.assets : [];
  const assetLine = assets.map(function (a) {
    const def = findDef(a.assetId);
    return '<span class="flow-run-acc">' + esc((def && def.name) || a.assetId) + ' ' + fmt(a.before) + ' → ' + fmt(a.after) + '</span>';
  }).join('');
  let undoArea = '<span class="flow-tag off">已撤销</span>';
  if (!reversed) {
    const block = flowUndoBlockReason(rec);
    if (block) {
      undoArea = '<button class="btn btn-sm" disabled>整单撤销</button><div class="flow-warn">' + esc(block) + '</div>';
    } else {
      undoArea = '<button class="btn btn-sm btn-danger" onclick="undoFlowRunUI(\'' + attrId(rec.id) + '\')">整单撤销</button>';
    }
  }
  const failed = undoMsg[rec.id] ? '<div class="flow-warn">' + esc(undoMsg[rec.id]) + '</div>' : '';
  return '<div class="flow-run">' +
    '<div class="flow-run-head"><div class="flow-run-title">' + esc(rec.flowName || '动作流') + tag +
    '<span class="flow-run-time">' + esc(fmtRunTime(rec.startedAt)) + ' · ' + trig + (rec.periodKey ? ' ' + esc(rec.periodKey) : '') + '</span></div>' +
    '<div class="flow-ops">' + undoArea + '</div></div>' +
    '<div class="flow-steps">' + steps + '</div>' +
    (accLine ? '<div class="flow-run-line">账户：' + accLine + '</div>' : '') +
    (assetLine ? '<div class="flow-run-line">资产：' + assetLine + '</div>' : '') +
    failed + '</div>';
}

export function renderFlowPanel() {
  // 全量 render 可能被 render-budget 重置条件上下文；模态打开时重新绑定回流的条件草稿
  if (flowModalOpen && flowDraft) bindFlowCond();
  const listEl = document.getElementById('flowList');
  if (listEl) {
    const list = flowsOf();
    listEl.innerHTML = list.length
      ? list.map(flowCardHTML).join('')
      : '<div class="flow-empty">还没有动作流。点击「新建动作流」配置触发方式、条件与有序步骤；保存后默认停用，可先试跑再启用。</div>';
  }
  const dryEl = document.getElementById('flowDryPanel');
  if (dryEl) dryEl.innerHTML = dryResult && dryResult.flowId === dryFlowId ? dryReportHTML(dryResult) : '';
  const runEl = document.getElementById('flowRunList');
  if (runEl) {
    const runs = recentRuns();
    runEl.innerHTML = runs.length
      ? runs.map(runCardHTML).join('')
      : '<div class="flow-empty">还没有运行记录。试跑不会写入这里；点击「立即执行」后会留下可撤销的运行记录。</div>';
  }
}

// ===== 错误文案 =====
export function flowErrorText(error) {
  const e = error && error.code ? error : (error && error.error ? error.error : error);
  const code = e && e.code;
  const info = (e && e.info) || {};
  if (code === 'FLOW_COMPILE_FAILED') return '动作流无法编译：' + compileErrorText(e.errors || info.errors);
  if (code === 'FLOW_NOT_FOUND') return '动作流不存在或已被删除';
  if (code === 'FLOW_DISABLED') return '动作流已停用，执行器会拒绝运行；请先启用。';
  if (code === 'FLOW_BUSY' || code === 'FLOW_REENTRANT') return '动作流正在执行中，请稍后再试';
  if (code === 'FLOW_CONDITION_ERROR') return '条件求值出错：' + (e.message || '');
  if (code === 'FLOW_INSUFFICIENT') {
    return '余额不足：' + accountLabel(info.account || info.assetId || '') + ' 当前 ' + fmt(info.balance) + '，需要 ' + fmt(info.amount);
  }
  if (code === 'FLOW_RUN_LIMIT') {
    return '超出单次运行额度（' + (info.kind || '') + '）：已用 ' + fmt(info.used) + '，本次 ' + fmt(info.amount) + '，上限 ' + fmt(info.max);
  }
  if (code === 'FLOW_ASSET_CAP') return '资产「' + (info.assetId || '') + '」发放后将超过余额上限 ' + fmt(info.maxBalance) + '（当前 ' + fmt(info.before) + '）';
  if (code === 'FLOW_ASSET_PERIOD_CAP') return '资产「' + (info.assetId || '') + '」本周期发放将超过单期上限 ' + fmt(info.max) + '（已发 ' + fmt(info.issued) + '）';
  if (code === 'FLOW_AMOUNT_LIMIT') return '单步数量超过上限：' + fmt(info.amount) + ' > ' + fmt(info.max);
  if (code === 'FLOW_INVALID_AMOUNT') return '金额必须是大于 0 的合法数值（最多两位小数）';
  if (code === 'FLOW_NOTE_TOO_LONG') return '记录内容最多 ' + FLOW_ATOM_NOTE_MAX_LEN + ' 个字符';
  if (code === 'FLOW_NOTE_LIMIT') return '单次运行的记录条数超过上限';
  if (code === 'FLOW_REACHECK_DUPLICATE') return '「复核成就」每次运行只能出现一次';
  if (code === 'FLOW_NO_TXN') return '内部错误：动作原子不在事务内';
  if (code === 'FLOW_STEP_LIMIT') return '步骤数量超过本次运行上限';
  if (code === 'FLOW_BAD_PARAMS') return '步骤参数不合法';
  if (code === 'FLOW_INVALID_ACCOUNT') return '账户不存在：' + (info.account || '');
  if (code === 'FLOW_ASSET_UNKNOWN') return '资产不存在：' + (info.assetId || '');
  if (code === 'FLOW_ASSET_DISABLED') return '资产已停用：' + (info.assetId || '');
  if (code === 'FLOW_ASSET_ARCHIVED') return '资产已归档：' + (info.assetId || '');
  if (code === 'FLOW_DRY_RUN_IN_TXN') return '试跑不能在事务内调用';
  if (code === 'FLOW_DRY_RUN_ERROR') return '试跑失败：' + (e.message || '');
  return '执行失败' + (code ? '（' + code + '）' : '');
}
export function flowUndoErrorText(error) {
  const e = error && error.code ? error : (error && error.error ? error.error : error);
  const code = e && e.code;
  const info = (e && e.info) || {};
  if (code === 'FLOW_UNDO_ALREADY') return UNDO_TEXT.ALREADY;
  if (code === 'FLOW_UNDO_NOT_FOUND') return UNDO_TEXT.NOT_FOUND;
  if (code === 'FLOW_UNDO_NO_JOURNAL') return UNDO_TEXT.NO_JOURNAL;
  if (code === 'FLOW_UNDO_LOG_TRIMMED') return UNDO_TEXT.LOG_TRIMMED;
  if (code === 'FLOW_UNDO_NO_REVERSER') return '步骤原子「' + (info.atom || '') + '」没有撤销实现，无法整单撤销';
  if (code === 'FLOW_UNDO_ASSET_MISSING') return '资产「' + (info.assetId || '') + '」的定义已被删除，无法恢复额度';
  if (code === 'FLOW_UNDO_CROSS_PERIOD') {
    return '资产「' + (info.assetId || '') + '」已跨发放周期（原周期 ' + (info.periodKey || '') + '，当前 ' + (info.current || '') + '），无法撤销';
  }
  if (code === 'FLOW_UNDO_ASSET_CONSUMED') {
    return '资产「' + (info.assetId || '') + '」发放的 ' + fmt(info.granted) + ' 已被消耗（当前余额 ' + fmt(info.balance) + '），无法撤销';
  }
  if (code === 'FLOW_UNDO_ENTITY_MISSING') return '被归档的实体或成就已被删除，无法恢复';
  if (code === 'FLOW_UNDO_BUSY') return UNDO_TEXT.BUSY;
  return '撤销被拒绝：' + (e && (e.message || e.code) ? (e.message || e.code) : '未知原因');
}

// ===== 处理器 =====
function triggerSelectValue(t) {
  if (t && t.type === 'event' && t.event && EVENT_KINDS.indexOf(t.event.kind) >= 0) return 'event-' + t.event.kind;
  return (t && t.type === 'manual') ? 'manual' : 'period';
}
function isEventTriggerSelect(v) {
  return v === 'event-checkin' || v === 'event-purchase';
}
function triggerFromSelect(v) {
  if (isEventTriggerSelect(v)) {
    return { type: 'event', event: { kind: v.slice(6) }, period: 'week', anchor: 1 };
  }
  return {
    type: v === 'manual' ? 'manual' : 'period',
    period: fieldValue('flowPeriod') || 'week',
    anchor: Number(fieldValue('flowAnchor')) || 1,
  };
}
export function openFlowModal(flowId) {
  const flow = flowId ? findFlow(flowId) : null;
  if (flowId && !flow) {
    toast('动作流不存在或已被删除', 'err');
    return null;
  }
  flowEditingId = flow ? flow.id : '';
  stepSeq = 0;
  if (flow) {
    flowDraft = clone(flow);
    flowDraft.condition = normalizeCondition(flowDraft.condition);
  } else {
    flowDraft = {
      v: FLOW_VERSION,
      id: '',
      name: '',
      enabled: false,
      trigger: { type: 'period', period: 'week', anchor: 1 },
      condition: { mode: 'all', items: [] },
      settleWhenConditionFalse: false,
      editorMode: 'advanced',
      migratedFromActivity: '',
      limits: {},
      steps: [],
    };
    flowDraft.steps.push(defaultStep('currency.grant'));
  }
  if (!Array.isArray(flowDraft.steps) || !flowDraft.steps.length) flowDraft.steps = [defaultStep('currency.grant')];
  flowModalOpen = true;
  setField('flowName', flowDraft.name || '');
  setChecked('flowEnabled', flowDraft.enabled !== false);
  setField('flowTriggerType', triggerSelectValue(flowDraft.trigger));
  setField('flowPeriod', flowDraft.trigger.period || 'week');
  setField('flowAnchor', String(flowDraft.trigger.anchor || 1));
  setField('flowCondMode', flowDraft.condition.mode === 'any' ? 'any' : 'all');
  setChecked('flowSettleWhenFalse', flowDraft.settleWhenConditionFalse === true);
  setFlowHint('');
  bindFlowCond();
  renderCondTree();
  renderFlowSteps();
  renderFlowEditorMode();
  flowTriggerChanged();
  openModal('flowModal');
  return flowDraft;
}
export function closeFlowModal() {
  flowModalOpen = false;
  flowDraft = null;
  flowEditingId = '';
  setCondEventMode(false);
  resetCondDraftUI();
  closeModal('flowModal');
}
function renderFlowEditorMode() {
  if (!flowDraft) return;
  const simple = flowDraft.editorMode === 'simple';
  showEl('flowStepsWrap', !simple);
  const box = document.getElementById('flowSimpleSummary');
  if (!box) return;
  if (!simple) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const steps = Array.isArray(flowDraft.steps) ? flowDraft.steps : [];
  box.style.display = '';
  box.innerHTML = '<div class="sec-note">简易模式：迁移生成的步骤只读预览；需要调整细节请转为高级编辑。</div>'
    + steps.map(function (s, i) {
      return '<div class="act-meta">' + (i + 1) + '. ' + esc(stepSummary(s)) + '</div>';
    }).join('')
    + '<button class="btn btn-sm" onclick="flowSwitchToAdvanced()">转为高级编辑</button>';
}
export function flowSwitchToAdvanced() {
  if (!flowDraft) return;
  flowDraft.editorMode = 'advanced';
  renderFlowEditorMode();
  toast('已切换到高级编辑；保存后生效');
}
export function deleteMigratedFlowConfig(flowId) {
  const flow = findFlow(flowId);
  if (!flow) { toast('动作流不存在或已被删除', 'err'); return; }
  if (typeof confirm === 'function' && !confirm('删除动作流「' + (flow.name || flow.id) + '」？\n旧周期活动会保持停用，可重新迁移。')) return;
  const r = deleteMigratedFlow(flowId);
  if (!r.ok) {
    if (r.code === 'FLOW_HAS_RUNS') toast('该动作流已有运行记录，无法删除', 'err');
    else if (r.code === 'FLOW_NOT_MIGRATED') toast('只能删除由周期活动迁移生成的流', 'err');
    else toast('删除失败：' + (r.code || '未知原因'), 'err');
    return;
  }
  save();
  renderAfterChange();
  toast('已删除迁移动作流；旧活动保持停用，可重新迁移');
}
export function handleFlowSave() {
  if (!flowDraft) return fail('FLOW_NO_DRAFT', '请先打开动作流编辑器');
  flowDraft.name = fieldValue('flowName');
  flowDraft.enabled = getChecked('flowEnabled');
  flowDraft.trigger = triggerFromSelect(fieldValue('flowTriggerType'));
  flowDraft.condition.mode = fieldValue('flowCondMode') === 'any' ? 'any' : 'all';
  flowDraft.settleWhenConditionFalse = getChecked('flowSettleWhenFalse');
  const built = buildCandidate();
  if (!built.ok) {
    setFlowHint(built.message, false);
    toast(built.message, 'err');
    return built;
  }
  const flows = flowsOf();
  if (!Array.isArray(state.flows)) state.flows = flows;
  const idx = flows.findIndex(function (f) { return f && f.id === built.flow.id; });
  if (idx >= 0) flows[idx] = built.flow;
  else flows.push(built.flow);
  const created = idx < 0;
  flowModalOpen = false;
  flowDraft = null;
  flowEditingId = '';
  resetCondDraftUI();
  closeModal('flowModal');
  save();
  renderAfterChange();
  toast(created
    ? ('已创建动作流「' + built.flow.name + '」' + (built.flow.enabled ? '' : '（默认停用，启用后才会执行）'))
    : ('已保存动作流「' + built.flow.name + '」'));
  return { ok: true, flow: built.flow };
}
function renderAfterChange() {
  render();
}
export function flowTriggerChanged() {
  const v = fieldValue('flowTriggerType');
  const event = isEventTriggerSelect(v);
  const type = event ? 'event' : (v === 'manual' ? 'manual' : 'period');
  showEl('flowPeriodWrap', type === 'period');
  showEl('flowAnchorWrap', type === 'period');
  showEl('flowEventHint', event);
  // 事件触发模式下条件编辑器要提前说明哪些指标/范围不可用，避免配完才发现被拒
  setCondEventMode(event);
  refreshCondPanel();
  if (flowDraft) flowDraft.trigger = triggerFromSelect(v);
}
export function flowCondModeChange() {
  if (!flowDraft) return;
  const mode = fieldValue('flowCondMode') === 'any' ? 'any' : 'all';
  flowDraft.condition.mode = mode;
  bindFlowCond();
  renderCondTree();
}
export function flowStepAtomChanged(path, atom) {
  const step = stepAt(path);
  if (!step || !FLOW_ATOMS[atom]) return;
  step.atom = atom;
  step.params = defaultParams(atom);
  renderFlowSteps();
}
export function flowStepSplitChanged(path, value) {
  const step = stepAt(path);
  if (!step) return;
  if (!step.params || typeof step.params !== 'object') step.params = {};
  if (value === 'allDomains') {
    step.params.split = 'allDomains';
    step.params.account = 'progress';
  } else {
    delete step.params.split;
    if (step.params.account === 'progress') step.params.account = 'vitality';
  }
  renderFlowSteps();
}
export function flowStepParamChanged(path, key, value) {
  const step = stepAt(path);
  if (!step) return;
  if (step.kind === 'branch') {
    if (!step.when || !Array.isArray(step.when.items) || !step.when.items.length) step.when = { mode: 'all', items: [defaultBranchLeaf()] };
    const leaf = step.when.items[0];
    if (key === 'whenRange') leaf.range = value;
    else if (key === 'whenDays') leaf.days = value;
    else if (key === 'whenMetric') leaf.metric = value;
    else if (key === 'whenOp') leaf.op = value;
    else if (key === 'whenValue') leaf.value = value;
    renderFlowSteps();
    return;
  }
  if (!step.params || typeof step.params !== 'object') step.params = {};
  // 可选参数清空即移除，避免空字符串被当成 0 / 非法值
  if ((key === 'cap' || key === 'taskId') && String(value).trim() === '') {
    delete step.params[key];
    return;
  }
  step.params[key] = value;
}
export function flowStepMove(path, dir) {
  const p = splitPath(path);
  const list = stepListAt(p.parent);
  if (!list || !list[p.index]) return;
  const to = p.index + Number(dir);
  if (to < 0 || to >= list.length) return;
  const tmp = list[p.index];
  list[p.index] = list[to];
  list[to] = tmp;
  renderFlowSteps();
}
export function flowStepDelete(path) {
  const p = splitPath(path);
  const list = stepListAt(p.parent);
  if (!list || !list[p.index]) return;
  list.splice(p.index, 1);
  renderFlowSteps();
}
export function flowAddStep(parent) {
  if (!flowDraft) return;
  const list = stepListAt(parent || '');
  if (!list) return;
  if (countSteps(flowDraft.steps) >= FLOW_MAX_STEPS) {
    toast('步骤总数不能超过 ' + FLOW_MAX_STEPS, 'err');
    return;
  }
  list.push(defaultStep('currency.grant'));
  renderFlowSteps();
}
export function flowAddBranch(parent) {
  if (!flowDraft) return;
  const list = stepListAt(parent || '');
  if (!list) return;
  if (pathDepth(parent || '') >= FLOW_MAX_DEPTH) {
    toast('条件分支嵌套不能超过 ' + FLOW_MAX_DEPTH + ' 层', 'err');
    return;
  }
  if (countSteps(flowDraft.steps) + 2 > FLOW_MAX_STEPS) {
    toast('步骤总数不能超过 ' + FLOW_MAX_STEPS, 'err');
    return;
  }
  list.push(defaultBranch());
  renderFlowSteps();
}
export function toggleFlowEnabled(flowId) {
  const flow = findFlow(flowId);
  if (!flow) {
    toast('动作流不存在或已被删除', 'err');
    return { ok: false };
  }
  const next = flow.enabled === false;
  if (next) {
    const compiled = FlowEngine.compile(flow);
    if (!compiled.ok) {
      toast('无法启用：' + compileErrorText(compiled.errors), 'err');
      renderAfterChange();
      return { ok: false, code: 'FLOW_COMPILE_FAILED' };
    }
  }
  flow.enabled = next;
  flow.updatedAt = now();
  save();
  renderAfterChange();
  const isEvent = !!(flow.trigger && flow.trigger.type === 'event');
  toast(next
    ? ('已启用「' + flow.name + '」：' + (isEvent ? '打卡/购买提交后自动执行' : '将按周期自动执行'))
    : ('已停用「' + flow.name + '」：不会再自动执行'));
  return { ok: true, enabled: next };
}
export function dryRunFlow(flowId) {
  const flow = findFlow(flowId);
  if (!flow) {
    toast('动作流不存在或已被删除', 'err');
    return { ok: false };
  }
  // 试跑用于“执行前预演”，停用的流也应能试跑；只在内存里临时放开，finally 立刻还原，不落盘
  const wasEnabled = flow.enabled;
  let rep;
  try {
    if (wasEnabled === false) flow.enabled = true;
    rep = FlowEngine.dryRun(flowId, { trigger: 'manual' });
  } finally {
    flow.enabled = wasEnabled;
  }
  dryResult = rep;
  dryFlowId = flowId;
  renderFlowPanel();
  return rep;
}
export function executeFlow(flowId) {
  const flow = findFlow(flowId);
  if (!flow) {
    toast('动作流不存在或已被删除', 'err');
    return { ok: false };
  }
  if (flow.enabled === false || flow.invalid) {
    toast('「' + flow.name + '」已停用，请先启用再执行', 'err');
    return { ok: false, code: 'FLOW_DISABLED' };
  }
  if (flow.trigger && flow.trigger.type === 'event') {
    toast('事件触发流只能在打卡/购买提交后自动执行，不能手动运行', 'warn');
    return { ok: false, code: 'FLOW_EVENT_TRIGGERED' };
  }
  if (typeof confirm === 'function' && !confirm('立即执行动作流「' + flow.name + '」？会立即写入流水。')) {
    return { ok: false, cancelled: true };
  }
  const trigger = flow.trigger && flow.trigger.type === 'manual' ? 'manual' : 'period';
  const r = FlowEngine.runFlow(flowId, { trigger: trigger });
  if (!r.ok) {
    const msg = flowErrorText(r.error || r);
    toast(msg, 'err');
    return r;
  }
  if (r.skipped) {
    toast(r.skipped === 'condition-false' ? '条件不成立，本次未执行' : '本周期已执行过，本次跳过', 'warn');
    return r;
  }
  save();
  renderAfterChange();
  toast('已执行「' + flow.name + '」');
  return r;
}
export function undoFlowRunUI(runId) {
  const rec = recentRuns().find(function (x) { return x && x.id === runId; }) || null;
  const block = flowUndoBlockReason(rec);
  if (block) {
    undoMsg[runId] = block;
    renderFlowPanel();
    toast(block, 'err');
    return { ok: false, message: block };
  }
  const r = FlowEngine.undoFlowRun(runId);
  if (!r.ok) {
    const msg = flowUndoErrorText(r.error || r);
    undoMsg[runId] = msg;
    renderFlowPanel();
    toast(msg, 'err');
    return r;
  }
  delete undoMsg[runId];
  save();
  renderAfterChange();
  toast('已整单撤销这次运行');
  return r;
}

registerRenderer('flow', renderFlowPanel);
