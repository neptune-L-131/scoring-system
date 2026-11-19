// 渲染切片 S3-A 的“渲染无差异”对照工具（不是测试，vitest 不收集）。
// 用法：node tests/tools/dump-render.mjs <输出文件>
// 固定时钟 + 固定 fixture，依次导出代表性面板与卡片的 innerHTML，改动前后各跑一次并 diff。
// 比对方式：JSON 逐字比对（面板 innerHTML 全等），不做 HTML 规范化；若出现差异先打印首个不同位置。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const at = (d, h, m) => new Date(2026, 4, d, h || 0, m || 0, 0, 0).getTime();
api.__setClockForTest(() => at(10, 12));

// 让 shim 里的 esc()/escAttr() 产出真实的转义文本（shim 原实现只存 textContent，innerHTML 为空）
const realCreateElement = globalThis.document.createElement;
globalThis.document.createElement = function (tag) {
  const el = realCreateElement(tag);
  let text = '';
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() { return text; },
    set(v) {
      text = String(v == null ? '' : v);
      el.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return el;
};

api.resetState({
  scores: { vitality: -3.5, progress: { d_default: 42, d2: 12 }, achievement: 120.5 },
  domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '健康 & 运动' }],
  collections: [{ id: 'c_default', name: '默认' }, { id: 'c2', name: '副业' }],
  tasks: [
    {
      id: 't1', name: '写日报<b>', collectionId: 'c_default', domainIds: ['d_default', 'd2'],
      scoreTypes: ['vitality', 'progress'], initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0,
      checkInCount: 7, streak: 3, lastCheckIn: at(10, 9), totalEarned: 30, pendingDebt: 0, archived: false,
    },
    {
      id: 't2', name: '跑步', collectionId: 'c2', domainIds: ['d2'],
      scoreTypes: ['vitality'], initialValue: 12.5, interestRate: 8, debtRate: 15, vitalityCost: 2,
      checkInCount: 4, streak: 0, lastCheckIn: at(8, 9), totalEarned: 18, pendingDebt: 1.5, archived: false,
    },
    {
      id: 't3', name: '季度复盘', collectionId: 'c2', domainIds: ['d_default'],
      scoreTypes: ['progress'], initialValue: 8, interestRate: 5, debtRate: 10, vitalityCost: 0,
      checkInCount: 2, streak: 2, lastCheckIn: at(9, 8), totalEarned: 9, pendingDebt: 0, archived: false,
      stageRewards: { enabled: true, last: 6, v: [0, 0, 0, 0, 0], p: [2, 4, 6, 8, 10] },
    },
    {
      id: 't4', name: '旧任务 & 归档', collectionId: 'c_default', domainIds: ['d_default'],
      scoreTypes: ['vitality', 'progress'], initialValue: 6, interestRate: 4, debtRate: 8, vitalityCost: 0,
      checkInCount: 2, streak: 0, lastCheckIn: at(1, 9), totalEarned: 4, pendingDebt: 0,
      archived: true, archivedAt: at(3, 9),
    },
    {
      id: 't5', name: '无集合任务', collectionId: 'ghost', domainIds: ['d_default'],
      scoreTypes: ['vitality'], initialValue: 5, interestRate: 6, debtRate: 10, vitalityCost: 0,
      checkInCount: 0, streak: 0, lastCheckIn: null, totalEarned: 0, pendingDebt: 0, archived: false,
    },
  ],
  affairs: [
    {
      id: 'a1', name: '学做菜', totalReward: 5, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      currentCell: 0, alreadyGiven: 0, domainId: 'd2', plannedAt: null, steps: [],
      ach: { enabled: false, amount: 0 }, createdAt: at(2, 9), startedAt: null, doneAt: null, archived: false,
    },
    {
      id: 'a2', name: '装修 <新房>', totalReward: 10, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      currentCell: 3, alreadyGiven: 1.5, domainId: null,
      plannedAt: at(10, 14),
      steps: [{ text: '量尺寸', doneAt: at(1, 9) }, { text: '下单', plannedAt: at(10, 10) }, { text: '验收', plannedAt: null }],
      ach: { enabled: true, amount: 2 }, createdAt: at(1, 9), startedAt: at(1, 9), doneAt: null, archived: false,
    },
    {
      id: 'a3', name: '体检', totalReward: 4, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      currentCell: 0, alreadyGiven: 0, domainId: 'd_default', plannedAt: at(10, 16), steps: [],
      ach: { enabled: false, amount: 0 }, createdAt: at(2, 9), startedAt: null, doneAt: null, archived: false,
    },
    {
      id: 'a4', name: '已完成项目', totalReward: 6, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      currentCell: 9, alreadyGiven: 6, domainId: 'd2', plannedAt: null, steps: [],
      ach: { enabled: true, amount: 1 }, createdAt: at(1, 9), startedAt: at(2, 9), doneAt: at(9, 9), archived: false,
    },
    {
      id: 'a5', name: '归档项目', totalReward: 3, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
      currentCell: 0, alreadyGiven: 0, domainId: null, plannedAt: null, steps: [],
      ach: { enabled: false, amount: 0 }, createdAt: at(1, 9), startedAt: null, doneAt: null,
      archived: true, archivedAt: at(4, 9),
    },
  ],
  affairPresets: [{
    id: 'ap1', name: '常规项目', totalReward: 8, curve: { type: 'even', values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
    ach: { enabled: true, amount: 1 },
  }],
  chores: [
    { id: 'c1', name: '交水费', createdAt: at(1, 9), plannedAt: at(6, 9), done: false, doneAt: null, archived: false, freshDays: 3, settled: false, decayKey: null },
    { id: 'c2', name: '洗车', createdAt: at(1, 9), plannedAt: at(10, 8), done: true, doneAt: at(10, 9), archived: false, freshDays: 5, settled: false, decayKey: null },
    { id: 'c3', name: '归档杂事', createdAt: at(1, 9), plannedAt: null, done: true, doneAt: at(2, 9), archived: true, archivedAt: at(3, 9), freshDays: 5, settled: false, decayKey: null },
    { id: 'c4', name: '浇花', createdAt: at(2, 9), plannedAt: null, done: false, doneAt: null, archived: false, freshDays: 5, settled: false, decayKey: null },
  ],
  achievements: [
    { id: 'ach1', name: '跑满 100 公里', domainId: 'd_default', threshold: 100, points: 5, unlocked: false, unlockedAt: null },
    { id: 'ach2', name: '连续早起', domainId: 'd2', threshold: 20, points: 3, unlocked: true, unlockedAt: at(5, 9) },
  ],
  loans: [{ amount: 30, currency: 'vitality', debtRate: 2, productName: '课程', date: at(2, 9) }],
  logs: [
    { id: 'l1', time: at(10, 11), st: 'both', amt: 5, amtV: 2, amtP: 3, desc: '打卡「写日报」', src: 'checkin', dom: 'd_default', taskId: 't1' },
    { id: 'l2', time: at(10, 10), st: 'vitality', amt: 12, desc: '打卡「跑步」', src: 'checkin', dom: 'd2', taskId: 't2' },
    { id: 'l3', time: at(10, 9), st: 'achievement', amt: -3, desc: '购买「咖啡」', src: 'purchase', prodId: 'p1' },
    { id: 'l4', time: at(10, 8), st: 'card', amt: 1, desc: '获得豁免卡', src: 'card-grant' },
    { id: 'l5', time: at(10, 7), st: '', amt: 0, desc: '新增杂事「交水费」', src: 'chore-create', choreId: 'c1' },
    { id: 'l6', time: at(9, 9), st: 'progress', amt: 4, desc: '项目「装修」进度结算', src: 'affair', affairId: 'a2', dom: 'd_default' },
    { id: 'l7', time: at(10, 6), st: 'vitality', amt: -5, desc: '购买「咖啡」', src: 'purchase', prodId: 'p1' },
  ],
  metrics: [{ id: 'm1', name: '体能', domainIds: ['d_default', 'd2'] }],
  cards: { exemption: 2 },
  shopCategories: [{ id: 'sc_default', name: '默认' }, { id: 'sc2', name: '周边' }],
  products: [
    { id: 'p1', name: '咖啡', categoryId: 'sc_default', price: 5, tier: 'daily', stock: -1, desc: '提神', debtRate: 0 },
    { id: 'p2', name: '课程', categoryId: 'sc2', price: 30, tier: 'daily', stock: 3, desc: '系统课', debtRate: 2 },
    { id: 'p3', name: '售罄周边', categoryId: 'sc2', price: 8, tier: 'daily', stock: 0, desc: '', debtRate: 0 },
    { id: 'p4', name: '旧咖啡券', categoryId: 'sc_default', price: 3, tier: 'daily', stock: 0, desc: '', debtRate: 0 },
  ],
  filterDomain: null,
});

api.patchState(s => {
  s.ext.stats.lifetimeVitalityIn = 88;
  s.ext.stats.lifetimeVitalityOut = 21;
  s.ext.stats.lifetimeProgressIn = 55;
  s.ext.stats.lifetimeAchievementIn = 9;
  s.ext.stats.lifetimeAchievementOut = 4;
  s.ext.stats.totalCheckins = 17;
  s.ext.stats.totalPurchases = 3;
  s.ext.shadow = [
    { acct: 'vitality', delta: -5, label: '贷款放款', src: 'loan', before: 10, after: 5, ts: at(10, 6) },
    { acct: 'achievement', delta: 2, label: '活动回收', src: 'activity', before: 7, after: 9, ts: at(10, 5) },
    { acct: 'progress:d2', delta: -1.5, label: '重算搬运', src: 'recalc', before: 3, after: 1.5, ts: at(9, 6) },
  ];
  // 覆盖新增的「事件派发失败」提示：只放既有结构，不引入新的写入通道
  s.flows = [{ id: 'f2', name: '打卡奖励', enabled: true, trigger: { type: 'event', event: { kind: 'checkin' } }, steps: [] }];
  s.ext.events = {
    v: 1,
    recent: [{
      v: 1, kind: 'checkin', key: 'checkin:t1', sourceId: 't1', occurredAt: at(10, 11),
      payload: { taskId: 't1' },
      results: [
        { flowId: 'f2', ok: false, code: 'FLOW_EVENT_EXCEPTION', message: '步骤执行时余额发生变化', runId: '', skipped: '' },
        { flowId: 'f2', ok: false, code: 'FLOW_COMPILE_FAILED', message: '', runId: '', skipped: '' },
        { flowId: 'f2', ok: true, code: '', message: '', runId: 'run_ok', skipped: '' },
      ],
    }],
  };
});

function capturePanel(id) {
  const el = globalThis.document.getElementById(id);
  return el ? el.innerHTML : null;
}

api.renderWork();
api.renderBank();
api.renderShop();

const out = {
  panels: {
    taskGroups: capturePanel('taskGroups'),
    archiveGroups: capturePanel('archiveGroups'),
    chorePanel: capturePanel('chorePanel'),
    affairPanel: capturePanel('affairPanel'),
    logList: capturePanel('logList'),
    shadowList: capturePanel('shadowList'),
    achGroups: capturePanel('achGroups'),
    shopList: capturePanel('shopList'),
    purchaseList: capturePanel('purchaseList'),
  },
  cards: {
    taskBoth: api.taskCardHTML(api.getState().tasks[0], 'c_default'),
    taskDebt: api.taskCardHTML(api.getState().tasks[1], 'c2'),
    taskStaged: api.taskCardHTML(api.getState().tasks[2], 'c2'),
    affairInProgress: api.affairInProgressCardHTML(api.getState().affairs[1]),
    affairSchedule: api.affairScheduleCardHTML(api.getState().affairs[2], { late: true, time: '今天 16:00' }),
    affairDraft: api.affairDraftCardHTML(api.getState().affairs[0]),
    affairDone: api.affairDoneCardHTML(api.getState().affairs[3]),
    affairStep: api.affairStepUnitCardHTML({
      affair: api.getState().affairs[1], step: api.getState().affairs[1].steps[1], index: 1, ts: at(10, 10),
    }, { late: true, time: '10:00' }),
    choreOverdue: api.choreCardHTML(api.getState().chores[0]),
    choreDone: api.choreCardHTML(api.getState().chores[1]),
    achLocked: api.achCardHTML(api.getState().achievements[0], 'd_default'),
    achUnlocked: api.achCardHTML(api.getState().achievements[1], 'd2'),
  },
};

const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'round5-render.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
Object.keys(out.panels).forEach(k => {
  const v = out.panels[k];
  console.log(k, v == null ? 'null' : v.length + ' chars');
});
