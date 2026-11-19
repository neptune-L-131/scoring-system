// 成就解锁的数值与流水形状特征测试。
//
// 这些用例在给 checkAchievements 加 silent/返回值之前全绿；
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
