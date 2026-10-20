// =============================================================================
// scripts/wizard.mjs — relic 安装向导（GUI 后端服务器）
// =============================================================================
// 启动：npm run wizard  →  http://localhost:17777 + 自动打开浏览器
// 职责：环境检查 / 身份选择 / 部署管线（SSE 实时进度）/ 升级（预留）
// 架构：直接调用 relic 现有模块（provider/gate/paths 等），不 spawn CLI——
//       避免 readline 交互冲突，进度可细粒度报告。
// =============================================================================

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { run, userHome } from '../src/core/exec.mjs';
import { giteeWhoami, giteeCreateRepo, giteeRepoExists, getProvider } from '../src/core/provider.mjs';
import { listDeployed, uninject, reinject, deactivate, fullUninstall } from '../src/core/uninstall-core.mjs';
import { ensureHabitsStore } from '../src/core/habits.mjs';
import { upgradeSteps } from '../src/core/upgrade-core.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = userHome();
const DEFAULT_CONTENT = join(HOME, '.config', 'relic-sync');
const PORT_START = 17777;
const PORT_RETRIES = 3;

// ─── 工具函数 ─────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((res) => {
    let d = '';
    req.on('data', (c) => d += c);
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** 检测已部署（决定显示安装流还是升级流） */
function isDeployed() {
  return existsSync(join(DEFAULT_CONTENT, 'policies.yaml'));
}

/** 读取 engine.lock */
function readEngineLock() {
  try {
    return JSON.parse(readFileSync(join(DEFAULT_CONTENT, 'engine.lock'), 'utf8'));
  } catch { return null; }
}

/** 读取 .last-sync */
function readLastSync() {
  try {
    return JSON.parse(readFileSync(join(DEFAULT_CONTENT, '.last-sync'), 'utf8'));
  } catch { return null; }
}

/** 获取引擎当前 commit + tag */
function engineVersion() {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
  const tagR = run('git', ['describe', '--tags', '--exact-match'], { cwd: REPO });
  return { commit, tag: tagR.ok ? tagR.stdout.trim() : null };
}

// ─── 环境检查 ─────────────────────────────────────────────────────────────

async function checkEnvironment() {
  const checks = [];
  const nodeV = run('node', ['--version']);
  if (nodeV.ok) {
    const major = parseInt(nodeV.stdout.slice(1).split('.')[0], 10);
    checks.push({ name: 'Node.js', ok: major >= 20, version: nodeV.stdout.trim(), hint: major < 20 ? '需要 ≥ 20' : null });
  } else {
    checks.push({ name: 'Node.js', ok: false, version: null, hint: '未安装' });
  }
  const gitV = run('git', ['--version']);
  checks.push({ name: 'Git', ok: gitV.ok, version: gitV.ok ? gitV.stdout.trim() : null, hint: gitV.ok ? null : '未安装' });
  const ghV = run('gh', ['--version']);
  checks.push({ name: 'gh CLI', ok: ghV.ok, optional: true, version: ghV.ok ? ghV.stdout.split('\n')[0] : null, hint: ghV.ok ? null : '未安装（仅 GitHub 模式需要）' });
  return checks;
}

/** 向导专用：sync 前清理内容库（加固版——覆盖所有脏状态场景） */
function wizardPreSyncClean(contentDir) {
  if (!existsSync(contentDir)) return;

  // 0. 确保 git 用户配置（防 commit 失败）
  const emailR = run('git', ['config', 'user.email'], { cwd: contentDir });
  if (!emailR.ok || !emailR.stdout.trim()) {
    run('git', ['config', 'user.email', 'wizard@relic.local'], { cwd: contentDir });
    run('git', ['config', 'user.name', 'relic wizard'], { cwd: contentDir });
  }

  // 1. 删 .bak 备份文件（产物，非用户内容）
  try {
    const entries = readdirSync(contentDir, { recursive: true });
    for (const e of entries) {
      if (typeof e === 'string' && e.includes('.bak.')) {
        try { rmSync(join(contentDir, e), { force: true }); } catch {}
      }
    }
  } catch {}

  // 2. add -A 先行（确保 untracked 文件也被暂存）
  run('git', ['add', '-A'], { cwd: contentDir });

  // 3. 有暂存内容则 commit
  const status = run('git', ['status', '--porcelain'], { cwd: contentDir });
  if (status.ok && status.stdout.trim() !== '') {
    const commitR = run('git', ['commit', '-m', 'wizard: auto-commit before deploy (user-initiated)'], { cwd: contentDir });
    if (commitR.ok) {
      // push 到远端（防 diverged——本地有 commit 而远端没有）
      run('git', ['push', 'origin', 'main'], { cwd: contentDir });
    } else {
      // commit 失败 → stash 兜底
      run('git', ['stash', '-u'], { cwd: contentDir });
    }
  }

  // 4. 最终验证——仍有脏文件则报错（而非静默通过）
  const final = run('git', ['status', '--porcelain'], { cwd: contentDir });
  if (final.ok && final.stdout.trim() !== '') {
    throw new Error(`内容库无法清理（残留：${final.stdout.trim().split('\n')[0]}）`);
  }
}

// ─── 部署管线（generator，每步 yield 进度） ────────────────────────────────

/**
 * 完整部署管线，yield { step, status, message } 供 SSE 推送。
 * @param {{mode:'gitee'|'existing'|'github', token?:string, url?:string, name?:string}} config
 */
async function* deployPipeline(config) {
  const contentDir = DEFAULT_CONTENT;

  // ── Step 1: 准备内容库 ──
  yield { step: 1, status: 'active', message: '准备身份内容库...' };
  if (config.mode === 'existing') {
    const r = run('git', ['clone', config.url, contentDir]);
    if (!r.ok) throw new Error(`clone 失败：${r.stderr}`);
  } else if (config.mode === 'gitee') {
    // 令牌校验
    const who = await giteeWhoami({ token: config.token });
    if (!who.ok) throw new Error(`令牌校验失败：${who.reason}`);
    const user = who.login;
    yield { step: 1, status: 'active', message: `令牌有效（${user}），创建 Gitee 私有库...` };
    const name = config.name || 'relic-sync';
    const ex = await giteeRepoExists({ user, name, token: config.token });
    if (ex.exists) throw new Error(`Gitee 已存在 ${name}，请选"接入已有身份"模式`);
    // 种子
    const seedDir = join(REPO, 'template');
    mkdirSync(contentDir, { recursive: true });
    copyFileSync(join(seedDir, 'policies.yaml'), join(contentDir, 'policies.yaml'));
    mkdirSync(join(contentDir, 'modules'), { recursive: true });
    for (const ent of readdirSync(join(seedDir, 'modules'), { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      mkdirSync(join(contentDir, 'modules', ent.name), { recursive: true });
      copyFileSync(join(seedDir, 'modules', ent.name, 'module.yaml'), join(contentDir, 'modules', ent.name, 'module.yaml'));
    }
    writeFileSync(join(contentDir, '.gitignore'), '.last-sync\n.relic-deploy\n');
    // git init
    run('git', ['init', '-b', 'main'], { cwd: contentDir });
    // engine.lock
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
    writeFileSync(join(contentDir, 'engine.lock'), JSON.stringify({ engine: 'relic-source', tag: 'dev', commit, pinned: new Date().toISOString() }, null, 2) + '\n');
    run('git', ['add', '-A'], { cwd: contentDir });
    run('git', ['commit', '-m', 'init: identity content (seeded from template) + engine.lock'], { cwd: contentDir });
    // 建 Gitee 库
    const created = await giteeCreateRepo({ name, token: config.token });
    if (!created.ok) throw new Error(`Gitee 建库失败：${created.reason}`);
    const url = `https://gitee.com/${user}/${name}.git`;
    run('git', ['remote', 'add', 'origin', url], { cwd: contentDir });
    // 令牌入 credential store
    // 平台无关：直接写 credential store 文件
    const { appendFileSync } = await import('fs');
    const credFile = join(HOME, '.git-credentials');
    appendFileSync(credFile, `https://${user}:${config.token}@gitee.com\n`);
    const pushR = run('git', ['push', '-u', 'origin', 'main'], { cwd: contentDir });
    if (!pushR.ok) throw new Error(`push 失败（令牌已存）：${pushR.stderr}`);
  }
  yield { step: 1, status: 'done', message: '身份内容库就绪' };

  // ── Step 2: 安装引擎依赖 ──
  yield { step: 2, status: 'active', message: '安装引擎依赖 (npm install)...' };
  if (!existsSync(join(REPO, 'node_modules'))) {
    const npmR = run('npm', ['install'], { cwd: REPO });
    if (!npmR.ok) throw new Error(`npm install 失败：${npmR.stderr}`);
  }
  yield { step: 2, status: 'done', message: '引擎依赖就绪' };

  // ── Step 3: 首次 sync（部署治理） ──
  yield { step: 3, status: 'active', message: '部署治理规则 (sync + generate)...' };
  ensureHabitsStore();  // Q5: 预创建 habit 库（治"不存在报错"）
  wizardPreSyncClean(contentDir);  // 向导专用：清理脏状态再 sync
  const syncR = run('npm', ['run', 'sync', '--', '--no-gate'], { cwd: REPO });
  if (!syncR.ok) throw new Error(`sync 失败：${syncR.stderr}`);
  yield { step: 3, status: 'done', message: '治理规则已部署' };

  // ── Step 4: 安装调度器 ──
  yield { step: 4, status: 'active', message: '安装调度器...' };
  const schedR = run('node', [join(REPO, 'scripts', 'install-schedule.mjs')]);
  yield { step: 4, status: schedR.ok ? 'done' : 'warn', message: schedR.ok ? '调度器已安装' : '调度器安装失败（可手动装）' };

  // ── Step 5: 验证 ──
  yield { step: 5, status: 'active', message: '验证部署...' };
  const report = { platforms: [], scheduler: schedR.ok };
  const deployedPaths = [
    { name: 'DSH', path: join(HOME, '.dsh', 'AGENTS.md') },
    { name: 'OpenCode', path: join(HOME, '.config', 'opencode', 'AGENTS.md') },
    { name: 'OMO', path: join(HOME, '.omo', 'omo.jsonc') },
    { name: 'Codex', path: join(HOME, '.codex', 'AGENTS.md') },
  ];
  for (const p of deployedPaths) {
    const exists = existsSync(p.path);
    if (exists) {
      const content = readFileSync(p.path, 'utf8');
      const sentinel = content.includes('RELIC IS RUNNING');
      report.platforms.push({ name: p.name, path: p.path, deployed: true, sentinel });
    } else {
      report.platforms.push({ name: p.name, path: p.path, deployed: false, sentinel: false });
    }
  }
  const anyDeployed = report.platforms.some(p => p.deployed);
  if (!anyDeployed) throw new Error('未检测到任何已部署平台（适配器 detect 失败？）');
  yield { step: 5, status: 'done', message: '验证完成' };
  return report;
}

// ─── 升级管线 ─────────────────────────────────────────────────────────────

async function* upgradePipeline() {
  // No wizardPreSyncClean here: upgrading must not auto-commit user changes.
  // Shared CLI semantics also reject failed tests on every platform.
  return yield* upgradeSteps({ repo: REPO });
}

// ─── HTTP 服务器 ──────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 静态文件：向导页面 ──
  if (url === '/' || url === '/index.html') {
    try {
      const html = readFileSync(join(REPO, 'scripts', 'wizard', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      json(res, 500, { error: 'index.html not found' });
    }
    return;
  }

  // ── PWA manifest ──
  if (url === '/manifest.json') {
    try {
      const mf = readFileSync(join(REPO, 'scripts', 'wizard', 'manifest.json'));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(mf);
    } catch {
      json(res, 500, { error: 'manifest not found' });
    }
    return;
  }

  // ── PWA 图标 ──
  if (url.startsWith('/icons/')) {
    const iconFile = url.split('/').pop();
    if (iconFile.endsWith('.png')) {
      try {
        const icon = readFileSync(join(REPO, 'scripts', 'wizard', 'icons', iconFile));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(icon);
      } catch {
        res.writeHead(404); res.end();
      }
      return;
    }
  }

  // ── GET /api/check ──
  if (url === '/api/check' && req.method === 'GET') {
    const checks = await checkEnvironment();
    json(res, 200, { checks, deployed: isDeployed() });
    return;
  }

  // ── GET /api/version ──
  if (url === '/api/version' && req.method === 'GET') {
    const engine = engineVersion();
    const lock = readEngineLock();
    const lastSync = readLastSync();
    json(res, 200, {
      engine,
      engineLock: lock,
      lastSync,
      deployed: isDeployed(),
    });
    return;
  }

  // ── POST /api/token ──
  if (url === '/api/token' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.token) { json(res, 400, { ok: false, reason: '令牌为空' }); return; }
    const who = await giteeWhoami({ token: body.token });
    json(res, who.ok ? 200 : 401, who);
    return;
  }

  // ── POST /api/deploy（SSE 流式进度） ──
  if (url === '/api/deploy' && req.method === 'POST') {
    const body = await parseBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      const iter = deployPipeline(body);
      let result;
      while (true) {
        const { value, done } = await iter.next();
        if (done) { result = value; break; }
        send(value);
      }
      send({ type: 'done', report: result });
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
    res.end();
    return;
  }

  // ── POST /api/upgrade（SSE 流式进度） ──
  if (url === '/api/upgrade' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      const iter = upgradePipeline();
      let result;
      while (true) {
        const { value, done } = await iter.next();
        if (done) { result = value; break; }
        send(value);
      }
      send({ type: 'done', report: result });
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
    res.end();
    return;
  }

  // ── GET /api/status（状态 Tab：治理状态全景） ──
  if (url === '/api/status' && req.method === 'GET') {
    try {
      const deployed = listDeployed();
      // 同步账本
      const lastSync = readLastSync();
      // 内容库概览
      let contentOverview = null;
      try {
        const policiesRaw = readFileSync(join(DEFAULT_CONTENT, 'policies.yaml'), 'utf8');
        const { parse: yamlParse } = await import('yaml');
        const doc = yamlParse(policiesRaw);
        contentOverview = {
          permissions: (doc.permissions || []).length,
          workflows: (doc.workflows || []).length,
          personas: (doc.personas || []).length,
          modules: (doc.modules || []).length,
        };
      } catch { /* 未部署或解析失败 */ }
      // 调度器状态
      let scheduler = 'unknown';
      if (process.platform !== 'win32') {
        const r = run('systemctl', ['--user', 'is-active', 'relic-sync.timer']);
        scheduler = r.ok && r.stdout.trim() === 'active' ? 'active' : 'inactive';
      } else {
        const r = run('schtasks', ['/Query', '/TN', 'relic-sync']);
        scheduler = r.ok ? 'active' : 'inactive';
      }
      json(res, 200, { deployed, lastSync, contentOverview, scheduler });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── GET /api/deployed（卸载 Tab 显示当前部署状态） ──
  if (url === '/api/deployed' && req.method === 'GET') {
    const deployed = listDeployed();
    json(res, 200, { deployed, hasScheduler: isDeployed() });
    return;
  }

  // ── POST /api/uninstall（SSE 流式进度） ──
  if (url === '/api/uninstall' && req.method === 'POST') {
    const body = await parseBody(req);
    const level = body.level || 'uninject';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      const targets = body.targets || [];
      send({ type: 'progress', message: `执行 ${level}${targets.length ? '（' + targets.join(', ') + '）' : ''}...` });
      let result;
      if (level === 'uninject') result = await uninject({ targets });
      else if (level === 'deactivate') result = await deactivate({ targets });
      else if (level === 'full') result = await fullUninstall();
      else throw new Error(`unknown level: ${level}`);
      send({ type: 'done', report: result });
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
    res.end();
    return;
  }

  // ── GET /api/reinject/status（恢复画面显示备份状态） ──
  if (url === '/api/reinject/status' && req.method === 'GET') {
    const { readdirSync: rd } = await import('fs');
    const backupDir = join(HOME, '.local', 'state', 'relic', 'uninject-backup');
    const hasBackup = existsSync(backupDir);
    const backups = hasBackup
      ? rd(backupDir).filter((f) => f.endsWith('-AGENTS.md'))
      : [];
    json(res, 200, { hasBackup, backups });
    return;
  }

  // ── POST /api/reinject（恢复去治理） ──
  if (url === '/api/reinject' && req.method === 'POST') {
    try {
      let result = await reinject();
      // reinject 恢复数为 0 时（无备份/已恢复）→ 走 sync 重新部署
      if (!result.restored || result.restored.length === 0) {
        const syncR = run('npm', ['run', 'sync', '--', '--no-gate'], { cwd: REPO });
        if (syncR.ok) {
          result = { ...result, ok: true, restored: ['(via sync — 重新部署治理)'] };
        } else {
          result = { ...result, errors: [...(result.errors || []), 'sync 兜底也失败: ' + (syncR.stderr || '').slice(0, 200)] };
        }
      }
      json(res, 200, result);
    } catch (e) {
      json(res, 500, { ok: false, errors: [e.message] });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
});

// ─── 启动 ─────────────────────────────────────────────────────────────────

async function start() {
  let port = PORT_START;
  for (let i = 0; i < PORT_RETRIES; i++) {
    const ok = await new Promise((res) => {
      server.once('error', () => res(false));
      server.listen(port, '127.0.0.1', () => res(true));
    });
    if (ok) {
      console.log(`[wizard] ✅ relic 安装向导已启动 → http://localhost:${port}`);
      // 打开浏览器
      const { exec } = await import('child_process');
      const cmd = process.platform === 'win32' ? `start http://localhost:${port}` : `xdg-open http://localhost:${port}`;
      exec(cmd, () => {}); // 忽略打开失败（可能是无头环境）
      return;
    }
    port++;
  }
  console.error('[wizard] ❌ 端口 17777-17779 均被占用');
  process.exit(1);
}

start();
