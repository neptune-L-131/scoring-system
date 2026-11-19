// chore-list.js —— 杂事标签归一 + 容器侧排序序列（纯计算，不读写 state）
//
// 标签：chore.tags 是纯文本数组，独立于「领域」命名空间；不参与任何经济计算。
// 排序：顺序存在容器侧（state.choreOrder），元素是杂事 id 序列；空数组表示“未设置”，
// 渲染回落到原有排序，从而保证零差异。实体本身不保存序号，删一条无需重排所有人。
import { CHORE_TAG_MAX_COUNT, CHORE_TAG_MAX_LEN } from './constants.js';

// 单个标签：必须是非空字符串；超出长度上限直接丢弃（不截断、不报错）。
function normalizeChoreTag(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.length > CHORE_TAG_MAX_LEN) return '';
  return s;
}

// 标签数组归一：旧存档缺省读入 []；非法条目丢弃；trim 后完全相同即视为重复。
// 超出条数上限的部分丢弃，不迁移、不补齐。
function normalizeChoreTags(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = Object.create(null);
  for (let i = 0; i < raw.length && out.length < CHORE_TAG_MAX_COUNT; i += 1) {
    const tag = normalizeChoreTag(raw[i]);
    if (!tag || seen[tag]) continue;
    seen[tag] = 1;
    out.push(tag);
  }
  return out;
}

// 顺序序列归一：只保留非空字符串 id，去重；validIds 存在时丢弃已不存在的实体 id。
// 不追加缺失实体（“未设置顺序”保持为空，由渲染回落到原排序）。
function normalizeChoreOrder(raw, validIds) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const valid = validIds ? new Set(Array.from(validIds).map(String)) : null;
  const seen = Object.create(null);
  raw.forEach(function (v) {
    if (typeof v !== 'string') return;
    const id = v.trim();
    if (!id || seen[id]) return;
    if (valid && !valid.has(id)) return;
    seen[id] = 1;
    out.push(id);
  });
  return out;
}

// 幂等修复：保留序列里仍存在的 id（顺序不变），缺失实体按 fallbackIds 追加。
// fallbackIds 传“当前显示顺序”，因此老存档无序列时生成的结果与原列表逐项一致。
function reconcileChoreOrder(order, entityIds, fallbackIds) {
  const ids = new Set((entityIds || []).map(String));
  const out = [];
  const seen = Object.create(null);
  normalizeChoreOrder(order).forEach(function (id) {
    if (!ids.has(id) || seen[id]) return;
    seen[id] = 1;
    out.push(id);
  });
  (fallbackIds || []).forEach(function (v) {
    const id = String(v);
    if (!ids.has(id) || seen[id]) return;
    seen[id] = 1;
    out.push(id);
  });
  return out;
}

// 新增落入序列：序列已建立时追加到末尾；未设置（空）时保持未设置，避免单条序列
// 把新旧杂事的相对顺序打乱。
function choreOrderInsert(order, id) {
  const list = Array.isArray(order) ? order.slice() : [];
  const key = String(id || '');
  if (!key || !list.length || list.indexOf(key) >= 0) return list;
  list.push(key);
  return list;
}

function choreOrderRemove(order, id) {
  const key = String(id || '');
  return (Array.isArray(order) ? order : []).filter(function (x) { return x !== key; });
}

// 把 id 移到 targetId 之前/之后；任一方不在序列里时原样返回（调用方先做 reconcile）。
function choreOrderMove(order, id, targetId, place) {
  const src = String(id || '');
  const tgt = String(targetId || '');
  const list = (Array.isArray(order) ? order : []).slice();
  if (!src || !tgt || src === tgt) return list;
  const from = list.indexOf(src);
  const to = list.indexOf(tgt);
  if (from < 0 || to < 0) return list;
  list.splice(from, 1);
  const at = list.indexOf(tgt);
  list.splice(place === 'after' ? at + 1 : at, 0, src);
  return list;
}

// 渲染排序：有序列时按序列名次排，未入序列的条目排在已入序列的之后，
// 同档再用 fallback 比较器；序列为空时完全交给 fallback（零差异判据）。
function sortChoresByOrder(list, order, fallback) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const rank = new Map();
  (Array.isArray(order) ? order : []).forEach(function (id, i) {
    if (typeof id === 'string' && !rank.has(id)) rank.set(id, i);
  });
  if (!rank.size) return fallback ? arr.sort(fallback) : arr;
  return arr.sort(function (a, b) {
    const ra = (a && rank.has(a.id)) ? rank.get(a.id) : Infinity;
    const rb = (b && rank.has(b.id)) ? rank.get(b.id) : Infinity;
    return (ra - rb) || (fallback ? fallback(a, b) : 0);
  });
}

export {
  normalizeChoreTag, normalizeChoreTags, normalizeChoreOrder, reconcileChoreOrder,
  choreOrderInsert, choreOrderRemove, choreOrderMove, sortChoresByOrder,
};
