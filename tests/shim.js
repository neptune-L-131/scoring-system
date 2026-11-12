// 统一的“加载入口”垫片。
//
// 测试只通过 api.* 访问被测逻辑，不关心代码放在哪个文件、怎么被加载。
// 第五轮阶段 1 先在单文件 app.js 上建立基线，阶段 2 拆分后切换到 src/ 模块导出，
// 测试文件本身不需要改动。
//
// 约定（拆分时遵守）：纯逻辑模块被 import 时不得触碰 DOM；
// 所有顶层副作用收敛到启动入口 main.js。垫片不加载 main.js。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');

// 测试可见的 API 面：拆分前后保持完全一致（名字不变、签名不变）。
// 新增被测函数时只改这里，不改测试文件。合并后会校验一次，缺失则告警。
const EXPORT_NAMES = [
  // 工具 / 日期 / 格式化
  'uid', 'fmt', 'now', 'daysSince', 'effectiveLastTs', 'taskCheckedToday', 'fmtTime',
  'totalProgress', 'domainName', 'taskNameLabel', 'collectionName', 'domainProgress', 'metricValue',
  'getTaskDomainIds', 'taskScoreTypes', 'taskHasType', 'logHasType', 'clone', 'splitCents',
  'round2', 'round4', 'logAmt', 'cardName', 'stageRewards', 'taskIsStaged', 'stageValues',
  'stageSel', 'stageValueAt', 'stageCellLabel', 'stageNetAt',
  'dayKey', 'weekStartKey', 'weekStartTs', 'periodKey', 'budgetBounds', 'dayStartTs',
  'prevPeriodRange', 'condWindowByRange', 'idleDaysSince', 'weekAnchorName',
  // 统一时间源（time.js）
  'dayStart', 'dayKeyOf', 'dayIndex', 'dayDiff', 'addDays', 'todayKey', 'isToday',
  'weekStart', 'weekKey', 'periodKeyOf', 'rangeOf', 'keyOffset', 'relativeDay',
  'businessDayKey', '__setClockForTest', '__clockRollbacks',
  // 只读实体聚合层（entity-kit.js）
  'ENTITY_KINDS', 'KIND_LABEL', 'normalizeEntityRef', 'entityRef', 'findEntity',
  'entityName', 'entityDomainIds', 'entityActive', 'entityLastActivity', 'entityMeta',
  'entityHistory', 'todayAgenda',
  // 事项转换（entity-convert.js）
  'CONVERSIONS_MAX', 'lossyFieldsOf', 'choreToAffair', 'affairToChore',
  'conversionUndoState', 'lastConversion', 'canUndoConversion', 'undoConversion',
  // 杂事产出进度（utils.js）
  'choreProgressOf', 'choreProgressParts',
  // 账户差额 / 统计
  'emptyAccountSums', 'accountSumsAdd', 'statsDiffs', 'noteInvisible', 'noteEvicted',
  'shadowLabel', 'shadowPush', 'seedCalibrationShadow', 'accountLabel',
  'statsDailyEnsure', 'statsPrune', 'computeEntryAgg', 'applyAgg', 'attachAgg', 'detachAgg',
  'reaggEntry', 'rebuildStats', 'noteAchievementEarned', 'pruneActivityBucket',
  'noteCheckinActivity', 'activityCountForDomain', 'applyCheckinGain', 'recalcTaskHistory',
  // 预置状态 / 归一化
  'defaultWatermark', 'newExtState', 'defaults', 'salvageJSON', 'toNum', 'toTs', 'asArray',
  'normalizeScores', 'normalizeTaskNums', 'normalizeAchNums', 'normalizeProdNums',
  'normalizeProductGate', 'normalizeProduct', 'dateKeyOffset', 'normalizeActivityIndex',
  'normalizeStatsDaily', 'normalizeAccountSums', 'normalizeAchievementCounted',
  'normalizePresetNums', 'normalizeLoanNums', 'normalizeLogNums', 'normalizeCards',
  'normalizeWatermark', 'normalizeBudgetSettings', 'normalizeBudgetRule',
  'normalizeBudgetCategory', 'normalizeBudgetPeriod', 'normalizeBudgetLedgerEntry',
  'normalizeBudgets', 'normalizeProductBudget', 'normalizeExt', 'applyMigrations', 'parseState',
  'defaultBudgetSettings', 'defaultBudgetsState', 'defaultProductGate', 'tierCurrency',
  'validProductTier', 'isArchivedEntity', 'defaultActivities', 'normalizeCondItem',
  'normalizeCondNode', 'normalizeCondition', 'normalizeRewardItem', 'normalizeResult',
  'normalizeActivity', 'migrateActivities', 'defaultChoreConfig', 'normalizeChoreConfig',
  'migrateChore',
  // 条件求值
  'evalCondition', 'evalNode', 'evalCondItem', 'logDomainsOf', 'logMatchesTarget',
  'taskMatchesTarget', 'domainMatchesTarget', 'eachStatsBucket', 'rangeStats', 'opSatisfied',
  'taskMetricValue', 'domainMetricValue', 'condLeafEntities', 'entityMetricValue',
  'affairActive', 'pointMetricValue', 'sumLogsInWindow', 'countLogsInWindow',
  'logAffairDomain', 'affairWindowValue', 'choreWindowValue', 'evalCountMetric',
  'isPointMetric', 'isAffairMetric', 'isChoreMetric', 'isStage1Metric', 'isGateMetric',
  'legacyGateCondition', 'gateConditionOf', 'gateFailReasons', 'evaluateProductGate',
  // 业务纯函数
  'checkIn', 'useExemption', 'buyProduct',
  'calcCheckIn', 'calcSkip', 'choreCfg', 'choreFreshDays', 'choreBaseTs', 'choreOverdueDays',
  'choreTierRate', 'choreDailyDecay', 'choreUnsettled', 'computeChoreDecay',
  'affairSteps', 'affairTotalSteps', 'affairDoneSteps', 'affairLastAdvance', 'affairCurve',
  'affairCurveType', 'affairTargetAt', 'affairIsDone', 'migrateAffair',
  // 跨域 / 结构操作
  'archiveIdleEntities', 'applyResult', 'processActivities', 'schedulerTick',
  'ensureMetabolismRule', 'processLoans', 'processChoreDecay', 'processDailyTaskDebts',
  'settleChoreBatches', 'checkAchievements', 'runConsistencyChecks',
  // 常量（按值导出）
  'SCHEMA_VERSION', 'LOG_MAX', 'LOG_DISPLAY', 'SHADOW_MAX', 'AUDIT_MAX',
  'BUDGET_LEDGER_MAX', 'BUDGET_PERIOD_KEEP', 'ACTIVITY_MAX_DAYS', 'STATS_VERSION',
  'STATS_KEEP_DAYS', 'STAGE_NAMES', 'BUDGET_RULE_NAMES', 'BUDGET_TARGET_NAMES',
  'PROD_TIERS', 'PROD_TIER_NAMES', 'SHADOW_SRC_NAMES', 'WEEK_ANCHOR_NAMES',
  'AFFAIR_CURVES', 'COND_METRIC_KEYS', 'COND_POINT_METRICS', 'COND_GATE_METRICS',
  // 引擎对象
  'Ledger', 'BudgetEngine', 'UNDO_ADAPTERS', 'RESULT_ACTION_HANDLERS',
];

// 最小 DOM 桩：只保证“加载与纯逻辑调用不抛异常”，不模拟真实渲染。
function makeElement(tag) {
  const el = {
    id: '', tagName: String(tag || 'div').toUpperCase(), nodeType: 1,
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    className: '', style: {}, dataset: {}, children: [], childNodes: [], parentNode: null,
    parentElement: null, rel: '', href: '', src: '', title: '', placeholder: '',
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, offsetWidth: 0,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
      replace() {}, forEach() {},
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    insertBefore(c) { el.children.push(c); return c; },
    append(...nodes) { nodes.forEach(n => el.appendChild(n)); },
    prepend(n) { el.children.unshift(n); },
    replaceChildren() { el.children.length = 0; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {}, focus() {}, blur() {}, click() {}, select() {},
    setAttribute(k, v) { el['__attr_' + k] = String(v); },
    getAttribute(k) { const v = el['__attr_' + k]; return v === undefined ? null : v; },
    hasAttribute(k) { return el['__attr_' + k] !== undefined; },
    removeAttribute(k) { delete el['__attr_' + k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    scrollIntoView() {}, insertAdjacentHTML() {}, contains() { return false; },
    reset() {}, submit() {}, setSelectionRange() {}, setCustomValidity() {},
    matches() { return false; },
  };
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1] || null; } });
  Object.defineProperty(el, 'firstElementChild', { get() { return el.children[0] || null; } });
  Object.defineProperty(el, 'nextSibling', { get() { return null; } });
  return el;
}

function makeSandbox() {
  const elements = new Map();
  const getEl = id => {
    if (!elements.has(id)) {
      const e = makeElement('div');
      e.id = id;
      elements.set(id, e);
    }
    return elements.get(id);
  };
  const docEl = makeElement('html');
  const storage = new Map();
  const localStorage = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    clear() { storage.clear(); },
    key(i) { return Array.from(storage.keys())[i] || null; },
    get length() { return storage.size; },
  };
  const mediaQuery = {
    matches: false, media: '',
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  };
  const document = {
    documentElement: docEl, head: makeElement('head'), body: makeElement('body'),
    hidden: false, visibilityState: 'visible',
    getElementById: getEl,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    getElementsByClassName() { return []; },
    createElement(tag) { return makeElement(tag); },
    createTextNode(t) { return { textContent: String(t), nodeType: 3 }; },
    createDocumentFragment() { return makeElement('fragment'); },
    addEventListener() {}, removeEventListener() {},
    execCommand() { return false; },
  };
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Set, Map,
    WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect, BigInt, Intl, ArrayBuffer, Uint8Array,
    isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    encodeURI, decodeURI, structuredClone,
    document, localStorage,
    navigator: { language: 'zh-CN', userAgent: 'vitest', standalone: false, storage: { persist() { return Promise.resolve(); } } },
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', pathname: '/', search: '', reload() {} },
    matchMedia() { return mediaQuery; },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    alert() {}, confirm() { return true; }, prompt() { return null; },
    Blob: function Blob() {}, URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
    FileReader: function FileReader() {}, fetch() { return Promise.reject(new Error('no-fetch')); },
    customElements: { define() {}, get() { return null; } },
    Event: function Event() {}, MouseEvent: function MouseEvent() {}, KeyboardEvent: function KeyboardEvent() {},
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    scrollTo() {}, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = document;
  sandbox.indexedDB = undefined;
  return { sandbox, getEl, elements };
}

// 纯逻辑模块在 import 时不会碰 DOM（拆分时刻意保证），
// 但少数业务函数在返回前会调用 toast / location.hash 之类的浏览器 API。
// 为了让“纯逻辑测试”仍能跑，这里把最小 DOM 桩装到 globalThis。
function installBrowserGlobals() {
  if (globalThis.__scoreDomInstalled) return;
  const { sandbox } = makeSandbox();
  const names = [
    'document', 'localStorage', 'location', 'matchMedia', 'requestAnimationFrame',
    'cancelAnimationFrame', 'getComputedStyle', 'alert', 'confirm', 'prompt',
    'Blob', 'URL', 'FileReader', 'customElements', 'Event', 'MouseEvent',
    'KeyboardEvent', 'scrollTo', 'addEventListener', 'removeEventListener',
    'dispatchEvent', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'indexedDB',
  ];
  for (const k of names) if (k in sandbox) globalThis[k] = sandbox[k];
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.__scoreDomInstalled = true;
}

async function loadFromModules() {
  // 纯逻辑模块（不含 main.js：入口会跑初始化、碰 DOM）。
  const MODULES = [
    'constants.js', 'time.js', 'pure.js', 'entity-kit.js', 'defaults.js', 'toast.js', 'cond-model.js', 'modal-host.js',
    'state.js', 'theme.js', 'normalize.js', 'persist.js', 'utils.js', 'stats.js',
    'ledger.js', 'gate.js', 'budget.js', 'budget-binding.js', 'conditions.js', 'entities.js', 'business.js',
    'library.js', 'shell.js', 'render-work.js', 'entity-convert.js', 'render-bank.js', 'render-shop.js',
    'render-budget.js', 'cycle.js', 'cond-ui.js', 'ui-events.js', 'undo.js',
    'modals.js', 'data.js', 'pwa.js', 'debug.js', 'startup.js',
  ];
  const api = {};
  const missingFiles = [];
  installBrowserGlobals();
  for (const file of MODULES) {
    const p = path.join(SRC_DIR, file);
    if (!fs.existsSync(p)) { missingFiles.push(file); continue; }
    const mod = await import(/* @vite-ignore */ 'file:///' + p.replace(/\\/g, '/'));
    Object.keys(mod).forEach(k => { api[k] = mod[k]; });
  }
  if (missingFiles.length) console.warn('[shim] 缺失模块：' + missingFiles.join(', '));
  const missingNames = EXPORT_NAMES.filter(n => api[n] === undefined);
  if (missingNames.length) console.warn('[shim] 未导出：' + missingNames.join(', '));
  api.__missing = missingNames;
  const getLiveState = api.getState;
  const setLiveState = api.setState;
  api.getState = () => JSON.parse(JSON.stringify(getLiveState()));
  api.resetState = patch => {
    setLiveState(api.defaults());
    if (patch && typeof patch === 'object') {
      // 深拷贝：避免产品代码写入时反向改写测试里的 fixture 对象
      Object.assign(getLiveState(), JSON.parse(JSON.stringify(patch)));
    }
    return api.getState();
  };
  api.patchState = mutator => { mutator(getLiveState()); return api.getState(); };
  api.getLive = () => getLiveState();
  api.mode = 'esm';
  return api;
}

export const api = await loadFromModules();
