// 结构不变式：用静态扫描锁住“注册了但不会执行 / 执行了但没登记 / 新写入路径没分类”这三类静默退化。
// 文件遍历一律用 readdirSync（第六批教训：glob 花括号可能匹配不到文件，导致“零消费方”假阴性）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');

function srcFiles() {
  return fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).map(f => path.join(SRC_DIR, f));
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

// 括号配平：跳过字符串，找到与 open 位置 '(' 匹配的 ')'
function matchClose(text, open) {
  let depth = 0, q = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// 顶层逗号切分实参
function splitArgs(inner) {
  const out = [];
  let depth = 0, q = '', cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += inner[++i] || ''; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ===== 1. render.js 的 ORDER ↔ registerRenderer 双向一致 =====
describe('渲染调度：ORDER 与注册器必须一一对应', () => {
  it('ORDER ⊆ 已注册渲染器，且每个注册器都在 ORDER 里', () => {
    const orderText = read(path.join(SRC_DIR, 'render.js'));
    const om = /const\s+ORDER\s*=\s*\[([\s\S]*?)\]/.exec(orderText);
    expect(om, 'render.js 中找不到 ORDER 数组').toBeTruthy();
    const order = [...om[1].matchAll(/'([^']+)'/g)].map(x => x[1]);

    const registered = [];
    for (const file of srcFiles()) {
      const text = read(file);
      for (const m of text.matchAll(/registerRenderer\(\s*'([^']+)'/g)) registered.push(m[1]);
    }

    const missingInOrder = registered.filter(n => !order.includes(n));
    const missingRenderer = order.filter(n => !registered.includes(n));
    expect(missingInOrder, '已注册但不在 ORDER（永不执行）：' + missingInOrder.join('、')).toEqual([]);
    expect(missingRenderer, '在 ORDER 但未注册（静默跳过）：' + missingRenderer.join('、')).toEqual([]);
    // 同名重复注册会让后注册者覆盖前者，也视为不一致
    expect(new Set(registered).size, '存在重复注册：' + registered.join('、')).toBe(registered.length);
  });
});

// ===== 2. 写 state.logs 的 src 必须已分类 =====
// 扫描口径：src/*.js 里所有 `src: 'literal'`，以及 Ledger.event 的第二个实参字面量。
// 这是“写入意图”的集合，实际是否会落进 state.logs 还取决于 visible 等参数；
// 因此白名单里同时包含“隐形补账/非流水”这类永不入账的值——宁可多分类，也不漏一个新写入路径。
const WHITELIST = {
  // A. 非 state.logs：UI 状态 / 影子校准 / 实体历史时间线
  all: '账本页筛选状态，不是流水',
  calibrate: '影子校准记录，不写 state.logs',
  created: '实体历史时间线，不是流水',
  planned: '实体历史时间线，不是流水',
  started: '实体历史时间线，不是流水',
  'step-done': '实体历史时间线，不是流水',
  completed: '实体历史时间线，不是流水',
  archived: '实体历史时间线，不是流水',

  // B. 事件留痕：只描述发生过什么，没有可反转的资金/数量；撤销它等于伪造历史
  create: '创建类留痕，无资金变化',
  edit: '编辑类留痕，无资金变化',
  'affair-create': '项目创建留痕',
  'affair-edit': '项目编辑留痕',
  'affair-del': '项目删除留痕（数据删除由确认流程负责，流水本身不反转）',
  'affair-archive': '项目自动归档留痕',
  'affair-restore': '项目恢复留痕',
  'chore-create': '杂事创建留痕',
  'chore-edit': '杂事编辑留痕',
  'chore-delete': '杂事删除留痕',
  'chore-restore': '杂事恢复留痕',
  'chore-archive': '杂事自动归档留痕',
  'chore-auto-done': '杂事自动完成留痕',
  'chore-batch': '杂事批量结算留痕（结算金额由当次配置决定，不回滚）',
  'chore-decay': '超期腐化扣减，作为既成事实不单独撤销',
  'chore-progress': '杂事产出进度，取消完成时由反向写入抵消',
  'chore-progress-undo': '取消杂事完成的反向进度，属于事件留痕',
  'entity-convert': '项目/杂事互转留痕',
  'task-domain': '任务领域变更留痕',
  'budget-anchor': '预算周期起始日变更留痕',
  'flow-event-error': '事件派发失败留痕，无资金变化',

  // C. 专用撤销 / 隐形补账：由整单撤销、业务入口或相反数写入处理，不走 undoLog
  affair: '项目奖励/回收由项目撤销入口反向记账',
  'checkin-replay': '历史重放补账，隐形流水（visible:false）',
  recalc: '重算补差，隐形流水',
  'recalc-cost': '重算补差，隐形流水',
  'task-domain-migrate': '领域迁移补差，隐形流水',
  'loan-draw': '贷款放款腿，隐形流水',
  'loan-interest': '贷款计息只改负债与审计，不产生可见流水',
  'budget-topup': '预算扩容扣费，由预算侧退款入口处理',
  'budget-topup-refund': '预算扩容退款，由预算侧处理',
  'purchase-grant': '购买赠送腿，随 purchase 整单撤销',
  'flow-run': '动作流运行日记，由 undoFlowRun 整单撤销',
  'flow-currency-grant': '动作流原子写入，由整单撤销回放',
  'flow-currency-spend': '动作流原子写入，由整单撤销回放',
  'flow-asset-grant': '动作流原子写入，由整单撤销回放',
  'flow-asset-spend': '动作流原子写入，由整单撤销回放',
  'flow-note': '动作流备注原子写入，由整单撤销回放',
  'flow-task-exempt': '动作流任务豁免，由整单撤销回放',
  'entity-create': '动作流建事项原子写入，由整单撤销回放',
  'undo-flow': '动作流撤销时的隐形冲正',
  'undo-cost': '撤销时的隐形冲正',
  'undo-purchase': '撤销时的隐形冲正',
  'undo-purchase-grant': '撤销时的隐形冲正',
  'undo-achievement': '撤销时的隐形冲正',
  'undo-card-grant': '撤销时的隐形冲正',
  'undo-loan-repay': '撤销时的隐形冲正',
  'undo-manual-adjust': '撤销时的隐形冲正',
  'undo-delete-task': '撤销删除时的隐形冲正',
  'undo-delete-domain': '撤销删除时的隐形冲正',
  'undo-exempt': '撤销时的隐形冲正',
  'undo-unlock': '撤销时的隐形冲正',
  'undo-budget-penalty': '撤销时的隐形冲正',
  'undo-budget-feedback': '撤销时的隐形冲正',
  'undo-budget-reward': '撤销时的隐形冲正',
};

function collectLogSrcs() {
  const found = new Map(); // src -> Set<file:line>
  const push = (v, file, text, idx) => {
    if (!v) return;
    const line = text.slice(0, idx).split('\n').length;
    if (!found.has(v)) found.set(v, new Set());
    found.get(v).add(path.basename(file) + ':' + line);
  };
  for (const file of srcFiles()) {
    const text = read(file);
    for (const m of text.matchAll(/\bsrc\s*:\s*(['"])([^'"]+)\1/g)) push(m[2], file, text, m.index);
    for (const m of text.matchAll(/Ledger\.event\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(text, open);
      if (close < 0) continue;
      const args = splitArgs(text.slice(open + 1, close));
      if (args.length < 2) continue;
      for (const x of args[1].matchAll(/(['"])([A-Za-z][A-Za-z0-9-]*)\1/g)) {
        push(x[2], file, text, open + 1 + x.index);
      }
    }
  }
  return found;
}

describe('账本写入来源：每个 src 要么可撤销，要么显式声明不可撤销', () => {
  it('所有写入 state.logs 的 src 都已分类', () => {
    const adapters = new Set(Object.keys(api.UNDO_ADAPTERS));
    const found = collectLogSrcs();
    const unclassified = [...found.keys()].filter(src => !adapters.has(src) && !(src in WHITELIST)).sort();
    expect(
      unclassified,
      '以下 src 既没有撤销适配器，也不在不可撤销白名单：\n' +
        unclassified.map(src => src + '（' + [...found.get(src)].join(' ') + '）').join('\n')
    ).toEqual([]);
  });

  it('白名单不重复分类可撤销 src，也不为空', () => {
    const adapters = new Set(Object.keys(api.UNDO_ADAPTERS));
    const overlap = Object.keys(WHITELIST).filter(src => adapters.has(src));
    expect(overlap, '以下 src 已有撤销适配器，不应再进白名单：' + overlap.join('、')).toEqual([]);
    for (const [src, why] of Object.entries(WHITELIST)) {
      expect(why && why.trim().length, src + ' 缺少不可撤销原因注释').toBeTruthy();
    }
  });
});

// ===== 3. FLOW_ATOMS 结构 =====
describe('动作流原子：id 唯一且可选项是全集子集', () => {
  it('FLOW_ATOMS 字面量 key 无重复，且与运行时 ids 一致', () => {
    const text = read(path.join(SRC_DIR, 'flow-atoms.js'));
    const start = text.indexOf('const FLOW_ATOMS');
    const end = text.indexOf('const FLOW_ATOM_IDS');
    expect(start, '找不到 FLOW_ATOMS 定义').toBeGreaterThan(-1);
    expect(end, '找不到 FLOW_ATOM_IDS 定义').toBeGreaterThan(start);
    const literalKeys = [...text.slice(start, end).matchAll(/^  '([^']+)':\s*\{/gm)].map(x => x[1]);

    const dup = literalKeys.filter((k, i) => literalKeys.indexOf(k) !== i);
    expect(dup, 'FLOW_ATOMS 字面量存在重复 id：' + dup.join('、')).toEqual([]);
    expect([...literalKeys].sort()).toEqual([...api.FLOW_ATOM_IDS].sort());
  });

  it('FLOW_ATOM_IDS 唯一，SELECTABLE ⊆ ids，且每个原子结构完整', () => {
    const ids = api.FLOW_ATOM_IDS;
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(Object.keys(api.FLOW_ATOMS));

    const selectable = api.FLOW_ATOM_SELECTABLE_IDS;
    expect(new Set(selectable).size).toBe(selectable.length);
    const outside = selectable.filter(id => !ids.includes(id));
    expect(outside, 'SELECTABLE 里出现未注册的 id：' + outside.join('、')).toEqual([]);

    for (const id of ids) {
      const atom = api.FLOW_ATOMS[id];
      expect(Array.isArray(atom.params), id + ' 缺少 params 数组').toBe(true);
      expect(typeof atom.run, id + ' 缺少 run 函数').toBe('function');
      expect(atom.id, id + ' 的 id 字段与 key 不一致').toBe(id);
    }
  });
});
