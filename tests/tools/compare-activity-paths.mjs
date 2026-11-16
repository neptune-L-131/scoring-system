// 活动两条触发路径的对照脚本（不是测试，vitest 不会收集它）。
// 用法：node tests/tools/compare-activity-paths.mjs [输出文件]
//
// 一次性证据工具（保留用于说明删除事件路径的原因，不参与生产、不进 PRECACHE）。
//
// 结论：期中触发与期末触发**不等价**；事件触发路径已废弃，活动一律在期末结算求值。
//   - 累计阈值活动（range=period）在期中评估时，窗口仍是「上一周期」，当前周期打卡不计入，
//     且旧实现会提前把 lastRun 推到当前周期，导致本周期奖励被提前判空。
//   - 时间窗活动（range=recent）的窗口随评估时刻滑动：期中评估能命中最近 X 天，
//     期末评估时窗口已滑过打卡日，反而不发。
// 因此事件路径不能替代期末结算，本脚本只作为当时的对照证据保留。
//
// 对照对象（事件基础设施删除后，B 路径改为直接调用同一 processActivities 模拟当时的期中评估）：
//   A) 期末结算触发：processActivities 在下一周期起点运行（按周期 + lastRun 门控）。
//   B) 期中评估：processActivities 在周期中途的记账时刻运行（即当年事件适配器会做的事）。
//
// 两个活动：
//   1) act_period —— 累计阈值：range=period（活动语义里的「上一周期」）打卡 >= 3 → 活力点 10
//   2) act_recent —— 时间窗：最近 3 天打卡 >= 3 → 成果点 5
//
// 固定时钟、固定场景，导出只保留可观察数值；连跑两次输出应逐字一致。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api } from '../shim.js';

const DAY = 864e5;
// 2024-03-04 是周一；周期 = 03-04（周一）～03-10（周日）。
const T_CHECKIN = [
  new Date(2024, 2, 4, 9, 0, 0, 0).getTime(),
  new Date(2024, 2, 5, 9, 0, 0, 0).getTime(),
  new Date(2024, 2, 6, 9, 0, 0, 0).getTime(),
];
const T_EVENT = new Date(2024, 2, 6, 12, 0, 0, 0).getTime();
// 期末结算：下一周期起点（周一 00:00），此时 prevPeriodRange 才是 03-04～03-10。
const T_PERIOD_END = new Date(2024, 2, 11, 0, 0, 0, 0).getTime();

let clock = T_CHECKIN[0];
api.__setClockForTest(() => clock);

const CURRENCY = { vitality: '活力点', achievement: '成果点', progress: '进度值', card: '卡' };

function baseState() {
  return {
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 0, progress: { d_default: 0 }, achievement: 0 },
    tasks: [{
      id: 't1', name: '每日任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
      initialValue: 1, interestRate: 0, debtRate: 0, vitalityCost: 0,
      checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
    }],
    logs: [],
  };
}

function setup() {
  api.patchState(s => {
    s.activities = [
      api.normalizeActivity({
        id: 'act_period', name: '累计阈值：本周期打卡≥3', enabled: true, period: 'week', anchor: 1,
        condition: { mode: 'all', items: [{ range: 'period', metric: 'checkins', op: '>=', value: 3 }] },
        result: { items: [{ type: 'vitality', amount: 10 }] },
        lastRun: null,
      }),
      api.normalizeActivity({
        id: 'act_recent', name: '时间窗：最近3天打卡≥3', enabled: true, period: 'week', anchor: 1,
        condition: { mode: 'all', items: [{ range: 'recent', days: 3, metric: 'checkins', op: '>=', value: 3 }] },
        result: { items: [{ type: 'achievement', amount: 5 }] },
        lastRun: null,
      }),
    ];
  });
}

function doCheckins() {
  T_CHECKIN.forEach(t => { clock = t; api.checkIn('t1'); });
}

function grantsOf(s) {
  return s.logs
    .filter(l => l && l.src === 'reward' && l.actId)
    .map(l => ({
      activityId: l.actId,
      asset: l.st,
      currency: CURRENCY[l.st] || l.st,
      amount: Number(l.amt) || 0,
      triggeredAt: l.time,
      triggeredAtIso: new Date(l.time).toISOString(),
    }));
}

function activityStates(s) {
  return s.activities.map(a => ({
    id: a.id,
    name: a.name,
    lastRun: a.lastRun,
    enabled: a.enabled,
  }));
}

function runPath(mode) {
  // 每个路径都重置状态与假时钟单调基线，保证两条路径互不影响、可重复。
  clock = T_CHECKIN[0];
  api.__setClockForTest(() => clock);
  api.resetState(baseState());
  setup();
  doCheckins();

  if (mode === 'periodEnd') {
    clock = T_PERIOD_END;
    api.processActivities(true, T_PERIOD_END);
  } else {
    // 模拟当年事件适配器：在期中记账时刻直接调用同一求值函数，只做对照，不代表现存能力。
    clock = T_EVENT;
    api.processActivities(true, T_EVENT);
  }

  const s = api.getState();
  return {
    mode,
    evaluatedAt: (mode === 'periodEnd') ? T_PERIOD_END : T_EVENT,
    evaluatedAtIso: new Date((mode === 'periodEnd') ? T_PERIOD_END : T_EVENT).toISOString(),
    grants: grantsOf(s),
    activities: activityStates(s),
    scores: s.scores,
  };
}

const periodEnd = runPath('periodEnd');
const eventTriggered = runPath('eventTriggered');

function grantsFor(p, actId) {
  return p.grants.filter(g => g.activityId === actId);
}

const comparisons = periodEnd.activities.map(a => {
  const b = eventTriggered.activities.find(x => x.id === a.id) || {};
  const ga = grantsFor(periodEnd, a.id);
  const gb = grantsFor(eventTriggered, a.id);
  const sum = list => list.reduce((n, g) => n + g.amount, 0);
  return {
    activity: a.name,
    periodEnd: {
      amount: sum(ga),
      grants: ga,
      lastRun: a.lastRun,
    },
    eventTriggered: {
      amount: sum(gb),
      grants: gb,
      lastRun: b.lastRun || null,
    },
    equal: sum(ga) === sum(gb),
  };
});

const out = {
  meta: {
    note: '固定时钟；periodEnd=旧调度器期末触发，eventTriggered=模拟当年事件路径在期中记账时刻求值（事件路径已删除）',
    checkinTimes: T_CHECKIN.map(t => new Date(t).toISOString()),
    eventTime: new Date(T_EVENT).toISOString(),
    periodEndTime: new Date(T_PERIOD_END).toISOString(),
    periodKeyOfEvent: api.periodKey({ period: 'week', anchor: 1 }, T_EVENT),
    periodKeyOfPeriodEnd: api.periodKey({ period: 'week', anchor: 1 }, T_PERIOD_END),
  },
  paths: { periodEnd, eventTriggered },
  comparisons,
};

const text = JSON.stringify(out, null, 2);
const file = process.argv[2] || path.join(process.env.TEMP || '.', 'activity-paths-compare.json');
fs.writeFileSync(file, text, 'utf8');
console.log('wrote', file);
console.log('sha256', crypto.createHash('sha256').update(text).digest('hex'));
comparisons.forEach(c => {
  console.log('[compare] ' + c.activity +
    ' | 期末 ' + c.periodEnd.amount + ' @' + (c.periodEnd.grants[0] ? c.periodEnd.grants[0].triggeredAtIso : '未发放') +
    ' | 事件 ' + c.eventTriggered.amount + ' @' + (c.eventTriggered.grants[0] ? c.eventTriggered.grants[0].triggeredAtIso : '未发放') +
    ' | equal=' + c.equal);
});
