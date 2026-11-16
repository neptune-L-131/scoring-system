// S3 前置特征测试：冻结“既有活动发卡”和“成就解锁”的数值与流水形状。
//
// 这些用例必须在抽取 assetGrantCore、给 checkAchievements 加 silent/返回值之前全绿；
// 改完之后再跑一遍，用例本身不改，作为“既有路径零漂移”的证据。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';

const opts = { save: 'none', render: false };

function txn(fn) {
  const r = api.Ledger.txn(fn, opts);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r;
}

function toastCount() {
  return globalThis.document.getElementById('toastWrap').children.length;
}

beforeEach(() => {
  api.resetState();
  globalThis.document.getElementById('toastWrap').children.length = 0;
});

describe('特征：既有活动发卡（card 结果项）', () => {
  it('cap 裁剪：余额 2 + 发放 3、上限 3 → 实际发放 1，流水字段逐字固定', () => {
    api.patchState(s => { s.cards = { exemption: 2 }; });
    const act = { id: 'a1', name: '每周卡', result: { items: [{ type: 'card', card: 'exemption', amount: 3, cap: 3 }] } };
    txn(() => api.applyResult(act, 1000));
    const s = api.getState();
    expect(s.cards.exemption).toBe(3);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toEqual(expect.objectContaining({
      st: 'card', amt: 1,
      desc: '周期活动「每周卡」发放 1 张断更豁免卡',
      src: 'card-grant', dom: '', card: 'exemption', actId: 'a1', granted: 1,
    }));
    expect(typeof s.logs[0].id).toBe('string');
    expect(typeof s.logs[0].time).toBe('number');
  });

  it('余额已达 cap：不发放、不写流水、余额不变', () => {
    api.patchState(s => { s.cards = { exemption: 3 }; });
    const act = { id: 'a2', name: '每周卡', result: { items: [{ type: 'card', card: 'exemption', amount: 2, cap: 3 }] } };
    txn(() => api.applyResult(act, 1000));
    const s = api.getState();
    expect(s.cards.exemption).toBe(3);
    expect(s.logs).toHaveLength(0);
  });

  it('cap 缺省为 1：余额 0 时只发 1 张', () => {
    const act = { id: 'a3', name: '保底', result: { items: [{ type: 'card', card: 'exemption', amount: 5 }] } };
    txn(() => api.applyResult(act, 1000));
    const s = api.getState();
    expect(s.cards.exemption).toBe(1);
    expect(s.logs[0]).toMatchObject({ amt: 1, granted: 1 });
  });

  it('previewResultItems 的裁剪结果与真实发放一致', () => {
    api.patchState(s => { s.cards = { exemption: 2 }; });
    const act = { id: 'a4', name: '每周卡', result: { items: [{ type: 'card', card: 'exemption', amount: 3, cap: 3 }] } };
    const preview = api.previewResultItems(act, 1000);
    expect(preview).toEqual([{ type: 'card', account: 'card:exemption', card: 'exemption', amount: 1, cap: 3 }]);
    txn(() => api.applyResult(act, 1000));
    expect(api.getState().cards.exemption).toBe(3);
  });

  it('多结果项：发卡与活力写入同一个事务，任一流水被裁剪时计数仍对齐', () => {
    const act = {
      id: 'a5', name: '组合',
      result: { items: [{ type: 'card', card: 'exemption', amount: 1, cap: 3 }, { type: 'vitality', amount: 4 }] },
    };
    txn(() => api.applyResult(act, 1000));
    const s = api.getState();
    expect(s.cards.exemption).toBe(1);
    expect(s.scores.vitality).toBe(4);
    expect(s.logs.map(l => l.src)).toEqual(['reward', 'card-grant']);
  });
});

describe('特征：成就解锁', () => {
  function seed() {
    api.patchState(s => {
      s.domains = [{ id: 'd_default', name: '默认' }];
      s.scores.progress = { d_default: 10 };
      s.achievements = [{ id: 'ach1', name: '十点', domainId: 'd_default', threshold: 10, points: 5, unlocked: false }];
    });
  }

  it('首次达标：发成果点、写 achievement 流水、弹一次提示', () => {
    seed();
    txn(() => api.checkAchievements('d_default'));
    const s = api.getState();
    expect(s.scores.achievement).toBe(5);
    expect(s.achievements[0].unlocked).toBe(true);
    expect(typeof s.achievements[0].unlockedAt).toBe('number');
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({
      st: 'achievement', amt: 5, desc: '里程碑「十点」解锁',
      src: 'achievement', dom: 'd_default', achId: 'ach1',
    });
    expect(toastCount()).toBe(1);
  });

  it('已解锁后再复核：不重复发点、不写流水', () => {
    seed();
    txn(() => api.checkAchievements('d_default'));
    txn(() => api.checkAchievements('d_default'));
    const s = api.getState();
    expect(s.scores.achievement).toBe(5);
    expect(s.logs).toHaveLength(1);
  });

  it('领域不匹配时不解锁', () => {
    seed();
    txn(() => api.checkAchievements('d_other'));
    const s = api.getState();
    expect(s.scores.achievement).toBe(0);
    expect(s.achievements[0].unlocked).toBe(false);
    expect(s.logs).toHaveLength(0);
  });
});
