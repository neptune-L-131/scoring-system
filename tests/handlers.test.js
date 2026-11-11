// 内联事件处理器回归：模板里出现的 onclick/onchange 等函数名必须全部登记在 main.js 的 __HANDLERS__。
// 背景：ES module 不再共享全局作用域，内联属性按名字查 window；漏登记时点击只会静默失效，
// 现有机制只做「__HANDLERS__ → __ALL__」单向校验，抓不到「模板 → __HANDLERS__」这一侧的遗漏。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 内联属性里可能出现的 JS 关键字/浏览器内置名，不属于需要挂载的应用处理器
const NON_HANDLER = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'event', 'this', 'Number', 'String', 'Boolean', 'Math',
  'JSON', 'Object', 'Array', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'confirm', 'alert',
  'prompt', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'structuredClone', 'window', 'document', 'console',
]);

// 从一段内联属性值里提取「运行时会被 window 查找」的函数名。
// 渲染期的字符串拼接（'...'+fn(x)+'...'）不在字符串字面量内，会被 inStr 状态排除；
// 例如 onclick="openX(''+escAttr(id)+'')" 里的 escAttr 是渲染期调用，不是内联处理器。
function inlineHandlerNames(chunk, startInString) {
  const out = [];
  let inStr = startInString;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'") { inStr = !inStr; continue; }
    if (!inStr) continue;
    if (/[A-Za-z_$]/.test(ch) && (i === 0 || !/[.\w$]/.test(chunk[i - 1]))) {
      let j = i + 1;
      while (j < chunk.length && /[\w$]/.test(chunk[j])) j++;
      const name = chunk.slice(i, j);
      let k = j;
      while (k < chunk.length && /\s/.test(chunk[k])) k++;
      if (chunk[k] === '(' && !NON_HANDLER.has(name)) out.push(name);
      i = j - 1;
    }
  }
  return out;
}

function collectTemplateHandlers() {
  const files = [path.join(ROOT, 'index.html')];
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.js')) files.push(path.join(ROOT, 'src', f));
  }
  const found = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const isHtml = file.endsWith('.html');
    const re = /\bon[a-z]+\s*=\s*/g;
    let m;
    while ((m = re.exec(text))) {
      const i = re.lastIndex;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") continue;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j++;
        j++;
      }
      if (j >= text.length) continue;
      const chunk = text.slice(i + 1, j);
      for (const name of inlineHandlerNames(chunk, true)) {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(path.basename(file));
      }
    }
  }
  return found;
}

function readHandlers() {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const arr = /const __HANDLERS__\s*=\s*\[([\s\S]*?)\];/.exec(main);
  expect(arr, 'main.js 中找不到 __HANDLERS__ 数组').toBeTruthy();
  return [...arr[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

describe('内联事件处理器登记', () => {
  it('模板用到的处理器名必须全部出现在 __HANDLERS__（漏登记会让按钮静默失效）', () => {
    const handlers = new Set(readHandlers());
    const used = collectTemplateHandlers();
    const missing = [...used.keys()].filter(n => !handlers.has(n)).sort()
      .map(n => n + '（' + [...used.get(n)].join('、') + '）');
    expect(missing, '以下内联处理器未登记到 main.js __HANDLERS__：\n' + missing.join('\n')).toEqual([]);
  });

  it('__HANDLERS__ 中的每个名字都必须能解析到真实函数（拦截拼写错误与未导出）', () => {
    const broken = readHandlers().filter(n => typeof api[n] !== 'function');
    expect(broken, '以下处理器在模块导出中找不到函数实现：' + broken.join('、')).toEqual([]);
  });

  it('被报告失效的两个按钮确实已登记', () => {
    const handlers = new Set(readHandlers());
    for (const n of ['budRuleEditWhen', 'budRuleDoneWhen', 'toggleAffairView', 'delMetric', 'closeAffairMenu']) {
      expect(handlers.has(n), n + ' 未登记').toBe(true);
    }
  });
});
