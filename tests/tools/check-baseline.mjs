// 阶段 4 基线校验（不是 vitest 用例）。
// 用法：npm run baseline
//
// 运行三个 dump 脚本（两条旧账务 + 一条阶段 4 动作流），逐条比对固定 sha256；
// 任一不匹配则非零退出。
// 不修改旧脚本的导出字段与计算逻辑：它们的白名单就是“旧账务未漂移”的信号源。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'baseline-hashes.json'), 'utf8'));

const SCENARIOS = [
  { name: 'dump-scenario', script: path.join(HERE, 'dump-scenario.mjs') },
  { name: 'dump-scenario2', script: path.join(HERE, 'dump-scenario2.mjs') },
  { name: 'dump-stage4', script: path.join(HERE, 'dump-stage4.mjs') },
];

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function sectionHashes(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sha256(JSON.stringify(v));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[k + '.' + k2] = sha256(JSON.stringify(v2));
    }
  }
  return out;
}

function changedSections(expected, actual) {
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  return [...keys]
    .filter(k => (expected || {})[k] !== (actual || {})[k])
    .sort();
}

function tail(text, lines = 8) {
  return String(text || '').trim().split(/\r?\n/).slice(-lines).join('\n');
}

function runScenario(item) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-baseline-'));
  const file = path.join(dir, item.name + '.json');
  const expected = MANIFEST[item.name];

  try {
    if (!expected) throw new Error('baseline-hashes.json 缺少 ' + item.name);

    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(process.execPath, [item.script, file], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      stderr = (e && e.stderr) || '';
      stdout = (e && e.stdout) || '';
      const detail = tail(stderr || e.message);
      return {
        ok: false,
        name: item.name,
        reason: '场景执行失败（退出码非 0）',
        detail,
        file,
        keep: true,
      };
    }

    const m = stdout.match(/^sha256\s+([0-9a-f]{64})$/m);
    if (!m) {
      return {
        ok: false,
        name: item.name,
        reason: '场景输出中未找到 sha256 行',
        detail: tail(stdout || stderr),
        file,
        keep: true,
      };
    }

    if (!fs.existsSync(file)) {
      return {
        ok: false,
        name: item.name,
        reason: '场景没有写出结果文件',
        detail: tail(stdout || stderr),
        file,
        keep: true,
      };
    }

    const text = fs.readFileSync(file, 'utf8');
    const fileHash = sha256(text);
    const stdoutHash = m[1];
    if (fileHash !== stdoutHash) {
      return {
        ok: false,
        name: item.name,
        reason: 'stdout 的 sha256 与结果文件实测不一致',
        detail: `stdout=${stdoutHash}\nfile  =${fileHash}`,
        file,
        keep: true,
      };
    }

    if (fileHash !== expected.hash) {
      let actualSections = {};
      let parseError = '';
      try {
        actualSections = sectionHashes(JSON.parse(text));
      } catch (e) {
        parseError = e.message;
      }
      const changed = changedSections(expected.sections, actualSections);
      return {
        ok: false,
        name: item.name,
        reason: 'sha256 不匹配',
        expectedHash: expected.hash,
        actualHash: fileHash,
        changed,
        detail: parseError ? '结果文件不是合法 JSON：' + parseError : '',
        file,
        keep: true,
      };
    }

    // 文件哈希对了，再核对分段哈希，避免清单本身过期却仍报 PASS。
    let actualSections = {};
    try {
      actualSections = sectionHashes(JSON.parse(text));
    } catch (e) {
      return {
        ok: false,
        name: item.name,
        reason: 'sha256 匹配但结果文件不是合法 JSON',
        detail: e.message,
        file,
        keep: true,
      };
    }
    const changed = changedSections(expected.sections, actualSections);
    if (changed.length) {
      return {
        ok: false,
        name: item.name,
        reason: 'sha256 匹配但分段哈希与基线清单不一致（清单过期）',
        changed,
        file,
        keep: true,
      };
    }

    return {
      ok: true,
      name: item.name,
      hash: fileHash,
      sectionCount: Object.keys(expected.sections).length,
      file,
      keep: false,
    };
  } catch (e) {
    return {
      ok: false,
      name: item.name,
      reason: '校验过程异常',
      detail: tail(e && e.stack ? e.stack : e),
      file,
      keep: true,
    };
  }
}

const results = SCENARIOS.map(runScenario);
let failed = 0;

console.log('阶段 4 基线校验（旧账务 2 + 动作流 1）');
for (const r of results) {
  if (r.ok) {
    console.log(`[PASS] ${r.name.padEnd(16)} ${r.hash}  sections ${r.sectionCount}`);
    try { fs.rmSync(path.dirname(r.file), { recursive: true, force: true }); } catch (_) {}
    continue;
  }

  failed++;
  console.log(`[FAIL] ${r.name}`);
  console.log(`       原因: ${r.reason}`);
  if (r.expectedHash) console.log(`       期望 sha256: ${r.expectedHash}`);
  if (r.actualHash) console.log(`       实测 sha256: ${r.actualHash}`);
  if (r.changed && r.changed.length) {
    const shown = r.changed.slice(0, 12);
    console.log(`       差异来源: ${shown.join(', ')}${r.changed.length > shown.length ? ` 等 ${r.changed.length} 段` : ''}`);
  }
  if (r.detail) console.log(`       详情: ${r.detail.replace(/\n/g, '\n             ')}`);
  if (r.file) console.log(`       输出文件: ${r.file}`);
}

console.log(`结果: ${failed ? 'FAIL' : 'PASS'} (${results.length - failed}/${results.length})`);
if (failed) process.exitCode = 1;
