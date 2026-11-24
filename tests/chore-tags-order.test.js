// 杂事标签 + 容器侧排序：形状守卫、幂等修复、移动/增删、渲染生效（本步不含界面）
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api } from './shim.js';

const at = (d, h, m) => new Date(2026, 4, d, h || 0, m || 0, 0, 0).getTime();
const chore = (s, id) => s.chores.find(c => c.id === id);

function choreRow(id, name, plannedAt, createdAt, doneAt) {
  return {
    id, name, plannedAt, createdAt: createdAt === undefined ? at(1, 9) : createdAt,
    done: !!doneAt, doneAt: doneAt || null, archived: false,
    freshDays: null, settled: false, decayKey: null,
  };
}

beforeEach(() => {
  api.__setClockForTest(() => at(10, 12));
  api.resetState({ domains: [{ id: 'd_default', name: '默认' }], logs: [] });
});
afterAll(() => api.__setClockForTest(null));

describe('标签：形状守卫与独立命名空间', () => {
  it('缺省 / 非数组读入空数组；非法条目丢弃，不报错', () => {
    expect(api.normalizeChoreTags(undefined)).toEqual([]);
    expect(api.normalizeChoreTags(null)).toEqual([]);
    expect(api.normalizeChoreTags('家务')).toEqual([]);
    expect(api.normalizeChoreTags([
      ' 家务 ', '', '   ', 1, null, {}, '家务', '健康',
      'x'.repeat(api.CHORE_TAG_MAX_LEN + 1),
    ])).toEqual(['家务', '健康']);
  });

  it('条数上限生效，超出部分直接丢弃', () => {
    const many = [];
    for (let i = 0; i < api.CHORE_TAG_MAX_COUNT + 4; i += 1) many.push('标签' + i);
    const out = api.normalizeChoreTags(many);
    expect(out).toHaveLength(api.CHORE_TAG_MAX_COUNT);
    expect(out[0]).toBe('标签0');
  });

  it('旧杂事读入 tags=[]；标签不做领域校验（独立命名空间）', () => {
    const old = api.migrateChore({ id: 'old', name: '旧杂事' });
    expect(old.tags).toEqual([]);
    const c = api.migrateChore({ id: 'tagged', name: '带标签', tags: ['默认', '默认', ' 出门 '] });
    expect(c.tags).toEqual(['默认', '出门']);
  });

  it('parseState 读档：旧存档补空标签，坏标签被过滤', () => {
    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.chores = [
      { id: 'c1', name: '无标签', done: false },
      { id: 'c2', name: '坏标签', done: false, tags: ['ok', 3, '', 'x'.repeat(api.CHORE_TAG_MAX_LEN + 1)] },
    ];
    const s = api.parseState(JSON.stringify(base));
    expect(chore(s, 'c1').tags).toEqual([]);
    expect(chore(s, 'c2').tags).toEqual(['ok']);
  });
});

describe('情境：标签键与卡片显示', () => {
  it('choreTagKey 忽略前导 @ 与大小写；只有 @ 时回退原文', () => {
    expect(api.choreTagKey('  @电脑 ')).toBe('电脑');
    expect(api.choreTagKey('电脑')).toBe('电脑');
    expect(api.choreTagKey('PC')).toBe(api.choreTagKey('pc'));
    expect(api.choreTagKey('@')).toBe('@');
    expect(api.choreTagKey('')).toBe('');
    expect(api.choreTagMatches('@电脑', '电脑')).toBe(true);
    expect(api.choreTagMatches('电脑', '有电话')).toBe(false);
  });

  it('choreTagIncludes 按键判重，@ 与大小写不产生第二个', () => {
    expect(api.choreTagIncludes(['电脑'], '@电脑')).toBe(true);
    expect(api.choreTagIncludes(['PC'], 'pc')).toBe(true);
    expect(api.choreTagIncludes(['电脑'], '有电话')).toBe(false);
  });

  it('collectChoreTags 按使用次数排序，同键取首次拼写，可按归档过滤', () => {
    const chores = [
      { tags: ['有电话'] },
      { tags: ['@电脑', 'PC', '有电话'] },
      { tags: ['出门'], archived: true },
    ];
    const all = api.collectChoreTags(chores, { includeArchived: true });
    expect(all.map(x => x.key)).toEqual(['有电话', '电脑', 'pc', '出门']);
    expect(all[0].count).toBe(2);
    expect(all[1].label).toBe('@电脑');
    const live = api.collectChoreTags(chores, { includeArchived: false });
    expect(live.map(x => x.key)).toEqual(['有电话', '电脑', 'pc']);
  });

  it('卡片最多显示前 3 个情境，其余收成 +n；无标签不产生节点', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [
        Object.assign(choreRow('a', '四条情境'), { tags: ['情境一', '情境二', '情境三', '情境四'] }),
        Object.assign(choreRow('b', '没有情境'), { tags: [] }),
      ],
    });
    api.resetWorkUiState();
    api.renderWork();
    const html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect((html.match(/class="chore-tags"/g) || []).length).toBe(1);
    expect((html.match(/<span class="tag d/g) || []).length).toBe(4);
    expect(html).toContain('+1');
  });
});

describe('待办池：情境筛选', () => {
  it('没有任何情境时不渲染筛选条', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [choreRow('a', '没有情境')],
    });
    api.resetWorkUiState();
    api.renderWork();
    const html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect(html).not.toContain('chore-tag-filter');
  });

  it('有情境才渲染；单选过滤待办；再次点击同一项取消', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [
        Object.assign(choreRow('a', '电脑上的事'), { tags: ['电脑'] }),
        Object.assign(choreRow('b', '电话上的事'), { tags: ['电话'] }),
        Object.assign(choreRow('c', '没有情境')),
        Object.assign(choreRow('d', '已完成的电话事'), { tags: ['电话'], done: true, doneAt: at(9, 9) }),
      ],
    });
    api.resetWorkUiState();
    api.renderWork();
    let html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect(html).toContain('chore-tag-filter');
    expect((html.match(/chore-tag-fbtn/g) || []).length).toBe(3);

    api.setChoreTagFilter('电脑');
    html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect(html).toContain('data-chore-id="a"');
    expect(html).not.toContain('data-chore-id="b"');
    expect(html).not.toContain('data-chore-id="c"');
    // 已完成区不受「此刻情境」影响
    expect(html).toContain('data-chore-id="d"');

    api.setChoreTagFilter('电脑');
    html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect(html).toContain('data-chore-id="a"');
    expect(html).toContain('data-chore-id="b"');
    expect(html).toContain('data-chore-id="c"');
  });

  it('筛选键失效时自动回到全部', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [Object.assign(choreRow('a', '电脑上的事'), { tags: ['电脑'] })],
    });
    api.resetWorkUiState();
    api.renderWork();
    api.setChoreTagFilter('电脑');
    expect(api.getState().chores[0].tags).toEqual(['电脑']);
    // 剔除最后一个该情境后重新渲染：筛选键失效，自动回到全部
    api.patchState(function(s){ s.chores[0].tags = []; });
    api.renderWork();
    const html = globalThis.document.getElementById('chorePanel').innerHTML;
    expect(html).not.toContain('chore-tag-filter');
    expect(html).toContain('data-chore-id="a"');
  });
});

describe('排序：序列形状与幂等修复', () => {
  it('归一：去重、丢弃非字符串/空串/已不存在的实体', () => {
    expect(api.normalizeChoreOrder(undefined)).toEqual([]);
    expect(api.normalizeChoreOrder(['c2', ' c1 ', 'c2', '', 5, null, 'ghost'], ['c1', 'c2']))
      .toEqual(['c2', 'c1']);
  });

  it('老存档无序列：按当前可见顺序生成，且修复幂等', () => {
    const ids = ['a', 'b', 'c'];
    const first = api.reconcileChoreOrder([], ids, ['c', 'a', 'b']);
    expect(first).toEqual(['c', 'a', 'b']);
    expect(api.reconcileChoreOrder(first, ids, ['c', 'a', 'b'])).toEqual(first);
    // 序列已存在时，只把缺失实体按 visible 顺序补在末尾，不重排已有项
    expect(api.reconcileChoreOrder(['b'], ids, ['c', 'a', 'b'])).toEqual(['b', 'c', 'a']);
  });

  it('序列残留（实体已删）时丢弃；实体新增时补到末尾', () => {
    expect(api.reconcileChoreOrder(['ghost', 'b', 'a'], ['a', 'b'], ['a', 'b'])).toEqual(['b', 'a']);
    expect(api.reconcileChoreOrder(['b', 'a'], ['a', 'b', 'n'], ['a', 'b', 'n'])).toEqual(['b', 'a', 'n']);
  });

  it('移动：之前 / 之后；目标不存在时原样返回', () => {
    const order = ['a', 'b', 'c'];
    expect(api.choreOrderMove(order, 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(api.choreOrderMove(order, 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    expect(api.choreOrderMove(order, 'a', 'ghost', 'before')).toEqual(order);
    expect(order).toEqual(['a', 'b', 'c']); // 纯函数，不改入参
  });

  it('新增落入序列 / 删除移出序列；未设置顺序时新增保持未设置', () => {
    expect(api.choreOrderInsert([], 'a')).toEqual([]);
    expect(api.choreOrderInsert(['a'], 'b')).toEqual(['a', 'b']);
    expect(api.choreOrderInsert(['a'], 'a')).toEqual(['a']);
    expect(api.choreOrderRemove(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('排序：空序列完全走原比较器；有序列按名次排', () => {
    const list = [{ id: 'a', k: 2 }, { id: 'b', k: 0 }, { id: 'c', k: 1 }];
    const cmp = (x, y) => x.k - y.k;
    expect(api.sortChoresByOrder(list, [], cmp).map(x => x.id)).toEqual(['b', 'c', 'a']);
    expect(api.sortChoresByOrder(list, ['a', 'c', 'b'], cmp).map(x => x.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('排序：渲染生效与默认零差异', () => {
  it('未设置顺序时维持原排序；设置后按序列显示', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [
        choreRow('a', '甲', at(10, 10), at(1, 9)),
        choreRow('b', '乙', at(10, 8), at(2, 9)),
        choreRow('c', '丙', null, at(3, 9)),
      ],
    });
    api.resetWorkUiState();
    const html = () => globalThis.document.getElementById('chorePanel').innerHTML;
    const ids = () => Array.from(html().matchAll(/data-chore-id="([^"]+)"/g)).map(m => m[1]);

    api.renderWork();
    // 原排序：plannedAt 升序，无日期垫底
    expect(ids()).toEqual(['b', 'a', 'c']);

    api.patchState(s => { s.choreOrder = ['c', 'a', 'b']; });
    api.renderWork();
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('创建/转换路径维护序列；parseState 丢弃残留 id', () => {
    api.resetState({
      domains: [{ id: 'd_default', name: '默认' }],
      logs: [],
      chores: [choreRow('c1', '旧', null)],
      choreOrder: ['c1'],
    });
    const created = api.createEntitiesFromTemplate('chore', { name: '新' }, at(10, 12));
    expect(api.getState().choreOrder).toEqual(['c1', created[0].id]);

    const r = api.choreToAffair('c1');
    expect(r.ok).toBe(true);
    expect(api.getState().choreOrder).toEqual([created[0].id]);

    const base = JSON.parse(JSON.stringify(api.defaults()));
    base.chores = [{ id: 'x', name: 'X', done: false }];
    base.choreOrder = ['ghost', 'x', 'x'];
    expect(api.parseState(JSON.stringify(base)).choreOrder).toEqual(['x']);
  });
});
