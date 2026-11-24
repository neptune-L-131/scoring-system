// D3：事件模式提前告知、干跑/历史显示实体主体、journal 无原始 kind:id 泄漏。
import { afterEach, describe, expect, it } from 'vitest';
import { api } from './shim.js';

const anchor = () => document.getElementById('__condAnchor');
const panelHTML = () => document.getElementById('condPanel').innerHTML;
const leaf = () => ({
  range: 'period', metric: 'checkins', op: '>=', value: 1,
  targetType: 'all', newFilter: 'none', target: '', aggregate: 'sum',
});

function condContext() {
  const draft = { mode: 'all', items: [leaf()] };
  api.setCondDraftContext(draft, 'eventCondItems', '', null, null);
  api.setCondEntityAllowed(true);
  api.openCondMetricPanel('0', anchor());
  return draft;
}

function entityFlow() {
  return api.normalizeFlow({
    id: 'fent', name: '项目格数发活力', enabled: true,
    trigger: { type: 'manual' },
    condition: {
      mode: 'all',
      items: [{
        range: 'today', metric: 'affair_cell', op: '>=', value: 5,
        targetType: 'entity', target: 'affair:a1', newFilter: 'none', aggregate: 'sum',
      }],
    },
    steps: [{ id: 's1', atom: 'currency.grant', params: { account: 'vitality', amount: 3 } }],
  });
}

afterEach(() => {
  api.setCondEventMode(false);
});

describe('事件触发：单实体点态指标在选择时就告知不可用', () => {
  it('实体专属指标在指标列表直接标记事件不可用', () => {
    condContext();
    api.setCondEventMode(true);
    api.pickCondRange('total');
    const html = panelHTML();
    expect(html).toContain('项目当前格数（事件不可用）');
    expect(html).toContain('事件触发不能使用点态指标');
  });

  it('共享指标的 entity 主体在事件模式下禁用，绕过 UI 直接调用也被拒绝', () => {
    const draft = condContext();
    api.setCondEventMode(true);
    api.pickCondMetric('affair_progress');
    const html = panelHTML();
    expect(html).toContain('事件触发按事件发生时刻求值');
    expect(html).toContain('按单个事项（事件不可用）');
    // 即便绕过按钮直接调用，也不能把草稿改成实体目标
    api.pickCondTargetType('entity');
    expect(draft.items[0].targetType).toBe('all');
    expect(draft.items[0].target).toBe('');
    expect(panelHTML()).toContain('统计主体');
  });

  it('窗口型实体指标在事件模式下仍可选实体', () => {
    condContext();
    api.setCondEventMode(true);
    api.pickCondMetric('affair_steps');
    const html = panelHTML();
    expect(html).toContain('按单个事项');
    expect(html).not.toContain('按单个事项（事件不可用）');
  });
});

describe('试跑面板 / 运行历史：实体条件不丢描述、不露原始 id', () => {
  it('流卡片与试跑面板都带条件描述行', () => {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      affairs: [{ id: 'a1', name: '装修', currentCell: 5 }],
      flows: [entityFlow()],
    });
    api.renderFlowPanel();
    expect(document.getElementById('flowList').innerHTML).toContain('条件：');
    const rep = api.dryRunFlow('fent');
    expect(rep.wouldRun).toBe(true);
    expect(rep.condition).toBe(true);
    const html = document.getElementById('flowDryPanel').innerHTML;
    expect(html).toContain('试跑结果');
    expect(html).toContain('条件：');
  });

  it('整条运行的 journal 与流水都不出现条件目标的 kind:id 原始串', () => {
    api.resetState({
      scores: { vitality: 0, progress: {}, achievement: 0 },
      affairs: [{ id: 'a1', name: '装修', currentCell: 5 }],
      flows: [entityFlow()],
    });
    const r = api.executeFlow('fent');
    expect(r.ok).toBe(true);
    expect(api.getState().scores.vitality).toBe(3);
    const recId = api.getState().ext.flowRuns.recent[0];
    const rec = api.getState().ext.flowRuns.byId[recId];
    expect(JSON.stringify(rec.journal)).not.toContain('affair:a1');
    expect(JSON.stringify(rec)).not.toContain('affair:a1');
    const descs = api.getState().logs.map(function (l) { return String(l.desc || l.note || ''); }).join('\n');
    expect(descs).toContain('项目格数发活力');
    expect(descs).not.toContain('affair:a1');
  });
});
