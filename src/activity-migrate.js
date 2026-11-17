// 阶段 5 第一步（第三块）：周期活动 → 动作流迁移
// 只做“计划 → 落配置 → 回滚”，不写流水、不注册 renderer、不改活动执行引擎。
import {
  FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_ASSET, FLOW_ATOM_MAX_ARCHIVE,
  FLOW_ATOM_MAX_CURRENCY, FLOW_MAX_STEPS, FLOW_VERSION, SCHEMA_VERSION,
} from './constants.js';
import { archiveIdleEntities } from './entities.js';
import { normalizeFlow } from './normalize.js';
import { now, periodKey, uid } from './pure.js';
import { state } from './state.js';

const MIGRATION_VERSION = 1;
const MIGRATION_NAME = 'activityToFlow';

function atOf(ts) {
  return Number.isFinite(Number(ts)) ? Number(ts) : now();
}
function flowList() {
  return Array.isArray(state.flows) ? state.flows : [];
}
function activities() {
  return Array.isArray(state.activities) ? state.activities : [];
}
function flowById(id) {
  return flowList().find(f => f && f.id === id) || null;
}
function activityById(id) {
  return activities().find(a => a && a.id === id) || null;
}
function domainExists(id) {
  return (state.domains || []).some(d => d && d.id === id);
}
function domainCount() {
  return (state.domains || []).filter(d => d && d.id).length;
}
function runMap() {
  const ext = state.ext || {};
  return (ext.flowRuns && ext.flowRuns.byId) || {};
}
export function flowHasRuns(flowId) {
  const by = runMap();
  return Object.keys(by).some(function (k) { return by[k] && by[k].flowId === flowId; });
}
function migrationMap() {
  const schema = state.schema || {};
  const m = schema.migrations && schema.migrations[MIGRATION_NAME];
  return (m && m.map && typeof m.map === 'object' && !Array.isArray(m.map)) ? m.map : {};
}
function writeMigrationMap(map, at) {
  if (!state.schema || typeof state.schema !== 'object') state.schema = { v: SCHEMA_VERSION, migratedAt: 0 };
  state.schema.migrations = state.schema.migrations && typeof state.schema.migrations === 'object' && !Array.isArray(state.schema.migrations)
    ? state.schema.migrations : {};
  state.schema.migrations[MIGRATION_NAME] = {
    v: MIGRATION_VERSION,
    at: atOf(at),
    map: map || {},
  };
}
function amountText(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100);
}
function twoDecimalsOk(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

// 单条活动 → 流草稿。无法等价表达时返回 reasons，绝不静默丢弃奖励项。
function buildFlowDraft(act, ts) {
  const at = atOf(ts);
  const reasons = [];
  const warnings = [];
  const steps = [];
  const items = (act && act.result && Array.isArray(act.result.items)) ? act.result.items : [];
  let anyGrant = false;
  let sumGrant = 0;
  let sumAsset = 0;
  let seq = 0;
  function nextId() { seq += 1; return 's' + seq; }
  function label() { return '「' + (act.name || '周期活动') + '」'; }
  function skip(it, why) {
    warnings.push('奖励项 ' + (items.indexOf(it) + 1) + '：' + why + '，已跳过');
  }

  items.forEach(function (it) {
    if (!it) return;
    if (it.type === 'vitality' || it.type === 'progress' || it.type === 'achievement') {
      const amt = Number(it.amount) || 0;
      if (amt <= 0) { skip(it, '金额不大于 0'); return; }
      if (!isFinite(amt) || amt > FLOW_ATOM_MAX_CURRENCY) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：金额 ' + amountText(amt) + ' 超过动作流单步上限 ' + FLOW_ATOM_MAX_CURRENCY);
        return;
      }
      if (!twoDecimalsOk(amt)) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：金额 ' + amountText(amt) + ' 超过两位小数');
        return;
      }
      const params = { amount: amt, desc: label() + '奖励（迁移）' };
      if (it.type === 'vitality') {
        params.account = 'vitality';
        if (it.taskId) params.taskId = String(it.taskId);
      } else if (it.type === 'achievement') {
        params.account = 'achievement';
      } else if (it.domainId) {
        if (!domainExists(it.domainId)) {
          reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：进度领域「' + it.domainId + '」不存在');
          return;
        }
        params.account = 'progress:' + it.domainId;
      } else {
        if (!domainCount()) {
          reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：未指定领域，但当前没有可分摊的领域');
          return;
        }
        params.account = 'progress';
        params.split = 'allDomains';
      }
      steps.push({ id: nextId(), atom: 'currency.grant', params: params });
      anyGrant = true;
      sumGrant += amt;
      return;
    }
    if (it.type === 'card') {
      const amt = Math.max(0, Math.round(Number(it.amount) || 0));
      if (amt <= 0) { skip(it, '数量不大于 0'); return; }
      if (amt > FLOW_ATOM_MAX_ASSET) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：资产数量 ' + amt + ' 超过动作流单步上限 ' + FLOW_ATOM_MAX_ASSET);
        return;
      }
      const def = (state.assetDefs || []).find(d => d && d.id === it.card);
      if (!def) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：资产「' + it.card + '」不存在');
        return;
      }
      if (def.enabled === false) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：资产「' + (def.name || def.id) + '」已停用');
        return;
      }
      if (def.archived) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：资产「' + (def.name || def.id) + '」已归档');
        return;
      }
      const cap = Math.max(1, Math.round(Number(it.cap) || 1));
      if (def.maxBalance !== undefined && def.maxBalance !== null && cap > Number(def.maxBalance)) {
        warnings.push('奖励项 ' + (items.indexOf(it) + 1) + '：活动上限 ' + cap + ' 大于资产余额上限 ' + def.maxBalance + '，迁移后按活动上限裁剪');
      }
      steps.push({
        id: nextId(), atom: 'asset.grant',
        params: { assetId: it.card, amount: amt, cap: cap, desc: label() + '发放资产（迁移）' },
      });
      sumAsset += amt;
      return;
    }
    if (it.type === 'archive') {
      const days = Math.max(1, Math.round(Number(it.idleDays) || 1));
      if (days > FLOW_ATOM_IDLE_DAYS_MAX) {
        reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：不活跃天数 ' + days + ' 超过动作流上限 ' + FLOW_ATOM_IDLE_DAYS_MAX);
        return;
      }
      const kind = (it.entity === 'affair' || it.entity === 'chore') ? it.entity : 'task';
      const hits = archiveIdleEntities(kind, days, at, act.name || '周期活动', true);
      if (hits > FLOW_ATOM_MAX_ARCHIVE) {
        warnings.push('奖励项 ' + (items.indexOf(it) + 1) + '：当前命中 ' + hits + ' 个，超过单次归档上限 ' + FLOW_ATOM_MAX_ARCHIVE + '，运行会失败');
      }
      steps.push({
        id: nextId(), atom: 'entity.archiveIdle',
        params: { kind: kind, idleDays: days, desc: label() + '归档不活跃实体（迁移）' },
      });
      return;
    }
    reasons.push('奖励项 ' + (items.indexOf(it) + 1) + '：类型「' + (it.type || '未知') + '」不支持迁移');
  });

  if (anyGrant) steps.push({ id: nextId(), atom: 'engine.recheckAchievements', params: {} });
  if (!steps.length) reasons.push('没有可执行的有效动作');
  if (steps.length > FLOW_MAX_STEPS) reasons.push('步骤数 ' + steps.length + ' 超过动作流上限 ' + FLOW_MAX_STEPS);
  if (sumGrant > FLOW_ATOM_MAX_CURRENCY) reasons.push('单次运行货币发放合计 ' + amountText(sumGrant) + ' 超过上限 ' + FLOW_ATOM_MAX_CURRENCY);
  if (sumAsset > FLOW_ATOM_MAX_ARCHIVE) reasons.push('单次运行资产发放合计 ' + sumAsset + ' 超过上限 ' + FLOW_ATOM_MAX_ARCHIVE);

  if (reasons.length) return { ok: false, reasons: reasons, warnings: warnings };

  const flow = normalizeFlow({
    v: FLOW_VERSION,
    id: uid(),
    name: act.name,
    enabled: false,
    trigger: { type: 'period', period: act.period || 'week', anchor: act.anchor || 1 },
    condition: act.condition,
    settleWhenConditionFalse: false,
    editorMode: 'simple',
    migratedFromActivity: act.id,
    limits: {
      maxSteps: Math.max(1, Math.min(FLOW_MAX_STEPS, steps.length)),
      maxRunsPerPeriod: 1,
      maxGrantPerRun: Math.min(FLOW_ATOM_MAX_CURRENCY, Math.max(20, Math.ceil(sumGrant))),
      maxSpendPerRun: 0,
      maxAssetGrantPerRun: Math.min(FLOW_ATOM_MAX_ARCHIVE, Math.max(3, sumAsset)),
      maxAssetSpendPerRun: 0,
    },
    steps: steps,
    lastRun: null,
  });
  // 旧活动本周期已经结算过：迁移后不能再结算一次
  const pk = periodKey(flow.trigger, at);
  if (act.lastRun && act.lastRun === pk) flow.lastRun = flow.id + '@' + act.lastRun;
  return { ok: true, flow: flow, warnings: warnings };
}

export function buildMigrationPlan(ts) {
  const at = atOf(ts);
  const plan = { at: at, candidates: [], blocked: [], migrated: [] };
  const map = migrationMap();
  activities().forEach(function (act) {
    if (!act || !act.id) return;
    // 已迁移且流仍在：只展示，不重复生成
    if (act.migratedToFlowId) {
      const existing = flowById(act.migratedToFlowId) || (map[act.id] ? flowById(map[act.id]) : null);
      if (existing) {
        plan.migrated.push({ activity: act, flow: existing });
        return;
      }
      // 指向已删除的流：视为未迁移，允许重新迁移
    }
    const built = buildFlowDraft(act, at);
    if (!built.ok) {
      plan.blocked.push({ activity: act, id: act.id, name: act.name, reasons: built.reasons, warnings: built.warnings });
    } else {
      plan.candidates.push({ activity: act, flow: built.flow, warnings: built.warnings });
    }
  });
  return plan;
}

// 落盘：只改配置；旧活动停用保留，绝不删除
export function applyMigration(ts) {
  const at = atOf(ts);
  const plan = buildMigrationPlan(at);
  if (!plan.candidates.length) {
    return { ok: true, created: 0, blocked: plan.blocked, migrated: plan.migrated };
  }
  const map = migrationMap();
  if (!Array.isArray(state.flows)) state.flows = [];
  const created = [];
  plan.candidates.forEach(function (c) {
    const flow = c.flow;
    while (flowList().some(f => f && f.id === flow.id)) flow.id = uid();
    // id 可能在去重时变化，重新计算 lastRun 前缀
    const pk = periodKey(flow.trigger, at);
    if (c.activity.lastRun && c.activity.lastRun === pk) flow.lastRun = flow.id + '@' + c.activity.lastRun;
    state.flows.push(flow);
    c.activity.migratedWasEnabled = c.activity.enabled !== false;
    c.activity.enabled = false;
    c.activity.migratedToFlowId = flow.id;
    c.activity.migratedAt = at;
    map[c.activity.id] = flow.id;
    created.push({ activityId: c.activity.id, flowId: flow.id, name: c.activity.name });
  });
  writeMigrationMap(map, at);
  return { ok: true, created: created.length, blocked: plan.blocked, migrated: plan.migrated, flows: created };
}

// 回滚：无运行记录的生成流删除并恢复活动；有运行记录的保留，避免抹掉历史
export function undoMigration(ts) {
  const at = atOf(ts);
  const map = migrationMap();
  const restored = [];
  const kept = [];
  Object.keys(map).forEach(function (actId) {
    const flow = flowById(map[actId]);
    const act = activityById(actId);
    if (!flow) {
      if (act) {
        act.migratedToFlowId = '';
        delete act.migratedAt;
        delete act.migratedWasEnabled;
      }
      delete map[actId];
      return;
    }
    if (flowHasRuns(flow.id)) {
      kept.push({ activityId: actId, name: act && act.name, flowId: flow.id });
      return;
    }
    state.flows = flowList().filter(f => f && f.id !== flow.id);
    if (act) {
      // 回到迁移前的启停状态，避免撤销时擅自启用用户原本停用的活动
      act.enabled = act.migratedWasEnabled !== false;
      act.migratedToFlowId = '';
      delete act.migratedAt;
      delete act.migratedWasEnabled;
      act.lastRun = periodKey(act, at);
    }
    delete map[actId];
    restored.push({ activityId: actId, name: act && act.name });
  });
  writeMigrationMap(map, at);
  return { ok: true, restored: restored.length, kept: kept, restoredList: restored };
}

// 单条恢复：仅当生成的流没有运行记录
export function restoreActivity(activityId, ts) {
  const at = atOf(ts);
  const act = activityById(activityId);
  if (!act) return { ok: false, code: 'ACTIVITY_NOT_FOUND' };
  const flow = act.migratedToFlowId ? flowById(act.migratedToFlowId) : null;
  if (flow && flowHasRuns(flow.id)) return { ok: false, code: 'FLOW_HAS_RUNS', flowId: flow.id };
  if (flow) state.flows = flowList().filter(f => f && f.id !== flow.id);
  act.enabled = act.migratedWasEnabled !== false;
  act.migratedToFlowId = '';
  delete act.migratedAt;
  delete act.migratedWasEnabled;
  // 同步到当前周期，避免恢复后立刻补发一次
  act.lastRun = periodKey(act, at);
  const map = migrationMap();
  delete map[activityId];
  writeMigrationMap(map, at);
  return { ok: true, activityId: activityId, flowId: flow ? flow.id : '' };
}

// 删除迁移生成的流：有运行记录时拒绝；旧活动保持停用，可重新迁移
export function deleteMigratedFlow(flowId, ts) {
  const flow = flowById(flowId);
  if (!flow) return { ok: false, code: 'FLOW_NOT_FOUND' };
  if (!flow.migratedFromActivity) return { ok: false, code: 'FLOW_NOT_MIGRATED' };
  if (flowHasRuns(flow.id)) return { ok: false, code: 'FLOW_HAS_RUNS' };
  state.flows = flowList().filter(f => f && f.id !== flow.id);
  const act = activityById(flow.migratedFromActivity);
  if (act && act.migratedToFlowId === flow.id) {
    act.migratedToFlowId = '';
    delete act.migratedAt;
    delete act.migratedWasEnabled;
    act.enabled = false;
  }
  const map = migrationMap();
  if (map[flow.migratedFromActivity] === flow.id) delete map[flow.migratedFromActivity];
  writeMigrationMap(map, atOf(ts));
  return { ok: true, activityId: flow.migratedFromActivity };
}

export { buildFlowDraft };
