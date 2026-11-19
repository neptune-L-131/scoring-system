// affair-steps.js —— 项目步骤的两种形状 + 「委派杂事」引用不变式（第 6 轮 B1）
//
// 步骤形状（只加可选字段，纯步骤其余字段逐字不变）：
//   纯步骤   { text, doneAt, plannedAt, stepId? }
//   委派步骤 { text, doneAt, plannedAt, stepId?, choreRef: { id, origin } }
//   choreRef.origin：'existing' = 引用一条已有杂事；'inline' = 在项目里就地新建的杂事
//   stepId：稳定 id，只用于撤销快照对齐，不参与渲染与经济计算（B5 一）。
//
// 口径：
// 1) 老存档里的步骤没有 choreRef，读入后一律按纯步骤处理，不做批量迁移、不补字段。
// 2) 引用独占：一条杂事同一时间只能被一个委派步骤引用。被引用期间它不算普通杂事，
//    「回杂事池」才是一个有意义的动作（是否从杂事池隐藏由后续 UI 会话按本文件的判定做）。
// 3) 引用只存在步骤上（单一事实来源）：杂事侧不写反向指针，聚合按需计算。
//    这样快照/撤销只需要还原步骤本身，不会出现“两边指针不同步”的中间态。
// 4) 归一化守卫只修 choreRef，不删步骤、不调整位置、不动 stepId：
//    非法形状 / 指向不存在的杂事 / 与其他步骤争抢同一杂事 / 没有文本的委派步骤，
//    一律只删掉 choreRef 降级为纯步骤（删字段而不是重建对象），杂事自动回到杂事池。
// 5) stepId 懒补齐：不整档迁移，压撤销快照 / 新建步骤时补齐；缺失或重复才发新 id。
import { uid } from './pure.js';
import { state } from './state.js';

const STEP_CHORE_ORIGINS = ['existing', 'inline'];
const STEP_CHORE_ORIGIN_LABEL = { existing: '引用已有杂事', inline: '就地新建' };

function stepHasText(step) {
  return !!(step && String(step.text || '').trim());
}

// 读取步骤上的引用：只有 id 与 origin 都合法才算委派步骤，其余一律视为纯步骤。
function stepChoreRef(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const r = step.choreRef;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const origin = STEP_CHORE_ORIGINS.indexOf(r.origin) >= 0 ? r.origin : '';
  if (!id || !origin) return null;
  return { id: id, origin: origin };
}

function isDelegatedStep(step) {
  return !!stepChoreRef(step);
}

// 构造引用：非法入参返回 null（调用方据此保留为纯步骤，不写半个引用）。
function makeChoreRef(id, origin) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key || STEP_CHORE_ORIGINS.indexOf(origin) < 0) return null;
  return { id: key, origin: origin };
}

function stepChoreOriginLabel(origin) {
  return STEP_CHORE_ORIGIN_LABEL[origin] || '';
}

// 步骤稳定 id 的懒补齐（原地写 affair.steps，返回是否有改动）。
// 只补缺失 / 空白 / 重复的 id；已有合法 id 一字不改，所以编辑文字、调整顺序都不会换 id。
// 幂等：紧接着再调用一次返回 false，快照因此能跨两次读写保持同一条步骤的身份。
function ensureAffairStepIds(affair) {
  const steps = (affair && Array.isArray(affair.steps)) ? affair.steps : null;
  if (!steps) return false;
  const seen = new Set();
  let changed = false;
  steps.forEach(function (s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    const cur = typeof s.stepId === 'string' ? s.stepId.trim() : '';
    if (cur && !seen.has(cur)) {
      seen.add(cur);
      if (cur !== s.stepId) { s.stepId = cur; changed = true; }
      return;
    }
    let next = uid();
    while (seen.has(next)) next = uid();
    s.stepId = next;
    seen.add(next);
    changed = true;
  });
  return changed;
}

// 只读校验：不修复、不写数据，逐条列出步骤形状与引用不变式的违反项。
// type：steps-not-array / step-not-object / bad-chore-ref / delegated-step-no-text /
//       missing-chore / duplicate-chore-ref
function affairStepIssues(affairs, chores) {
  const choreIds = new Set();
  (chores || []).forEach(function (c) {
    if (c && typeof c.id === 'string' && c.id) choreIds.add(c.id);
  });
  const issues = [];
  const claims = new Map();
  (affairs || []).forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    const base = { affairId: a.id || '', affairName: String(a.name || '') };
    if (a.steps === undefined) return;
    if (!Array.isArray(a.steps)) {
      issues.push(Object.assign({ type: 'steps-not-array', stepIndex: -1 }, base));
      return;
    }
    a.steps.forEach(function (s, i) {
      const at = Object.assign({ stepIndex: i }, base);
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        issues.push(Object.assign({ type: 'step-not-object' }, at));
        return;
      }
      if (s.choreRef === undefined) return; // 纯步骤：不参与引用校验
      const ref = stepChoreRef(s);
      if (!ref) {
        issues.push(Object.assign({ type: 'bad-chore-ref', choreRef: s.choreRef }, at));
        return;
      }
      if (!stepHasText(s)) {
        issues.push(Object.assign({ type: 'delegated-step-no-text', choreId: ref.id }, at));
        return;
      }
      if (!choreIds.has(ref.id)) {
        issues.push(Object.assign({ type: 'missing-chore', choreId: ref.id }, at));
        return;
      }
      const list = claims.get(ref.id);
      if (list) list.push(at); else claims.set(ref.id, [at]);
    });
  });
  claims.forEach(function (list, choreId) {
    if (list.length < 2) return;
    list.forEach(function (at) {
      issues.push(Object.assign({ type: 'duplicate-chore-ref', choreId: choreId }, at));
    });
  });
  return issues;
}

// 读档归一：按「项目顺序 + 步骤顺序」先到先得，修复脏引用。
// 原地修改 affairs，返回 { changed, dropped }；dropped 只用于测试与排查，不写流水。
function normalizeAffairStepRefs(affairs, chores) {
  const choreIds = new Set();
  (chores || []).forEach(function (c) {
    if (c && typeof c.id === 'string' && c.id) choreIds.add(c.id);
  });
  const claimed = new Set();
  const dropped = [];
  let changed = false;
  (affairs || []).forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    if (a.steps !== undefined && !Array.isArray(a.steps)) {
      // 非数组步骤在旧读取路径里本来就等价于空列表；这里只补结构，不改任何步骤内容
      a.steps = [];
      changed = true;
      return;
    }
    if (!Array.isArray(a.steps)) return;
    a.steps.forEach(function (s, i) {
      // 非对象条目保持原位：撤销快照的旧兼容分支按位置对齐，删条目会让之后的位置错位
      if (!s || typeof s !== 'object' || Array.isArray(s)) return;
      if (s.choreRef === undefined) return;
      const ref = stepChoreRef(s);
      let reason = '';
      if (!ref) reason = 'bad-chore-ref';
      else if (!stepHasText(s)) reason = 'delegated-step-no-text';
      else if (!choreIds.has(ref.id)) reason = 'missing-chore';
      else if (claimed.has(ref.id)) reason = 'duplicate-chore-ref';
      if (!reason) {
        claimed.add(ref.id);
        return;
      }
      delete s.choreRef;
      changed = true;
      dropped.push({
        type: reason, affairId: a.id || '', affairName: String(a.name || ''),
        stepIndex: i, choreId: ref ? ref.id : '',
      });
    });
  });
  return { changed: changed, dropped: dropped };
}

// 只读索引：choreId -> 认领它的步骤列表（脏数据下可能不止一条，按原样如实返回）
function buildChoreClaimIndex(affairs) {
  const map = new Map();
  (affairs || []).forEach(function (a) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.steps)) return;
    a.steps.forEach(function (s, i) {
      const ref = stepChoreRef(s);
      if (!ref || !stepHasText(s)) return;
      const claim = {
        choreId: ref.id, affairId: a.id || '', affairName: String(a.name || ''),
        stepIndex: i, origin: ref.origin, step: s,
      };
      const list = map.get(ref.id);
      if (list) list.push(claim); else map.set(ref.id, [claim]);
    });
  });
  return map;
}

// ===== 只读聚合视图（读当前 state，供后续会话直接用，不必自己遍历） =====

// 这条杂事被哪些项目的哪些步骤引用
function choreClaimsOf(choreId, affairs) {
  const id = String(choreId || '');
  if (!id) return [];
  return buildChoreClaimIndex(affairs || state.affairs || []).get(id) || [];
}

// 这条杂事当前的唯一认领（脏数据时取最先出现的；正常数据下最多一条）
function choreClaimOf(choreId, affairs) {
  const list = choreClaimsOf(choreId, affairs);
  return list.length ? list[0] : null;
}

function isChoreClaimed(choreId, affairs) {
  return !!choreClaimOf(choreId, affairs);
}

// 全部被引用的杂事 id（后续 UI 用它把杂事池里的委派杂事排除）
function claimedChoreIds(affairs) {
  return new Set(buildChoreClaimIndex(affairs || state.affairs || []).keys());
}

// 这个项目有哪些委派步骤（返回步骤本身 + 位置 + 引用）
function affairDelegatedSteps(affair) {
  const out = [];
  const steps = (affair && Array.isArray(affair.steps)) ? affair.steps : [];
  steps.forEach(function (s, i) {
    const ref = stepChoreRef(s);
    if (!ref || !stepHasText(s)) return;
    out.push({ stepIndex: i, step: s, choreId: ref.id, origin: ref.origin });
  });
  return out;
}

export {
  STEP_CHORE_ORIGINS, STEP_CHORE_ORIGIN_LABEL,
  stepChoreRef, isDelegatedStep, makeChoreRef, stepChoreOriginLabel, ensureAffairStepIds,
  affairStepIssues, normalizeAffairStepRefs, buildChoreClaimIndex,
  choreClaimsOf, choreClaimOf, isChoreClaimed, claimedChoreIds, affairDelegatedSteps,
};
