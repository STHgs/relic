// =============================================================================
// tests/base.test.mjs — T7 adapter base 契约 + 辅助函数测试
// =============================================================================
// 验证 backup / writeWithHeader / emptyReport 三个共享辅助的基本行为。
// （完整适配器测试在 T8 adapters.test.mjs；这里只测共享层）
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { backup, writeWithHeader, emptyReport, isContentUnchanged } from '../src/adapters/base.mjs';

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-base-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('backup()', () => {
  it('backs up existing file to .bak.<ts>', () => {
    const src = join(scratch, 'cfg.jsonc');
    writeFileSync(src, 'OLD');
    const bak = backup(src, { now: () => new Date('2026-08-26T10:00:00.000Z') });
    assert.match(bak, /^.*\.bak\.2026-08-26T10-00-00-000Z$/);
    assert.equal(readFileSync(bak, 'utf8'), 'OLD');
  });

  it('returns empty string when source does not exist', () => {
    const bak = backup(join(scratch, 'nope'));
    assert.equal(bak, '');
  });

  it('skips writing when dryRun=true', () => {
    const src = join(scratch, 'cfg.jsonc');
    writeFileSync(src, 'OLD');
    const bak = backup(src, { dryRun: true, now: () => new Date('2026-08-26T10:00:00.000Z') });
    assert.match(bak, /\.bak\./);           // returns the would-be path
    assert.equal(existsSync(bak), false);   // but does not create it
  });
});

describe('writeWithHeader()', () => {
  it('writes content with default relic header', () => {
    const dst = join(scratch, 'sub', 'out.jsonc');
    writeWithHeader(dst, '{"x":1}');
    const out = readFileSync(dst, 'utf8');
    assert.match(out, /部分自动生成 — agent 键由 relic 生成/);
    assert.match(out, /生成时间: /);
    assert.match(out, /\{"x":1\}$/);
  });

  it('creates parent directories', () => {
    const dst = join(scratch, 'a', 'b', 'c', 'out.md');
    writeWithHeader(dst, 'body');
    assert.equal(existsSync(dst), true);
  });

  it('respects custom header', () => {
    const dst = join(scratch, 'out.md');
    writeWithHeader(dst, 'body', { header: '# HDR\n\n' });
    assert.equal(readFileSync(dst, 'utf8'), '# HDR\n\nbody');
  });

  it('does not write when dryRun=true', () => {
    const dst = join(scratch, 'out.md');
    writeWithHeader(dst, 'body', { dryRun: true });
    assert.equal(existsSync(dst), false);
  });
});

describe('emptyReport()', () => {
  it('returns a clean ok report', () => {
    assert.deepEqual(emptyReport(), { ok: true, written: [], backups: [], skipped: [], errors: [] });
  });
});

describe('isContentUnchanged()', () => {
  it('returns true when file content equals newContent', () => {
    const p = join(scratch, 'cfg.md');
    writeFileSync(p, 'IDENTICAL');
    assert.equal(isContentUnchanged(p, 'IDENTICAL'), true);
  });
  it('returns false when content differs', () => {
    const p = join(scratch, 'cfg.md');
    writeFileSync(p, 'OLD');
    assert.equal(isContentUnchanged(p, 'NEW'), false);
  });
  it('returns false when file does not exist', () => {
    assert.equal(isContentUnchanged(join(scratch, 'nope'), 'anything'), false);
  });
  it('returns true for empty string match', () => {
    const p = join(scratch, 'empty.md');
    writeFileSync(p, '');
    assert.equal(isContentUnchanged(p, ''), true);
  });
});
