// Service Worker 整版清单校验（不是浏览器测试，只是静态一致性检查）。
//
// 目的：sw.js 的 PRECACHE 是“整版缓存”的唯一依据。它一旦漏文件，
// 线上就会出现“SW 装完了但这版少了某个模块”的混合版本。
// 没有构建步骤意味着清单只能手写，所以用这条测试把它钉死。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

function precacheList() {
  const m = swSrc.match(/const PRECACHE = \[([\s\S]*?)\];/);
  expect(m, 'sw.js 里应有 const PRECACHE = [...]').toBeTruthy();
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function runtimeFiles() {
  const out = ['index.html', 'style.css', 'main.js'];
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.js')) out.push('src/' + f);
  }
  return out;
}

describe('sw.js 整版清单', () => {
  it('VERSION 与缓存名绑定，且形如日期.序号', () => {
    const v = swSrc.match(/const VERSION = '([^']+)'/);
    expect(v, 'sw.js 里应有 const VERSION').toBeTruthy();
    expect(v[1]).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(swSrc).toContain("const CACHE = 'score-sys-' + VERSION;");
  });

  it('清单覆盖全部运行时文件（漏一个就是混版）', () => {
    const listed = new Set(precacheList().map(u => u.replace(/^\.\//, '')));
    listed.delete('');
    for (const f of runtimeFiles()) {
      expect(listed.has(f), `sw.js PRECACHE 缺少 ${f}`).toBe(true);
    }
  });

  it('清单里没有重复项，也没有不存在的文件', () => {
    const list = precacheList();
    const norm = list.map(u => (u === './' ? 'index.html' : u.replace(/^\.\//, '')));
    expect(new Set(norm).size).toBe(norm.length);
    for (const rel of norm) {
      expect(fs.existsSync(path.join(ROOT, rel)), `清单里的 ${rel} 不存在`).toBe(true);
    }
  });

  it('所有 import 都指向真实存在的模块（GitHub Pages 大小写敏感）', () => {
    const files = ['main.js'];
    for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
      if (f.endsWith('.js')) files.push('src/' + f);
    }
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = path.resolve(path.dirname(path.join(ROOT, f)), m[1]);
        if (!fs.existsSync(target)) missing.push(`${f} -> ${m[1]}`);
        else {
          // 大小写敏感：必须与磁盘上的真实文件名完全一致
          const real = fs.readdirSync(path.dirname(target));
          if (!real.includes(path.basename(target))) missing.push(`${f} -> ${m[1]}（大小写不符）`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
