// #debug 自检第 3 项（ext.activity 桶 vs 打卡日志）的截断降级行为。
//
// 这条测试要区分的是三种状态，而不是「有没有抛错」：
//   1) 未截断 + 桶与日志一致        -> 严格比对执行且通过（存在严格的按领域条目，ok=true、无 skip）
//   2) 未截断 + 桶与日志不一致      -> 严格比对判 bad（ok=false），证明严格判定真的在生效
//   3) 已截断 + 同样的不一致        -> 降级为提示（ok=true、skip=true），不得出现 bad
// 并且 2/3 用的是同一份不一致数据，差别只有 logs 长度是否达到 LOG_MAX，
// 因此两种结果只能由「是否截断」解释，不会被其他因素蒙混过关。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

// 截断分支用 '活跃度桶 vs 打卡日志'，严格分支用 '活跃度桶「领域」vs 打卡日志'
const ACTIVITY_PREFIX = '活跃度桶';
const STRICT_PREFIX = '活跃度桶「';

function activityItems(report) {
  return report.filter(r => String(r.label).indexOf(ACTIVITY_PREFIX) === 0);
}

// 造一条真实打卡：1 条打卡流水 + 当日活跃度桶 d_default=1（由 noteCheckinActivity 写入）
function seedCheckedIn() {
  api.resetState({
    tasks: [{
      id: 't1', name: '读英语', description: '', collectionId: 'c_default',
      domainIds: ['d_default'], scoreTypes: ['vitality'],
      initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
      checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null,
      pendingDebt: 0, archived: false,
    }],
  });
  api.checkIn('t1');
  expect(api.getState().logs.filter(l => l.src === 'checkin')).toHaveLength(1);
  expect(api.getState().ext.activity.d_default[api.dayKey(api.now())]).toBe(1);
}

// 把活跃度桶改成 5 次：与唯一一条打卡日志（1 次）相差 4
function tamperActivityBucket() {
  const live = api.getLive();
  live.ext.activity = { d_default: { [api.dayKey(api.now())]: 5 } };
}

// 用 0 金额流水把日志补到 LOG_MAX：不改变余额、统计与打卡次数，只触发「已截断」判定
function padLogsToMax() {
  const live = api.getLive();
  let i = 0;
  while (live.logs.length < api.LOG_MAX) {
    live.logs.push({
      id: 'pad-' + (i++), time: api.now(), st: 'vitality', amt: 0,
      desc: '填充', src: 'pad', dom: '',
    });
  }
  expect(live.logs.length).toBe(api.LOG_MAX);
}

describe('#debug 活跃度桶检查：日志截断时应降级为提示', () => {
  it('未截断且一致：执行严格比对并通过', () => {
    seedCheckedIn();
    const items = activityItems(api.runConsistencyChecks());
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('活跃度桶「d_default」vs 打卡日志');
    expect(items[0].ok).toBe(true);
    expect(items[0].skip).toBeFalsy();
    expect(items[0].detail).toContain('差异合计 0');
  });

  it('未截断且不一致：严格比对判 bad（严格判定未失效）', () => {
    seedCheckedIn();
    tamperActivityBucket();
    const items = activityItems(api.runConsistencyChecks());
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('活跃度桶「d_default」vs 打卡日志');
    expect(items[0].ok).toBe(false);
    expect(items[0].skip).toBeFalsy();
    expect(items[0].detail).toContain('差异合计 4');
  });

  it('已截断且同样的不一致：降级为 skip，不参与 bad 判定', () => {
    seedCheckedIn();
    tamperActivityBucket();
    padLogsToMax();

    const report = api.runConsistencyChecks();
    const items = activityItems(report);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ label: '活跃度桶 vs 打卡日志', ok: true, skip: true, detail: '日志已截断，跳过严格比对' });
    // 截断分支不得再产出按领域的严格条目，否则会与降级提示并存造成误报
    expect(report.filter(r => String(r.label).indexOf(STRICT_PREFIX) === 0)).toEqual([]);

    // 反向验证：只把日志降到 LOG_MAX 以下（其余不变），同一条不一致立刻恢复为 bad，
    // 说明结果差异确实由「是否截断」决定，而不是别的因素。
    api.getLive().logs.pop();
    const strict = activityItems(api.runConsistencyChecks());
    expect(strict).toHaveLength(1);
    expect(strict[0].label).toBe('活跃度桶「d_default」vs 打卡日志');
    expect(strict[0].ok).toBe(false);
  });
});
