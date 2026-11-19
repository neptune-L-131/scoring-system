// 账务引擎 Ledger：记账、拆分、隐形增减、事务回滚、截断对账、撤销适配器。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const opts = { save: 'none', render: false };
const run = fn => {
  const r = api.Ledger.txn(fn, opts);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r;
};

const sums = s => ({
  visible: s.logs.filter(l => l.st === 'vitality').reduce((a, l) => a + l.amt, 0),
  invisible: s.ext.stats.invisible.vitality,
  evicted: s.ext.stats.evicted.vitality,
});

function checkinTask(extra) {
  return Object.assign({
    id: 't1', name: '读英语', description: '', collectionId: 'c_default',
    domainIds: ['d_default'], scoreTypes: ['vitality'],
    initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
    checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null,
    pendingDebt: 0, archived: false,
  }, extra || {});
}

describe('Ledger.post：可见记账', () => {
  it('发放/消费分别累计收入与支出，流水最新在前', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test', desc: '测试入账' } });
      api.Ledger.spend('vitality', 3, { src: 'cost', desc: '消耗' });
    });
    const s = api.getState();
    expect(s.scores.vitality).toBe(7);
    expect(s.logs).toHaveLength(2);
    expect(s.logs[0]).toMatchObject({ st: 'vitality', amt: -3, desc: '消耗', src: 'cost' });
    expect(s.logs[1]).toMatchObject({ st: 'vitality', amt: 10, desc: '测试入账' });
    expect(s.ext.stats.lifetimeVitalityIn).toBe(10);
    expect(s.ext.stats.lifetimeVitalityOut).toBe(3);
  });

  it('adjust 以目标值为准，而不是增量', () => {
    api.resetState();
    run(() => { api.Ledger.adjust('vitality', 42, { src: 'manual' }); });
    expect(api.getState().scores.vitality).toBe(42);
    run(() => { api.Ledger.adjust('vitality', 5, { src: 'manual' }); });
    expect(api.getState().scores.vitality).toBe(5);
  });

  it('idemKey 在同一事务内去重', () => {
    api.resetState();
    let second = null;
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'achievement', delta: 5, idemKey: 'k1', reason: { src: 'test' } });
      second = api.Ledger.post({ op: 'grant', account: 'achievement', delta: 5, idemKey: 'k1', reason: { src: 'test' } });
    });
    expect(second.deduped).toBe(true);
    expect(api.getState().scores.achievement).toBe(5);
    expect(api.getState().logs).toHaveLength(1);
  });

  it('非法账户抛事务错误并整体回滚', () => {
    api.resetState();
    const r = api.Ledger.txn(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 10, reason: { src: 'test' } });
      api.Ledger.post({ op: 'grant', account: 'no_such_account', delta: 5, reason: { src: 'test' } });
    }, opts);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_ACCOUNT');
    const s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
  });
});

describe('Ledger.postSplits：多领域按分均摊', () => {
  it('10 元分 3 个领域，账面无浮点尾巴且流水明细逐分守恒', () => {
    api.resetState({
      domains: [
        { id: 'd_default', name: '默认' },
        { id: 'd2', name: '领域二' },
        { id: 'd3', name: '领域三' },
      ],
    });
    run(() => {
      api.Ledger.postSplits({
        splits: [{ domainIds: ['d_default', 'd2', 'd3'], delta: 10 }],
        entry: { st: 'progress', amt: 10, desc: '分摊', src: 'checkin', dom: 'd_default,d2,d3' },
        reason: { src: 'checkin' },
      });
    });
    const s = api.getState();
    expect(s.scores.progress).toEqual({ d_default: 3.34, d2: 3.33, d3: 3.33 });
    expect(s.logs[0].splits).toEqual([
      { dom: 'd_default', amt: 3.34 },
      { dom: 'd2', amt: 3.33 },
      { dom: 'd3', amt: 3.33 },
    ]);
    expect(Math.round(s.logs[0].splits.reduce((a, x) => a + x.amt, 0) * 100)).toBe(1000);
    expect(s.ext.stats.lifetimeProgressIn).toBe(10);
  });

  it('隐形拆分不写流水，但计入 invisible 且逐领域精确', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }, { id: 'd3', name: '三' }],
    });
    run(() => {
      api.Ledger.postSplits({
        splits: [{ domainIds: ['d_default', 'd2', 'd3'], delta: 1 }],
        visible: false,
        reason: { src: 'checkin-replay' },
      });
    });
    const s = api.getState();
    expect(s.logs).toHaveLength(0);
    expect(s.ext.stats.invisible.progress).toEqual({ d_default: 0.34, d2: 0.33, d3: 0.33 });
    expect(s.ext.shadow).toHaveLength(3);
  });
});

describe('Ledger 隐形操作：余额变了但流水没有对应行', () => {
  it('visible:false 只改余额、写差额累计与余额调整记录', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 50, visible: false, reason: { src: 'loan-draw', desc: '贷款放款' } });
    });
    const s = api.getState();
    expect(s.scores.vitality).toBe(50);
    expect(s.logs).toHaveLength(0);
    expect(s.ext.stats.invisible.vitality).toBe(50);
    expect(s.ext.shadow).toHaveLength(1);
    expect(s.ext.shadow[0]).toMatchObject({ acct: 'vitality', delta: 50, before: 0, after: 50, label: '贷款放款' });
    expect(sums(s)).toEqual({ visible: 0, invisible: 50, evicted: 0 });
  });

  it('隐形 transfer 两端都留痕，且对账等式成立', () => {
    api.resetState();
    run(() => { api.Ledger.grant('achievement', 100, { src: 'test' }); });
    run(() => {
      api.Ledger.transfer('achievement', 'vitality', 30, { src: 'loan-draw', desc: '放款' }, { visible: false });
    });
    const s = api.getState();
    expect(s.scores.achievement).toBe(70);
    expect(s.scores.vitality).toBe(30);
    expect(s.ext.stats.invisible.achievement).toBe(-30);
    expect(s.ext.stats.invisible.vitality).toBe(30);
    expect(s.ext.shadow).toHaveLength(2);
  });
});

describe('LOG_MAX 截断与对账等式', () => {
  it('超过上限的旧流水转入 evicted，余额 == 可见 + 隐形 + evicted', () => {
    api.resetState();
    run(() => {
      for (let i = 0; i < api.LOG_MAX + 5; i++) {
        api.Ledger.post({ op: 'grant', account: 'vitality', delta: 1, reason: { src: 'test' } });
      }
    });
    const s = api.getState();
    expect(api.LOG_MAX).toBe(300);
    expect(s.logs).toHaveLength(300);
    expect(s.scores.vitality).toBe(305);
    expect(s.ext.stats.evicted.vitality).toBe(5);
    expect(s.ext.stats.lifetimeVitalityIn).toBe(305); // 生命周期计数不受截断影响
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(305);
  });

  it('撤销（移除流水）后仍精确对账', () => {
    api.resetState();
    run(() => {
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 8, reason: { src: 'test' } });
      api.Ledger.post({ op: 'grant', account: 'vitality', delta: 2, reason: { src: 'test' } });
    });
    const id = api.getState().logs[0].id;
    run(() => { api.Ledger.removeLogs(l => l.id !== id); });
    const s = api.getState();
    // 移除流水只是剪枝：余额不变，被移除的 +2 从可见口径转入 evicted
    expect(s.scores.vitality).toBe(10);
    expect(s.logs).toHaveLength(1);
    expect(s.ext.stats.evicted.vitality).toBe(2);
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(10);
  });
});

describe('撤销适配器（Ledger.reverse）', () => {
  it('打卡 → 撤销：余额、流水、任务计数/连胜/累计收益全部回到打卡前', () => {
    api.resetState({ tasks: [checkinTask()] });
    api.checkIn('t1');
    let s = api.getState();
    expect(s.scores.vitality).toBe(10);
    expect(s.tasks[0]).toMatchObject({ checkInCount: 1, streak: 1, totalEarned: 10 });
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({ src: 'checkin', st: 'vitality', amt: 10, prevStreak: 0, prevLastCheckIn: null });

    api.Ledger.reverse(s.logs[0].id);
    s = api.getState();
    expect(s.scores.vitality).toBe(0);
    expect(s.logs).toHaveLength(0);
    expect(s.tasks[0]).toMatchObject({ checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0 });
    const v = sums(s);
    expect(v.visible + v.invisible + v.evicted).toBe(0);
  });

  it('带消耗的打卡撤销会连带退回消耗的活力点', () => {
    api.resetState({
      scores: { vitality: 20, progress: {}, achievement: 0 },
      tasks: [checkinTask({ vitalityCost: 4 })],
    });
    api.checkIn('t1');
    let s = api.getState();
    expect(s.scores.vitality).toBe(26); // -4 成本 +10 收益
    expect(s.logs).toHaveLength(2);
    const checkinId = s.logs.find(l => l.src === 'checkin').id;
    api.Ledger.reverse(checkinId);
    s = api.getState();
    expect(s.scores.vitality).toBe(20);
    expect(s.logs).toHaveLength(0);
  });
});

describe('资产身份兜底：单一写入口从 card:<id> 补 card 字段', () => {
  const NOW = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
  function setFixture() {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      domains: [{ id: 'd_default', name: '默认' }],
      cards: { exemption: 0, star: 0, token: 5 },
      tasks: [checkinTask({ lastCheckIn: null })],
    });
    api.patchState(s => {
      s.assetDefs.push(api.normalizeAssetDef({
        id: 'star', name: '星星', unit: '颗', maxBalance: 10, origin: 'user',
      }));
      s.assetDefs.push(api.normalizeAssetDef({
        id: 'token', name: '令牌', unit: '枚', maxBalance: 99, origin: 'user',
      }));
    });
  }
  const cardLogs = () => api.getState().logs.filter(l => l.st === 'card');

  it('活动发卡：调用方只传账户字符串，账本补齐 card', () => {
    setFixture();
    run(() => {
      api.assetGrantCore({
        mode: 'activity', assetId: 'star', amount: 1, cap: 3,
        entry: g => ({ st: 'card', amt: g, desc: '活动发卡', src: 'card-grant', granted: g }),
        reason: { src: 'card-grant' },
      });
    });
    const logs = cardLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].card).toBe('star');
    expect(api.getState().cards.star).toBe(1);
  });

  it('动作流发放与消耗：流水都带 card', () => {
    setFixture();
    run(() => {
      api.runFlowAtom('asset.grant', { assetId: 'star', amount: 2 }, { ts: NOW });
      api.runFlowAtom('asset.spend', { assetId: 'star', amount: 1 }, { ts: NOW });
    });
    const logs = cardLogs();
    expect(logs.map(l => l.card)).toEqual(['star', 'star']);
    expect(logs.map(l => l.src)).toEqual(['flow-asset-spend', 'flow-asset-grant']);
  });

  it('购买：消耗腿与赠送腿都带 card', () => {
    setFixture();
    api.patchState(s => {
      s.products.push(api.normalizeProduct({
        id: 'p1', name: '资产商品', desc: '', price: 0, stock: 2,
        categoryId: 'sc_default', tier: 'daily',
        assetPrice: { assetId: 'token', amount: 2 },
        grants: [{ kind: 'asset', assetId: 'star', amount: 1 }],
        sold: 0,
      }));
    });
    api.buyProduct('p1');
    const logs = cardLogs();
    expect(logs).toHaveLength(2);
    logs.forEach(l => {
      expect(l.card).toBe(l.src === 'purchase' ? 'token' : 'star');
    });
  });

  it('隐形消耗：visible:false 不写可见流水，余额痕迹仍指向具体资产', () => {
    setFixture();
    api.patchState(s => { s.cards.exemption = 1; });
    // 旧「直接用卡」业务入口已移除；这里直接走账务单一写入口，继续校验 card 字段兜底
    const r = api.Ledger.post({
      op: 'spend', account: 'card:exemption', delta: -1, visible: false,
      reason: { src: 'exempt-use', assetCat: 'spend', assetFrom: '手动操作', assetTo: '豁免任务「旧任务」' },
    });
    expect(r.ok).toBe(true);
    const s = api.getState();
    expect(s.cards.exemption).toBe(0);
    expect(cardLogs()).toHaveLength(0);
    const shadow = s.ext.shadow.find(x => x.acct === 'card:exemption');
    expect(shadow).toMatchObject({ acct: 'card:exemption', delta: -1, src: 'exempt-use' });
  });

  it('撤销补账：反向补账落在具体资产账户上', () => {
    setFixture();
    api.patchState(s => {
      s.products.push(api.normalizeProduct({
        id: 'p1', name: '资产商品', desc: '', price: 0, stock: 2,
        categoryId: 'sc_default', tier: 'daily',
        assetPrice: { assetId: 'token', amount: 2 }, grants: [], sold: 0,
      }));
    });
    api.buyProduct('p1');
    const leg = api.getState().logs.find(l => l.src === 'purchase');
    const r = api.undoLog(leg.id);
    expect(r.ok).toBe(true);
    const undoShadow = api.getState().ext.shadow.filter(x => String(x.src).indexOf('undo-purchase') === 0);
    expect(undoShadow.length).toBeGreaterThan(0);
    undoShadow.forEach(x => { expect(x.acct).toBe('card:token'); });
  });

  it('按资产筛选：资产流水全部归入对应资产，没有掉进「未知」', () => {
    setFixture();
    run(() => {
      api.assetGrantCore({
        mode: 'activity', assetId: 'star', amount: 2, cap: 3,
        entry: g => ({ st: 'card', amt: g, desc: '发卡测试', src: 'card-grant', granted: g }),
        reason: { src: 'card-grant' },
      });
      // 只传账户字符串的直接写入：同样要被补上 token
      api.Ledger.post({ op: 'spend', account: 'card:token', delta: -1, reason: { src: 'purchase', desc: '令牌消耗' } });
    });
    cardLogs().forEach(l => { expect(l.card).toBeTruthy(); });
    api.renderBank();
    const rows = () => (document.getElementById('logList').innerHTML.match(/class="ledger-row /g) || []).length;
    expect(rows()).toBe(2); // 未筛选：星星 + 令牌两条都在

    api.setLedgerFilter('acct', 'card:star');
    const meta = document.getElementById('logMeta');
    expect(meta.textContent).toContain('命中 1 条'); // 只剩星星那条，令牌不混入，也没有「未知」桶
    expect(rows()).toBe(1);
    api.clearLedgerFilter();
  });
});

describe('Ledger.liability：负债生命周期', () => {
  it('open / mutate / close 都留在审计里', () => {
    api.resetState();
    let id = '';
    run(() => {
      const loan = api.Ledger.liability.open({ amount: 100, debtRate: 10, currency: 'vitality', reason: { src: 'loan' } });
      id = loan.id;
      api.Ledger.liability.mutate(id, 120, { src: 'loan-interest' });
      expect(api.Ledger.liability.close(id, { src: 'loan-repay' })).toBe(true);
    });
    const s = api.getState();
    expect(s.loans).toHaveLength(0);
    const ops = s.ext.audit.map(a => a.op);
    expect(ops).toEqual(expect.arrayContaining(['liability-open', 'liability-mutate', 'liability-close']));
    const mutate = s.ext.audit.find(a => a.op === 'liability-mutate');
    expect(mutate).toMatchObject({ before: 100, after: 120, delta: 20 });
  });
});
