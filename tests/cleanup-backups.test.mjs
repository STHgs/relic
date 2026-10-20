// =============================================================================
// tests/cleanup-backups.test.mjs — B1 cleanup-backups 脚本测试
// =============================================================================
// 测试核心去重逻辑：dedupeGroup（按内容 hash 去重 + 保留最近 N 个变更点）。
// 纯逻辑测试（不跑 CLI），用 mkdtemp 构造真实 .bak 文件集。
// =============================================================================
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 导入脚本的核心逻辑函数（需要从脚本中导出——用动态 import 或直接测试 findBackupsInDir+dedupeGroup）
// cleanup-backups.mjs 是 CLI 脚本，核心逻辑未导出。这里用集成测试方式：构造 .bak 文件集，跑 CLI 验证结果。

import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'cleanup-backups.mjs');

function runCli(args, customHome) {
  const env = { ...process.env };
  if (customHome) env.HOME = customHome;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

describe('B1: cleanup-backups', () => {
  let scratch;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'relic-cleanup-')); });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('dedupes adjacent identical .bak, keeps latest per change point', () => {
    // 模拟：3 个变更点 × 各 5 个冗余 = 15 个 .bak，keep=3 → 保留 3，删 12
    const dir = join(scratch, '.dsh');
    mkdirSync(dir, { recursive: true });
    const contents = ['v1', 'v2', 'v3'];
    let ts = 1;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(dir, `AGENTS.md.bak.2026-09-23T00-${String(ts).padStart(2,'0')}-00-000Z`), contents[c]);
        ts++;
      }
    }
    // 共 15 个 .bak，3 个唯一内容（v1/v2/v3）
    const before = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    assert.equal(before, 15);

    const r = runCli(['--keep', '3', '--path', dir], scratch);
    assert.ok(r.ok, `CLI failed: ${r.stderr}`);

    const after = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    assert.equal(after, 3, `expected 3 .bak after cleanup, got ${after}`);
    // 保留的是每个变更点的最新一个
    const remaining = readdirSync(dir).filter(f => f.includes('.bak.')).sort();
    assert.ok(remaining[remaining.length - 1].includes('00-15-00'), `latest change point .bak should be kept: ${remaining[remaining.length-1]}`);
  });

  it('keep=10 with only 3 change points keeps all 3', () => {
    const dir = join(scratch, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const contents = ['a', 'b', 'c'];
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `AGENTS.md.bak.2026-09-23T00-0${i}-00-000Z`), contents[i]);
    }
    const r = runCli(['--keep', '10', '--path', dir], scratch);
    assert.ok(r.ok);
    const after = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    assert.equal(after, 3, 'keep=10 > change points=3, all kept');
  });

  it('idempotent: running twice produces same result', () => {
    const dir = join(scratch, '.dsh');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `AGENTS.md.bak.2026-09-23T00-0${i}-00-000Z`), i < 5 ? 'v1' : 'v2');
    }
    runCli(['--keep', '5', '--path', dir], scratch);
    const after1 = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    runCli(['--keep', '5', '--path', dir], scratch);
    const after2 = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    assert.equal(after1, after2, 'second run deletes nothing (idempotent)');
  });

  it('dry-run does not delete', () => {
    const dir = join(scratch, '.dsh');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `AGENTS.md.bak.2026-09-23T00-0${i}-00-000Z`), i < 5 ? 'v1' : 'v2');
    }
    const r = runCli(['--dry-run', '--keep', '1', '--path', dir], scratch);
    assert.ok(r.ok);
    const after = readdirSync(dir).filter(f => f.includes('.bak.')).length;
    assert.equal(after, 10, 'dry-run does not delete');
  });

  it('no .bak files: graceful', () => {
    const dir = join(scratch, '.dsh');
    const r = runCli(['--path', dir], scratch);
    assert.ok(r.ok);
    assert.match(r.stdout, /no .bak/);
  });

  it('handles multiple original files in same dir', () => {
    const dir = join(scratch, '.dsh');
    mkdirSync(dir, { recursive: true });
    // 两个原始文件，各有冗余
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `AGENTS.md.bak.2026-09-23T00-0${i}-00-000Z`), i < 3 ? 'a1' : 'a2');
      writeFileSync(join(dir, `other.md.bak.2026-09-23T00-0${i}-00-000Z`), i < 3 ? 'b1' : 'b2');
    }
    const r = runCli(['--keep', '5', '--path', dir], scratch);
    assert.ok(r.ok);
    const agentsBaks = readdirSync(dir).filter(f => f.startsWith('AGENTS.md.bak.')).length;
    const otherBaks = readdirSync(dir).filter(f => f.startsWith('other.md.bak.')).length;
    assert.equal(agentsBaks, 2, 'AGENTS.md: 2 change points');
    assert.equal(otherBaks, 2, 'other.md: 2 change points');
  });
});
