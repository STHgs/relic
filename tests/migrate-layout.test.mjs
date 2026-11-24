// =============================================================================
// tests/migrate-layout.test.mjs — 旧布局 → ~/.relic 迁移（v0.0.4）
// =============================================================================
// 覆盖：计划生成、dry-run 不写盘、apply 后布局/配置/备份、内容库脏拒、
//       ensureLayout 自动迁移、自引擎延迟清理、硬切解析。
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planMigration, migrateLayout, ensureLayout, sweepPendingEngineRemoval,
} from '../src/core/migrate-layout.mjs';
import {
  relicLayout, relicRoot, contentRepoDefault, habitsDir, stateDir,
} from '../src/core/relic-root.mjs';

let home, legacy, L;

function buildLegacy() {
  home = mkdtempSync(join(tmpdir(), 'relic-migrate-'));
  legacy = {
    content: join(home, '.config', 'relic-sync'),
    habits: join(home, '.config', 'relic-habits'),
    state: join(home, '.local', 'state', 'relic'),
    log: join(home, '.relic-sync.log'),
    engine: join(home, '.config', 'relic'),
  };
  mkdirSync(join(legacy.content, 'modules', 'm'), { recursive: true });
  writeFileSync(join(legacy.content, 'policies.yaml'), 'meta:\n  version: 2\n');
  writeFileSync(join(legacy.content, 'engine.lock'), '{"engine":"relic"}\n');
  mkdirSync(legacy.habits, { recursive: true });
  writeFileSync(join(legacy.habits, 'learned.yaml'), 'entries: []\n');
  mkdirSync(legacy.state, { recursive: true });
  writeFileSync(join(legacy.state, 'sync-gate.log'), 'gate\n');
  writeFileSync(legacy.log, 'sync log\n');
  mkdirSync(legacy.engine, { recursive: true });
  writeFileSync(join(legacy.engine, 'package.json'), '{"name":"relic"}\n');
  writeFileSync(join(legacy.engine, 'relic.config.json'), JSON.stringify({
    contentRepo: legacy.content, syncRemote: 'https://example.invalid/relic-sync.git',
  }));
  L = relicLayout(join(home, '.relic'));
}

const env = () => ({ HOME: home });

beforeEach(() => { buildLegacy(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('M1: 计划与 dry-run', () => {
  it('识别全部旧单元，dry-run 不写盘', () => {
    const plan = planMigration({ home, env: env(), platform: 'linux', engineRoot: legacy.engine });
    assert.equal(plan.needed, true);
    const ids = plan.units.map((u) => u.id).sort();
    assert.deepEqual(ids, ['engine', 'habits', 'log', 'state', 'sync']);

    const r = migrateLayout({ home, env: env(), platform: 'linux', engineRoot: legacy.engine });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(existsSync(L.content), false, 'dry-run 不得创建目标');
    assert.equal(existsSync(L.engine), false);
  });

  it('已是目标布局 → 无需迁移', () => {
    mkdirSync(L.content, { recursive: true });
    mkdirSync(L.habits, { recursive: true });
    mkdirSync(L.state, { recursive: true });
    mkdirSync(L.engine, { recursive: true });
    writeFileSync(join(L.engine, 'package.json'), '{}\n');
    rmSync(legacy.content, { recursive: true, force: true });
    rmSync(legacy.habits, { recursive: true, force: true });
    rmSync(legacy.state, { recursive: true, force: true });
    rmSync(legacy.log, { force: true });
    rmSync(legacy.engine, { recursive: true, force: true });
    const plan = planMigration({ home, env: env(), platform: 'linux', engineRoot: L.engine });
    assert.equal(plan.needed, false);
  });
});

describe('M2: apply 迁移', () => {
  it('移动内容/习惯/状态并保留备份，写根级配置', () => {
    const r = migrateLayout({
      home, env: env(), platform: 'linux', engineRoot: legacy.engine,
      apply: true, scheduler: false, shortcut: false,
    });
    assert.equal(r.ok, true, r.reason);

    assert.ok(existsSync(join(L.content, 'policies.yaml')));
    assert.ok(existsSync(join(L.content, 'engine.lock')));
    assert.ok(existsSync(join(L.habits, 'learned.yaml')));
    assert.ok(existsSync(join(L.state, 'sync-gate.log')));
    assert.ok(existsSync(join(L.state, 'sync.log')));
    assert.ok(existsSync(join(L.engine, 'package.json')), '自引擎应被复制到新位置');

    const cfg = JSON.parse(readFileSync(join(L.root, 'relic.config.json'), 'utf8'));
    assert.equal(cfg.contentRepo, L.content, '根级配置指向新内容库');
    assert.equal(cfg.syncRemote, 'https://example.invalid/relic-sync.git', '保留 syncRemote');

    assert.ok(existsSync(r.backup), '备份目录必须保留');
    assert.ok(existsSync(join(r.backup, 'sync', 'policies.yaml')), '旧内容库完整入备份');
    assert.ok(existsSync(join(r.backup, 'habits')), '旧习惯库入备份');
    assert.ok(existsSync(join(r.backup, 'state', 'sync-gate.log')), '旧状态入备份');

    // 硬切：解析链立即指向新布局
    assert.equal(contentRepoDefault(env()), L.content);
    assert.equal(habitsDir(env()), L.habits);
    assert.equal(stateDir(env()), L.state);
    // 旧位置已不存在（迁移 = 移动 + 备份副本）
    assert.equal(existsSync(legacy.content), false);
    assert.equal(existsSync(legacy.habits), false);

    // 自引擎：旧目录延迟清理标记
    const marker = join(L.state, 'pending-engine-removal.json');
    assert.ok(existsSync(marker));
    const swept = sweepPendingEngineRemoval({ home, env: env(), platform: 'linux', engineRoot: L.engine });
    assert.ok(swept && swept.ok);
    assert.equal(existsSync(legacy.engine), false, '旧引擎应被归档');
    assert.equal(existsSync(marker), false);
  });

  it('目标引擎已存在（引擎归档路径）时，旧配置 syncRemote 仍保留', () => {
    mkdirSync(L.engine, { recursive: true });
    writeFileSync(join(L.engine, 'package.json'), '{}\n');
    const r = migrateLayout({
      home, env: env(), platform: 'linux', engineRoot: L.engine,
      apply: true, scheduler: false, shortcut: false,
    });
    assert.equal(r.ok, true, r.reason);
    const cfg = JSON.parse(readFileSync(join(L.root, 'relic.config.json'), 'utf8'));
    assert.equal(cfg.contentRepo, L.content);
    assert.equal(cfg.syncRemote, 'https://example.invalid/relic-sync.git', 'engine-leftover 的旧配置不得丢失');
    assert.ok(existsSync(join(r.backup, 'engine-leftover')), '旧引擎应归档为 engine-leftover');
  });

  it('内容库脏 → 拒绝迁移且不写目标', () => {
    mkdirSync(join(legacy.content, '.git'), { recursive: true });
    const r = migrateLayout({
      home, env: env(), platform: 'linux', engineRoot: legacy.engine,
      apply: true, scheduler: false, shortcut: false,
      runFn: () => ({ ok: true, stdout: ' M policies.yaml\n', stderr: '' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /未提交改动/);
    assert.equal(existsSync(L.content), false);
    assert.ok(existsSync(legacy.content), '拒绝迁移时旧内容库必须原样保留');
  });
});

describe('M3: ensureLayout 自动迁移', () => {
  it('检测旧布局并自动迁移；新布局下为 no-op', () => {
    const r = ensureLayout({
      home, env: env(), platform: 'linux', engineRoot: legacy.engine,
      scheduler: false, shortcut: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.migrated, true);
    assert.ok(existsSync(join(L.content, 'policies.yaml')));

    const again = ensureLayout({
      home, env: env(), platform: 'linux', engineRoot: L.engine,
      scheduler: false, shortcut: false,
    });
    assert.equal(again.ok, true);
    assert.equal(again.migrated, false);
  });

  it('RELIC_SKIP_MIGRATE=1 时完全跳过', () => {
    const r = ensureLayout({
      home, env: { HOME: home, RELIC_SKIP_MIGRATE: '1' },
      platform: 'linux', engineRoot: legacy.engine,
      scheduler: false, shortcut: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(existsSync(L.content), false);
  });
});

describe('M4: 根目录解析（硬切）', () => {
  it('RELIC_ROOT 覆盖根；默认 ~/.relic', () => {
    assert.equal(relicRoot({ HOME: home }), join(home, '.relic'));
    assert.equal(relicRoot({ HOME: home, RELIC_ROOT: join(home, 'custom') }), join(home, 'custom'));
  });
  it('config.contentRepo 优先于默认 sync', () => {
    mkdirSync(join(home, '.relic'), { recursive: true });
    writeFileSync(join(home, '.relic', 'relic.config.json'), JSON.stringify({ contentRepo: '/tmp/elsewhere' }));
    assert.equal(contentRepoDefault({ HOME: home }), '/tmp/elsewhere');
  });
});
