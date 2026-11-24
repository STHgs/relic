// =============================================================================
// src/core/relic-root.mjs — 唯一根目录与布局解析（v0.0.4 目录收敛）
// =============================================================================
// 布局（硬切：旧路径不再识别；旧装由 migrate-layout 自动迁移）：
//
//   ~/.relic/                     （Windows: %USERPROFILE%\.relic）
//   ├── engine/                   引擎 clone（部署位）
//   ├── sync/                     身份内容库（policies.yaml + modules/ + engine.lock）
//   ├── habits/                   学习库（learned.yaml / sources.json / ingest-state.json / audit.log）
//   └── state/                    运行状态与日志（sync.log / sync-gate.log / 迁移备份）
//   relic.config.json             根级机器登记（contentRepo / syncRemote / identity）
//
// 解析优先级：
//   根：RELIC_ROOT env > ~/.relic
//   内容库：--content / RELIC_CONTENT_REPO > relic.config.json.contentRepo > <root>/sync
//   学习库：RELIC_HABITS_DIR > <root>/habits
//   状态：RELIC_STATE_DIR > <root>/state
//
// 本模块只做解析，不做迁移；迁移见 migrate-layout.mjs。
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

export const ROOT_DIRNAME = '.relic';

/** 归一化用户主目录（与 exec.userHome 同语义，但接受 env 注入，便于测试）。 */
export function homeFrom(env = process.env) {
  return env.USERPROFILE || env.HOME || homedir();
}

/**
 * relic 根目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function relicRoot(env = process.env, home = homeFrom(env)) {
  const override = env.RELIC_ROOT;
  return override && String(override).trim() ? resolve(override) : join(home, ROOT_DIRNAME);
}

/**
 * 布局路径（纯计算）。
 * @param {string} [root]
 * @returns {{root:string, engine:string, content:string, habits:string, state:string, config:string, syncLog:string, gateLog:string}}
 */
export function relicLayout(root = relicRoot()) {
  const state = join(root, 'state');
  return {
    root,
    engine: join(root, 'engine'),
    content: join(root, 'sync'),
    habits: join(root, 'habits'),
    state,
    config: join(root, 'relic.config.json'),
    syncLog: join(state, 'sync.log'),
    gateLog: join(state, 'sync-gate.log'),
  };
}

/**
 * 旧布局（v0.0.3 及以前）。仅迁移与提示使用，解析链不再回退。
 * @param {string} [home]
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{engine:string, content:string, habits:string, state:string, syncLog:string}}
 */
export function legacyLayout(home = homeFrom(), platform = process.platform, env = process.env) {
  const win = platform === 'win32';
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return {
    engine: win ? join(home, 'relic') : join(home, '.config', 'relic'),
    content: join(home, '.config', 'relic-sync'),
    habits: join(home, '.config', 'relic-habits'),
    state: win ? join(localAppData, 'relic') : join(home, '.local', 'state', 'relic'),
    syncLog: join(home, '.relic-sync.log'),
  };
}

/**
 * 探测旧布局中存在哪些目录。
 * @param {string} [home]
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{existsSync:(p:string)=>boolean}} [opts.fsx]
 * @returns {{paths:object, found:string[], any:boolean}}
 */
export function detectLegacyLayout(home = homeFrom(), opts = {}) {
  const fsx = opts.fsx || { existsSync };
  const paths = legacyLayout(home, opts.platform, opts.env);
  const found = [];
  for (const [key, p] of Object.entries(paths)) {
    if (p && fsx.existsSync(p)) found.push(key);
  }
  return { paths, found, any: found.length > 0 };
}

/** 确保根与四个子目录存在。 */
export function ensureRootDirs(root = relicRoot()) {
  const L = relicLayout(root);
  for (const d of [L.root, L.engine, L.content, L.habits, L.state]) {
    mkdirSync(d, { recursive: true });
  }
  return L;
}

/**
 * 读取根级 relic.config.json（缺失/损坏返回 {}，永不抛）。
 * @param {string} [root]
 * @returns {object}
 */
export function readRelicConfig(root = relicRoot()) {
  try {
    const raw = readFileSync(join(root, 'relic.config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/**
 * 原子写根级 relic.config.json。
 * @param {object} cfg
 * @param {string} [root]
 */
export function writeRelicConfig(cfg, root = relicRoot()) {
  mkdirSync(root, { recursive: true });
  const target = join(root, 'relic.config.json');
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, target);
}

/**
 * 内容库默认位置（不含 --content 参数；该参数由各 CLI 自行处理）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function contentRepoDefault(env = process.env) {
  const explicit = env.RELIC_CONTENT_REPO;
  if (explicit && String(explicit).trim()) return resolve(explicit);
  const cfg = readRelicConfig(relicRoot(env));
  if (cfg.contentRepo && String(cfg.contentRepo).trim()) return resolve(cfg.contentRepo);
  return relicLayout(relicRoot(env)).content;
}

/** 学习库目录。 */
export function habitsDir(env = process.env) {
  const explicit = env.RELIC_HABITS_DIR;
  if (explicit && String(explicit).trim()) return resolve(explicit);
  return relicLayout(relicRoot(env)).habits;
}

/** 状态/日志目录。 */
export function stateDir(env = process.env) {
  const explicit = env.RELIC_STATE_DIR;
  if (explicit && String(explicit).trim()) return resolve(explicit);
  return relicLayout(relicRoot(env)).state;
}

/** 部署引擎目录（新装默认位置；开发 clone 可不在该处）。 */
export function engineDir(env = process.env) {
  return relicLayout(relicRoot(env)).engine;
}
