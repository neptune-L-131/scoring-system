// flow-engine.js —— 阶段 4 动作流：编译、静态校验、单事务执行与周期调度（S4）
//
// 边界：
// 1. 只做“编译 + 执行 + 调度 + 干跑”，不做撤销回放（S6）、不做 UI（S8/S9）；
// 2. 一条流的一次运行 = 一个 Ledger.txn；任一步失败整条回滚，不留半截流水；
// 3. 原子复用 S3 的 runFlowAtom，不新造写入路径；
// 4. 条件不成立 = “本次未发生”：不写 lastRun、不写幂等键、不落流水，同一周期可再次求值。
import {
  CHORE_TAG_MAX_COUNT, CHORE_TAG_MAX_LEN,
  FLOW_ATOM_CREATE_NAME_MAX, FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_ASSET, FLOW_ATOM_MAX_CREATE,
  FLOW_ATOM_MAX_CURRENCY, FLOW_ATOM_NOTE_MAX_LEN, FLOW_IDEM_KEEP, FLOW_MAX_DEPTH, FLOW_MAX_STEPS, FLOW_RUN_KEEP,
} from './constants.js';
import { registerFlowDueProcessor } from './flow-scheduler.js';
import { FLOW_ATOMS, assetPeriodKeyOf, runFlowAtom } from './flow-atoms.js';
import { BudgetEngine } from './budget.js';
import { evalCondition } from './cond-eval.js';
import { EVENT_KINDS } from './events.js';
import { Ledger } from './ledger.js';
import { save } from './persist.js';
import { isEntityPointMetric, isPointMetric, now, periodKey, uid } from './pure.js';
import { getState, setState, state } from './state.js';

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,15}$/;
const STEP_FIELDS = ['id', 'atom', 'params', 'when', 'as', 'kind', 'then', 'else'];
// 原子可被引用的数值输出字段（只允许这些；entryId 等标识类字段不可参与运算）
const ATOM_OUTPUT_FIELDS = {
  'currency.grant': ['amount'],
  'currency.spend': ['spent'],
  'asset.grant': ['granted', 'amount'],
  'asset.spend': ['spent'],
  'entity.archiveIdle': ['count', 'archived'],
  'entity.create': ['count'],
  'log.note': [],
  'engine.recheckAchievements': ['count'],
  'task.exempt': [],
};

function fail(code, info) {
  const e = new Error(code);
  e.__txn = true;
  e.code = code;
  e.info = info || {};
  throw e;
}
function cErr(code, stepId, detail) {
  return { code: code, stepId: stepId || '', detail: detail === undefined ? '' : String(detail) };
}

// 条件树叶子遍历：分组节点用 items 嵌套，叶子带 metric/range
function walkCondLeaves(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.items)) node.items.forEach(function (n) { walkCondLeaves(n, fn); });
  if (typeof node.metric === 'string' && node.metric) fn(node);
}
// 步骤树里的分支条件（when）同样属于“事件流条件”，必须一并做指标白名单校验
function walkBranchWhens(list, fn) {
  (Array.isArray(list) ? list : []).forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    if (s.kind === 'branch') {
      fn(s.when);
      walkBranchWhens(s.then, fn);
      walkBranchWhens(s.else, fn);
    }
  });
}

function findAssetDef(assetId) {
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  return defs.find(d => d && d.id === assetId) || null;
}

// 编译期账户校验仍走 Ledger.accountInfo，避免另造账户键解析
function isKnownAccount(account) {
  let info;
  try { info = Ledger.accountInfo(account); } catch (e) { return false; }
  if (!info || typeof info.get !== 'function') return false;
  if (info.st === 'progress') {
    return Array.isArray(state.domains) && state.domains.some(d => d && d.id === info.dom);
  }
  return info.st === 'vitality' || info.st === 'achievement';
}

// ===== 编译 =====
function compile(flow) {
  const errors = [];
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    return { ok: false, errors: [cErr('FLOW_INVALID_DEF')], plan: null };
  }
  if (flow.v !== undefined && (typeof flow.v !== 'number' || flow.v < 1)) errors.push(cErr('FLOW_INVALID_DEF', '', 'v'));
  if (typeof flow.id !== 'string' || !flow.id) errors.push(cErr('FLOW_INVALID_DEF', '', 'id'));
  const trig = flow.trigger || {};
  if (trig.type !== 'period' && trig.type !== 'manual' && trig.type !== 'event') errors.push(cErr('FLOW_BAD_TRIGGER'));
  if (trig.type === 'period') {
    if (['day', 'week', 'month'].indexOf(trig.period) < 0) errors.push(cErr('FLOW_BAD_TRIGGER', '', 'period'));
    if (!Number.isInteger(trig.anchor) || trig.anchor < 1 || trig.anchor > 7) errors.push(cErr('FLOW_BAD_TRIGGER', '', 'anchor'));
  }
  if (trig.type === 'event' && (!trig.event || EVENT_KINDS.indexOf(trig.event.kind) < 0)) {
    errors.push(cErr('FLOW_BAD_TRIGGER', '', 'event'));
  }
  const limits = (flow.limits && typeof flow.limits === 'object') ? flow.limits : {};
  const maxSteps = Math.min(FLOW_MAX_STEPS, Math.max(1, Math.round(Number(limits.maxSteps) || FLOW_MAX_STEPS)));
  if (!Array.isArray(flow.steps) || !flow.steps.length) errors.push(cErr('FLOW_NO_STEPS'));

  const st = {
    seen: {}, registry: {}, total: 0,
    recheckId: '', recheckCount: 0, recheckNested: false,
    lastTopId: '', overSteps: false,
    // 运行输入：只在运行时由调用方注入（资产使用配方传 taskId），静态参数可声明引用
    inputs: new Set((Array.isArray(flow.inputs) ? flow.inputs : []).map(function (x) { return x && x.name; }).filter(Boolean)),
  };
  if (Array.isArray(flow.steps)) {
    validateStepList(flow.steps, 0, false, st, maxSteps, errors, true);
  }
  if (st.overSteps) errors.push(cErr('FLOW_STEP_LIMIT', '', maxSteps));
  if (st.recheckCount > 1) errors.push(cErr('FLOW_REACHECK_ORDER', st.recheckId, 'multiple'));
  if (st.recheckId) {
    if (st.recheckNested) errors.push(cErr('FLOW_REACHECK_ORDER', st.recheckId, 'nested'));
    else if (st.lastTopId && st.recheckId !== st.lastTopId) errors.push(cErr('FLOW_REACHECK_ORDER', st.recheckId, 'not-last'));
  }
  // 事件触发只承诺“事件发生那一刻”：点态指标与 range:'period' 在事件时刻没有稳定窗口，
  // 保存/编译直接拒绝，而不是等到运行期才给出不可复现的结果。
  if (trig.type === 'event') {
    const checkEventCond = function (when) {
      walkCondLeaves(when, function (it) {
        // 单实体条件里 affair_progress 等按实体累计字段取值，也属于点态，事件时刻没有稳定窗口。
        const pointLike = (it.targetType === 'entity') ? isEntityPointMetric(it.metric) : isPointMetric(it.metric);
        if (pointLike) errors.push(cErr('FLOW_EVENT_POINT_METRIC', it.metric, 'metric'));
        if (it.range === 'period') errors.push(cErr('FLOW_EVENT_PERIOD_RANGE', it.metric, 'range'));
      });
    };
    checkEventCond(flow.condition);
    walkBranchWhens(flow.steps, checkEventCond);
  }
  if (errors.length) return { ok: false, errors: errors, plan: null };
  return {
    ok: true,
    errors: [],
    plan: {
      flowId: flow.id, trigger: trig,
      condition: flow.condition || { mode: 'all', items: [] },
      limits: limits, steps: flow.steps, totalSteps: st.total,
      inputs: Array.isArray(flow.inputs) ? flow.inputs : [],
    },
  };
}

function validateStepList(list, depth, insideBranch, st, maxSteps, errors, isTop) {
  if (!Array.isArray(list)) { errors.push(cErr('FLOW_BAD_STEP')); return; }
  list.forEach((s, idx) => {
    st.total += 1;
    if (st.total > maxSteps) { st.overSteps = true; return; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(cErr('FLOW_BAD_STEP')); return; }
    Object.keys(s).forEach(k => {
      if (STEP_FIELDS.indexOf(k) < 0) errors.push(cErr('FLOW_BAD_STEP', s.id, 'field:' + k));
    });
    const id = s.id;
    if (typeof id !== 'string' || !STEP_ID_RE.test(id)) { errors.push(cErr('FLOW_BAD_STEP', id, 'id')); return; }
    if (st.seen[id]) { errors.push(cErr('FLOW_BAD_STEP', id, 'duplicate')); return; }
    if (Object.prototype.hasOwnProperty.call(st.registry, id)) {
      errors.push(cErr('FLOW_REF_NAME_CONFLICT', id, id));
      return;
    }
    st.seen[id] = true;
    if (isTop && idx === list.length - 1) st.lastTopId = id;
    if (s.kind !== undefined && s.kind !== 'branch') { errors.push(cErr('FLOW_BAD_STEP', id, 'kind')); return; }

    if (s.kind === 'branch') {
      if (s.atom !== undefined || s.params !== undefined) errors.push(cErr('FLOW_BAD_STEP', id, 'branch-atom'));
      if (s.as !== undefined) errors.push(cErr('FLOW_BAD_STEP', id, 'branch-as'));
      validateWhen(s.when, id, errors);
      st.registry[id] = { atom: 'branch', fields: [], insideBranch: insideBranch };
      if (depth + 1 > FLOW_MAX_DEPTH) { errors.push(cErr('FLOW_DEPTH_LIMIT', id, depth + 1)); return; }
      if (!Array.isArray(s.then) || !s.then.length) errors.push(cErr('FLOW_BAD_STEP', id, 'then'));
      if (s.else !== undefined && !Array.isArray(s.else)) errors.push(cErr('FLOW_BAD_STEP', id, 'else'));
      if (Array.isArray(s.then)) validateStepList(s.then, depth + 1, true, st, maxSteps, errors, false);
      if (Array.isArray(s.else)) validateStepList(s.else, depth + 1, true, st, maxSteps, errors, false);
      return;
    }

    if (typeof s.atom !== 'string' || !FLOW_ATOMS[s.atom]) {
      errors.push(cErr('FLOW_UNKNOWN_ATOM', id, s.atom));
      return;
    }
    validateWhen(s.when, id, errors);
    const params = s.params === undefined ? {} : s.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      errors.push(cErr('FLOW_BAD_PARAMS', id));
      return;
    }
    checkStaticParams(s, params, insideBranch, st, errors);

    // 先校验参数再登记：保证自引用 / 前向引用一定失败
    const fields = ATOM_OUTPUT_FIELDS[s.atom] || [];
    st.registry[id] = { atom: s.atom, fields: fields, insideBranch: insideBranch };
    if (s.atom === 'engine.recheckAchievements') {
      st.recheckCount += 1;
      st.recheckId = id;
      if (insideBranch) st.recheckNested = true;
    }
    if (s.as !== undefined) {
      if (typeof s.as !== 'string' || !STEP_ID_RE.test(s.as)) {
        errors.push(cErr('FLOW_BAD_STEP', id, 'as'));
      } else if (st.seen[s.as] || Object.prototype.hasOwnProperty.call(st.registry, s.as)) {
        errors.push(cErr('FLOW_REF_NAME_CONFLICT', id, s.as));
      } else {
        st.registry[s.as] = { atom: s.atom, fields: fields, insideBranch: insideBranch };
      }
    }
  });
}

function validateWhen(when, stepId, errors) {
  if (when === undefined) return;
  if (!when || typeof when !== 'object' || Array.isArray(when)) errors.push(cErr('FLOW_BAD_PARAMS', stepId, 'when'));
}

function checkStaticParams(step, params, insideBranch, st, errors) {
  const atomId = step.atom;
  const atom = FLOW_ATOMS[atomId];
  Object.keys(params).forEach(k => {
    if (atom.params.indexOf(k) < 0) { errors.push(cErr('FLOW_BAD_PARAMS', step.id, k)); return; }
    const v = params[k];
    const isRef = v && typeof v === 'object' && !Array.isArray(v) && v.ref !== undefined;
    if (isRef) {
      // 只有数值型 amount 允许引用；assetId / account 等必须静态
      if (k !== 'amount') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'ref:' + k));
      else validateRef(step.id, v, insideBranch, st, errors);
      return;
    }
    const isInput = v && typeof v === 'object' && !Array.isArray(v) && v.input !== undefined;
    if (isInput) {
      // 运行输入只允许 taskId，且必须在 flow.inputs 里声明
      if (k !== 'taskId' || typeof v.input !== 'string' || !st.inputs.has(v.input)) {
        errors.push(cErr('FLOW_BAD_REF', step.id, 'input:' + k));
      }
      return;
    }
    if (k === 'amount' && (typeof v !== 'number' || !isFinite(v) || v <= 0) && atomId !== 'entity.create') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
    if (k === 'account' && typeof v !== 'string') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'account'));
    if (k === 'assetId' && typeof v !== 'string') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'assetId'));
    if (k === 'idleDays' && (!Number.isInteger(v) || v < 1 || v > FLOW_ATOM_IDLE_DAYS_MAX)) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'idleDays'));
    if (k === 'kind' && ['task', 'affair', 'chore'].indexOf(v) < 0) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'kind'));
    if (k === 'desc' && (typeof v !== 'string' || !v.trim())) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'desc'));
    if (k === 'split' && v !== 'allDomains') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'split'));
    if (k === 'taskId' && typeof v !== 'string') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'taskId'));
    if (k === 'cap' && (!Number.isInteger(v) || v < 1)) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'cap'));
    if (k === 'amount' && typeof v === 'number' && atomId.indexOf('currency.') === 0 && v > FLOW_ATOM_MAX_CURRENCY) {
      errors.push(cErr('FLOW_AMOUNT_LIMIT', step.id, v));
    }
  });

  if (atomId === 'currency.grant' || atomId === 'currency.spend') {
    const splitAll = atomId === 'currency.grant' && params.split === 'allDomains';
    if (params.account === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'account'));
    else if (splitAll) {
      if (params.account !== 'progress') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'split'));
      else if (!(state.domains || []).some(d => d && d.id)) errors.push(cErr('FLOW_INVALID_ACCOUNT', step.id, 'progress'));
    } else if (params.account === 'progress') {
      errors.push(cErr('FLOW_INVALID_ACCOUNT', step.id, 'progress'));
    } else if (typeof params.account === 'string' && !isKnownAccount(params.account)) {
      errors.push(cErr('FLOW_INVALID_ACCOUNT', step.id, params.account));
    }
    if (params.taskId !== undefined && params.account !== 'vitality') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'taskId'));
    if (params.amount === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
  }
  if (atomId === 'asset.grant' || atomId === 'asset.spend') {
    const def = params.assetId === undefined ? null : findAssetDef(params.assetId);
    if (params.assetId === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'assetId'));
    else if (!def) errors.push(cErr('FLOW_ASSET_UNKNOWN', step.id, params.assetId));
    else {
      if (def.enabled === false) errors.push(cErr('FLOW_ASSET_DISABLED', step.id, params.assetId));
      if (def.archived) errors.push(cErr('FLOW_ASSET_ARCHIVED', step.id, params.assetId));
    }
    if (params.amount === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
    if (typeof params.amount === 'number') {
      if (!Number.isInteger(params.amount)) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
      const defMax = def && def.maxIssuedPerPeriod !== null && def.maxIssuedPerPeriod !== undefined
        ? Number(def.maxIssuedPerPeriod) : FLOW_ATOM_MAX_ASSET;
      // 带 cap 的发放复刻活动语义，不受资产周期上限压缩
      const stepMax = params.cap !== undefined ? FLOW_ATOM_MAX_ASSET : Math.min(FLOW_ATOM_MAX_ASSET, defMax);
      if (params.amount > stepMax) errors.push(cErr('FLOW_AMOUNT_LIMIT', step.id, params.amount));
    }
  }
  if (atomId === 'entity.archiveIdle') {
    if (params.kind === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'kind'));
    if (params.idleDays === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'idleDays'));
  }
  if (atomId === 'entity.create') {
    const validKind = params.kind === 'task' || params.kind === 'affair' || params.kind === 'chore';
    if (params.kind === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'kind'));
    if (params.name === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'name'));
    else if (typeof params.name !== 'string' || !params.name.trim()) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'name'));
    else if (params.name.trim().length > FLOW_ATOM_CREATE_NAME_MAX) errors.push(cErr('FLOW_NAME_TOO_LONG', step.id, params.name.length));
    if (validKind && params.kind !== 'chore') {
      if (params.domainId === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'domainId'));
      else if (typeof params.domainId !== 'string' || !(state.domains || []).some(d => d && d.id === params.domainId)) {
        errors.push(cErr('FLOW_INVALID_ACCOUNT', step.id, params.domainId));
      }
    } else if (params.kind === 'chore' && params.domainId !== undefined) {
      errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'domainId'));
    }
    if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1 || params.count > FLOW_ATOM_MAX_CREATE)) {
      errors.push(cErr('FLOW_CREATE_LIMIT', step.id, params.count));
    }
    // 情境标签：只属于杂事，必须是字符串数组，条数与单条长度沿用与手建杂事相同的上限。
    if (params.tags !== undefined) {
      let tagsBad = params.kind !== 'chore' || !Array.isArray(params.tags);
      if (!tagsBad) {
        if (params.tags.length > CHORE_TAG_MAX_COUNT) tagsBad = true;
        for (let ti = 0; ti < params.tags.length && !tagsBad; ti += 1) {
          const t = params.tags[ti];
          if (typeof t !== 'string' || !t.trim() || t.trim().length > CHORE_TAG_MAX_LEN) tagsBad = true;
        }
      }
      if (tagsBad) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'tags'));
    }
    if (params.amount !== undefined) {
      const isRefAmount = params.amount && typeof params.amount === 'object' && !Array.isArray(params.amount) && params.amount.ref !== undefined;
      if (!isRefAmount) {
        if (params.kind === 'chore') errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
        else if (typeof params.amount !== 'number' || !isFinite(params.amount) || params.amount < 0) {
          errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
        } else if (params.amount > FLOW_ATOM_MAX_CURRENCY) {
          errors.push(cErr('FLOW_AMOUNT_LIMIT', step.id, params.amount));
        } else if (params.kind === 'affair' && params.amount <= 0) {
          errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'amount'));
        }
      }
    }
  }
  if (atomId === 'log.note') {
    if (params.desc === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'desc'));
    if (typeof params.desc === 'string' && params.desc.length > FLOW_ATOM_NOTE_MAX_LEN) {
      errors.push(cErr('FLOW_NOTE_TOO_LONG', step.id, params.desc.length));
    }
  }
  if (atomId === 'task.exempt') {
    if (params.taskId === undefined) errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'taskId'));
    else if (typeof params.taskId === 'string' && !params.taskId.trim()) {
      errors.push(cErr('FLOW_BAD_PARAMS', step.id, 'taskId'));
    }
  }
}

function validateRef(stepId, v, insideBranch, st, errors) {
  const raw = v.ref;
  if (typeof raw !== 'string' || raw.indexOf('.') < 0) { errors.push(cErr('FLOW_BAD_REF', stepId, raw)); return; }
  const dot = raw.indexOf('.');
  const name = raw.slice(0, dot);
  const field = raw.slice(dot + 1);
  const target = st.registry[name];
  if (!target) { errors.push(cErr('FLOW_BAD_REF', stepId, raw)); return; }
  if (target.fields.indexOf(field) < 0) { errors.push(cErr('FLOW_BAD_REF', stepId, raw)); return; }
  if (v.default !== undefined && typeof v.default !== 'number') errors.push(cErr('FLOW_BAD_REF', stepId, 'default'));
  // 分支内的输出不保证存在：引用它必须带默认值
  if (target.insideBranch && v.default === undefined) errors.push(cErr('FLOW_REF_DEFAULT_REQUIRED', stepId, raw));
}

// ===== 执行 =====
const _active = new Set();

function countIdem(idem, base) {
  let n = 0;
  Object.keys(idem).forEach(function (k) {
    if (k === base || k.indexOf(base + '#') === 0) n += 1;
  });
  return n;
}

function resolveParams(ctx, params) {
  const out = {};
  Object.keys(params).forEach(function (k) {
    const v = params[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.input !== undefined) {
      const name = String(v.input);
      const val = ctx.inputs ? ctx.inputs[name] : undefined;
      if (val !== undefined && val !== null) out[k] = val;
      else fail('FLOW_INPUT_MISSING', { input: name });
      return;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.ref !== undefined) {
      const raw = String(v.ref);
      const dot = raw.indexOf('.');
      const name = raw.slice(0, dot);
      const field = raw.slice(dot + 1);
      const src = ctx.outputs[name];
      if (src && src[field] !== undefined && src[field] !== null) out[k] = src[field];
      else if (v.default !== undefined) out[k] = v.default;
      else fail('FLOW_REF_SKIPPED', { ref: raw });
      return;
    }
    out[k] = v;
  });
  return out;
}

function executeStep(ctx, step) {
  const pass = step.when
    ? evalCondition(Object.assign({}, ctx.actLike, { condition: step.when }), ctx.ts)
    : true;
  if (step.kind === 'branch') {
    ctx.journalSteps.push({
      stepId: step.id, atom: '', kind: 'branch', pass: !!pass,
      input: {}, output: {}, logIds: [],
    });
    executeSteps(ctx, pass ? (step.then || []) : (step.else || []));
    return;
  }
  if (!pass) {
    ctx.journalSteps.push({
      stepId: step.id, atom: step.atom, kind: 'atom', pass: false,
      input: {}, output: {}, logIds: [],
    });
    return;
  }
  const params = resolveParams(ctx, step.params || {});
  // 步骤执行前后对比流水 id：原子内部产生的所有日志（含归档事件、成就解锁）都要进 journal
  const beforeIds = new Set(state.logs.map(function (l) { return l && l.id; }));
  const result = runFlowAtom(step.atom, params, ctx);
  const logIds = state.logs
    .filter(function (l) { return l && !beforeIds.has(l.id); })
    .map(function (l) { return l.id; })
    .reverse(); // state.logs 新的在前，反转为写入顺序
  ctx.journalSteps.push({
    stepId: step.id, atom: step.atom, kind: 'atom', pass: true,
    input: params, output: result, logIds: logIds,
  });
  ctx.outputs[step.id] = result;
  if (step.as) ctx.outputs[step.as] = result;
  ctx.stepOutputs[step.id] = result;
  logIds.forEach(function (id) { ctx.stepLogIds.push(id); });
  if (step.atom === 'asset.grant' || step.atom === 'asset.spend') {
    const aid = params.assetId;
    const delta = step.atom === 'asset.grant' ? (result.granted || 0) : (result.spent || 0);
    // cap 裁剪到 0 时不产生任何计量（避免 runs/issued 被空发放污染）
    if (delta > 0) {
      const op = ctx.assetOps[aid] || { issued: 0, spent: 0 };
      if (step.atom === 'asset.grant') op.issued += delta;
      else op.spent += delta;
      ctx.assetOps[aid] = op;
    }
  }
}

function executeSteps(ctx, steps) {
  (steps || []).forEach(function (step) { executeStep(ctx, step); });
}

function deltasOf(ctx) {
  const out = { vitality: 0, achievement: 0, progress: {}, cards: {} };
  if (!ctx.stepLogIds.length) return out;
  const set = new Set(ctx.stepLogIds);
  state.logs.forEach(function (l) {
    if (!set.has(l.id)) return;
    if (l.st === 'vitality') out.vitality += l.amt;
    else if (l.st === 'achievement') out.achievement += l.amt;
    else if (l.st === 'progress') {
      // 全领域均分的流水带 splits，按领域展开，避免全部记到默认领域
      if (Array.isArray(l.splits) && l.splits.length) {
        l.splits.forEach(function (x) {
          const dom = (x && x.dom) || 'd_default';
          out.progress[dom] = (out.progress[dom] || 0) + (Number(x.amt) || 0);
        });
      } else {
        out.progress[l.dom] = (out.progress[l.dom] || 0) + l.amt;
      }
    }
    else if (l.st === 'card') out.cards[l.card] = (out.cards[l.card] || 0) + l.amt;
  });
  return out;
}

// 资产周期计量由执行器统一写（S3 原子只读额度）
function updateAssetMeters(ctx) {
  const meters = state.ext && state.ext.assetMeters;
  if (!meters || !meters.byAsset) return;
  Object.keys(ctx.assetOps).forEach(function (aid) {
    const def = findAssetDef(aid);
    if (!def) return;
    const pk = assetPeriodKeyOf(def, ctx.ts);
    if (!meters.byAsset[aid]) meters.byAsset[aid] = {};
    const m = meters.byAsset[aid][pk] || { issued: 0, spent: 0, runs: 0 };
    m.issued += ctx.assetOps[aid].issued || 0;
    m.spent += ctx.assetOps[aid].spent || 0;
    m.runs += 1;
    meters.byAsset[aid][pk] = m;
  });
}

function writeRunRecord(flow, ctx, journalId, deltas, journal) {
  const runs = state.ext && state.ext.flowRuns;
  if (!runs) return;
  runs.seq = (runs.seq || 0) + 1;
  runs.byId = runs.byId || {};
  runs.recent = runs.recent || [];
  const rec = {
    id: ctx.runId, flowId: flow.id, flowName: flow.name, runKey: ctx.runKey,
    trigger: ctx.trigger, periodKey: ctx.periodKey, startedAt: ctx.startedAt, finishedAt: now(),
    status: 'active', journalLogId: journalId,
    childLogIds: ctx.stepLogIds.slice(), deltas: deltas, stepOutputs: ctx.stepOutputs,
    journal: journal || null,
  };
  // 执行权购买：运行记录与购买单双向可识别
  if (ctx.orderId) rec.orderId = ctx.orderId;
  if (ctx.productId) rec.productId = ctx.productId;
  runs.byId[rec.id] = rec;
  runs.recent.unshift(rec.id);
  if (runs.recent.length > FLOW_RUN_KEEP) runs.recent.length = FLOW_RUN_KEEP;
  const keep = new Set(runs.recent);
  Object.keys(runs.byId).forEach(function (id) { if (!keep.has(id)) delete runs.byId[id]; });
}

function pruneIdem() {
  const idem = state.ext && state.ext.assetMeters && state.ext.assetMeters.idem;
  if (!idem) return;
  const keys = Object.keys(idem);
  if (keys.length <= FLOW_IDEM_KEEP) return;
  keys.sort(function (a, b) { return (idem[a].at || 0) - (idem[b].at || 0); });
  keys.slice(0, keys.length - FLOW_IDEM_KEEP).forEach(function (k) { delete idem[k]; });
}

// 运行 journal：撤销所需的全部证据（步骤输入/输出/产生的日志、账户与资产前后值、计量前值）
function buildRunJournal(ctx, startBalances, startSnap) {
  const endBalances = balancesOf(state);
  const accounts = [];
  const keys = Object.keys(startBalances);
  Object.keys(endBalances).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  keys.forEach(function (k) {
    const b = Number(startBalances[k]) || 0;
    const a = Number(endBalances[k]) || 0;
    if (a !== b) accounts.push({ key: k, before: b, after: a, delta: a - b });
  });

  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  const assets = [];
  defs.forEach(function (def) {
    if (!def || !def.id) return;
    const pk = assetPeriodKeyOf(def, ctx.ts);
    const m0 = startSnap.meters[def.id] || { issued: 0, spent: 0, runs: 0, existed: false };
    const m1 = meterSnapshot(state, def.id, pk);
    const b0 = Number(startBalances['card:' + def.id]) || 0;
    const b1 = Number(endBalances['card:' + def.id]) || 0;
    if (b0 === b1 && m0.issued === m1.issued && m0.spent === m1.spent && m0.runs === m1.runs) return;
    assets.push({
      assetId: def.id, periodKey: pk,
      before: b0, after: b1, delta: b1 - b0,
      issuedBefore: m0.issued, spentBefore: m0.spent, runsBefore: m0.runs,
      meterExisted: m0.existed === true,
    });
  });

  return {
    v: 1,
    runKey: ctx.runKey, trigger: ctx.trigger, periodKey: ctx.periodKey,
    startedAt: ctx.startedAt, finishedAt: now(),
    steps: ctx.journalSteps, logIds: ctx.stepLogIds.slice(),
    accounts: accounts, assets: assets,
    totals: Object.assign({}, ctx.totals),
  };
}

function ensureRuntimeStructures() {  if (!state.ext) state.ext = {};
  if (!state.ext.assetMeters || typeof state.ext.assetMeters !== 'object') {
    state.ext.assetMeters = { v: 1, byAsset: {}, idem: {} };
  }
  if (!state.ext.assetMeters.byAsset) state.ext.assetMeters.byAsset = {};
  if (!state.ext.assetMeters.idem) state.ext.assetMeters.idem = {};
  if (!state.ext.flowRuns || typeof state.ext.flowRuns !== 'object') {
    state.ext.flowRuns = { v: 1, seq: 0, byId: {}, recent: [] };
  }
  if (!state.ext.flowRuns.byId) state.ext.flowRuns.byId = {};
  if (!Array.isArray(state.ext.flowRuns.recent)) state.ext.flowRuns.recent = [];
}

function execute(flow, plan, meta) {
  const runId = uid();
  const ctx = {
    flow: flow, flowName: flow.name, limits: plan.limits,
    runId: runId, runKey: meta.runKey, trigger: meta.trigger, periodKey: meta.period,
    ts: meta.ts, actLike: meta.actLike, startedAt: now(), silent: true, dryRun: false,
    orderId: meta.orderId || '', productId: meta.productId || '',
    inputs: (meta && meta.inputs && typeof meta.inputs === 'object') ? meta.inputs : {},
    outputs: {}, stepOutputs: {}, stepLogIds: [], assetOps: {}, journalSteps: [],
    totals: { granted: 0, spent: 0, assetGranted: 0, assetSpent: 0, steps: 0, notes: 0, recheck: 0 },
  };
  const txr = Ledger.txn(function () {
    // 执行前快照：整单撤销的 journal 需要账户/资产/计量的前后值
    const startBalances = balancesOf(state);
    const startSnap = captureStateSnapshot(state, ctx.ts);
    executeSteps(ctx, plan.steps);
    const deltas = deltasOf(ctx);
    ctx.deltas = deltas;
    updateAssetMeters(ctx);
    const journal = buildRunJournal(ctx, startBalances, startSnap);
    const journalEntry = Ledger.event('动作流「' + flow.name + '」执行', 'flow-run', {
      flowId: flow.id, flowRunId: runId, runKey: meta.runKey,
      trigger: meta.trigger, childLogIds: ctx.stepLogIds.slice(),
    });
    writeRunRecord(flow, ctx, journalEntry && journalEntry.id, deltas, journal);
    if (meta.trigger === 'period') {
      flow.lastRun = meta.runKey;
      state.ext.assetMeters.idem[meta.runKey] = { flowId: flow.id, runId: runId, at: now() };
      pruneIdem();
    } else if (meta.trigger === 'event') {
      // 事件触发的幂等靠事件键：lastEventKey + 持久幂等表，跨刷新不重放
      flow.lastEventKey = meta.eventKey || '';
      state.ext.assetMeters.idem[meta.runKey] = { flowId: flow.id, runId: runId, at: now() };
      pruneIdem();
    }
  }, { label: 'flow:' + flow.id, save: 'none', render: false });
  if (!txr.ok) return { ok: false, error: txr.error };
  return {
    ok: true, runId: runId, runKey: meta.runKey, stepOutputs: ctx.stepOutputs,
    totals: ctx.totals, deltas: ctx.deltas,
  };
}

// 执行一条流。trigger='period' 时走幂等闸门；'manual' 为显式手动执行，不占周期额度。
function runFlow(flowId, opts) {
  return runFlowCore(flowId, opts, false);
}
// 在既有事务内执行（购买执行权专用）：不占流周期额度、不写幂等键，成败随外层事务。
function runFlowInTxn(flowId, opts) {
  return runFlowCore(flowId, opts, true);
}
function runFlowCore(flowId, opts, inTxn) {
  opts = opts || {};
  if (inTxn) {
    if (!Ledger.inTxn()) return { ok: false, error: { code: 'FLOW_NO_TXN', message: '必须在事务内调用' } };
  } else if (Ledger.inTxn()) {
    return { ok: false, error: { code: 'FLOW_BUSY', message: '流执行不能嵌套在事务内' } };
  }
  const flow = (state.flows || []).find(f => f && f.id === flowId) || null;
  if (!flow) return { ok: false, error: { code: 'FLOW_NOT_FOUND' } };
  if (flow.enabled === false || flow.invalid) return { ok: false, error: { code: 'FLOW_DISABLED' } };
  if (_active.has(flow.id)) return { ok: false, error: { code: 'FLOW_REENTRANT' } };
  const compiled = compile(flow);
  if (!compiled.ok) return { ok: false, error: { code: 'FLOW_COMPILE_FAILED', errors: compiled.errors } };
  // 声明了运行输入（目前仅资产使用配方的 taskId）就必须由调用方注入
  const inputs = (opts.inputs && typeof opts.inputs === 'object') ? opts.inputs : {};
  const declared = compiled.plan.inputs || [];
  for (let i = 0; i < declared.length; i += 1) {
    const name = declared[i] && declared[i].name;
    if (name && (inputs[name] === undefined || inputs[name] === null || inputs[name] === '')) {
      return { ok: false, error: { code: 'FLOW_INPUT_MISSING', input: name } };
    }
  }
  ensureRuntimeStructures();

  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  const trigger = opts.trigger === 'manual' ? 'manual'
    : opts.trigger === 'event' ? 'event'
      : opts.trigger === 'purchase' ? 'purchase' : 'period';
  let runKey = '';
  let period = '';
  let base = '';
  let eventKey = '';
  if (trigger === 'period') {
    period = periodKey(flow.trigger, ts);
    base = flow.id + '@' + period;
    // lastRun 是“该周期已发生”的快速闸门；idem 负责多跑额度与持久去重
    if (flow.limits.maxRunsPerPeriod <= 1 && flow.lastRun === base) {
      return { ok: true, skipped: 'already-run', runKey: base };
    }
    const used = countIdem(state.ext.assetMeters.idem, base);
    if (used >= flow.limits.maxRunsPerPeriod) return { ok: true, skipped: 'already-run', runKey: base };
    runKey = used === 0 ? base : base + '#' + used;
  } else if (trigger === 'event') {
    eventKey = (opts.event && typeof opts.event.key === 'string') ? opts.event.key : '';
    if (!eventKey) return { ok: false, error: { code: 'FLOW_BAD_EVENT' } };
    // 同一事件的同一条流只执行一次：lastEventKey 快速闸门 + 持久幂等表跨刷新去重
    runKey = flow.id + '@event:' + eventKey;
    if (flow.lastEventKey === eventKey || state.ext.assetMeters.idem[runKey]) {
      return { ok: true, skipped: 'already-run', runKey: runKey };
    }
  } else if (trigger === 'purchase') {
    // 执行权：由购买单驱动，一次购买执行一次，不占流自身的周期额度
    const orderId = typeof opts.orderId === 'string' ? opts.orderId : '';
    if (!orderId) return { ok: false, error: { code: 'FLOW_BAD_PURCHASE' } };
    runKey = flow.id + '@purchase@' + orderId;
  } else {
    runKey = flow.id + '@manual@' + ts;
  }

  const actLike = {
    period: flow.trigger.period, anchor: flow.trigger.anchor,
    budgetCtx: BudgetEngine.activityContext(ts),
  };
  let condOk = false;
  try {
    condOk = evalCondition(Object.assign({}, actLike, { condition: compiled.plan.condition }), ts);
  } catch (e) {
    return { ok: false, error: { code: 'FLOW_CONDITION_ERROR', message: e && e.message } };
  }
  // 条件不成立 = 本次未发生：默认不写 lastRun、不写幂等键、不落任何流水。
  // 迁移流可开启 settleWhenConditionFalse：本周期就此结束（复刻活动“每周期只求值一次”）。
  if (!condOk) {
    if (trigger === 'event') {
      // 事件流条件不成立 = 本次未发生：不发放，但落“已求值”幂等记录，避免同一事件重复求值
      flow.lastEventKey = eventKey;
      state.ext.assetMeters.idem[runKey] = { flowId: flow.id, runId: '', at: now(), skipped: true };
      pruneIdem();
      return { ok: true, skipped: 'condition-false', settled: false, runKey: runKey };
    }
    const settled = trigger === 'period' && flow.settleWhenConditionFalse === true;
    if (settled) flow.lastRun = base;
    return { ok: true, skipped: 'condition-false', settled: settled, runKey: runKey };
  }

  _active.add(flow.id);
  try {
    return execute(flow, compiled.plan, {
      trigger: trigger, ts: ts, runKey: runKey, period: period, actLike: actLike, inputs: inputs,
      eventKey: eventKey, orderId: opts.orderId || '', productId: opts.productId || '',
    });
  } finally {
    _active.delete(flow.id);
  }
}

// ===== 资产使用配方（task.exempt 闭环）=====
// 配方不是一条落盘的流：运行时按资产定义生成一条虚拟手动流，复用同一编译器/执行器/撤销。
// 语义：先扣本资产（可见流水），再登记任务豁免；任一步失败整单回滚。
function buildAssetUseFlow(def) {
  const recipe = def && def.useRecipe;
  if (!recipe || recipe.type !== 'task-exempt') return null;
  const cost = Math.max(1, Math.min(10, Math.round(Number(recipe.cost) || 1)));
  return {
    v: 1,
    id: 'use:' + def.id,
    name: '使用「' + (def.name || def.id) + '」豁免',
    enabled: true,
    trigger: { type: 'manual' },
    condition: { mode: 'all', items: [] },
    limits: {
      maxSteps: 4, maxGrantPerRun: 0, maxSpendPerRun: 0,
      maxAssetGrantPerRun: 0, maxAssetSpendPerRun: Math.max(3, cost), maxRunsPerPeriod: 1,
    },
    inputs: [{ name: 'taskId', type: 'task' }],
    steps: [
      { id: 'spend', atom: 'asset.spend', params: { assetId: def.id, amount: cost, desc: '使用「' + (def.name || def.id) + '」' } },
      { id: 'exempt', atom: 'task.exempt', params: { taskId: { input: 'taskId' }, desc: '「' + (def.name || def.id) + '」豁免任务' } },
    ],
  };
}

function assetUseDef(assetId) {
  const def = findAssetDef(assetId);
  if (!def) return { error: { code: 'FLOW_ASSET_UNKNOWN' } };
  if (def.enabled === false) return { error: { code: 'FLOW_ASSET_DISABLED' } };
  if (def.archived) return { error: { code: 'FLOW_ASSET_ARCHIVED' } };
  if (!def.useRecipe || def.useRecipe.type !== 'task-exempt') return { error: { code: 'FLOW_NO_USE_RECIPE' } };
  return { def: def };
}

// 使用资产执行一次手动运行（trigger='asset'，不占周期额度）
function runAssetUse(assetId, opts) {
  opts = opts || {};
  if (Ledger.inTxn()) return { ok: false, error: { code: 'FLOW_BUSY', message: '资产使用不能嵌套在事务内' } };
  const found = assetUseDef(assetId);
  if (found.error) return { ok: false, error: found.error };
  const taskId = opts.taskId;
  if (typeof taskId !== 'string' || !taskId) return { ok: false, error: { code: 'FLOW_INPUT_MISSING', input: 'taskId' } };
  const flow = buildAssetUseFlow(found.def);
  const compiled = compile(flow);
  if (!compiled.ok) return { ok: false, error: { code: 'FLOW_COMPILE_FAILED', errors: compiled.errors } };
  ensureRuntimeStructures();
  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  const actLike = { period: 'week', anchor: 1, budgetCtx: BudgetEngine.activityContext(ts) };
  return execute(flow, compiled.plan, {
    trigger: 'asset', ts: ts, runKey: 'use:' + assetId + '@' + ts, period: '',
    actLike: actLike, inputs: { taskId: taskId },
  });
}

// 资产使用干跑：与流干跑同一条路径（克隆 state → 真执行 → 还原）
function dryRunAssetUse(assetId, opts) {
  opts = opts || {};
  if (Ledger.inTxn()) {
    return { ok: false, dryRun: true, error: { code: 'FLOW_DRY_RUN_IN_TXN', message: '干跑不能在事务内调用' } };
  }
  const original = getState();
  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  const found = assetUseDef(assetId);
  const flowName = found.def ? ('使用「' + (found.def.name || found.def.id) + '」豁免') : '';
  const clone = cloneStateDeep(original);
  const snap = captureStateSnapshot(clone, ts);
  setState(clone);
  let report;
  try {
    const result = runAssetUse(assetId, { taskId: opts.taskId, ts: ts });
    report = buildDryRunReport(original, snap, getState(), result, {
      flowId: 'use:' + assetId, flowName: flowName, trigger: 'asset', ts: ts, periodKey: '',
    });
  } finally {
    setState(original);
  }
  return report;
}

// 周期调度：只求值 trigger.type === 'period' 的启用流
function processDue(ts, silent) {
  const at = Number.isFinite(Number(ts)) ? Number(ts) : now();
  const results = [];
  let changed = false;
  (state.flows || []).forEach(function (flow) {
    if (!flow || flow.enabled === false || flow.invalid) return;
    if (!flow.trigger || flow.trigger.type !== 'period') return;
    const r = runFlow(flow.id, { trigger: 'period', ts: at });
    if (r && r.ok && (!r.skipped || r.settled)) changed = true;
    results.push(r);
  });
  // 单条流由 runFlow 以 save:'none' 执行；批量求值后只在这里落盘一次
  if (changed && !silent) save();
  return results;
}

// ===== 干跑（S5）：克隆态 + 真实执行器 =====
// 硬约束：
// 1. 不允许另写“只计算不执行”的平行逻辑 —— 直接把全局 state 换成深拷贝后调用 runFlow；
// 2. 正常、失败回滚、异常三种路径都在 finally 里还原原 state，克隆态不外泄；
// 3. 不写盘（runFlow 内事务固定 save:'none'）、不渲染、不发提示（原子在 silent 下运行）。
function cloneStateDeep(s) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(s); } catch (e) { /* 回退到 JSON */ }
  }
  return JSON.parse(JSON.stringify(s));
}

// 账户余额快照：vitality / achievement / progress:<dom> / card:<asset>
function balancesOf(s) {
  const out = {};
  const sc = s.scores || {};
  out.vitality = Number(sc.vitality) || 0;
  out.achievement = Number(sc.achievement) || 0;
  const pr = sc.progress || {};
  Object.keys(pr).forEach(function (k) { out['progress:' + k] = Number(pr[k]) || 0; });
  (s.domains || []).forEach(function (d) {
    if (d && d.id && out['progress:' + d.id] === undefined) out['progress:' + d.id] = 0;
  });
  Object.keys(s.cards || {}).forEach(function (k) { out['card:' + k] = Number(s.cards[k]) || 0; });
  return out;
}

function accountKindOf(key) {
  if (key === 'vitality') return 'vitality';
  if (key === 'achievement') return 'achievement';
  if (key.indexOf('progress:') === 0) return 'progress';
  if (key.indexOf('card:') === 0) return 'asset';
  return 'other';
}

function accountLabelOf(key, s) {
  const kind = accountKindOf(key);
  if (kind === 'vitality') return '活力';
  if (kind === 'achievement') return '成就';
  if (kind === 'progress') {
    const id = key.slice(9);
    const d = (s.domains || []).find(function (x) { return x && x.id === id; });
    return (d && d.name) || id;
  }
  if (kind === 'asset') {
    const id = key.slice(5);
    const def = (s.assetDefs || []).find(function (x) { return x && x.id === id; });
    return (def && def.name) || id;
  }
  return key;
}

function meterSnapshot(s, assetId, pk) {
  const by = (s.ext && s.ext.assetMeters && s.ext.assetMeters.byAsset) || {};
  const m = (by[assetId] && by[assetId][pk]) || null;
  return {
    issued: m ? Number(m.issued) || 0 : 0,
    spent: m ? Number(m.spent) || 0 : 0,
    runs: m ? Number(m.runs) || 0 : 0,
  };
}

// 执行前快照：余额、已有流水 id、各资产当期计量
function captureStateSnapshot(s, ts) {
  const balances = balancesOf(s);
  const logIds = {};
  (s.logs || []).forEach(function (l) { if (l && l.id) logIds[l.id] = true; });
  const meters = {};
  const defs = Array.isArray(s.assetDefs) ? s.assetDefs : [];
  const byAsset = (s.ext && s.ext.assetMeters && s.ext.assetMeters.byAsset) || {};
  defs.forEach(function (def) {
    if (!def || !def.id) return;
    const pk = assetPeriodKeyOf(def, ts);
    const m = meterSnapshot(s, def.id, pk);
    m.existed = !!(byAsset[def.id] && byAsset[def.id][pk]);
    meters[def.id] = m;
  });
  Object.keys(s.cards || {}).forEach(function (id) {
    if (meters[id]) return;
    const def = defs.find(function (x) { return x && x.id === id; }) || { id: id };
    const pk = assetPeriodKeyOf(def, ts);
    const m = meterSnapshot(s, id, pk);
    m.existed = !!(byAsset[id] && byAsset[id][pk]);
    meters[id] = m;
  });
  return { balances: balances, logIds: logIds, meters: meters };
}

function collectAssetUsage(original, snap, after, ts, report) {
  const defs = Array.isArray(original.assetDefs) ? original.assetDefs : [];
  const afterBalances = balancesOf(after);
  const ids = Object.keys(snap.meters || {});
  Object.keys(afterBalances).forEach(function (k) {
    if (k.indexOf('card:') !== 0) return;
    const id = k.slice(5);
    if (ids.indexOf(id) < 0) ids.push(id);
  });
  ids.forEach(function (aid) {
    const def = defs.find(function (d) { return d && d.id === aid; })
      || { id: aid, name: aid, unit: '', maxBalance: null, maxIssuedPerPeriod: null };
    const pk = assetPeriodKeyOf(def, ts);
    const m0 = snap.meters[aid] || { issued: 0, spent: 0, runs: 0 };
    const m1 = meterSnapshot(after, aid, pk);
    const b0 = Number(snap.balances['card:' + aid]) || 0;
    const b1 = Number(afterBalances['card:' + aid]) || 0;
    const dIssued = m1.issued - m0.issued;
    const dSpent = m1.spent - m0.spent;
    const dRuns = m1.runs - m0.runs;
    if (b0 === b1 && dIssued === 0 && dSpent === 0 && dRuns === 0) return;
    const item = {
      assetId: aid, name: def.name || aid, unit: def.unit || '',
      balanceBefore: b0, balanceAfter: b1, balanceDelta: b1 - b0,
      periodKey: pk,
      issued: m1.issued, spent: m1.spent, runs: m1.runs,
      deltaIssued: dIssued, deltaSpent: dSpent, deltaRuns: dRuns,
      maxBalance: def.maxBalance === undefined ? null : def.maxBalance,
      maxIssuedPerPeriod: def.maxIssuedPerPeriod === undefined ? null : def.maxIssuedPerPeriod,
    };
    report.assets.push(item);
    if (item.maxBalance !== null && b1 > Number(item.maxBalance)) {
      report.warnings.push({
        code: 'ASSET_OVER_CAP', assetId: aid, label: item.name,
        after: b1, maxBalance: Number(item.maxBalance),
      });
    }
  });
}

function buildDryRunReport(original, snap, after, result, meta) {
  const flow = (original.flows || []).find(function (f) { return f && f.id === meta.flowId; }) || null;
  const report = {
    ok: true, dryRun: true,
    flowId: meta.flowId,
    flowName: (flow && flow.name) || meta.flowName || '',
    trigger: meta.trigger,
    periodKey: meta.periodKey || '',
    runKey: '',
    wouldRun: false,
    skipped: '',
    condition: null,
    accounts: [], entries: [], assets: [],
    totals: { granted: 0, spent: 0, assetGranted: 0, assetSpent: 0, steps: 0, notes: 0 },
    error: null,
    warnings: [],
  };
  if (result && result.runKey) report.runKey = result.runKey;
  if (!result || !result.ok) {
    report.error = (result && result.error) || { code: 'FLOW_DRY_RUN_ERROR' };
    return report;
  }
  if (result.skipped) {
    report.skipped = result.skipped;
    report.condition = result.skipped === 'condition-false' ? false : null;
    return report;
  }
  report.wouldRun = true;
  report.condition = true;
  if (result.totals) {
    ['granted', 'spent', 'assetGranted', 'assetSpent', 'steps', 'notes'].forEach(function (k) {
      report.totals[k] = Number(result.totals[k]) || 0;
    });
  }

  const afterBalances = balancesOf(after);
  const keys = Object.keys(snap.balances);
  Object.keys(afterBalances).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
  keys.forEach(function (key) {
    const b = Number(snap.balances[key]) || 0;
    const a = Number(afterBalances[key]) || 0;
    if (a === b) return;
    const label = accountLabelOf(key, original);
    report.accounts.push({
      key: key, kind: accountKindOf(key), label: label,
      before: b, after: a, delta: a - b,
    });
    if (a < 0) {
      report.warnings.push({ code: 'NEGATIVE_BALANCE', account: key, label: label, before: b, after: a });
    }
  });

  // 干跑时真实执行过一遍，clone 里新出现的流水就是“将要写入的流水”
  const afterLogs = Array.isArray(after.logs) ? after.logs : [];
  report.entries = afterLogs.filter(function (l) { return l && !snap.logIds[l.id]; }).reverse();

  collectAssetUsage(original, snap, after, meta.ts, report);
  return report;
}

// 干跑一条流：返回报告本身；ok 表示干跑完成，是否会执行看 wouldRun。
function dryRun(flowId, opts) {
  opts = opts || {};
  if (Ledger.inTxn()) {
    return { ok: false, dryRun: true, error: { code: 'FLOW_DRY_RUN_IN_TXN', message: '干跑不能在事务内调用' } };
  }
  const original = getState();
  const flow = (original.flows || []).find(function (f) { return f && f.id === flowId; }) || null;
  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  let trigger = opts.trigger;
  if (trigger !== 'manual' && trigger !== 'period') {
    trigger = (flow && flow.trigger && flow.trigger.type === 'manual') ? 'manual' : 'period';
  }
  let pk = '';
  if (trigger === 'period' && flow && flow.trigger) {
    try { pk = periodKey(flow.trigger, ts); } catch (e) { pk = ''; }
  }

  const clone = cloneStateDeep(original);
  const snap = captureStateSnapshot(clone, ts);
  setState(clone);
  let report;
  try {
    let result;
    try {
      result = runFlow(flowId, { trigger: trigger, ts: ts });
    } catch (e) {
      result = { ok: false, error: { code: 'FLOW_DRY_RUN_ERROR', message: e && e.message } };
    }
    report = buildDryRunReport(original, snap, getState(), result, {
      flowId: flowId, trigger: trigger, ts: ts, periodKey: pk,
    });
  } finally {
    // 无论成功、事务回滚还是异常，都还原真实 state；克隆态只在本函数内存在
    setState(original);
  }
  return report;
}

// ===== 整单撤销（S6）：journal 驱动 + 原子反转器 + 单事务 =====
// 顺序铁律：先全量前置扫描（不写一笔）→ 逆序反转每一步 → 删主日志 → 写 status:'reversed'。
// 失败一律抛 __txn，由 Ledger.txn 整单回滚；撤销后不调用任何收尾逻辑（不做成就复核/贷款结算等）。
function undoFail(code, info) {
  const e = new Error(code);
  e.__txn = true;
  e.code = code;
  e.info = info || {};
  throw e;
}

function accountKeyOfLog(log) {
  if (!log || !log.st) return '';
  // 拆分流水没有单一账户键，由 reverseOneLog 逐领域退回
  if (log.st === 'progress' && Array.isArray(log.splits) && log.splits.length) return '';
  if (log.st === 'progress') return 'progress:' + (log.dom || 'd_default');
  if (log.st === 'card') return 'card:' + (log.card || '');
  if (log.st === 'vitality' || log.st === 'achievement') return log.st;
  return '';
}

function reLockAchievement(achId) {
  const a = (state.achievements || []).find(function (x) { return x && x.id === achId; });
  if (!a) return;
  a.unlocked = false;
  a.unlockedAt = null;
}

// 单条子日志反转：按流水贡献反向补账（隐形）→ 删流水；成就日志额外回锁
function reverseOneLog(logId, ctx) {
  const log = (state.logs || []).find(function (l) { return l && l.id === logId; });
  if (!log) undoFail('FLOW_UNDO_LOG_TRIMMED', { logId: logId });
  if (log.achId) reLockAchievement(log.achId);
  const key = accountKeyOfLog(log);
  const amt = Number(log.amt) || 0;
  if (!key && log.st === 'progress' && Array.isArray(log.splits) && log.splits.length) {
    log.splits.forEach(function (x) {
      const v = Number(x && x.amt) || 0;
      if (!v) return;
      Ledger.post({ op: 'grant', account: 'progress:' + ((x && x.dom) || 'd_default'), delta: -v, visible: false, reason: { src: 'undo-flow' } });
    });
  } else if (key && amt !== 0) {
    Ledger.post({ op: 'grant', account: key, delta: -amt, visible: false, reason: { src: 'undo-flow' } });
  }
  Ledger.removeLogs(function (l) { return l.id !== logId; });
  ctx.removedLogs += 1;
}

// 通用反转器：账户/资产/备注/成就日志都按“反向补账 + 删日志”处理（步骤内逆序）
function reverseGenericStep(step, ctx) {
  const ids = (step && step.logIds) || [];
  for (let i = ids.length - 1; i >= 0; i--) reverseOneLog(ids[i], ctx);
}

function restoreArchivedEntities(step, ctx) {
  const kind = step && step.input && step.input.kind;
  const list = kind === 'affair' ? (state.affairs || [])
    : kind === 'chore' ? (state.chores || []) : (state.tasks || []);
  const ids = (step && step.output && step.output.ids) || [];
  ids.forEach(function (id) {
    const e = list.find(function (x) { return x && x.id === id; });
    if (!e) undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: kind, id: id });
    e.archived = false;
    delete e.archivedAt;
    ctx.restoredEntities += 1;
  });
}

// task.exempt 反转：恢复任务字段（日志由通用反转删除；扣卡步骤有自己的 reverser）
function restoreTaskExempt(step, ctx) {
  reverseGenericStep(step, ctx);
  const taskId = step && step.input && step.input.taskId;
  const t = (state.tasks || []).find(function (x) { return x && x.id === taskId; });
  if (!t) undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: 'task', id: taskId });
  const o = (step && step.output) || {};
  if (o.prevLastExempt !== undefined && o.prevLastExempt !== null) t.lastExempt = o.prevLastExempt;
  else delete t.lastExempt;
  t.pendingDebt = Number(o.prevPendingDebt) || 0;
  if (o.prevLastDebtDate !== undefined && o.prevLastDebtDate !== null) t.lastDebtDate = o.prevLastDebtDate;
  else delete t.lastDebtDate;
  ctx.restoredEntities += 1;
}

// 各原子一个反转器（独立注册表）：能复用通用语义的就只声明差异
const FLOW_REVERSERS = {
  'currency.grant': reverseGenericStep,
  'currency.spend': reverseGenericStep,
  'asset.grant': reverseGenericStep,
  'asset.spend': reverseGenericStep,
  'log.note': reverseGenericStep,
  'entity.archiveIdle': function (step, ctx) {
    reverseGenericStep(step, ctx);
    restoreArchivedEntities(step, ctx);
  },
  'entity.create': function (step, ctx) {
    reverseGenericStep(step, ctx);
    removeCreatedEntities(step, ctx);
  },
  'engine.recheckAchievements': reverseGenericStep,
  'task.exempt': restoreTaskExempt,
};

// entity.create 反转：删除本次创建的事项。已被使用/修改过的一律拒绝（不夹 0、不留半截）
function createdEntityList(kind) {
  return kind === 'affair' ? (state.affairs || [])
    : kind === 'chore' ? (state.chores || []) : (state.tasks || []);
}
function entityUsedSinceCreate(kind, e) {
  if (!e) return true;
  if (e.archived) return true;
  if (kind === 'task') return Number(e.checkInCount) > 0 || !!e.lastCheckIn;
  if (kind === 'affair') {
    return Number(e.currentCell) > 0 || Number(e.alreadyGiven) > 0 || !!e.doneAt || !!e.startedAt ||
      (Array.isArray(e.steps) && e.steps.length > 0);
  }
  return !!e.done || !!e.settled;
}
function removeCreatedEntities(step, ctx) {
  const kind = (step && step.input && step.input.kind) || 'task';
  const list = createdEntityList(kind);
  const ids = (step && step.output && step.output.ids) || [];
  ids.forEach(function (id) {
    const idx = list.findIndex(function (x) { return x && x.id === id; });
    if (idx < 0) undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: kind, id: id });
    if (entityUsedSinceCreate(kind, list[idx])) undoFail('FLOW_UNDO_ENTITY_USED', { kind: kind, id: id });
    list.splice(idx, 1);
    if (!ctx.removedEntities) ctx.removedEntities = 0;
    ctx.removedEntities += 1;
  });
}

function restoreAssetMeters(journal, ctx) {
  const meters = state.ext && state.ext.assetMeters;
  if (!meters || !meters.byAsset) return;
  (journal.assets || []).forEach(function (a) {
    const bucket = meters.byAsset[a.assetId] || (meters.byAsset[a.assetId] = {});
    if (!a.meterExisted) {
      delete bucket[a.periodKey];
      if (!Object.keys(bucket).length) delete meters.byAsset[a.assetId];
    } else {
      bucket[a.periodKey] = {
        issued: Number(a.issuedBefore) || 0,
        spent: Number(a.spentBefore) || 0,
        runs: Number(a.runsBefore) || 0,
      };
    }
    ctx.restoredAssets += 1;
  });
}

// 前置扫描：只读。任一不满足直接拒绝，绝不先写后回滚。
function preflightUndo(rec, journal, ts) {
  const logById = {};
  (state.logs || []).forEach(function (l) { if (l && l.id) logById[l.id] = l; });
  const ids = journal.logIds || [];

  // 1. 日志完整（子日志 + 主日志）：被裁剪即不可逆
  ids.forEach(function (id) {
    if (!logById[id]) undoFail('FLOW_UNDO_LOG_TRIMMED', { logId: id });
  });
  if (rec.journalLogId && !logById[rec.journalLogId]) {
    undoFail('FLOW_UNDO_LOG_TRIMMED', { logId: rec.journalLogId });
  }

  // 2. 每个步骤都必须有反转器（未知原子/旧 journal 不猜）
  (journal.steps || []).forEach(function (step) {
    if (step.kind === 'branch') return;
    if (!FLOW_REVERSERS[step.atom]) undoFail('FLOW_UNDO_NO_REVERSER', { atom: step.atom });
  });

  // 3. 资产：定义存在、未跨期、未被消耗（Fail-Closed：不夹 0、不部分撤销）
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  (journal.assets || []).forEach(function (a) {
    const def = defs.find(function (d) { return d && d.id === a.assetId; });
    if (!def) undoFail('FLOW_UNDO_ASSET_MISSING', { assetId: a.assetId });
    const pkNow = assetPeriodKeyOf(def, ts);
    if (a.periodKey && pkNow !== a.periodKey) {
      undoFail('FLOW_UNDO_CROSS_PERIOD', { assetId: a.assetId, periodKey: a.periodKey, current: pkNow });
    }
    const cur = Number((state.cards || {})[a.assetId]) || 0;
    if (Number(a.delta) > 0 && cur < Number(a.delta)) {
      undoFail('FLOW_UNDO_ASSET_CONSUMED', { assetId: a.assetId, granted: Number(a.delta), balance: cur });
    }
  });

  // 4. 实体存在：归档过的实体若已被删除则拒绝
  (journal.steps || []).forEach(function (step) {
    if (step.kind === 'branch' || step.atom !== 'entity.archiveIdle') return;
    const kind = step.input && step.input.kind;
    const list = kind === 'affair' ? (state.affairs || [])
      : kind === 'chore' ? (state.chores || []) : (state.tasks || []);
    const archivedIds = (step.output && step.output.ids) || [];
    archivedIds.forEach(function (id) {
      if (!list.some(function (x) { return x && x.id === id; })) {
        undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: kind, id: id });
      }
    });
  });

  // 4b. 按模板创建的事项：必须仍存在，且未被使用/修改（否则删除会留下统计残差）
  (journal.steps || []).forEach(function (step) {
    if (step.kind === 'branch' || step.atom !== 'entity.create') return;
    const kind = (step.input && step.input.kind) || 'task';
    const list = createdEntityList(kind);
    const ids = (step.output && step.output.ids) || [];
    ids.forEach(function (id) {
      const e = list.find(function (x) { return x && x.id === id; });
      if (!e) undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: kind, id: id });
      if (entityUsedSinceCreate(kind, e)) undoFail('FLOW_UNDO_ENTITY_USED', { kind: kind, id: id });
    });
  });

  // 5. 成就存在：要回锁的成就必须还在
  const achIds = [];
  ids.forEach(function (id) {
    const log = logById[id];
    if (log && log.achId) achIds.push(log.achId);
  });
  achIds.forEach(function (aid) {
    if (!(state.achievements || []).some(function (a) { return a && a.id === aid; })) {
      undoFail('FLOW_UNDO_ENTITY_MISSING', { kind: 'achievement', id: aid });
    }
  });
}

// 撤销一次流运行：单事务回滚整条流的全部产出
function findUndoRun(runId) {
  const runs = state.ext && state.ext.flowRuns;
  const rec = (runs && runs.byId) ? runs.byId[runId] : null;
  if (!rec) return { ok: false, error: { code: 'FLOW_UNDO_NOT_FOUND' } };
  if (rec.status === 'reversed') return { ok: false, error: { code: 'FLOW_UNDO_ALREADY' } };
  const journal = rec.journal;
  if (!journal || !journal.v) return { ok: false, error: { code: 'FLOW_UNDO_NO_JOURNAL' } };
  return { ok: true, rec: rec, journal: journal };
}

function applyUndoWrites(rec, journal, ctx) {
  // 逆序：最后发生的步骤先反转；步骤内的子日志也逆序
  const steps = (journal.steps || []).slice().reverse();
  steps.forEach(function (step) {
    if (step.kind === 'branch') return;
    const reverse = FLOW_REVERSERS[step.atom];
    if (!reverse) undoFail('FLOW_UNDO_NO_REVERSER', { atom: step.atom });
    reverse(step, ctx);
  });
  // 主日志最后删
  if (rec.journalLogId) {
    Ledger.removeLogs(function (l) { return l.id !== rec.journalLogId; });
    ctx.removedLogs += 1;
  }
  // 资产计量回到执行前（前置扫描已保证没有跨期）
  restoreAssetMeters(journal, ctx);
  // status 最后写
  rec.status = 'reversed';
  rec.reversedAt = now();
  rec.undo = {
    at: rec.reversedAt, removedLogs: ctx.removedLogs,
    restoredEntities: ctx.restoredEntities, restoredAssets: ctx.restoredAssets,
    removedEntities: ctx.removedEntities || 0,
  };
}

function undoResult(runId, rec, ctx) {
  return {
    ok: true, runId: runId, flowId: rec.flowId, reversedAt: rec.reversedAt,
    removedLogs: ctx.removedLogs, restoredEntities: ctx.restoredEntities,
    restoredAssets: ctx.restoredAssets, removedEntities: ctx.removedEntities || 0,
  };
}

function undoFlowRun(runId, opts) {
  opts = opts || {};
  if (Ledger.inTxn()) {
    return { ok: false, error: { code: 'FLOW_UNDO_BUSY', message: '撤销不能在事务内调用' } };
  }
  const found = findUndoRun(runId);
  if (!found.ok) return found;
  const rec = found.rec;
  // 购买产生的运行不能单独撤销：必须与购买记录整单进退，避免“钱付了、效果没了”
  if (rec.trigger === 'purchase') {
    return { ok: false, error: { code: 'FLOW_UNDO_PURCHASE_BOUND', message: '该运行由商品购买产生，请在对应购买记录上整单撤销' } };
  }
  const journal = found.journal;
  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  try {
    preflightUndo(rec, journal, ts);
  } catch (e) {
    return {
      ok: false,
      error: { code: e.code || 'FLOW_UNDO_REFUSED', message: e.message, info: e.info || {} },
    };
  }

  const ctx = { removedLogs: 0, restoredEntities: 0, restoredAssets: 0 };
  const txr = Ledger.txn(function () { applyUndoWrites(rec, journal, ctx); }, {
    label: 'undo-flow:' + (rec.flowId || ''),
    save: opts.save === false ? 'none' : undefined,
    render: false,
  });

  if (!txr.ok) return { ok: false, error: txr.error };
  return undoResult(runId, rec, ctx);
}

// 供“购买撤销”在同一事务内联动撤销执行：不做事务/购买归属检查，由调用方保证事务边界。
// 前置扫描失败返回错误；写入阶段抛错则由外层事务整体回滚。
function undoFlowRunInTxn(runId, opts) {
  opts = opts || {};
  if (!Ledger.inTxn()) return { ok: false, error: { code: 'FLOW_NO_TXN', message: '必须在事务内调用' } };
  const found = findUndoRun(runId);
  if (!found.ok) return found;
  const rec = found.rec;
  const journal = found.journal;
  const ts = Number.isFinite(Number(opts.ts)) ? Number(opts.ts) : now();
  try {
    preflightUndo(rec, journal, ts);
  } catch (e) {
    return {
      ok: false,
      error: { code: e.code || 'FLOW_UNDO_REFUSED', message: e.message, info: e.info || {} },
    };
  }
  const ctx = { removedLogs: 0, restoredEntities: 0, restoredAssets: 0 };
  applyUndoWrites(rec, journal, ctx);
  return undoResult(runId, rec, ctx);
}

const FlowEngine = {
  compile: compile, runFlow: runFlow, runFlowInTxn: runFlowInTxn, processDue: processDue,
  dryRun: dryRun, undoFlowRun: undoFlowRun, undoFlowRunInTxn: undoFlowRunInTxn,
  runAssetUse: runAssetUse, dryRunAssetUse: dryRunAssetUse,
};

registerFlowDueProcessor(processDue);

export {
  compile, runFlow, runFlowInTxn, processDue, dryRun, undoFlowRun, undoFlowRunInTxn,
  runAssetUse, dryRunAssetUse, buildAssetUseFlow,
  FLOW_REVERSERS, FlowEngine,
};
