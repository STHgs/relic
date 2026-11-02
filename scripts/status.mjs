// =============================================================================
// scripts/status.mjs — 治理状态 CLI（与控制台 /api/status 同源）
// =============================================================================
// 用途：不开 GUI 也能看清"哪些平台已治理 / 已安装未治理 / 何时同步过"，
// 便于排查"新装了 harness 但治理没跟上"这类问题。
//   npm run status          # 文本表
//   npm run status -- --json # 机器可读（脚本/CI 用）
// 只读：不写文件、不改调度器。
// =============================================================================

import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { userHome } from '../src/core/exec.mjs';
import { collectPlatformStatus } from '../src/core/platform-status.mjs';
import { createScheduler } from '../src/core/scheduler.mjs';
import { readHabits, HABITS_FILE } from '../src/core/habits.mjs';
import { countPendingProposals } from '../src/core/habits-ingest.mjs';
import { planSandboxAccess } from '../src/core/sandbox-access.mjs';
import { run } from '../src/core/exec.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = userHome();
const CONTENT = process.env.RELIC_CONTENT_REPO || join(HOME, '.config', 'relic-sync');

const LABELS = {
  governed: '已治理',
  stale: '已过期（待同步）',
  ungoverned: '已检测未治理',
  absent: '未检测',
};

function readLastSync() {
  try {
    return JSON.parse(readFileSync(join(CONTENT, '.last-sync'), 'utf8'));
  } catch {
    return null;
  }
}

function schedulerStatus() {
  try {
    return createScheduler({ repo: REPO, home: HOME }).status();
  } catch (e) {
    return { backend: 'unknown', installed: false, enabled: false, running: null, detail: e.message };
  }
}

const lastSync = readLastSync();
// 过期判定：用本次渲染产物对比（dry-run，不写盘）
let renderMap = null;
try {
  const { pipeline } = await import('../src/index.mjs');
  const dry = await pipeline({ policiesPath: join(CONTENT, 'policies.yaml'), home: HOME, dryRun: true, runtimeRoot: CONTENT });
  if (dry.ok) renderMap = dry.fileMaps;
} catch { /* 未部署或内容不可读：跳过过期判定 */ }

const status = collectPlatformStatus({
  home: HOME,
  contentRepo: CONTENT,
  renderMap,
});
const scheduler = schedulerStatus();

// 学习库（habits v3）：库内条数 + 待合并提案（只读探测）
let habits = { entries: 0, pending: 0, files: [], file: HABITS_FILE() };
try {
  const store = readHabits();
  const pending = countPendingProposals();
  habits = { entries: store.entries.length, pending: pending.total, files: pending.files, file: HABITS_FILE() };
} catch { /* 库不可读：保持零值 */ }

// 沙箱只读访问（仅 Windows + Codex 有意义；其余平台返回 applicable:false）
let sandbox = { applicable: false, reason: '未探测' };
try {
  sandbox = planSandboxAccess({
    dirs: [CONTENT, join(HOME, '.config', 'relic-habits')],
    exec: (cmd, args) => run(cmd, args),
  });
} catch (e) {
  sandbox = { applicable: false, reason: e.message };
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ home: HOME, repo: REPO, content: CONTENT, lastSync, scheduler, habits, sandbox, ...status }, null, 2) + '\n');
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('relic 治理状态');
console.log(`  引擎     ${REPO}`);
console.log(`  内容库   ${CONTENT}`);
console.log(`  上次同步 ${lastSync?.time ?? '从未'}`);
for (const p of status.platforms) {
  const declaredNote = p.declaredPath && !p.declaredExists ? `  (声明路径已失效: ${p.declaredPath})` : '';
  console.log(`  ${pad(p.name, 9)} ${LABELS[p.status] ?? p.status}  ${p.target ?? '—'}${declaredNote}`);
}
console.log(`  定时同步 ${scheduler.installed ? (scheduler.enabled ? '已启用' : '已禁用') : '未安装'} (${scheduler.backend})`);
console.log(`  学习库   ${habits.entries} 条，待合并提案 ${habits.pending} 行`);
if (sandbox.applicable) {
  const missing = (sandbox.dirs || []).filter((d) => d.exists && !d.granted).map((d) => d.path);
  console.log(`  Codex 沙箱可读  ${sandbox.needsGrant ? `否（${missing.length} 个目录未授权）` : '是'}${sandbox.groupExists ? '' : '（未启用 Codex 沙箱）'}`);
}

if (status.ungoverned.length > 0) {
  console.log('\n→ 有平台已安装但未部署治理：打开控制台（npm run wizard）点「重新部署治理」，');
  console.log('  或直接运行 `npm run sync -- --no-gate` 立即部署。');
}
