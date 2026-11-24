// flow-atoms.js —— 阶段 4 动作原子（S3）
//
// 约束（与设计草案 2.1 / 2.4 一致）：
// 1. 唯一写入口：只调用 Ledger.post / Ledger.event / assetGrantCore，不直接写 state.scores / state.cards；
// 2. 必须已在事务内：入口断言 Ledger.inTxn()，否则抛 FLOW_NO_TXN（不自动开事务）；
// 3. 参数白名单：未知字段直接拒绝，禁止注入 src / visible / entry / reason / idemKey；
// 4. 失败抛 __txn 错误，由 Ledger.txn 统一回滚；原子不吞错、不落盘、不渲染、不弹提示；
// 5. 运行计量（ext.assetMeters）只读；写入由后续执行器统一负责——本文件只负责“读额度 + 拦截”。
import {
  FLOW_ATOM_CREATE_NAME_MAX, FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_ARCHIVE, FLOW_ATOM_MAX_ASSET,
  FLOW_ATOM_MAX_CREATE, FLOW_ATOM_MAX_CURRENCY, FLOW_ATOM_MAX_NOTES, FLOW_ATOM_NOTE_MAX_LEN, FLOW_MAX_STEPS,
} from './constants.js';
import { checkAchievements, exemptTaskCore } from './business.js';
import { archiveIdleEntities, assetGrantCore, createEntitiesFromTemplate } from './entities.js';
import { normalizeChoreTags } from './chore-list.js';
import { Ledger } from './ledger.js';
import { state } from './state.js';
import { periodKeyOf } from './time.js';

function fail(code, info) {
  const e = new Error(code);
  e.__txn = true;
  e.code = code;
  e.info = info || {};
  throw e;
}

// 流级上限：以执行器传入的 ctx.limits 为准，缺省值与 normalizeFlowLimits 保持一致
function limitsOf(ctx) {
  const raw = (ctx && ctx.limits) || (ctx && ctx.flow && ctx.flow.limits) || {};
  const n = (v, def, min, max) => {
    const x = Number(v);
    const y = isFinite(x) ? x : def;
    return Math.min(max, Math.max(min, y));
  };
  return {
    maxSteps: Math.round(n(raw.maxSteps, FLOW_MAX_STEPS, 1, FLOW_MAX_STEPS)),
    maxGrantPerRun: n(raw.maxGrantPerRun, 20, 0, 100),
    maxSpendPerRun: n(raw.maxSpendPerRun, 20, 0, 100),
    maxAssetGrantPerRun: Math.round(n(raw.maxAssetGrantPerRun, 3, 0, 20)),
    maxAssetSpendPerRun: Math.round(n(raw.maxAssetSpendPerRun, 3, 0, 20)),
  };
}

// 单次运行的累计量（执行上下文，不落盘）：原子在写成功后累加，用于流级总额与步骤数上限
function totalsOf(ctx) {
  if (!ctx.totals || typeof ctx.totals !== 'object') ctx.totals = {};
  const t = ctx.totals;
  ['granted', 'spent', 'assetGranted', 'assetSpent', 'steps', 'notes', 'recheck'].forEach(k => {
    const v = Number(t[k]);
    t[k] = isFinite(v) ? v : 0;
  });
  return t;
}

function idemOf(ctx) {
  const run = ctx.runKey || ctx.runId || '';
  const step = ctx.stepId || '';
  return (run && step) ? (run + '#' + step) : undefined;
}

function checkParams(atomId, params, allowed) {
  const p = (params === undefined || params === null) ? {} : params;
  if (typeof p !== 'object' || Array.isArray(p)) fail('FLOW_BAD_PARAMS', { atom: atomId });
  Object.keys(p).forEach(k => {
    if (allowed.indexOf(k) < 0) fail('FLOW_BAD_PARAMS', { atom: atomId, key: k });
  });
  return p;
}

function descOf(params, fallback) {
  const raw = params.desc;
  const d = (raw === undefined || raw === null) ? '' : String(raw).trim();
  return d ? d.slice(0, 120) : fallback;
}

// 摘要用的中性标签：原子层不读 state，UI 层可传入带名称的解析器覆盖。
// account / asset 缺省回退原始键；kind 是纯枚举映射，可在此翻译。
const PLAIN_LABELS = {
  account: v => (v === undefined || v === null || v === '') ? '未选账户' : String(v),
  asset: v => (v === undefined || v === null || v === '') ? '未选资产' : String(v),
  task: v => (typeof v === 'string' && v) ? '任务 ' + v : '运行时指定任务',
};
function labelsOf(labels) {
  const src = labels && typeof labels === 'object' ? labels : {};
  const pick = (k) => typeof src[k] === 'function' ? src[k] : PLAIN_LABELS[k];
  return { account: pick('account'), asset: pick('asset'), task: pick('task') };
}
function kindLabel(kind) {
  return kind === 'affair' ? '项目' : kind === 'chore' ? '杂事' : '任务';
}

// 货币金额：>0、最多 2 位小数、单步 ≤ 100
function currencyAmount(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) fail('FLOW_INVALID_AMOUNT', { amount: v });
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) fail('FLOW_INVALID_AMOUNT', { amount: v });
  const amt = cents / 100;
  if (amt > FLOW_ATOM_MAX_CURRENCY) fail('FLOW_AMOUNT_LIMIT', { amount: amt, max: FLOW_ATOM_MAX_CURRENCY });
  return amt;
}

// 资产数量：正整数、单步 ≤ 10
function assetAmount(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || !Number.isInteger(n)) fail('FLOW_INVALID_AMOUNT', { amount: v });
  if (n > FLOW_ATOM_MAX_ASSET) fail('FLOW_AMOUNT_LIMIT', { amount: n, max: FLOW_ATOM_MAX_ASSET });
  return n;
}

// 账户白名单：vitality / achievement / progress:<已存在领域>
// 键解析完全委托 Ledger.accountInfo（唯一账户键解析路径），本文件不再自行切分键名。
function resolveAccount(account) {
  let info;
  try {
    info = Ledger.accountInfo(account);
  } catch (e) {
    return fail('FLOW_INVALID_ACCOUNT', { account: account });
  }
  if (!info || typeof info.get !== 'function' || typeof info.set !== 'function') {
    fail('FLOW_INVALID_ACCOUNT', { account: account });
  }
  if (info.st !== 'vitality' && info.st !== 'achievement' && info.st !== 'progress') {
    fail('FLOW_INVALID_ACCOUNT', { account: account });
  }
  if (info.st === 'progress' && !(Array.isArray(state.domains) && state.domains.some(d => d && d.id === info.dom))) {
    fail('FLOW_INVALID_ACCOUNT', { account: account });
  }
  return info;
}

function findAsset(assetId) {
  if (typeof assetId !== 'string' || !assetId) fail('FLOW_ASSET_UNKNOWN', { assetId: assetId });
  const defs = Array.isArray(state.assetDefs) ? state.assetDefs : [];
  const def = defs.find(d => d && d.id === assetId);
  if (!def) fail('FLOW_ASSET_UNKNOWN', { assetId: assetId });
  return def;
}

function ensureAssetUsable(def) {
  if (def.enabled === false) fail('FLOW_ASSET_DISABLED', { assetId: def.id });
  if (def.archived) fail('FLOW_ASSET_ARCHIVED', { assetId: def.id });
}

function assetPeriodKey(def, ts) {
  const ip = (def && def.issuePeriod) || {};
  return periodKeyOf(
    { period: ip.cycle === 'month' ? 'month' : 'week', anchor: ip.anchor || 1 },
    ts === undefined || ts === null ? Date.now() : ts
  );
}
const assetPeriodKeyOf = assetPeriodKey;

// 只读周期计量；写入由执行器统一负责（S4）
function assetMeter(assetId, pk) {
  const meters = state.ext && state.ext.assetMeters;
  const by = (meters && meters.byAsset && meters.byAsset[assetId]) || null;
  return (by && by[pk]) || { issued: 0, spent: 0, runs: 0 };
}

// ===== A. currency.grant =====
function currencyGrant(ctx, params) {
  const amount = currencyAmount(params.amount);
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.granted + amount > limits.maxGrantPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'grant', used: totals.granted, amount: amount, max: limits.maxGrantPerRun });
  }
  // 迁移专用：进度未指定领域时按当前全部领域均分（复刻周期活动语义）
  if (params.split === 'allDomains') {
    if (params.account !== 'progress') fail('FLOW_BAD_PARAMS', { field: 'split' });
    const dids = (state.domains || []).map(d => d && d.id).filter(Boolean);
    if (!dids.length) fail('FLOW_INVALID_ACCOUNT', { account: 'progress' });
    const desc = descOf(params, '动作流发放 进度（全部领域均分）');
    const r = Ledger.postSplits({
      splits: [{ domainIds: dids, delta: amount }],
      entry: {
        st: 'progress', amt: amount, desc: desc, src: 'flow-currency-grant', dom: '',
        flowRunId: ctx.runId || '', stepId: ctx.stepId || '',
      },
      reason: { src: 'flow-currency-grant', desc: desc },
    });
    totals.granted += amount;
    return { ok: true, amount: amount, entryId: (r && r.entryId) || null, split: true };
  }
  if (params.split !== undefined) fail('FLOW_BAD_PARAMS', { field: 'split' });
  const acct = resolveAccount(params.account);
  if (params.taskId !== undefined && acct.st !== 'vitality') fail('FLOW_BAD_PARAMS', { field: 'taskId' });
  const st = acct.st;
  const dom = acct.dom;
  const desc = descOf(params, '动作流发放 ' + params.account);
  const entry = { st: st, amt: amount, desc: desc, src: 'flow-currency-grant', dom: dom, flowRunId: ctx.runId || '', stepId: ctx.stepId || '' };
  if (typeof params.taskId === 'string' && params.taskId) entry.taskId = params.taskId;
  const r = Ledger.post({
    op: 'grant', account: params.account, delta: amount, idemKey: idemOf(ctx),
    entry: entry,
    reason: { src: 'flow-currency-grant', desc: desc, dom: dom },
  });
  totals.granted += amount;
  return { ok: true, amount: amount, entryId: (r && r.entryId) || null };
}

// ===== B. currency.spend =====
function currencySpend(ctx, params) {
  const acct = resolveAccount(params.account);
  const amount = currencyAmount(params.amount);
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.spent + amount > limits.maxSpendPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'spend', used: totals.spent, amount: amount, max: limits.maxSpendPerRun });
  }
  const before = Ledger.balance(params.account);
  if (before - amount < 0) fail('FLOW_INSUFFICIENT', { account: params.account, balance: before, amount: amount });
  const st = acct.st;
  const dom = acct.dom;
  const desc = descOf(params, '动作流扣除 ' + params.account);
  const r = Ledger.post({
    op: 'spend', account: params.account, delta: -amount, idemKey: idemOf(ctx),
    entry: { st: st, amt: -amount, desc: desc, src: 'flow-currency-spend', dom: dom, flowRunId: ctx.runId || '', stepId: ctx.stepId || '' },
    reason: { src: 'flow-currency-spend', desc: desc, dom: dom },
  });
  totals.spent += amount;
  return { ok: true, spent: amount, entryId: (r && r.entryId) || null };
}

// ===== C. asset.grant =====
function assetGrant(ctx, params) {
  const assetId = params.assetId;
  const def = findAsset(assetId);
  ensureAssetUsable(def);
  const amount = assetAmount(params.amount);
  // 迁移专用 cap：复刻周期活动「按上限静默裁剪、到顶本次发放 0 但步骤成功」
  const hasCap = params.cap !== undefined && params.cap !== null && String(params.cap).trim() !== '';
  const cap = hasCap ? Math.round(Number(params.cap)) : null;
  if (hasCap && (!isFinite(cap) || cap < 1)) fail('FLOW_BAD_PARAMS', { field: 'cap' });
  // 单步上限 = min(10, 资产周期上限)；带 cap 时不再受资产周期上限压缩（与活动一致）
  const periodMax = (def.maxIssuedPerPeriod === null || def.maxIssuedPerPeriod === undefined) ? null : Number(def.maxIssuedPerPeriod);
  const stepMax = hasCap ? FLOW_ATOM_MAX_ASSET : Math.min(FLOW_ATOM_MAX_ASSET, periodMax === null ? FLOW_ATOM_MAX_ASSET : periodMax);
  if (amount > stepMax) fail('FLOW_AMOUNT_LIMIT', { assetId: assetId, amount: amount, max: stepMax });
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.assetGranted + amount > limits.maxAssetGrantPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'assetGrant', used: totals.assetGranted, amount: amount, max: limits.maxAssetGrantPerRun });
  }
  const pk = assetPeriodKey(def, ctx.ts);
  const meter = assetMeter(assetId, pk);
  if (!hasCap && periodMax !== null && meter.issued + amount > periodMax) {
    fail('FLOW_ASSET_PERIOD_CAP', { assetId: assetId, periodKey: pk, issued: meter.issued, amount: amount, max: periodMax });
  }
  const desc = descOf(params, '动作流发放 ' + assetId);
  const assetFrom = '动作流「' + (ctx.flowName || '未命名') + '」';
  const plan = hasCap
    ? assetGrantCore({
      mode: 'activity', assetId: assetId, amount: amount, cap: cap,
      entry: granted => ({
        st: 'card', amt: granted, desc: desc, src: 'flow-asset-grant', dom: '',
        card: assetId, flowRunId: ctx.runId || '', stepId: ctx.stepId || '', granted: granted,
      }),
      reason: { src: 'flow-asset-grant', desc: desc, assetCat: 'issue', assetFrom: assetFrom },
    })
    : assetGrantCore({
      mode: 'flow', assetId: assetId, amount: amount, maxBalance: def.maxBalance,
      entry: granted => ({
        st: 'card', amt: granted, desc: desc, src: 'flow-asset-grant', dom: '',
        card: assetId, flowRunId: ctx.runId || '', stepId: ctx.stepId || '', granted: granted,
      }),
      reason: { src: 'flow-asset-grant', desc: desc, assetCat: 'issue', assetFrom: assetFrom },
    });
  if (!plan.ok) {
    if (hasCap && plan.code === 'CARD_AT_CAP') {
      // 已达上限：不写流水、不计计量，步骤仍成功
      return { ok: true, granted: 0, amount: 0, skipped: true, entryId: null };
    }
    if (plan.code === 'FLOW_ASSET_CAP') {
      fail('FLOW_ASSET_CAP', { assetId: assetId, before: plan.before, amount: amount, maxBalance: def.maxBalance });
    }
    return fail(plan.code || 'FLOW_BAD_PARAMS', { assetId: assetId });
  }
  totals.assetGranted += plan.granted;
  return { ok: true, granted: plan.granted, amount: plan.granted, entryId: plan.entryId || null };
}

// ===== D. asset.spend =====
function assetSpend(ctx, params) {
  const assetId = params.assetId;
  const def = findAsset(assetId);
  ensureAssetUsable(def);
  const amount = assetAmount(params.amount);
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.assetSpent + amount > limits.maxAssetSpendPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'assetSpend', used: totals.assetSpent, amount: amount, max: limits.maxAssetSpendPerRun });
  }
  const before = Ledger.balance('card:' + assetId);
  if (before - amount < 0) fail('FLOW_INSUFFICIENT', { assetId: assetId, balance: before, amount: amount });
  const desc = descOf(params, '动作流消耗 ' + assetId);
  // 去向：资产使用配方（use: 前缀）消耗时能确定被豁免的任务
  let assetTo = '';
  const useFlow = String((ctx.flow && ctx.flow.id) || '').indexOf('use:') === 0;
  const useTaskId = useFlow && ctx.inputs ? ctx.inputs.taskId : '';
  if (useTaskId) {
    const useTask = (state.tasks || []).find(function (x) { return x && x.id === useTaskId; });
    assetTo = '豁免任务「' + ((useTask && useTask.name) || useTaskId) + '」';
  }
  const r = Ledger.post({
    op: 'spend', account: 'card:' + assetId, delta: -amount, idemKey: idemOf(ctx),
    entry: {
      st: 'card', amt: -amount, desc: desc, src: 'flow-asset-spend', dom: '',
      card: assetId, flowRunId: ctx.runId || '', stepId: ctx.stepId || '', spent: amount,
    },
    reason: { src: 'flow-asset-spend', desc: desc, assetCat: 'spend', assetFrom: '动作流「' + (ctx.flowName || '未命名') + '」', assetTo: assetTo },
  });
  totals.assetSpent += amount;
  return { ok: true, spent: amount, entryId: (r && r.entryId) || null };
}

// ===== E. entity.archiveIdle =====
// 归档前活跃集合：journal 需要记录“到底归档了谁”，整单撤销据此还原
function entityListOf(kind) {
  if (kind === 'affair') return state.affairs || [];
  if (kind === 'chore') return state.chores || [];
  return state.tasks || [];
}
function activeIdsOf(kind) {
  return entityListOf(kind).filter(function (e) { return e && e.id && !e.archived; }).map(function (e) { return e.id; });
}

function archiveIdle(ctx, params) {
  const kind = params.kind;
  if (kind !== 'task' && kind !== 'affair' && kind !== 'chore') fail('FLOW_INVALID_ENTITY', { kind: kind });
  const days = Number(params.idleDays);
  if (!isFinite(days) || !Number.isInteger(days) || days < 1) fail('FLOW_INVALID_AMOUNT', { idleDays: params.idleDays });
  if (days > FLOW_ATOM_IDLE_DAYS_MAX) fail('FLOW_AMOUNT_LIMIT', { idleDays: days, max: FLOW_ATOM_IDLE_DAYS_MAX });
  const ts = (ctx.ts === undefined || ctx.ts === null) ? Date.now() : (Number(ctx.ts) || 0);
  const label = descOf(params, ctx.flowName || '动作流');
  // 先只读预演：命中过多时整步失败，避免一次写爆日志上限
  const n = archiveIdleEntities(kind, days, ts, label, true);
  if (n > FLOW_ATOM_MAX_ARCHIVE) fail('FLOW_ARCHIVE_TOO_MANY', { count: n, max: FLOW_ATOM_MAX_ARCHIVE });
  const beforeIds = activeIdsOf(kind);
  const done = n > 0 ? archiveIdleEntities(kind, days, ts, label, false) : 0;
  const ids = beforeIds.filter(function (id) {
    const e = entityListOf(kind).find(function (x) { return x && x.id === id; });
    return !!e && !!e.archived;
  });
  return { ok: true, count: done, archived: done, ids: ids };
}

// ===== F. entity.create =====
// 按模板创建任务 / 项目 / 杂事（一次调用只创建一类）。
// 只开放模板所需的最小字段；项目不带步骤，杂事不带进度，避免造出复杂形态。
// 先完整校验再写入；任一校验失败整步抛错，由事务统一回滚。
function entityCreate(ctx, params) {
  const kind = params.kind;
  if (kind !== 'task' && kind !== 'affair' && kind !== 'chore') fail('FLOW_INVALID_ENTITY', { kind: kind });
  const name = String(params.name === undefined || params.name === null ? '' : params.name).trim();
  if (!name) fail('FLOW_BAD_PARAMS', { field: 'name' });
  if (name.length > FLOW_ATOM_CREATE_NAME_MAX) {
    fail('FLOW_NAME_TOO_LONG', { length: name.length, max: FLOW_ATOM_CREATE_NAME_MAX });
  }
  let count = 1;
  if (params.count !== undefined && params.count !== null && String(params.count).trim() !== '') {
    count = Number(params.count);
  }
  if (!Number.isInteger(count) || count < 1 || count > FLOW_ATOM_MAX_CREATE) {
    fail('FLOW_CREATE_LIMIT', { count: params.count, max: FLOW_ATOM_MAX_CREATE });
  }
  let amount = 0;
  const hasAmount = params.amount !== undefined && params.amount !== null && String(params.amount).trim() !== '';
  if (kind === 'chore' && hasAmount) fail('FLOW_BAD_PARAMS', { field: 'amount' });
  if (kind !== 'chore' && hasAmount) {
    amount = Number(params.amount);
    if (!isFinite(amount) || amount < 0) fail('FLOW_INVALID_AMOUNT', { amount: params.amount });
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) fail('FLOW_INVALID_AMOUNT', { amount: params.amount });
    amount = Math.round(amount * 100) / 100;
    if (amount > FLOW_ATOM_MAX_CURRENCY) fail('FLOW_AMOUNT_LIMIT', { amount: amount, max: FLOW_ATOM_MAX_CURRENCY });
    if (kind === 'affair' && amount <= 0) fail('FLOW_INVALID_AMOUNT', { amount: params.amount });
  }
  let domainId = '';
  if (kind !== 'chore') {
    domainId = String(params.domainId === undefined || params.domainId === null ? '' : params.domainId).trim();
    if (!domainId) fail('FLOW_BAD_PARAMS', { field: 'domainId' });
    if (!(state.domains || []).some(d => d && d.id === domainId)) {
      fail('FLOW_INVALID_ACCOUNT', { domainId: domainId });
    }
  } else if (params.domainId !== undefined && String(params.domainId).trim() !== '') {
    fail('FLOW_BAD_PARAMS', { field: 'domainId' });
  }
  // 情境标签只允许出现在杂事上；编译期已拦，这里保留运行时兜底。
  let tags = [];
  if (params.tags !== undefined && params.tags !== null) {
    if (kind !== 'chore') fail('FLOW_BAD_PARAMS', { field: 'tags' });
    tags = normalizeChoreTags(params.tags);
  }
  const list = createEntitiesFromTemplate(kind, { name: name, count: count, domainId: domainId, amount: amount, tags: tags }, ctx.ts);
  const kindName = kindLabel(kind);
  list.forEach(function (e) {
    Ledger.event('按模板创建' + kindName + '「' + e.name + '」', 'entity-create', {
      kind: e.kind, entityId: e.id, flowRunId: ctx.runId || '', stepId: ctx.stepId || '',
    });
  });
  return {
    ok: true, kind: kind, count: list.length,
    ids: list.map(function (e) { return e.id; }), names: list.map(function (e) { return e.name; }),
  };
}

// ===== G. log.note =====
function logNote(ctx, params) {
  const desc = params.desc === undefined || params.desc === null ? '' : String(params.desc).trim();
  if (!desc) fail('FLOW_BAD_PARAMS', { field: 'desc' });
  if (desc.length > FLOW_ATOM_NOTE_MAX_LEN) fail('FLOW_NOTE_TOO_LONG', { length: desc.length, max: FLOW_ATOM_NOTE_MAX_LEN });
  const totals = totalsOf(ctx);
  if (totals.notes + 1 > FLOW_ATOM_MAX_NOTES) fail('FLOW_NOTE_LIMIT', { used: totals.notes, max: FLOW_ATOM_MAX_NOTES });
  const entry = Ledger.event(desc, 'flow-note', { flowRunId: ctx.runId || '', stepId: ctx.stepId || '' });
  totals.notes += 1;
  return { ok: true, entryId: (entry && entry.id) || null };
}

// ===== G. engine.recheckAchievements =====
function recheckAchievements(ctx, params) {
  const totals = totalsOf(ctx);
  if (totals.recheck > 0) fail('FLOW_REACHECK_DUPLICATE', {});
  const ids = checkAchievements(undefined, { silent: !!(ctx.silent || ctx.dryRun) });
  totals.recheck += 1;
  return { ok: true, count: ids.length, entryIds: ids };
}

// ===== H. task.exempt =====
// 任务豁免：只登记任务字段与可见流水，不扣卡；扣卡由同一运行里的 asset.spend 完成。
// 这样“消耗什么资产”由资产使用配方声明，豁免本身不再绑死某个活动配置。
function taskExempt(ctx, params) {
  const taskId = params.taskId;
  if (typeof taskId !== 'string' || !taskId) fail('FLOW_BAD_PARAMS', { field: 'taskId' });
  const ts = (ctx.ts === undefined || ctx.ts === null) ? Date.now() : (Number(ctx.ts) || 0);
  const label = descOf(params, ctx.flowName || '动作流豁免');
  const r = exemptTaskCore(taskId, {
    ts: ts, processDebts: false, src: 'flow-task-exempt', desc: label,
  });
  if (!r.ok) fail(r.code || 'FLOW_TASK_EXEMPT', { taskId: taskId, reason: r.reason });
  return {
    ok: true, taskId: taskId, entryId: r.entryId, wasBroken: r.wasBroken,
    prevLastExempt: r.prevLastExempt, prevPendingDebt: r.prevPendingDebt,
    prevLastDebtDate: r.prevLastDebtDate,
  };
}

const FLOW_ATOMS = {
  'currency.grant': {
    id: 'currency.grant', name: '发放数值',
    params: ['account', 'amount', 'desc', 'taskId', 'split'], run: currencyGrant,
    describe: (p, L) => (p.split === 'allDomains'
      ? '向全部领域均分发放 ' + p.amount
      : '向「' + L.account(p.account) + '」发放 ' + p.amount) +
      (p.taskId ? '（关联任务「' + L.task(p.taskId) + '」）' : ''),
  },
  'currency.spend': {
    id: 'currency.spend', name: '扣除数值',
    params: ['account', 'amount', 'desc'], run: currencySpend,
    describe: (p, L) => '从「' + L.account(p.account) + '」扣除 ' + p.amount,
  },
  'asset.grant': {
    id: 'asset.grant', name: '发放资产',
    params: ['assetId', 'amount', 'desc', 'cap'], run: assetGrant,
    describe: (p, L) => '发放资产「' + L.asset(p.assetId) + '」×' + p.amount +
      (p.cap !== undefined && p.cap !== null && p.cap !== '' ? '（单次上限 ' + p.cap + '）' : ''),
  },
  'asset.spend': {
    id: 'asset.spend', name: '消耗资产',
    params: ['assetId', 'amount', 'desc'], run: assetSpend,
    describe: (p, L) => '消耗资产「' + L.asset(p.assetId) + '」×' + p.amount,
  },
  'entity.archiveIdle': {
    id: 'entity.archiveIdle', name: '归档闲置事项',
    params: ['kind', 'idleDays', 'desc'], run: archiveIdle,
    describe: p => '归档 ' + p.idleDays + ' 天未活跃的' + kindLabel(p.kind),
  },
  'entity.create': {
    id: 'entity.create', name: '创建事项',
    params: ['kind', 'name', 'domainId', 'amount', 'count', 'tags'], run: entityCreate,
    describe: p => '创建 ' + (Number(p.count) > 1 ? Number(p.count) + ' 个' : '') +
      kindLabel(p.kind) + '「' + (p.name || '') + '」',
  },
  'log.note': {
    id: 'log.note', name: '写入记录',
    params: ['desc'], run: logNote,
    describe: p => '写入记录：' + (p.desc || ''),
  },
  'engine.recheckAchievements': {
    id: 'engine.recheckAchievements', name: '复核成就',
    params: [], run: recheckAchievements,
    describe: () => '复核成就解锁',
  },
  'task.exempt': {
    id: 'task.exempt', name: '豁免任务',
    params: ['taskId', 'desc'], run: taskExempt,
    describe: (p, L) => (typeof p.taskId === 'string' && p.taskId
      ? '豁免任务「' + L.task(p.taskId) + '」'
      : '豁免任务（运行时指定任务）'),
  },
};
const FLOW_ATOM_IDS = Object.keys(FLOW_ATOMS);
// 可供用户在下拉里新增的原子：task.exempt 的 taskId 只能由资产使用配方在运行时注入，
// 手动选择必然因参数缺失而 FLOW_BAD_PARAMS。注册与实现保留，用于旧配置和配方。
const FLOW_ATOM_SELECTABLE_IDS = FLOW_ATOM_IDS.filter(function (id) { return id !== 'task.exempt'; });

// 原子统一入口：事务断言 → 原子白名单 → 参数白名单 → 步骤数上限 → 执行
function runFlowAtom(atomId, params, ctx) {
  if (!Ledger.inTxn()) fail('FLOW_NO_TXN', { atom: atomId });
  const atom = FLOW_ATOMS[atomId];
  if (!atom) fail('FLOW_UNKNOWN_ATOM', { atom: atomId });
  const p = checkParams(atomId, params, atom.params);
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const totals = totalsOf(c);
  const limits = limitsOf(c);
  if (totals.steps >= limits.maxSteps) fail('FLOW_STEP_LIMIT', { steps: totals.steps, max: limits.maxSteps });
  const result = atom.run(c, p);
  totals.steps += 1;
  return result;
}

// labels：可选的中文标签解析器 { account, asset, task }，由 UI 层按 state 提供；
// 缺省时回退原始键，保证原子层不依赖全局 state。
function describeFlowAtom(atomId, params, labels) {
  const atom = FLOW_ATOMS[atomId];
  return atom ? atom.describe(params || {}, labelsOf(labels)) : '';
}

export { FLOW_ATOMS, FLOW_ATOM_IDS, FLOW_ATOM_SELECTABLE_IDS, runFlowAtom, describeFlowAtom, assetPeriodKeyOf };
