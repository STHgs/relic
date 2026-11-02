// tests/platform-status.test.mjs — 治理状态探测（控制台自愈只读底座）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPlatformStatus, summarizeDeployReport, SENTINEL } from '../src/core/platform-status.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relic-status-'));
  const home = join(root, 'home');
  const content = join(root, 'content');
  mkdirSync(home, { recursive: true });
  mkdirSync(content, { recursive: true });
  return { root, home, content, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function statusOf(f, extra = {}) {
  return collectPlatformStatus({ home: f.home, contentRepo: f.content, env: {}, ...extra });
}

function writeAgents(dir, body = `# governance\n${SENTINEL} @ 0101-000000\n`) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), body);
}

test('P1: 全无安装 → 三平台 absent，无未治理', () => {
  const f = fixture();
  try {
    const s = statusOf(f);
    assert.deepEqual(s.platforms.map((p) => p.id), ['dsh', 'opencode', 'codex']);
    assert.ok(s.platforms.every((p) => p.status === 'absent'));
    assert.deepEqual(s.ungoverned, []);
    assert.equal(s.governedCount, 0);
  } finally { f.cleanup(); }
});

test('P2: 已建 ~/.dsh 但无 AGENTS.md → 已检测未治理', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, '.dsh'));
    const s = statusOf(f);
    const dsh = s.platforms.find((p) => p.id === 'dsh');
    assert.equal(dsh.detected, true);
    assert.equal(dsh.governed, false);
    assert.equal(dsh.status, 'ungoverned');
    assert.deepEqual(s.ungoverned, ['dsh']);
  } finally { f.cleanup(); }
});

test('P3: AGENTS.md 含哨兵 → governed + healthy', () => {
  const f = fixture();
  try {
    writeAgents(join(f.home, '.dsh'));
    writeAgents(join(f.home, '.codex'));
    const s = statusOf(f);
    assert.equal(s.platforms.find((p) => p.id === 'dsh').status, 'governed');
    assert.equal(s.platforms.find((p) => p.id === 'dsh').healthy, true);
    assert.equal(s.platforms.find((p) => p.id === 'codex').status, 'governed');
    assert.equal(s.governedCount, 2);
    assert.deepEqual(s.ungoverned, []);
  } finally { f.cleanup(); }
});

test('P4: 文件存在但无哨兵 → governed 但 healthy=false', () => {
  const f = fixture();
  try {
    writeAgents(join(f.home, '.dsh'), '# manually written\n');
    const dsh = statusOf(f).platforms.find((p) => p.id === 'dsh');
    assert.equal(dsh.governed, true);
    assert.equal(dsh.healthy, false);
  } finally { f.cleanup(); }
});

test('P5: 与本次渲染不一致 → stale；一致 → governed', () => {
  const f = fixture();
  try {
    const dir = join(f.home, '.dsh');
    writeAgents(dir, 'old content');
    const renderMap = { dsh: { 'AGENTS.md': 'fresh content' } };
    let s = statusOf(f, { renderMap });
    assert.equal(s.platforms.find((p) => p.id === 'dsh').status, 'stale');
    assert.deepEqual(s.stale, ['dsh']);

    writeAgents(dir, 'fresh content');
    s = statusOf(f, { renderMap });
    assert.equal(s.platforms.find((p) => p.id === 'dsh').status, 'governed');
    assert.deepEqual(s.stale, []);
  } finally { f.cleanup(); }
});

test('P6: 声明路径不存在 → declaredMissing', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.content, 'harness-paths.json'), JSON.stringify({ dsh: join(f.root, 'gone', 'home') }));
    const s = statusOf(f);
    assert.deepEqual(s.declaredMissing, [{ id: 'dsh', path: join(f.root, 'gone', 'home') }]);
    assert.equal(s.platforms.find((p) => p.id === 'dsh').declaredExists, false);
  } finally { f.cleanup(); }
});

test('P7: 声明路径存在 → target 取声明路径（优先于默认）', () => {
  const f = fixture();
  try {
    const custom = join(f.root, 'custom-dsh');
    writeAgents(custom);
    writeAgents(join(f.home, '.dsh'));
    writeFileSync(join(f.content, 'harness-paths.json'), JSON.stringify({ dsh: custom }));
    const dsh = statusOf(f).platforms.find((p) => p.id === 'dsh');
    assert.equal(dsh.target, custom);
    assert.equal(dsh.governed, true);
    assert.deepEqual(statusOf(f).declaredMissing, []);
  } finally { f.cleanup(); }
});

test('P8: env 注入 DSH_HOME → 候选命中环境变量路径', () => {
  const f = fixture();
  try {
    const envHome = join(f.root, 'env-dsh');
    mkdirSync(envHome, { recursive: true });
    const s = collectPlatformStatus({
      home: f.home,
      contentRepo: f.content,
      env: { DSH_HOME: envHome },
    });
    const dsh = s.platforms.find((p) => p.id === 'dsh');
    assert.equal(dsh.target, envHome);
    assert.equal(dsh.status, 'ungoverned');
  } finally { f.cleanup(); }
});

test('P9: summarizeDeployReport 汇总扁平报告', () => {
  const r = summarizeDeployReport({
    ok: true,
    report: { written: ['/a/AGENTS.md'], skipped: ['b (unchanged)'], errors: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.writtenCount, 1);
  assert.deepEqual(r.skipped, ['b (unchanged)']);
  assert.deepEqual(r.errors, []);
});

test('P10: 缺 home 抛错（调用方契约）', () => {
  assert.throws(() => collectPlatformStatus({}), /home 必填/);
});
