// 静态禁令：已迁移到命令层的引擎路径不得再直接触碰落盘/渲染/提示。
//
// 分级约定：
//   - 整模块迁移完成的文件用“模块 import 级”断言（不许 import persist/render/toast）；
//   - 仍有未迁移函数在直接 save/render/toast 的文件，只能按“函数体”断言已迁移的那几条路径。
// 目前只有 budget.js 达到整模块级；其余（business/render-work/library/undo）仍是函数体级。
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// 从源码里截取某个顶层函数的函数体（按花括号配对）
function bodyOf(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces for ' + name);
}

describe('命令层静态禁令', () => {
  it('business.checkIn 不再直接调用 save/render/toast，只委托 runCommand', () => {
    const body = bodyOf(read('src/business.js'), 'checkIn');
    expect(body).toMatch(/runCommand\(/);
    expect(body).not.toMatch(/\bsave\(\)/);
    expect(body).not.toMatch(/\brender\(\)/);
    expect(body).not.toMatch(/\btoast\(/);
  });

  it('杂事三函数：命令层统一开事务与副作用', () => {
    const src = read('src/render-work.js');
    const core = read('src/chore-core.js');
    [['settleChoreBatches', src], ['processChoreDecay', core], ['toggleChoreDone', src]].forEach(([name, text]) => {
      const body = bodyOf(text, name);
      expect(body, name).toMatch(/runCommand\(/);
      expect(body, name).not.toMatch(/Ledger\.txn\(/);
      expect(body, name).not.toMatch(/\bsave\(\)/);
      expect(body, name).not.toMatch(/\brender\(\)/);
      expect(body, name).not.toMatch(/\btoast\(/);
      expect(body, name).not.toMatch(/\bcommit\(/);
    });
  });

  it('项目族三函数：命令层统一开事务与副作用', () => {
    const src = read('src/render-work.js');
    ['affairApplyProgress', 'advanceAffairStep', 'completeAffair'].forEach(name => {
      const body = bodyOf(src, name);
      expect(body, name).toMatch(/runCommand\(/);
      expect(body, name).not.toMatch(/Ledger\.txn\(/);
      expect(body, name).not.toMatch(/\bsave\(\)/);
      expect(body, name).not.toMatch(/\brender\(\)/);
      expect(body, name).not.toMatch(/\btoast\(/);
      expect(body, name).not.toMatch(/\bcommit\(/);
    });
  });

  it('budget.js 已达整模块级：不得 import 落盘/渲染/提示，也不得直接调用它们', () => {
    const src = read('src/budget.js');
    expect(src).not.toMatch(/from '\.\/persist\.js'/);
    expect(src).not.toMatch(/from '\.\/render\.js'/);
    expect(src).not.toMatch(/from '\.\/toast\.js'/);
    expect(src).not.toMatch(/\bsave\(\)/);
    expect(src).not.toMatch(/\brender\(\)/);
    expect(src).not.toMatch(/\btoast\(/);
  });

  it('library 三函数：命令层统一开事务与副作用', () => {
    const src = read('src/library.js');
    ['buyProduct', 'delTask', 'delDomain'].forEach(name => {
      const body = bodyOf(src, name);
      expect(body, name).toMatch(/runCommand\(/);
      expect(body, name).not.toMatch(/Ledger\.txn\(/);
      expect(body, name).not.toMatch(/\bsave\(\)/);
      expect(body, name).not.toMatch(/\brender\(\)/);
      expect(body, name).not.toMatch(/\btoast\(/);
      expect(body, name).not.toMatch(/\bcommit\(/);
    });
  });

  it('undo.undoLog：命令层统一开事务与收尾副作用', () => {
    const body = bodyOf(read('src/undo.js'), 'undoLog');
    expect(body).toMatch(/runCommand\(/);
    expect(body).not.toMatch(/Ledger\.txn\(/);
    expect(body).not.toMatch(/\bsave\(\)/);
    expect(body).not.toMatch(/\brender\(\)/);
    expect(body).not.toMatch(/\btoast\(/);
  });

  it('command.js 只依赖 Ledger 与三个副作用出口，不反向依赖业务模块', () => {
    const src = read('src/command.js');
    expect(src).toMatch(/from '\.\/ledger\.js'/);
    expect(src).not.toMatch(/from '\.\/business\.js'/);
    expect(src).not.toMatch(/from '\.\/state\.js'/);
  });

  it('command.js 已进入 shim 装载表与 SW 预缓存', () => {
    expect(read('tests/shim.js')).toMatch(/'command\.js'/);
    expect(read('sw.js')).toMatch(/\.\/src\/command\.js'/);
  });
});
