// flow-atoms.js —— 阶段 4 动作原子（S3）
//
// 约束（与设计草案 2.1 / 2.4 一致）：
// 1. 唯一写入口：只调用 Ledger.post / Ledger.event / assetGrantCore，不直接写 state.scores / state.cards；
// 2. 必须已在事务内：入口断言 Ledger.inTxn()，否则抛 FLOW_NO_TXN（不自动开事务）；
// 3. 参数白名单：未知字段直接拒绝，禁止注入 src / visible / entry / reason / idemKey；
// 4. 失败抛 __txn 错误，由 Ledger.txn 统一回滚；原子不吞错、不落盘、不渲染、不弹提示；
// 5. 运行计量（ext.assetMeters）只读；写入由后续执行器统一负责——本文件只负责“读额度 + 拦截”。
import {
  FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_ARCHIVE, FLOW_ATOM_MAX_ASSET,
  FLOW_ATOM_MAX_CURRENCY, FLOW_ATOM_MAX_NOTES, FLOW_ATOM_NOTE_MAX_LEN, FLOW_MAX_STEPS,
} from './constants.js';
import { checkAchievements } from './business.js';
import { archiveIdleEntities, assetGrantCore } from './entities.js';
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
  const acct = resolveAccount(params.account);
  const amount = currencyAmount(params.amount);
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.granted + amount > limits.maxGrantPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'grant', used: totals.granted, amount: amount, max: limits.maxGrantPerRun });
  }
  const st = acct.st;
  const dom = acct.dom;
  const desc = descOf(params, '动作流发放 ' + params.account);
  const r = Ledger.post({
    op: 'grant', account: params.account, delta: amount, idemKey: idemOf(ctx),
    entry: { st: st, amt: amount, desc: desc, src: 'flow-currency-grant', dom: dom, flowRunId: ctx.runId || '', stepId: ctx.stepId || '' },
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
  // 单步上限 = min(10, 资产周期上限)；余额硬顶由 assetGrantCore 严格判定（不裁剪）
  const periodMax = (def.maxIssuedPerPeriod === null || def.maxIssuedPerPeriod === undefined) ? null : Number(def.maxIssuedPerPeriod);
  const stepMax = Math.min(FLOW_ATOM_MAX_ASSET, periodMax === null ? FLOW_ATOM_MAX_ASSET : periodMax);
  if (amount > stepMax) fail('FLOW_AMOUNT_LIMIT', { assetId: assetId, amount: amount, max: stepMax });
  const limits = limitsOf(ctx);
  const totals = totalsOf(ctx);
  if (totals.assetGranted + amount > limits.maxAssetGrantPerRun) {
    fail('FLOW_RUN_LIMIT', { kind: 'assetGrant', used: totals.assetGranted, amount: amount, max: limits.maxAssetGrantPerRun });
  }
  const pk = assetPeriodKey(def, ctx.ts);
  const meter = assetMeter(assetId, pk);
  if (periodMax !== null && meter.issued + amount > periodMax) {
    fail('FLOW_ASSET_PERIOD_CAP', { assetId: assetId, periodKey: pk, issued: meter.issued, amount: amount, max: periodMax });
  }
  const desc = descOf(params, '动作流发放 ' + assetId);
  const plan = assetGrantCore({
    mode: 'flow', assetId: assetId, amount: amount, maxBalance: def.maxBalance,
    entry: granted => ({
      st: 'card', amt: granted, desc: desc, src: 'flow-asset-grant', dom: '',
      card: assetId, flowRunId: ctx.runId || '', stepId: ctx.stepId || '', granted: granted,
    }),
    reason: { src: 'flow-asset-grant', desc: desc },
  });
  if (!plan.ok) {
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
  const r = Ledger.post({
    op: 'spend', account: 'card:' + assetId, delta: -amount, idemKey: idemOf(ctx),
    entry: {
      st: 'card', amt: -amount, desc: desc, src: 'flow-asset-spend', dom: '',
      card: assetId, flowRunId: ctx.runId || '', stepId: ctx.stepId || '', spent: amount,
    },
    reason: { src: 'flow-asset-spend', desc: desc },
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

// ===== F. log.note =====
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

const FLOW_ATOMS = {
  'currency.grant': {
    id: 'currency.grant', params: ['account', 'amount', 'desc'], run: currencyGrant,
    describe: p => '发放 ' + p.amount + ' 到 ' + p.account,
  },
  'currency.spend': {
    id: 'currency.spend', params: ['account', 'amount', 'desc'], run: currencySpend,
    describe: p => '从 ' + p.account + ' 扣除 ' + p.amount,
  },
  'asset.grant': {
    id: 'asset.grant', params: ['assetId', 'amount', 'desc'], run: assetGrant,
    describe: p => '发放资产 ' + p.assetId + ' ×' + p.amount,
  },
  'asset.spend': {
    id: 'asset.spend', params: ['assetId', 'amount', 'desc'], run: assetSpend,
    describe: p => '消耗资产 ' + p.assetId + ' ×' + p.amount,
  },
  'entity.archiveIdle': {
    id: 'entity.archiveIdle', params: ['kind', 'idleDays', 'desc'], run: archiveIdle,
    describe: p => '归档不活跃 ' + p.idleDays + ' 天的 ' + p.kind,
  },
  'log.note': {
    id: 'log.note', params: ['desc'], run: logNote,
    describe: p => '记录：' + (p.desc || ''),
  },
  'engine.recheckAchievements': {
    id: 'engine.recheckAchievements', params: [], run: recheckAchievements,
    describe: () => '复核成就解锁',
  },
};
const FLOW_ATOM_IDS = Object.keys(FLOW_ATOMS);

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

function describeFlowAtom(atomId, params) {
  const atom = FLOW_ATOMS[atomId];
  return atom ? atom.describe(params || {}) : '';
}

export { FLOW_ATOMS, FLOW_ATOM_IDS, runFlowAtom, describeFlowAtom, assetPeriodKeyOf };
