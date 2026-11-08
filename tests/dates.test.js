// 日期 / 周期 / 数值格式化 —— 纯逻辑，不依赖浏览器。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

// 本地时间构造，避免测试依赖运行机器的时区格式
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const DAY = 864e5;

describe('dayKey：本地自然日', () => {
  it('按本地零点切换，而不是 UTC', () => {
    expect(api.dayKey(at(2024, 1, 5, 0, 0))).toBe('2024-01-05');
    expect(api.dayKey(at(2024, 1, 5, 23, 59))).toBe('2024-01-05');
    expect(api.dayKey(at(2024, 1, 6, 0, 0))).toBe('2024-01-06');
  });
});

describe('weekStartTs / weekStartKey：任意周起始日', () => {
  const wed = at(2024, 1, 10, 15, 30); // 周三

  it('anchor=1 取周一，anchor=3 取周三，anchor=7 取周日', () => {
    expect(api.dayKey(api.weekStartTs(1, wed))).toBe('2024-01-08');
    expect(api.dayKey(api.weekStartTs(3, wed))).toBe('2024-01-10');
    expect(api.dayKey(api.weekStartTs(7, wed))).toBe('2024-01-07');
  });

  it('weekStartTs 结果固定在本地零点', () => {
    const ts = api.weekStartTs(1, wed);
    const d = new Date(ts);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  it('weekStartKey 与 weekStartTs 参数顺序不同但结果一致', () => {
    expect(api.weekStartKey(wed, 3)).toBe(api.dayKey(api.weekStartTs(3, wed)));
    expect(api.weekStartKey(wed, 1)).toBe(api.dayKey(api.weekStartTs(1, wed)));
  });
});

describe('periodKey：周期活动 / 预算共用同一套周期键', () => {
  const wed = at(2024, 1, 10, 9, 0);
  it('day / week / month', () => {
    expect(api.periodKey({ period: 'day' }, wed)).toBe('2024-01-10');
    expect(api.periodKey({ period: 'week', anchor: 1 }, wed)).toBe('2024-01-08');
    expect(api.periodKey({ period: 'week', anchor: 3 }, wed)).toBe('2024-01-10');
    expect(api.periodKey({ period: 'month' }, wed)).toBe('2024-01');
  });
});

describe('budgetBounds：预算周期边界', () => {
  it('月周期从当月 1 日到次月 1 日', () => {
    const b = api.budgetBounds('month', at(2024, 2, 15, 12, 0), 1);
    expect(b.key).toBe('M:2024-02');
    expect(b.start).toBe(at(2024, 2, 1));
    expect(b.end).toBe(at(2024, 3, 1));
  });

  it('周周期按 anchor 计算，长度恒为 7 天', () => {
    const wed = at(2024, 1, 10, 12, 0);
    const mon = api.budgetBounds('week', wed, 1);
    expect(mon).toEqual({ key: 'W:2024-01-08', start: at(2024, 1, 8), end: at(2024, 1, 15) });
    const sun = api.budgetBounds('week', wed, 7);
    expect(sun).toEqual({ key: 'W:2024-01-07', start: at(2024, 1, 7), end: at(2024, 1, 14) });
    expect(mon.end - mon.start).toBe(7 * DAY);
  });

  it('anchor 非法值夹回 1..7', () => {
    const wed = at(2024, 1, 10, 12, 0);
    expect(api.budgetBounds('week', wed, 0).key).toBe('W:2024-01-08');
    expect(api.budgetBounds('week', wed, 99).key).toBe('W:2024-01-07');
  });

  it('省略 ts 时使用当前时间且不抛错', () => {
    const b = api.budgetBounds('month');
    expect(b.key.startsWith('M:')).toBe(true);
    expect(b.end > b.start).toBe(true);
  });
});

describe('splitCents：按分均摊，逐分守恒', () => {
  const cents = parts => Math.round(parts.reduce((s, v) => s + v, 0) * 100);

  it('10 元分 3 份：尾差按顺序 +1 分', () => {
    expect(api.splitCents(10, 3)).toEqual([3.34, 3.33, 3.33]);
    expect(cents(api.splitCents(10, 3))).toBe(1000);
  });

  it('0.1 元分 3 份仍精确到分', () => {
    expect(api.splitCents(0.1, 3)).toEqual([0.04, 0.03, 0.03]);
    expect(cents(api.splitCents(0.1, 3))).toBe(10);
  });

  it('负数与 0 份', () => {
    expect(api.splitCents(-1, 3)).toEqual([-0.34, -0.33, -0.33]);
    expect(cents(api.splitCents(-1, 3))).toBe(-100);
    expect(api.splitCents(10, 0)).toEqual([]);
    expect(api.splitCents(10, 1)).toEqual([10]);
  });

  it('1 份时原样返回，不做四舍五入以外的改动', () => {
    expect(api.splitCents(3.3333, 1)).toEqual([3.33]);
  });
});

describe('fmt / round2 / round4', () => {
  it('fmt 去掉多余小数位，空值显示 0', () => {
    expect(api.fmt(0)).toBe('0');
    expect(api.fmt(12)).toBe('12');
    expect(api.fmt(2.346)).toBe('2.346');
    expect(api.fmt(2.34567891)).toBe('2.34568');
    expect(api.fmt(1.2345678)).toBe('1.23457');
    expect(api.fmt(null)).toBe('0');
    expect(api.fmt(undefined)).toBe('0');
    expect(api.fmt(NaN)).toBe('0');
    expect(api.fmt(-4)).toBe('-4');
  });

  it('round2 / round4 保留固定小数位', () => {
    expect(api.round2(2.346)).toBe(2.35);
    expect(api.round2(0)).toBe(0);
    expect(api.round4(1.23456)).toBe(1.2346);
    expect(api.round4(1)).toBe(1);
  });
});

describe('dayStartTs / idleDaysSince / condWindowByRange', () => {
  it('dayStartTs 归到本地零点', () => {
    const d = new Date(api.dayStartTs(at(2024, 5, 6, 18, 45)));
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    expect(api.dayKey(api.dayStartTs(at(2024, 5, 6, 18, 45)))).toBe('2024-05-06');
  });

  it('idleDaysSince 按自然日计差，未来/无基准不算超期', () => {
    const ref = at(2024, 5, 10, 9, 0);
    expect(api.idleDaysSince(at(2024, 5, 7, 23, 0), ref)).toBe(3);
    expect(api.idleDaysSince(at(2024, 5, 10, 1, 0), ref)).toBe(0);
    expect(api.idleDaysSince(at(2024, 5, 12, 1, 0), ref)).toBe(0);
    expect(api.idleDaysSince(null, ref)).toBe(null);
  });

  it('今日窗口 = 本地零点起 24 小时', () => {
    const ts = at(2024, 5, 10, 15, 0);
    expect(api.condWindowByRange('today', null, ts)).toEqual({ start: at(2024, 5, 10), end: at(2024, 5, 10) + DAY });
  });

  it('最近 N 天窗口 = [ts-N天, ts]，N 至少为 1', () => {
    const ts = at(2024, 5, 10, 15, 0);
    expect(api.condWindowByRange('recent', null, ts, 7)).toEqual({ start: ts - 7 * DAY, end: ts });
    // days=0 视为“未设置”，回落到默认 7 天（与条件编辑器默认值一致）
    expect(api.condWindowByRange('recent', null, ts, 0)).toEqual({ start: ts - 7 * DAY, end: ts });
  });

  it('周期窗口取“上一个周期”，与周期活动的结算时点一致', () => {
    const act = { period: 'week', anchor: 1 };
    const ts = at(2024, 1, 10, 9, 0); // 周三
    expect(api.condWindowByRange('period', act, ts)).toEqual({ start: at(2024, 1, 1), end: at(2024, 1, 8) });
    const mon = { period: 'month' };
    expect(api.condWindowByRange('period', mon, at(2024, 2, 15))).toEqual({ start: at(2024, 1, 1), end: at(2024, 2, 1) });
  });
});
