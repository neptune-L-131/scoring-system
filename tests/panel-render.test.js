// 面板级重绘（S3-B）：注册表可枚举、逐面板与全量渲染逐字一致、未知面板空操作。
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from './shim.js';
import { render } from '../src/render.js';
import { panelTarget, panelTargetNames, renderPanel } from '../src/render-targets.js';

const NOW = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
api.__setClockForTest(() => NOW);

function setFixture() {
  api.resetState({
    scores: { vitality: 10, progress: { d_default: 5 }, achievement: 20 },
    domains: [{ id: 'd_default', name: '默认' }],
    collections: [{ id: 'c_default', name: '默认' }],
    tasks: [
      {
        id: 't1', name: '任务A', collectionId: 'c_default', domainIds: ['d_default'],
        scoreTypes: ['vitality', 'progress'], initialValue: 10, interestRate: 10, debtRate: 20,
        vitalityCost: 0, checkInCount: 1, streak: 0, lastCheckIn: null,
        totalEarned: 0, pendingDebt: 0, archived: false,
      },
      {
        id: 't2', name: '归档任务', collectionId: 'c_default', domainIds: ['d_default'],
        scoreTypes: ['vitality'], initialValue: 5, interestRate: 5, debtRate: 10,
        vitalityCost: 0, checkInCount: 1, streak: 0, lastCheckIn: null,
        totalEarned: 0, pendingDebt: 0, archived: true, archivedAt: NOW - 86400000,
      },
    ],
    logs: [
      { id: 'l1', time: NOW - 1000, st: 'both', amt: 3, amtV: 1, amtP: 2, desc: '打卡「任务A」', src: 'checkin', taskId: 't1' },
      { id: 'l2', time: NOW - 2000, st: 'vitality', amt: 5, desc: '打卡「任务A」', src: 'checkin', taskId: 't1' },
      { id: 'l3', time: NOW - 3000, st: 'purchase', amt: -2, desc: '购买「咖啡」', src: 'purchase', prodId: 'p1' },
      { id: 'l4', time: NOW - 4000, st: 'achievement', amt: -1, desc: '消费成果点', src: 'purchase', prodId: 'p2' },
    ],
    chores: [
      { id: 'c1', name: '待办杂事', createdAt: NOW - 5000, plannedAt: null, done: false, doneAt: null, archived: false, freshDays: 5, settled: false, decayKey: null },
      { id: 'c2', name: '已完成杂事', createdAt: NOW - 6000, plannedAt: null, done: true, doneAt: NOW - 2000, archived: false, freshDays: 5, settled: false, decayKey: null },
      { id: 'c3', name: '归档杂事', createdAt: NOW - 7000, plannedAt: null, done: true, doneAt: NOW - 3000, archived: true, archivedAt: NOW - 2000, freshDays: 5, settled: false, decayKey: null },
    ],
  });
  api.resetWorkUiState();
}

const html = id => document.getElementById(id).innerHTML;
const text = id => document.getElementById(id).textContent;

describe('render-targets 面板注册表', () => {
  beforeEach(setFixture);

  it('注册名可枚举', () => {
    expect(panelTargetNames().sort()).toEqual([
      'bank', 'bank.logs', 'work', 'work.affairs', 'work.chores', 'work.tasks',
    ]);
    expect(panelTarget('work.tasks')).toBeTypeOf('function');
    expect(panelTarget('bank.logs')).toBeTypeOf('function');
  });

  it('work.tasks 单独重绘与全量渲染逐字一致', () => {
    setFixture();
    render();
    const expected = {
      taskGroups: html('taskGroups'),
      archiveGroups: html('archiveGroups'),
      archiveMeta: text('archiveMeta'),
    };

    setFixture();
    expect(renderPanel('work.tasks')).toBe(true);
    expect({
      taskGroups: html('taskGroups'),
      archiveGroups: html('archiveGroups'),
      archiveMeta: text('archiveMeta'),
    }).toEqual(expected);
  });

  it('bank.logs 单独重绘与全量渲染逐字一致', () => {
    setFixture();
    render();
    const expected = { logList: html('logList'), logMeta: text('logMeta') };

    setFixture();
    expect(renderPanel('bank.logs')).toBe(true);
    expect({ logList: html('logList'), logMeta: text('logMeta') }).toEqual(expected);
  });

  it('只重绘目标面板，不触碰其它面板', () => {
    setFixture();
    render();
    document.getElementById('logList').innerHTML = 'SENTINEL-LOG';
    document.getElementById('taskGroups').innerHTML = 'SENTINEL-TASK';

    renderPanel('work.tasks');
    const tasksAfterPanel = html('taskGroups');
    expect(html('logList')).toBe('SENTINEL-LOG');
    expect(tasksAfterPanel).not.toBe('SENTINEL-TASK');

    renderPanel('bank.logs');
    expect(html('taskGroups')).toBe(tasksAfterPanel);
    expect(html('logList')).not.toBe('SENTINEL-LOG');
  });

  it('未知面板名是空操作：返回 false 且不改 DOM', () => {
    setFixture();
    render();
    const before = {
      taskGroups: html('taskGroups'),
      logList: html('logList'),
      chorePanel: html('chorePanel'),
    };
    expect(renderPanel('work.nope')).toBe(false);
    expect(renderPanel('')).toBe(false);
    expect({
      taskGroups: html('taskGroups'),
      logList: html('logList'),
      chorePanel: html('chorePanel'),
    }).toEqual(before);
  });
});

// ===== S3-C：只把「仅影响杂事面板」的动作局部化 =====
// 非杂事面板清单：覆盖 render() 里 work(除杂事)/bank/shop/budget/cycle/exempt 的固定挂载点。
const NON_CHORE_IDS = [
  // work 页（除杂事）
  'wVitality', 'wProgress', 'wAchievement', 'wProgressSub', 'domainPills',
  'taskGroups', 'archiveMeta', 'archiveGroups', 'affairPanel', 'affairMeta',
  // bank 页
  'bVitality', 'bProgress', 'bAchievement', 'bVitalitySub', 'bProgressSub', 'bAchSub',
  'vIncome', 'vSpend', 'pIncome', 'aIncome', 'aSpend',
  'totalCheckins', 'achUnlocked', 'totalPurchases',
  'logMeta', 'logList', 'shadowMeta', 'shadowList', 'achGroups',
  'trendChart', 'trendModeBtn', 'chartTooltip', 'flowChart',
  'weekCompareChart', 'weekCompareSummary', 'radarChart', 'radarEmpty', 'metricChips',
  // shop 页
  'shopList', 'purchaseList',
  // budget 页
  'budgetAnchorNotice', 'bPeriod', 'bPeriodSub', 'budgetCategories',
  'budgetLedgerMeta', 'budgetLedgerList', 'budgetRuleList', 'budgetCatDefaultDomain',
];

function nonChoreSnapshot() {
  return NON_CHORE_IDS.map(id => {
    const el = document.getElementById(id);
    return [id, el.innerHTML, el.textContent, el.className];
  });
}

// 项目面板的局部化断言用：其余挂载点（含杂事面板）都不应被纯展示动作触碰。
const NON_AFFAIR_IDS = NON_CHORE_IDS.filter(id => id !== 'affairPanel' && id !== 'affairMeta');
function nonAffairSnapshot() {
  return NON_AFFAIR_IDS.map(id => {
    const el = document.getElementById(id);
    return [id, el.innerHTML, el.textContent, el.className];
  });
}

// 局部化动作的通用断言：
// 1) 动作执行后，非杂事面板与执行前逐字一致（动作没写它们的数据）；
// 2) 随后再全量 render()，非杂事面板仍与动作后一致（证明不是“没重绘”造成的假一致）；
// 3) 杂事面板确实发生了变化（动作有可见效果）。
function expectLocalized(action) {
  render();
  const before = nonChoreSnapshot();
  const choreBefore = html('chorePanel');
  action();
  const after = nonChoreSnapshot();
  expect(after).toEqual(before);
  expect(html('chorePanel')).not.toBe(choreBefore);
  render();
  expect(nonChoreSnapshot()).toEqual(after);
}

describe('work.chores 局部重绘（S3-C）', () => {
  beforeEach(setFixture);

  it('work.chores 单独重绘与全量渲染逐字一致', () => {
    setFixture();
    render();
    const expected = html('chorePanel');

    setFixture();
    expect(renderPanel('work.chores')).toBe(true);
    expect(html('chorePanel')).toBe(expected);
  });

  it('已完成区折叠切换：非杂事面板零变化', () => {
    expectLocalized(() => api.toggleChoreDoneZone());
  });

  it('已归档区折叠切换：非杂事面板零变化', () => {
    expectLocalized(() => api.toggleChoreArchivedZone());
  });

  it('保存杂事经济设置：非杂事面板零变化', () => {
    document.getElementById('choreCfgN').value = '4';
    document.getElementById('choreCfgY').value = '9';
    expectLocalized(() => api.saveChoreConfig());
  });

  // 对照：新增杂事会写 Ledger 事件流水（银行页 logList），必须继续走全量 render()。
  it('对照：新增杂事会改动银行流水，不能局部化', () => {
    render();
    const logBefore = html('logList');
    const countBefore = (logBefore.match(/class="log-item"/g) || []).length;
    document.getElementById('choreInput').value = '新杂事';
    api.addChoreFromInput();
    expect(html('logList')).not.toBe(logBefore);
    expect((html('logList').match(/class="log-item"/g) || []).length).toBe(countBefore + 1);
  });

  // 灵敏度验证：若把“写流水”的动作错误地只重绘杂事面板，logList 会陈旧，
  // 上面的非杂事快照断言就会失败。
  it('灵敏度：写流水后只重绘杂事面板会留下陈旧的银行流水', () => {
    render();
    const countBefore = (html('logList').match(/class="log-item"/g) || []).length;
    api.getLive().chores.push({
      id: 'cx', name: '影子杂事', done: false, doneAt: null, plannedAt: null,
      createdAt: NOW, settled: false, freshDays: null, decayKey: null, archived: false,
    });
    api.Ledger.event('新增杂事「影子杂事」', 'chore-create');
    renderPanel('work.chores');
    const stale = nonChoreSnapshot();
    render();
    expect(nonChoreSnapshot()).not.toEqual(stale);
    expect((html('logList').match(/class="log-item"/g) || []).length).toBe(countBefore + 1);
  });

  it('resetWorkUiState 复位两个折叠区（含此前漏掉的已归档区）', () => {
    setFixture();
    render();
    const baseline = html('chorePanel');

    api.toggleChoreDoneZone();
    api.toggleChoreArchivedZone();
    expect(html('chorePanel')).not.toBe(baseline);

    api.resetWorkUiState();
    render();
    expect(html('chorePanel')).toBe(baseline);
  });
});

// ===== S3-C2：项目面板的纯展示状态动作局部化 =====
function expectLocalizedAffair(action) {
  render();
  const before = nonAffairSnapshot();
  const targetBefore = html('affairPanel');
  action();
  const after = nonAffairSnapshot();
  expect(after).toEqual(before);
  expect(html('affairPanel')).not.toBe(targetBefore);
  render();
  expect(nonAffairSnapshot()).toEqual(after);
}

describe('work.affairs 局部重绘（S3-C2）', () => {
  beforeEach(setFixture);

  it('work.affairs 单独重绘与全量渲染逐字一致', () => {
    setFixture();
    render();
    const expected = html('affairPanel');

    setFixture();
    expect(renderPanel('work.affairs')).toBe(true);
    expect(html('affairPanel')).toBe(expected);
  });

  it('列表/日历切换：非项目面板零变化', () => {
    expectLocalizedAffair(() => api.toggleAffairView());
  });

  it('已完成区折叠切换：非项目面板零变化', () => {
    expectLocalizedAffair(() => api.toggleAffairDone());
  });

  it('日历选日：非项目面板零变化', () => {
    render();
    api.toggleAffairView(); // 先进入日历视图，选日才有可见效果

    const before = nonAffairSnapshot();
    const targetBefore = html('affairPanel');
    api.affairSelectDay(NOW);
    expect(nonAffairSnapshot()).toEqual(before);
    expect(html('affairPanel')).not.toBe(targetBefore);
    render();
    expect(nonAffairSnapshot()).toEqual(before);
  });

  it('日历翻月：非项目面板零变化', () => {
    render();
    api.toggleAffairView();

    const before = nonAffairSnapshot();
    const targetBefore = html('affairPanel');
    api.affairCalShift(1);
    expect(nonAffairSnapshot()).toEqual(before);
    expect(html('affairPanel')).not.toBe(targetBefore);
    render();
    expect(nonAffairSnapshot()).toEqual(before);
  });

  // 对照：新建项目会写 Ledger 事件流水（银行页 logList），必须继续走全量 render()。
  it('对照：新建项目会改动银行流水，不能局部化', () => {
    render();
    const countBefore = (html('logList').match(/class="log-item"/g) || []).length;
    document.getElementById('affairInput').value = '新项目';
    api.addAffairFromInput();
    expect((html('logList').match(/class="log-item"/g) || []).length).toBe(countBefore + 1);
  });

  // 灵敏度：写流水后只重绘项目面板，logList 会陈旧，非项目快照断言随之失败。
  it('灵敏度：写流水后只重绘项目面板会留下陈旧的银行流水', () => {
    render();
    const countBefore = (html('logList').match(/class="log-item"/g) || []).length;
    api.Ledger.event('创建项目「影子项目」', 'affair-create');
    renderPanel('work.affairs');
    const stale = nonAffairSnapshot();
    render();
    expect(nonAffairSnapshot()).not.toEqual(stale);
    expect((html('logList').match(/class="log-item"/g) || []).length).toBe(countBefore + 1);
  });
});

// ===== 领域筛选：失效引用必须回落「全部」 =====
describe('领域筛选失效回落', () => {
  function seedFilter(over) {
    api.resetState(Object.assign({
      domains: [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }],
      collections: [{ id: 'c_default', name: '默认' }],
      tasks: [{
        id: 't1', name: '任务A', collectionId: 'c_default', domainIds: ['d2'],
        scoreTypes: ['progress'], initialValue: 10, interestRate: 0, debtRate: 0,
        vitalityCost: 0, checkInCount: 0, streak: 0, lastCheckIn: null,
        totalEarned: 0, pendingDebt: 0, archived: false,
      }],
      filterDomain: 'd2',
    }, over || {}));
    api.resetWorkUiState();
  }

  it('删除正在筛选的领域后筛选清空，任务重新可见', () => {
    seedFilter();
    api.delDomain('d2');
    expect(api.getLive().filterDomain).toBe(null);
    render();
    expect(html('taskGroups')).toContain('data-task-id="t1"');
  });

  it('筛选值残留失效时渲染回落「全部」，不激活任何 pill', () => {
    seedFilter({ domains: [{ id: 'd_default', name: '默认' }], filterDomain: 'ghost' });
    render();
    expect(html('taskGroups')).toContain('data-task-id="t1"');
    expect(html('domainPills')).not.toContain('domain-pill active');
  });

  it('读档归一：失效 filterDomain 变 null，有效值保留', () => {
    const raw = api.defaults();
    raw.domains = [{ id: 'd_default', name: '默认' }, { id: 'd2', name: '二' }];
    raw.filterDomain = 'ghost';
    expect(api.parseState(JSON.stringify(raw)).filterDomain).toBe(null);
    raw.filterDomain = 'd2';
    expect(api.parseState(JSON.stringify(raw)).filterDomain).toBe('d2');
  });
});
