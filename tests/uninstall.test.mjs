// =============================================================================
// tests/uninstall.test.mjs — 卸载核心逻辑测试
// =============================================================================
// U1: listDeployed 列出有 AGENTS.md 的平台
// U2: uninject 移除 AGENTS.md + .bak，保存备份
// U3: reinject 从备份恢复
// U4: deactivate 包含 uninject + 调度器停用结果
// U5: fullUninstall 删目录（skipPush + skipEngine 测试模式）
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { posix, join as fsJoin } from 'path';
import { tmpdir } from 'os';

// 测试用：mock HOME 隔离真实环境
const FAKE_HOME = mkdtempSync(fsJoin(tmpdir(), 'relic-uninstall-test-'));

// mock platformPaths 的 HOME
const originalHome = process.env.HOME;
process.env.HOME = FAKE_HOME;
process.env.RELIC_CONTENT_REPO = '/nonexistent-repo';
process.env.DSH_HOME = '';
process.env.XDG_CONFIG_HOME = '';
process.env.OPENCODE_CONFIG = '';

const { listDeployed, uninject, reinject } = await import('../src/core/uninstall-core.mjs');

const pjoin = posix.join;

beforeEach(() => {
  // 每个测试前重建 fake 部署
  mkdirSync(pjoin(FAKE_HOME, '.dsh'), { recursive: true });
  writeFileSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md'), '# governance test');
  mkdirSync(pjoin(FAKE_HOME, '.config', 'opencode'), { recursive: true });
  writeFileSync(pjoin(FAKE_HOME, '.config', 'opencode', 'AGENTS.md'), '# governance test');
  // .bak 备份
  writeFileSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md.bak.2026-09-30'), '# old');
});

afterEach(() => {
  // 清理
  rmSync(pjoin(FAKE_HOME, '.dsh'), { recursive: true, force: true });
  rmSync(pjoin(FAKE_HOME, '.config'), { recursive: true, force: true });
  rmSync(pjoin(FAKE_HOME, '.local'), { recursive: true, force: true });
});

describe('U1: listDeployed', () => {
  it('lists platforms with AGENTS.md present', () => {
    const deployed = listDeployed();
    const names = deployed.map(p => p.name);
    assert.ok(names.includes('DSH'), 'DSH should be detected');
    assert.ok(names.includes('OpenCode'), 'OpenCode should be detected');
  });
  it('returns empty when no AGENTS.md', () => {
    rmSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md'), { force: true });
    rmSync(pjoin(FAKE_HOME, '.config', 'opencode', 'AGENTS.md'), { force: true });
    const deployed = listDeployed();
    assert.equal(deployed.length, 0);
  });
});

describe('U2: uninject removes AGENTS.md + .bak, saves backup', () => {
  it('removes AGENTS.md and .bak files', async () => {
    const r = await uninject();
    assert.equal(r.ok, true);
    assert.ok(r.removed.some(f => f.includes('.dsh') && f.includes('AGENTS.md')));
    assert.ok(!existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md')), 'AGENTS.md should be removed');
    assert.ok(!existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md.bak.2026-09-30')), '.bak should be removed');
  });
  it('saves backup copy', async () => {
    await uninject();
    const backupDir = pjoin(FAKE_HOME, '.local', 'state', 'relic', 'uninject-backup');
    assert.ok(existsSync(pjoin(backupDir, 'DSH-AGENTS.md')), 'DSH backup should exist');
    const content = readFileSync(pjoin(backupDir, 'DSH-AGENTS.md'), 'utf8');
    assert.match(content, /governance test/);
  });
});

describe('U3: reinject restores from backup', () => {
  it('restores AGENTS.md after uninject', async () => {
    await uninject();
    assert.ok(!existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md')));
    const r = await reinject();
    assert.equal(r.ok, true);
    assert.ok(existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md')), 'AGENTS.md should be restored');
    const content = readFileSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md'), 'utf8');
    assert.match(content, /governance test/);
  });
});

describe('U4: selective uninject by harness targets', () => {
  it('removes only DSH when targets=["DSH"]', async () => {
    const r = await uninject({ targets: ['DSH'] });
    assert.equal(r.ok, true);
    assert.ok(!existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md')), 'DSH AGENTS.md should be removed');
    assert.ok(existsSync(pjoin(FAKE_HOME, '.config', 'opencode', 'AGENTS.md')), 'OpenCode AGENTS.md should remain');
  });
  it('removes only OpenCode when targets=["OpenCode"]', async () => {
    const r = await uninject({ targets: ['OpenCode'] });
    assert.equal(r.ok, true);
    assert.ok(existsSync(pjoin(FAKE_HOME, '.dsh', 'AGENTS.md')), 'DSH should remain');
    assert.ok(!existsSync(pjoin(FAKE_HOME, '.config', 'opencode', 'AGENTS.md')), 'OpenCode should be removed');
  });
});

// 清理测试环境
process.env.HOME = originalHome;
