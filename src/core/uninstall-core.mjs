// =============================================================================
// src/core/uninstall-core.mjs — relic 卸载核心逻辑（三级）
// =============================================================================
// uninject  (去治理)：移除部署位 AGENTS.md + .bak 备份；保留一切（秒级恢复）
// deactivate(停服务)：uninject + 停用调度器（disable 而非删除——可重新启用）
// full      (完全卸载)：deactivate + push 内容库 + 删引擎/内容库/habits/状态
//
// 安全原则（不可妥协）：
//   1. 永不删 harness 本体——只删 relic 写的 AGENTS.md，不删 ~/.dsh/ 等目录
//   2. full 前自动 push 内容库（防丢用户数据）
//   3. uninject 保留最后一份副本到 STATE_DIR/uninject-backup/（一键恢复）
// =============================================================================

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { run, userHome } from './exec.mjs';
import { platformPaths } from './paths.mjs';

const HOME = userHome();
const STATE_DIR = join(HOME, '.local', 'state', 'relic');
const UNINJECT_BACKUP_DIR = join(STATE_DIR, 'uninject-backup');
const DEFAULT_CONTENT = join(HOME, '.config', 'relic-sync');

// ─── 工具 ─────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[uninstall] ${msg}`);
}

/** 列出 relic 已部署的平台（有 AGENTS.md 的） */
export function listDeployed() {
  const platforms = [
    { name: 'DSH', dirs: platformPaths(HOME, { env: process.env }).dsh, file: 'AGENTS.md' },
    { name: 'OpenCode', dirs: platformPaths(HOME, { env: process.env }).opencode, file: 'AGENTS.md' },
    { name: 'Codex', dirs: platformPaths(HOME, { env: process.env }).codex, file: 'AGENTS.md' },
  ];
  const deployed = [];
  for (const p of platforms) {
    for (const dir of p.dirs) {
      const filePath = join(dir, p.file);
      if (existsSync(filePath)) {
        deployed.push({ name: p.name, dir, filePath });
        break;
      }
    }
  }
  return deployed;
}

// ─── Level 1: 去治理（uninject） ────────────────────────────────────────

/**
 * 移除所有部署位的 AGENTS.md + .bak 备份。保留最后副本用于恢复。
 * @param {object} [opts]
 * @returns {Promise<{ok: boolean, removed: string[], saved: string[], errors: string[]}>}
 */
export async function uninject(opts = {}) {
  const removed = [];
  const saved = [];
  const errors = [];
  let deployed = listDeployed();

  if (opts.targets && opts.targets.length > 0) {
    deployed = deployed.filter(p => opts.targets.includes(p.name));
    log('selective removal: ' + opts.targets.join(', '));
  }

  if (deployed.length === 0) {
    log('未检测到已部署平台（无 AGENTS.md 需要移除）');
    return { ok: true, removed, saved, errors };
  }

  // 备份目录
  mkdirSync(UNINJECT_BACKUP_DIR, { recursive: true });
  writeFileSync(join(UNINJECT_BACKUP_DIR, 'timestamp'), new Date().toISOString());

  for (const p of deployed) {
    try {
      // 保存最后副本
      const backupPath = join(UNINJECT_BACKUP_DIR, `${p.name}-AGENTS.md`);
      copyFileSync(p.filePath, backupPath);
      saved.push(backupPath);

      // 删 AGENTS.md
      rmSync(p.filePath, { force: true });
      removed.push(p.filePath);

      // 删该目录下的 .bak.* 备份（relic backup() 产物）
      const bakFiles = readdirSync(p.dir).filter((f) => f.includes('.bak.'));
      for (const bak of bakFiles) {
        rmSync(join(p.dir, bak), { force: true });
        removed.push(join(p.dir, bak));
      }
      log(`已移除 ${p.name} 的 AGENTS.md + ${bakFiles.length} 个备份`);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, removed, saved, errors };
}

/** 恢复去治理（从 UNINJECT_BACKUP_DIR 恢复 AGENTS.md） */
export async function reinject(opts = {}) {
  const restored = [];
  const errors = [];
  if (!existsSync(UNINJECT_BACKUP_DIR)) {
    return { ok: false, restored, errors: ['无备份可恢复（去治理后未执行过）'] };
  }
  let files = readdirSync(UNINJECT_BACKUP_DIR).filter((f) => f.endsWith('-AGENTS.md'));
  if (opts.targets && opts.targets.length > 0) {
    files = files.filter(f => opts.targets.some(t => f.startsWith(t + '-')));
  }
  const platforms = {
    DSH: platformPaths(HOME, { env: process.env }).dsh,
    OpenCode: platformPaths(HOME, { env: process.env }).opencode,
    Codex: platformPaths(HOME, { env: process.env }).codex,
  };
  for (const f of files) {
    const name = f.replace('-AGENTS.md', '');
    const dirs = platforms[name];
    if (!dirs || dirs.length === 0) { errors.push(`${name}: 无候选目录`); continue; }
    const target = join(dirs[0], 'AGENTS.md');
    copyFileSync(join(UNINJECT_BACKUP_DIR, f), target);
    restored.push(target);
    log(`已恢复 ${name} → ${target}`);
  }
  return { ok: errors.length === 0, restored, errors };
}

// ─── Level 2: 停服务（deactivate） ─────────────────────────────────────

/**
 * uninject + 停用调度器（disable 而非删除）。
 * @param {object} [opts]
 */
export async function deactivate(opts = {}) {
  const inj = await uninject(opts);
  const schedResults = [];

  // Linux: systemd timer
  if (process.platform !== 'win32') {
    const r = run('systemctl', ['--user', 'disable', '--now', 'relic-sync.timer']);
    schedResults.push({ platform: 'systemd', ok: r.ok, detail: r.ok ? 'disabled' : 'not found or already disabled' });
  }
  // Win: schtasks
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Change', '/TN', 'relic-sync', '/DISABLE']);
    schedResults.push({ platform: 'schtasks', ok: r.ok, detail: r.ok ? 'disabled' : 'not found or already disabled' });
  }
  // macOS: launchd
  if (process.platform === 'darwin') {
    const plist = join(HOME, 'Library', 'LaunchAgents', 'com.relic.sync.plist');
    if (existsSync(plist)) {
      run('launchctl', ['unload', plist]);
      schedResults.push({ platform: 'launchd', ok: true, detail: 'unloaded' });
    }
  }

  return { ...inj, scheduler: schedResults };
}

// ─── Level 3: 完全卸载（full） ─────────────────────────────────────────

/**
 * deactivate + push 内容库 + 删除所有 relic 目录。
 * @param {object} opts
 * @param {string} [opts.engineDir] 引擎目录（默认从调用方推断）
 * @param {boolean} [opts.skipPush] 跳过内容库 push（测试用）
 */
export async function fullUninstall(opts = {}) {
  const deact = await deactivate(opts);
  const engineDir = opts.engineDir || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const removedDirs = [];
  const errors = [...deact.errors];

  // 1. push 内容库（防丢用户数据）
  if (!opts.skipPush && existsSync(join(DEFAULT_CONTENT, '.git'))) {
    log('推送内容库到远程（保留用户数据）...');
    const pushR = run('git', ['push'], { cwd: DEFAULT_CONTENT });
    if (!pushR.ok) {
      log('内容库 push 失败（可能有未提交改动）——尝试 commit 后再推');
      run('git', ['add', '-A'], { cwd: DEFAULT_CONTENT });
      run('git', ['commit', '-m', 'uninstall: auto-commit before full removal'], { cwd: DEFAULT_CONTENT });
      run('git', ['push'], { cwd: DEFAULT_CONTENT });
    }
  }

  // 2. 删除各目录
  const dirsToRemove = [
    { path: DEFAULT_CONTENT, label: '内容库（身份/规则/人设）' },
    { path: join(HOME, '.config', 'relic-habits'), label: '学习习惯' },
    { path: STATE_DIR, label: '状态/日志' },
  ];

  for (const d of dirsToRemove) {
    if (existsSync(d.path)) {
      try {
        rmSync(d.path, { recursive: true, force: true });
        removedDirs.push({ path: d.path, label: d.label });
        log(`已删除 ${d.label}: ${d.path}`);
      } catch (e) {
        errors.push(`删除 ${d.label} 失败: ${e.message}`);
      }
    }
  }

  // 3. 删引擎目录（最后——因为当前脚本正在引擎里跑）
  if (existsSync(engineDir) && !opts.skipEngine) {
    try {
      // 写一个标记文件让外部 shell 完成删除（self-delete 不可靠）
      const marker = join(STATE_DIR, 'pending-engine-removal');
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(marker, engineDir);
      log(`引擎目录将在进程退出后删除: ${engineDir}`);
      removedDirs.push({ path: engineDir, label: '引擎（退出后删除）', deferred: true });
    } catch (e) {
      errors.push(`标记引擎删除失败: ${e.message}`);
    }
  }

  return { ...deact, removedDirs, errors };
}
