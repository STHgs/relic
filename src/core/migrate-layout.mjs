// =============================================================================
// src/core/migrate-layout.mjs — 旧布局 → ~/.relic 自动迁移（v0.0.4）
// =============================================================================
// 目标布局：
//   ~/.relic/{engine,sync,habits,state} + relic.config.json
// 旧布局：
//   ~/.config/relic（引擎）、~/.config/relic-sync、~/.config/relic-habits、
//   ~/.local/state/relic、~/.relic-sync.log（Windows 引擎在 %USERPROFILE%\relic）
//
// 语义（用户拍板）：
//   · 自动：任何会用到布局的命令入口先调用 ensureLayout()；
//   · 硬切：迁移完成后解析链只认 ~/.relic，不保留旧路径回退；
//   · 只迁部署引擎：旧规范路径里的引擎（或调度器指向的 clone）才搬；
//     开发 clone（如 ~/workspace/relic）原地不动；
//   · 保留备份：旧目录先移到 <root>/state/migrate-backup-<时间戳>/，再复制到新位置；
//     备份由用户/维护者在确认成功后清理（npm run migrate -- --cleanup-backup）。
//
// 安全：迁移前要求内容库工作树干净；全程持 <root>/.migrate.lock；失败回滚并如实报错。
// =============================================================================

import {
  existsSync, mkdirSync, renameSync, cpSync, rmSync, readFileSync, writeFileSync,
  openSync, closeSync, readdirSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  relicRoot, relicLayout, legacyLayout, detectLegacyLayout, homeFrom,
  readRelicConfig, writeRelicConfig,
} from './relic-root.mjs';
import { createScheduler } from './scheduler.mjs';
import { shortcutFiles } from './console-service.mjs';
import { run as defaultRun } from './exec.mjs';

const SELF_ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 生成迁移计划（只读）。
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {string} [opts.engineRoot] 当前引擎根（默认模块自身位置）
 * @param {object} [opts.fsx]
 * @returns {{root:string, layout:object, legacy:object, units:object[], needed:boolean, backup:string}}
 */
export function planMigration(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeFrom(env);
  const platform = opts.platform ?? process.platform;
  const fsx = opts.fsx || { existsSync };
  const exists = (p) => Boolean(p) && fsx.existsSync(p);
  const root = relicRoot(env, home);
  const L = relicLayout(root);
  const legacy = legacyLayout(home, platform, env);
  const engineRoot = opts.engineRoot ?? SELF_ENGINE;
  const engineIsSelf = exists(legacy.engine)
    && resolve(legacy.engine) === resolve(engineRoot)
    && resolve(legacy.engine) !== resolve(L.engine);

  const units = [];
  const add = (id, from, to, extra = {}) => {
    if (exists(from) && !exists(to)) units.push({ id, from, to, ...extra });
  };
  add('sync', legacy.content, L.content);
  add('habits', legacy.habits, L.habits);
  add('state', legacy.state, L.state, { merge: true });
  add('log', legacy.syncLog, L.syncLog);
  if (exists(legacy.engine) && !exists(L.engine)) {
    units.push({ id: 'engine', from: legacy.engine, to: L.engine, isSelf: engineIsSelf });
  } else if (exists(legacy.engine) && exists(L.engine) && resolve(legacy.engine) !== resolve(L.engine)) {
    // 新引擎已就位（如 Windows 安装器先 clone 再迁移）：旧引擎只归档不留原位
    units.push({ id: 'engine-leftover', from: legacy.engine, to: L.engine, leftover: true });
  }
  const needed = units.length > 0;
  return {
    root, layout: L, legacy, units, needed,
    backup: join(L.state, `migrate-backup-${stamp()}`),
    engineRoot,
  };
}

function writeJournal(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  } catch { /* 诊断信息失败不阻塞 */ }
}

function contentIsClean(fsx, runFn, contentDir) {
  if (!fsx.existsSync(join(contentDir, '.git'))) return { ok: true, dirty: false };
  const r = runFn('git', ['status', '--porcelain'], { cwd: contentDir });
  if (!r.ok) return { ok: false, reason: `git status 失败：${(r.stderr || '').trim()}` };
  const dirty = String(r.stdout || '').trim().length > 0;
  return { ok: true, dirty };
}

/**
 * 执行迁移（apply=false 时只返回计划）。
 * @param {object} [opts]
 * @param {boolean} [opts.apply] true 才实际移动
 * @param {boolean} [opts.force] 内容库脏也迁移（不推荐）
 * @param {boolean} [opts.scheduler] 是否重写调度器（默认 true；测试传 false）
 * @param {boolean} [opts.shortcut] 是否重建快捷方式（默认 true）
 * @returns {{ok:boolean, migrated:boolean, plan:object, steps:object[], backup?:string,
 *            deferredEngineRemoval?:string, errors?:string[]}}
 */
export function migrateLayout(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeFrom(env);
  const platform = opts.platform ?? process.platform;
  const fsx = opts.fsx || { existsSync, mkdirSync, renameSync, cpSync, rmSync, readFileSync, writeFileSync };
  const runFn = opts.runFn ?? defaultRun;
  const plan = planMigration({ ...opts, env, home, platform });
  const { root, layout: L, legacy, units } = plan;

  if (!plan.needed) {
    return { ok: true, migrated: false, plan, steps: [], reason: '已在目标布局，无需迁移' };
  }
  if (!opts.apply) {
    return { ok: true, migrated: false, dryRun: true, plan, steps: units.map((u) => ({ id: u.id, from: u.from, to: u.to })) };
  }

  // 内容库脏拒（防丢未提交改动）
  if (units.some((u) => u.id === 'sync') && !opts.force) {
    const clean = contentIsClean(fsx, runFn, legacy.content);
    if (!clean.ok || clean.dirty) {
      return {
        ok: false, migrated: false, plan, steps: [],
        reason: clean.dirty
          ? `内容库有未提交改动，拒绝迁移：${legacy.content}（先 commit/push，或 --force）`
          : clean.reason,
      };
    }
  }

  mkdirSync(root, { recursive: true });
  mkdirSync(L.state, { recursive: true });
  const lockPath = join(root, '.migrate.lock');
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    return { ok: false, migrated: false, plan, steps: [], reason: `迁移锁已存在：${lockPath}（另一进程正在迁移；确认无进程后删除该文件重试）` };
  }

  const journalPath = join(L.state, 'migrate-journal.json');
  const journal = { startedAt: new Date().toISOString(), root, backup: plan.backup, engineRoot: plan.engineRoot, steps: [] };
  writeJournal(journalPath, journal);

  const steps = [];
  const created = [];           // 本次新建的目标目录（回滚时删除）
  let backup = plan.backup;
  let deferredEngine = null;

  const step = (id, detail, extra = {}) => {
    const s = { id, detail, at: new Date().toISOString(), ...extra };
    steps.push(s);
    journal.steps.push(s);
    writeJournal(journalPath, journal);
  };

  const copyDir = (from, to) => {
    fsx.cpSync(from, to, { recursive: true, force: true, dereference: true, errorOnExist: false });
  };
  const moveToBackup = (from, name) => {
    mkdirSync(backup, { recursive: true });
    const dest = join(backup, name);
    if (fsx.existsSync(dest)) {
      // 备份已存在（重试场景）：追加时间后缀，避免覆盖
      const alt = `${dest}-${stamp()}`;
      fsx.renameSync(from, alt);
      return alt;
    }
    fsx.renameSync(from, dest);
    return dest;
  };

  try {
    for (const u of units) {
      if (u.id === 'engine-leftover') {
        const bak = moveToBackup(u.from, 'engine-leftover');
        step('engine-leftover', `旧引擎归档到 ${bak}（新引擎已在 ${L.engine}）`);
        continue;
      }
      if (u.id === 'engine') {
        if (u.isSelf) {
          // 当前进程就跑在旧引擎里：先复制，旧目录保留到下次运行再清理
          copyDir(u.from, u.to);
          created.push(u.to);
          deferredEngine = u.from;
          step('engine', `复制自身引擎 → ${u.to}（旧目录延迟清理）`, { deferred: true });
        } else {
          const bak = moveToBackup(u.from, 'engine');
          copyDir(bak, u.to);
          created.push(u.to);
          step('engine', `旧引擎 → 备份 ${bak}，复制到 ${u.to}`);
        }
        continue;
      }
      if (u.id === 'state') {
        const bak = moveToBackup(u.from, 'state');
        mkdirSync(L.state, { recursive: true });
        copyDir(bak, L.state);
        step('state', `旧状态/日志 → 备份 ${bak}，合并到 ${L.state}`);
        continue;
      }
      const bak = moveToBackup(u.from, u.id);
      copyDir(bak, u.to);
      created.push(u.to);
      step(u.id, `${u.from} → 备份 ${bak}，复制到 ${u.to}`);
    }

    // 根级配置：合并旧引擎配置，contentRepo 指向新内容库
    const cfgSources = [
      join(L.engine, 'relic.config.json'),
      join(backup, 'engine', 'relic.config.json'),
      join(backup, 'engine-leftover', 'relic.config.json'),
    ];
    let cfg = {};
    for (const s of cfgSources) {
      if (fsx.existsSync(s)) { cfg = safeJson(s) || {}; break; }
    }
    cfg = { ...cfg, contentRepo: L.content };
    writeRelicConfig(cfg, root);
    try { fsx.rmSync(join(L.engine, 'relic.config.json'), { force: true }); } catch { /* 旧文件可留 */ }
    step('config', `根级 relic.config.json → contentRepo=${L.content}`);

    // 校验（迁移成功的硬条件）
    const missing = [];
    if (!fsx.existsSync(L.content) && !fsx.existsSync(join(L.content, '.git'))) missing.push('sync');
    if (units.some((u) => u.id === 'engine') && !fsx.existsSync(join(L.engine, 'package.json'))) missing.push('engine');
    if (units.some((u) => u.id === 'habits') && !fsx.existsSync(L.habits)) missing.push('habits');
    if (missing.length > 0) throw new Error(`迁移后校验失败：缺少 ${missing.join(', ')}`);

    // 调度器改指新引擎（只在已安装时收敛，不无中生有）
    if (opts.scheduler !== false && units.some((u) => u.id === 'engine' || u.id === 'engine-leftover')) {
      try {
        const sched = createScheduler({ home, repo: L.engine, runFn, logPath: L.syncLog });
        const st = sched.status();
        if (st.installed) {
          const r = sched.install();
          step('scheduler', `调度器指向 ${L.engine}（${r.ok ? 'ok' : '失败：' + (r.notes || []).join('; ')}）`);
        } else {
          step('scheduler', '未安装调度器，跳过');
        }
      } catch (e) {
        step('scheduler', `调度器重写失败（不阻塞）：${e.message}`);
      }
    }

    // 快捷方式改指新引擎（仅当旧快捷方式存在）
    if (opts.shortcut !== false) {
      try {
        const oldFiles = shortcutFiles({ home, repo: legacy.engine });
        if (oldFiles.some((f) => fsx.existsSync(f.path)) && fsx.existsSync(join(L.engine, 'scripts', 'console-shortcut.mjs'))) {
          const r = runFn('node', [join(L.engine, 'scripts', 'console-shortcut.mjs')], { cwd: L.engine });
          step('shortcut', `快捷方式指向 ${L.engine}（${r.ok ? 'ok' : '失败'}）`);
        }
      } catch (e) {
        step('shortcut', `快捷方式重建失败（不阻塞）：${e.message}`);
      }
    }

    if (deferredEngine) {
      writeFileSync(join(L.state, 'pending-engine-removal.json'), JSON.stringify({
        path: deferredEngine, backup, since: new Date().toISOString(),
      }, null, 2) + '\n');
      step('deferred', `旧引擎目录 ${deferredEngine} 待下次运行清理（保留为备份）`);
    }

    journal.ok = true;
    journal.finishedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    writeFileSync(join(L.state, 'last-migration.json'), JSON.stringify({
      at: journal.finishedAt, backup, steps,
    }, null, 2) + '\n');

    return { ok: true, migrated: true, plan, steps, backup, deferredEngineRemoval: deferredEngine || undefined };
  } catch (e) {
    // 回滚：删除本次新建目标 → 备份挪回旧位置 → 清理根级配置
    const errors = [];
    for (const target of created.reverse()) {
      try { fsx.rmSync(target, { recursive: true, force: true }); } catch (err) { errors.push(`删除 ${target}: ${err.message}`); }
    }
    for (const u of units) {
      const bak = join(backup, u.id === 'log' ? 'log' : u.id);
      try {
        if (u.id === 'engine') {
          if (fsx.existsSync(join(backup, 'engine')) && !fsx.existsSync(u.from)) fsx.renameSync(join(backup, 'engine'), u.from);
          continue;
        }
        if (u.id === 'state') continue; // 状态合并类：备份保留，原目录已被移走
        if (fsx.existsSync(bak) && !fsx.existsSync(u.from)) fsx.renameSync(bak, u.from);
      } catch (err) { errors.push(`回滚 ${u.id}: ${err.message}`); }
    }
    try { fsx.rmSync(join(root, 'relic.config.json'), { force: true }); } catch { /* ignore */ }
    journal.ok = false;
    journal.error = e.message;
    journal.rollbackErrors = errors;
    journal.finishedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    return { ok: false, migrated: false, plan, steps, backup, reason: e.message, rollbackErrors: errors };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 清理上次迁移遗留的旧引擎目录（移动到备份，不直接删除）。
 * @param {object} [opts]
 * @returns {null|{ok:boolean, moved?:string, reason?:string}}
 */
export function sweepPendingEngineRemoval(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeFrom(env);
  const fsx = opts.fsx || { existsSync, renameSync, rmSync, mkdirSync, readFileSync, writeFileSync };
  const L = relicLayout(relicRoot(env, home));
  const marker = join(L.state, 'pending-engine-removal.json');
  if (!fsx.existsSync(marker)) return null;
  const data = safeJson(marker) || {};
  const oldPath = data.path;
  if (!oldPath || !fsx.existsSync(oldPath)) {
    try { fsx.rmSync(marker, { force: true }); } catch { /* ignore */ }
    return { ok: true, reason: '旧引擎目录已不存在，标记已清理' };
  }
  const engineRoot = opts.engineRoot ?? SELF_ENGINE;
  if (resolve(oldPath) === resolve(engineRoot)) return null; // 仍在旧引擎里跑，下次再说
  try {
    const backup = data.backup || join(L.state, `migrate-backup-${stamp()}`);
    fsx.mkdirSync(backup, { recursive: true });
    const dest = join(backup, 'engine-old');
    if (!fsx.existsSync(dest)) fsx.renameSync(oldPath, dest);
    fsx.rmSync(marker, { force: true });
    return { ok: true, moved: dest };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 入口自动迁移：先清理遗留旧引擎，再按需迁移。
 * 硬切语义：新布局缺失且旧布局存在 → 立即迁移（失败则抛错，拒绝在未知布局上继续）。
 * @param {object} [opts]
 * @param {boolean} [opts.allowMigration] 入口可显式关闭（默认 true）
 * @returns {{ok:boolean, migrated:boolean, reason?:string, backup?:string}}
 */
export function ensureLayout(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.RELIC_SKIP_MIGRATE === '1') return { ok: true, migrated: false, skipped: true };
  const home = opts.home ?? homeFrom(env);

  const swept = sweepPendingEngineRemoval({ ...opts, env, home });
  const legacy = detectLegacyLayout(home, { platform: opts.platform, env, fsx: opts.fsx });
  if (!legacy.any) return { ok: true, migrated: false, swept };

  const L = relicLayout(relicRoot(env, home));
  const exists = (p) => (opts.fsx?.existsSync || existsSync)(p);
  const needs = ['content', 'habits', 'engine'].some((k) => exists(legacy.paths[k]) && !exists(L[k === 'content' ? 'content' : k]))
    || (exists(legacy.paths.engine) && exists(L.engine) && resolve(legacy.paths.engine) !== resolve(L.engine));
  if (!needs) return { ok: true, migrated: false, swept };

  if (opts.allowMigration === false) {
    return { ok: false, migrated: false, reason: `检测到旧布局，但当前入口禁止迁移；请先运行 npm run migrate` };
  }
  const r = migrateLayout({ ...opts, env, home, apply: true });
  if (!r.ok) return { ok: false, migrated: false, reason: r.reason, backup: r.backup };
  return { ok: true, migrated: r.migrated, backup: r.backup, steps: r.steps };
}

/**
 * 列出备份目录；cleanup=true 时删除它们（仅限 <root>/state/migrate-backup-*）。
 * @param {object} [opts]
 * @param {boolean} [opts.cleanup]
 * @returns {{ok:boolean, dirs:string[], removed?:string[], reason?:string}}
 */
export function manageBackups(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeFrom(env);
  const L = relicLayout(relicRoot(env, home));
  const dirs = [];
  try {
    for (const name of readdirSync(L.state)) {
      if (name.startsWith('migrate-backup-')) dirs.push(join(L.state, name));
    }
  } catch { /* state 不存在 */ }
  if (!opts.cleanup) return { ok: true, dirs };
  const removed = [];
  const errors = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); removed.push(d); }
    catch (e) { errors.push(`${d}: ${e.message}`); }
  }
  return { ok: errors.length === 0, dirs, removed, errors };
}
