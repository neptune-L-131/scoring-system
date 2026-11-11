// 编辑任务勾选「重算历史数据」：重算失败必须整体回滚，不得写入新参数、不得记「修改任务」事件。
import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

const task = {
  id: 't1', name: '读英语', domainIds: ['d_default'], scoreTypes: ['vitality'],
  initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0,
  checkInCount: 0, streak: 0, totalEarned: 0, lastCheckIn: null, pendingDebt: 0, archived: false,
};

const save = patch => api.saveTaskData(Object.assign({
  id: 't1', name: '读英语', domainIds: ['d_default'], scoreTypes: ['vitality'],
  initialValue: 10, interestRate: 0, debtRate: 0, vitalityCost: 0, recalc: true,
}, patch));

describe('saveTaskData + recalc：事务失败不落参数', () => {
  it('重算中途失败：返回 false、参数/余额/事件全部保持原样，之后仍能正常保存', () => {
    api.resetState({ tasks: [task] });
    api.checkIn('t1');
    const before = api.getState().scores.vitality;
    expect(before).toBe(10);

    // 无限成本让重放在发奖之后、扣成本时触发 INVALID_AMOUNT（事务中途失败）
    const failed = save({ name: '改名', vitalityCost: Infinity });
    expect(failed).toBe(false);

    let s = api.getState();
    expect(s.tasks[0].name).toBe('读英语');
    expect(s.tasks[0].initialValue).toBe(10);
    expect(s.scores.vitality).toBe(before);
    expect(s.logs.some(l => l.src === 'edit')).toBe(false);
    expect(s.logs.find(l => l.src === 'checkin').amt).toBe(10);

    // 失败后事务已回滚，正常参数仍可保存
    const ok = save({ initialValue: 12 });
    expect(ok).toBe(true);
    s = api.getState();
    expect(s.tasks[0].initialValue).toBe(12);
    expect(s.scores.vitality).toBe(12);
    expect(s.logs.some(l => l.src === 'edit')).toBe(true);
  });
});
