// =============================================================================
// tests/adapters-merge.test.mjs — P1+P2: install deep/shallow merge (GAP1+GAP2)
// =============================================================================
// P1 (GAP1): omo install must deep-merge permission into existing
//   omo.jsonc['[opencode]'].agents.<name>.permission, preserving
//   model/fallback_models/other top-level + per-agent fields.
//   Faithful port of live install.sh:87-94 merge semantics.
//
// P2 (GAP2): opencode install must shallow-merge agent field into existing
//   opencode.jsonc, preserving provider/model/sharing top-level sentinels.
//   Faithful port of live install.sh:146 merge semantics.
//   Q6 decision: match live shallow merge exactly (oc.agent = {...(oc.agent||{}), ...genAgent}).
//
// Also tests stripJsonc/parseJsonc shared helpers (extracted from live install.sh).
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripJsonc, parseJsonc } from '../src/adapters/base.mjs';
import omoAdapter from '../src/adapters/omo.mjs';
import opencodeAdapter from '../src/adapters/opencode.mjs';

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-merge-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ─── stripJsonc / parseJsonc ──────────────────────────────────────────

describe('stripJsonc()', () => {
  it('strips single-line comments (//)', () => {
    const input = '{ "a": 1 // comment\n, "b": 2 }';
    const out = stripJsonc(input);
    assert.equal(out, '{ "a": 1 \n, "b": 2 }');
  });

  it('strips block comments (/* */)', () => {
    const input = '{ "a": /* inline */ 1 }';
    const out = stripJsonc(input);
    assert.equal(out, '{ "a":  1 }');
  });

  it('preserves // inside strings', () => {
    const input = '{ "url": "https://example.com" }';
    const out = stripJsonc(input);
    assert.equal(out, input);
  });

  it('preserves /* inside strings', () => {
    const input = '{ "path": "a/*b" }';
    const out = stripJsonc(input);
    assert.equal(out, input);
  });

  it('handles escaped backslash-quote in strings', () => {
    const input = '{ "s": "a\\"//b" }';
    const out = stripJsonc(input);
    assert.equal(out, input);
  });

  it('handles multi-line block comments', () => {
    const input = '{ "a": /* multi\nline\ncomment */ 1 }';
    const out = stripJsonc(input);
    assert.equal(out, '{ "a":  1 }');
  });

  it('handles empty string', () => {
    assert.equal(stripJsonc(''), '');
  });

  it('handles string with no comments unchanged', () => {
    const input = '{"x":1,"y":2}';
    assert.equal(stripJsonc(input), input);
  });
});

describe('parseJsonc()', () => {
  it('parses JSONC with comments', () => {
    const input = '// header\n{ "a": 1 /* x */, "b": 2 }';
    const obj = parseJsonc(input);
    assert.deepEqual(obj, { a: 1, b: 2 });
  });

  it('parses plain JSON', () => {
    assert.deepEqual(parseJsonc('{"x":1}'), { x: 1 });
  });
});

// ─── P1: omo install deep-merge (GAP1) ─────────────────────────────────


// ─── P2: opencode install shallow-merge (GAP2) ─────────────────────────

// 2026-09-15 去硬约束：opencode/omo install 合并语义已随 route A 退役（相关 describe 移除）；
// stripJsonc/parseJsonc 等 base helper 测试保留。
