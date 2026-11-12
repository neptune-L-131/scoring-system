// 统一时间源（src/time.js）与打卡跨零点一致性。
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { api } from './shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 本地时间构造，避免测试依赖运行机器的时区格式
const at = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms).getTime();

afterEach(() => { api.__setClockForTest(null); });

describe('dayDiff：按日历日计差，不按毫秒差', () => {
  it('23:01 与次日 00:59 相差 1 天；同日 00:00 与 23:59 相差 0 天', () => {
    const late = at(2024, 1, 5, 23, 1);
    const nextEarly = at(2024, 1, 6, 0, 59);
    expect(api.dayDiff(nextEarly, late)).toBe(1);
    expect(api.dayDiff(late, nextEarly)).toBe(-1);
    expect(api.dayDiff(at(2024, 1, 5, 23, 59), at(2024, 1, 5, 0, 0))).toBe(0);
    // 毫秒差只有 22 分钟，但日历上确实跨了一天
    expect(nextEarly - late).toBeLessThan(864e5);
  });

  it('夏令时切换日：实际间隔 23/25 小时，日历差仍为 1 天', () => {
    // 在带 DST 的时区子进程里验证，避免污染当前测试进程的时区
    const target = pathToFileURL(path.join(ROOT, 'src', 'time.js')).href;
    const script = [
      'import { dayDiff, dayStart, addDays } from ' + JSON.stringify(target) + ';',
      'const springA=new Date(2024,2,10,23,30).getTime();',
      'const springB=new Date(2024,2,11,0,30).getTime();',
      'const fallA=new Date(2024,10,3,23,30).getTime();',
      'const fallB=new Date(2024,10,4,0,30).getTime();',
      'const springDayLen=new Date(2024,2,11).getTime()-new Date(2024,2,10).getTime();',
      'const fallDayLen=new Date(2024,10,4).getTime()-new Date(2024,10,3).getTime();',
      'const noon=addDays(new Date(2024,2,9,12,0).getTime(),1);',
      'console.log(JSON.stringify({',
      '  springDiff:dayDiff(springB,springA), fallDiff:dayDiff(fallB,fallA),',
      '  springDayLen:springDayLen, fallDayLen:fallDayLen,',
      '  stepBack:dayDiff(addDays(dayStart(springB),-1),dayStart(springB)),',
      '  noonHour:new Date(noon).getHours(), noonMs:noon-new Date(2024,2,9,12,0).getTime()',
      '}));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: Object.assign({}, process.env, { TZ: 'America/New_York' }),
      encoding: 'utf8',
    });
    const r = JSON.parse(out.trim());
    expect(r.springDayLen).toBe(23 * 3600e3); // 春季切换日只有 23 小时
    expect(r.fallDayLen).toBe(25 * 3600e3);   // 秋季切换日有 25 小时
    expect(r.springDiff).toBe(1);
    expect(r.fallDiff).toBe(1);
    expect(r.stepBack).toBe(-1);
    // addDays 走日历运算：跨 DST 后墙钟仍是 12:00，但实际经过 23 小时
    expect(r.noonHour).toBe(12);
    expect(r.noonMs).toBe(23 * 3600e3);
  });
});

describe('addDays：跨月跨年跨闰日', () => {
  it('月末 +1 进入次月，年末 +1 进入次年', () => {
    expect(api.dayKeyOf(api.addDays(at(2024, 1, 31, 8, 30), 1))).toBe('2024-02-01');
    expect(api.dayKeyOf(api.addDays(at(2023, 12, 31, 23, 30), 1))).toBe('2024-01-01');
    expect(new Date(api.addDays(at(2023, 12, 31, 23, 30), 1)).getHours()).toBe(23);
  });

  it('闰年 2/29 与平年 2/28', () => {
    expect(api.dayKeyOf(api.addDays(at(2024, 2, 29), 1))).toBe('2024-03-01');
    expect(api.dayKeyOf(api.addDays(at(2023, 2, 28), 1))).toBe('2023-03-01');
    expect(api.dayKeyOf(api.addDays(at(2024, 3, 1), -1))).toBe('2024-02-29');
  });
});

describe('周期函数与旧导出保持一致（P1 替换的安全网）', () => {
  const wed = at(2024, 1, 10, 15, 30);
  it('weekStart / weekKey / periodKeyOf 与 weekStartTs / weekStartKey / periodKey 等价', () => {
    [1, 3, 7].forEach(a => {
      expect(api.weekStart(wed, a)).toBe(api.weekStartTs(a, wed));
      expect(api.weekKey(wed, a)).toBe(api.weekStartKey(wed, a));
      expect(api.periodKeyOf({ period: 'week', anchor: a }, wed)).toBe(api.periodKey({ period: 'week', anchor: a }, wed));
    });
    expect(api.periodKeyOf({ period: 'day' }, wed)).toBe(api.periodKey({ period: 'day' }, wed));
    expect(api.periodKeyOf({ period: 'month' }, wed)).toBe(api.periodKey({ period: 'month' }, wed));
  });

  it('budgetBounds 与旧版完全一致（含 M:/W: 键格式）', () => {
    const wed = at(2024, 1, 10, 12, 0);
    expect(api.budgetBounds('month', at(2024, 2, 15, 12, 0), 1)).toEqual({
      key: 'M:2024-02', start: at(2024, 2, 1), end: at(2024, 3, 1),
    });
    expect(api.budgetBounds('week', wed, 1)).toEqual({ key: 'W:2024-01-08', start: at(2024, 1, 8), end: at(2024, 1, 15) });
    expect(api.budgetBounds('week', wed, 7)).toEqual({ key: 'W:2024-01-07', start: at(2024, 1, 7), end: at(2024, 1, 14) });
  });

  it('rangeOf 的 end 为开区间；businessDayKey 预留 cutoff（本轮固定 0 点）', () => {
    const r = api.rangeOf('week', at(2024, 1, 10, 12, 0), 1);
    expect(r.start).toBe(at(2024, 1, 8));
    expect(r.end).toBe(at(2024, 1, 15));
    expect(api.businessDayKey(at(2024, 1, 5, 1, 0))).toBe('2024-01-05');
    // 预留能力：业务日从 3 点开始时，凌晨 1 点仍算前一天
    expect(api.businessDayKey(at(2024, 1, 5, 1, 0), 3)).toBe('2024-01-04');
  });

  it('keyOffset 按自然日回溯，跨月跨年正确', () => {
    api.__setClockForTest(() => at(2024, 1, 1, 0, 30));
    expect(api.keyOffset(0)).toBe('2024-01-01');
    expect(api.keyOffset(1)).toBe('2023-12-31');
    expect(api.keyOffset(31)).toBe('2023-12-01');
  });
});

describe('now：可注入假时钟，且对回拨单调夹住', () => {
  it('注入后 now() 返回假时钟值', () => {
    const T = at(2025, 3, 1, 12, 0);
    api.__setClockForTest(() => T);
    expect(api.now()).toBe(T);
  });

  it('时钟回拨时返回上一次读到的时刻，并累计回拨次数', () => {
    const T = at(2025, 3, 1, 12, 0);
    api.__setClockForTest(() => T);
    expect(api.now()).toBe(T);
    const before = api.__clockRollbacks();
    api.__setClockForTest(() => T - 60000, false); // 保留单调基线，模拟设备时间被调早
    expect(api.now()).toBe(T);
    expect(api.__clockRollbacks()).toBeGreaterThan(before);
  });
});

// ===== 打卡跨零点：同一事务内四个落点必须落在同一自然日 =====
function seedTask() {
  api.resetState({
    domains: [{ id: 'd_default', name: '默认' }],
    scores: { vitality: 0, progress: { d_default: 0 }, achievement: 0 },
    tasks: [{
      id: 't1', name: '夜间任务', domainIds: ['d_default'], scoreTypes: ['vitality'],
      initialValue: 10, interestRate: 10, debtRate: 20, vitalityCost: 0,
      checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
    }],
  });
}

function checkinArtifacts() {
  const s = api.getState();
  const t = s.tasks[0];
  const log = s.logs.filter(l => l.src === 'checkin').slice(-1)[0];
  const activity = (s.ext.activity && s.ext.activity.d_default) || {};
  const daily = s.ext.stats.daily || {};
  return { t, log, activity, daily };
}

describe('打卡跨零点单事务', () => {
  it('事务中途时钟推进越过零点：打卡记录/流水/活跃度/统计落在同一天', () => {
    seedTask();
    const base = api.dayStart(api.now());
    const start = base + 23 * 3600e3 + 59 * 60e3 + 58e3; // 23:59:58
    const after = start + 5000;                          // 次日 00:00:03
    let calls = 0;
    // 前两次读时钟在零点前，之后跳到零点后：若各写点各自读时钟就会分裂到两天
    api.__setClockForTest(() => { calls++; return calls <= 2 ? start : after; });
    api.checkIn('t1');

    const { t, log, activity, daily } = checkinArtifacts();
    expect(log).toBeTruthy();
    const key = api.dayKeyOf(t.lastCheckIn);
    expect([api.dayKeyOf(start), api.dayKeyOf(after)]).toContain(key);
    expect(api.dayKeyOf(log.time)).toBe(key);
    expect(Object.keys(activity)).toEqual([key]);
    expect(activity[key]).toBe(1);
    expect(daily[key]).toBeTruthy();
    expect(daily[key].ck).toBe(1);
    const other = api.dayKeyOf(start) === key ? api.dayKeyOf(after) : api.dayKeyOf(start);
    expect(daily[other]).toBeUndefined();
    // 时钟确实在事务前后跨过了零点
    expect(calls).toBeGreaterThan(2);
  });

  it('事务中途时钟回拨：回拨被夹住，四个落点仍落在同一天', () => {
    seedTask();
    const base = api.dayStart(api.now());
    const start = base + 1000;      // 00:00:01
    const rolledBack = start - 5000; // 回拨到前一天 23:59:56
    let calls = 0;
    const before = api.__clockRollbacks();
    api.__setClockForTest(() => { calls++; return calls <= 2 ? start : rolledBack; });
    api.checkIn('t1');

    const { t, log, activity, daily } = checkinArtifacts();
    const key = api.dayKeyOf(t.lastCheckIn);
    expect(api.dayKeyOf(start)).toBe(key);
    expect(api.dayKeyOf(log.time)).toBe(key);
    expect(Object.keys(activity)).toEqual([key]);
    expect(daily[key]).toBeTruthy();
    expect(daily[api.dayKeyOf(rolledBack)]).toBeUndefined();
    expect(api.__clockRollbacks()).toBeGreaterThan(before);
  });
});
