// 读档失败后的状态残留：parseState 每次解析先归零 loadIssue；attemptRecovery 只在备份确实可解析时
// 才写入，并解除读档失败造成的写盘暂停。
import { beforeEach, describe, it, expect } from 'vitest';
import { api } from './shim.js';
import { KEY } from '../src/constants.js';
import { loadIssue, _persistBlocked } from '../src/normalize.js';

// 最小 IndexedDB 桩：只实现 open → transaction → objectStore.get/put 这条持久化代码用到的路径
let store = new Map();
const fakeStore = {
  get(k) {
    const req = {};
    queueMicrotask(() => { req.result = store.get(k); if (req.onsuccess) req.onsuccess(); });
    return req;
  },
  put(v, k) { store.set(k, v); },
  delete(k) { store.delete(k); },
};
const fakeDB = {
  objectStoreNames: { contains: () => true },
  createObjectStore() {},
  transaction() {
    const tx = { objectStore: () => fakeStore };
    queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
    return tx;
  },
};
globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => { req.result = fakeDB; if (req.onsuccess) req.onsuccess({ target: req }); });
    return req;
  },
};

const validState = () => JSON.stringify(Object.assign(api.defaults(), {
  scores: { vitality: 7, progress: {}, achievement: 0 },
}));

beforeEach(() => {
  store = new Map();
  api.setLoadIssue(null);
  api.setPersistBlocked(false);
  api.resetState();
});

describe('parseState：每次解析重置错误状态', () => {
  it('上一次失败残留的 loadIssue 不会污染下一次成功解析', () => {
    api.setLoadIssue({ type: 'corrupt' });
    const s = api.parseState(validState());
    expect(loadIssue).toBe(null);
    expect(s.scores.vitality).toBe(7);
  });

  it('先解析损坏内容、再解析正常内容：第二次必须干净通过', () => {
    api.parseState('{ not json');
    expect(loadIssue).toEqual({ type: 'corrupt' });
    const s = api.parseState(validState());
    expect(loadIssue).toBe(null);
    expect(s.scores.vitality).toBe(7);
  });
});

describe('attemptRecovery：只有备份可解析才算恢复成功', () => {
  it('备份本身损坏：报错、不写入、不解除写盘暂停', async () => {
    store.set(KEY + '_corrupt', '{ broken');
    api.setPersistBlocked(true);
    api.patchState(s => { s.scores.vitality = 42; });

    await api.attemptRecovery();

    expect(_persistBlocked).toBe(true);
    expect(loadIssue).toEqual({ type: 'corrupt' });
    expect(api.getState().scores.vitality).toBe(42); // 现场未被空白默认库覆盖
    expect(api.Persist.isPending()).toBe(false);
  });

  it('备份可解析：写入恢复数据、解除停写，并真的落盘', async () => {
    store.set(KEY + '_corrupt', validState());
    api.setPersistBlocked(true);

    await api.attemptRecovery();

    expect(_persistBlocked).toBe(false);
    expect(loadIssue).toBe(null);
    expect(api.getState().scores.vitality).toBe(7);
    expect(api.Persist.isPending()).toBe(true);

    await api.Persist.flush();
    expect(api.Persist.isPending()).toBe(false);
    expect(store.get(KEY)).toContain('"vitality":7');
  });
});
