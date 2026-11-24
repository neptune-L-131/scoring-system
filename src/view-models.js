// view-models.js —— 面板展示数据的选择器（第五轮 S3-A）
//
// 把“卡片要展示什么”从模板字符串里拆出来：只读 state / 纯函数，返回普通对象。
// 不拼接 HTML（HTML 由 render-* + view-primitives 负责），不写 state、不触发渲染。
// 经济模型保持原样：这里只做展示口径的派生，不改变任何数值与交互。

import { choreCycleOf } from './chore-cycle.js';
import { calcCheckIn, calcSkip, dayStart, fmt, getTaskDomainIds, logAmt, now, taskCheckedToday, taskIsStaged, taskScoreTypes } from './pure.js';
import { state } from './state.js';
import { choreDoneNow, choreOverdueDays, choreProgressOf, domainName } from './utils.js';

// 任务卡：打卡预览、阶段条、豁免按钮、标签都从这一份口径取数
function taskCardView(t) {
  const types = taskScoreTypes(t);
  const hasV = types.indexOf('vitality') >= 0;
  const hasP = types.indexOf('progress') >= 0;
  const checkIn = calcCheckIn(t);
  const skip = calcSkip(t);
  const cost = t.vitalityCost || 0;
  let streak = t.streak || 0;
  if (streak === 0 && t.lastCheckIn) streak = 1;

  const checkedToday = taskCheckedToday(t);
  const todayStart = dayStart(now());
  const exemptToday = !!(t.lastExempt && t.lastExempt >= todayStart);
  // 任何配置了「任务豁免」且余额足够的资产都能承担豁免
  const recipeAssets = (state.assetDefs || []).filter(function (d) {
    return d && d.enabled !== false && !d.archived
      && d.useRecipe && d.useRecipe.type === 'task-exempt'
      && ((state.cards && state.cards[d.id]) || 0) > 0;
  });
  const canAsset = recipeAssets.length > 0;

  const typeTags = hasV && hasP
    ? [{ kind: 'v', text: '活力点' }, { kind: 'p', text: '进度值' }]
    : (hasP ? [{ kind: 'p', text: '进度值' }] : [{ kind: 'v', text: '活力点' }]);

  return {
    staged: taskIsStaged(t),
    hasV: hasV,
    hasP: hasP,
    isV: !hasP,
    cost: cost,
    streak: streak,
    checkedToday: checkedToday,
    sign: checkIn.net >= 0 ? '+' : '',
    checkIn: checkIn,
    skip: skip,
    typeTags: typeTags,
    domainNames: hasP ? getTaskDomainIds(t).map(function (id) { return domainName(id); }) : [],
    exemption: {
      canExempt: canAsset && !checkedToday && !exemptToday,
      label: checkIn.gapDays >= 2 ? '补救' : '请假',
    },
  };
}

// 项目卡：名称 + 单标签（领域进度 / 活力点）
function affairCardView(a) {
  return {
    tagKind: a.domainId ? 'p' : 'v',
    tagText: a.domainId ? domainName(a.domainId) : '活力点',
  };
}

// 杂事卡：逾期天数、进度产出、计划日期；循环杂事额外给出下次到期日
function choreCardView(c) {
  const cy = choreCycleOf(c);
  return {
    id: c.id,
    name: c.name,
    done: choreDoneNow(c),
    plannedAt: c.plannedAt || null,
    progressAmount: choreProgressOf(c).amount,
    overdueDays: choreOverdueDays(c),
    tags: Array.isArray(c.tags) ? c.tags.slice() : [],
    cycle: cy ? { unit: cy.unit, interval: cy.interval, nextDue: cy.nextDue } : null,
  };
}

// 银行流水行：金额文本、单位、正负样式、可撤销性
function logRowView(l, undoableSrc) {
  const isBoth = l.st === 'both';
  const amtCls = l.amt > 0
    ? 'pos' + (isBoth || l.st === 'progress' ? ' p' : l.st === 'achievement' ? ' a' : '')
    : l.amt < 0 ? 'neg' : 'zero';
  const dotCls = isBoth ? 'p' : l.st === 'vitality' ? 'v' : l.st === 'progress' ? 'p' : l.st === 'achievement' ? 'a' : 's';
  let amtTxt = '';
  let unit = '';
  if (isBoth) {
    // both 型打卡两个分值可能不同：分别显示，避免只看净活力误解进度收入
    const av = logAmt(l, 'vitality');
    const ap = logAmt(l, 'progress');
    amtTxt = (av > 0 ? '+' : '') + fmt(av) + ' 活力 / ' + (ap > 0 ? '+' : '') + fmt(ap) + ' 进度';
  } else {
    const sign = l.amt > 0 ? '+' : '';
    amtTxt = l.amt !== 0 ? sign + fmt(l.amt) : '—';
    unit = l.st === 'vitality' ? ' 活力' : l.st === 'progress' ? ' 进度' : l.st === 'achievement' ? ' 成果' : l.st === 'card' ? ' 张' : '';
  }
  return {
    id: l.id,
    desc: l.desc,
    time: l.time,
    dot: dotCls,
    amtCls: amtCls,
    amount: amtTxt + unit,
    canUndo: (undoableSrc || []).indexOf(l.src) >= 0,
  };
}

// 余额调整行（已由 stats.js 提供文案与账户名，这里只做展示口径）
function shadowRowView(r) {
  const d = Number(r.delta) || 0;
  const unit = r.acct === 'vitality' ? ' 活力' : r.acct === 'achievement' ? ' 成果' : r.acct.indexOf('progress:') === 0 ? ' 进度' : r.acct.indexOf('card:') === 0 ? ' 张' : '';
  const between = (r.before !== null && r.before !== undefined)
    ? (' · ' + fmt(r.before) + ' → ' + fmt(r.after)) : '';
  return {
    dot: 's',
    amtCls: d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero',
    amount: (d > 0 ? '+' : '') + fmt(d) + unit,
    time: r.ts,
    range: between,
  };
}

export { taskCardView, affairCardView, choreCardView, logRowView, shadowRowView };
