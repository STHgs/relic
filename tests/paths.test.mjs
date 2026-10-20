// =============================================================================
// tests/paths.test.mjs — harness 位置四层解析链（2026-09-23 v2）
// =============================================================================
// PL1: 第 4 层约定兜底（默认环境 = 原行为）
// PL2: 第 2 层 env（DSH_HOME/OPENCODE_CONFIG/XDG_CONFIG_HOME）
// PL3: 第 1 层声明（contentRepo harness-paths.json 注入）
// PL4: 优先序（声明 > env > 约定）
// PL5: firstExisting 探测序（沿用）
// PL6: 声明文件损坏容错
// =============================================================================
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { platformPaths, firstExisting } from '../src/core/paths.mjs';

const ENV_KEYS = ['DSH_HOME', 'OPENCODE_CONFIG', 'OMO_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME'];
const saved = {};
const realPlatform = process.platform;

describe('PL1: layer-4 convention fallback (default env)', () => {
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('opencode resolves to ~/.config/opencode (XdG default)', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: {} });
    assert.deepEqual(p.opencode, ['/home/u/.config/opencode']);
  });
  it('dsh/omo/codex use dotfile conventions', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: {} });
    assert.deepEqual(p.dsh, ['/home/u/.dsh']);
    assert.deepEqual(p.omo, ['/home/u/.omo']);   // OMO 真机=点目录（非 XDG）
    assert.deepEqual(p.codex, ['/home/u/.codex']);
  });
});

describe('PL2: layer-2 env overrides', () => {
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('DSH_HOME takes priority over convention', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: { DSH_HOME: '/custom/dsh' } });
    assert.deepEqual(p.dsh, ['/custom/dsh', '/home/u/.dsh']);
  });
  it('OPENCODE_CONFIG dir becomes top opencode candidate', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: { OPENCODE_CONFIG: '/custom/oc/opencode.json' } });
    assert.equal(p.opencode[0], '/custom/oc');
    assert.ok(p.opencode[1].endsWith('.config/opencode'));
  });
  it('XDG_CONFIG_HOME reroots opencode only (omo is dotdir fact)', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: { XDG_CONFIG_HOME: '/xdg/root' } });
    assert.deepEqual(p.opencode, ['/xdg/root/opencode']);
    assert.deepEqual(p.omo, ['/home/u/.omo']);
  });
  it('CODEX_HOME takes priority over convention', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: { CODEX_HOME: '/custom/codex' } });
    assert.deepEqual(p.codex, ['/custom/codex', '/home/u/.codex']);
  });
  it('relative XDG_CONFIG_HOME ignored (spec violation)', () => {
    const p = platformPaths('/home/u', { contentRepo: '/nonexistent-repo', env: { XDG_CONFIG_HOME: 'relative/path' } });
    assert.ok(p.opencode[0].includes('/home/u/.config/opencode'));
  });
});

describe('PL3: layer-1 declared paths (content repo json)', () => {
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('declared dsh/opencode/omo lead the candidate lists', () => {
    const repo = mkdtempSync(join(tmpdir(), 'relic-paths-declared-'));
    try {
      writeFileSync(join(repo, 'harness-paths.json'), JSON.stringify({
        dsh: '/declared/dsh', opencode: '/declared/oc', omo: '/declared/omo',
      }));
      const p = platformPaths('/home/u', { contentRepo: repo });
      assert.equal(p.dsh[0], '/declared/dsh');
      assert.equal(p.opencode[0], '/declared/oc');
      assert.equal(p.omo[0], '/declared/omo');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('partial declaration only affects that harness', () => {
    const repo = mkdtempSync(join(tmpdir(), 'relic-paths-partial-'));
    try {
      writeFileSync(join(repo, 'harness-paths.json'), JSON.stringify({ dsh: '/declared/dsh' }));
      const p = platformPaths('/home/u', { contentRepo: repo });
      assert.equal(p.dsh[0], '/declared/dsh');
      assert.deepEqual(p.opencode, ['/home/u/.config/opencode']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('missing declaration file -> pure convention (no throw)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'relic-paths-empty-'));
    try {
      const p = platformPaths('/home/u', { contentRepo: repo });
      assert.deepEqual(p.dsh, ['/home/u/.dsh']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('PL4: precedence declared > env > convention', () => {
  beforeEach(() => { saved.DSH_HOME = process.env.DSH_HOME; process.env.DSH_HOME = '/env/dsh'; Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.DSH_HOME; Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('declared beats env beats convention', () => {
    const repo = mkdtempSync(join(tmpdir(), 'relic-paths-pre-'));
    try {
      writeFileSync(join(repo, 'harness-paths.json'), JSON.stringify({ dsh: '/declared/dsh' }));
      const p = platformPaths('/home/u', { contentRepo: repo });
      assert.deepEqual(p.dsh, ['/declared/dsh', '/env/dsh', '/home/u/.dsh']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('PL5: firstExisting probing order', () => {
  it('returns first existing candidate', () => {
    assert.equal(firstExisting(['/nope', '/hit'], (p) => p === '/hit'), '/hit');
  });
  it('null when none', () => {
    assert.equal(firstExisting(['/a'], () => false), null);
  });
});

describe('PL6: corrupt declaration tolerated', () => {
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('broken json -> convention fallback (no throw)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'relic-paths-bad-'));
    try {
      writeFileSync(join(repo, 'harness-paths.json'), '{ this is not json');
      const p = platformPaths('/home/u', { contentRepo: repo });
      assert.deepEqual(p.dsh, ['/home/u/.dsh']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('PL7: win32 variant keeps AppData+config dual path', () => {
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('opencode = AppData first, .config fallback (platform-agnostic)', () => {
    const p = platformPaths('C:\\Users\\u');
    assert.equal(p.opencode.length, 2);
    assert.ok(p.opencode[0].includes('AppData') && p.opencode[0].includes('opencode'), 'first: ' + p.opencode[0]);
    assert.ok(p.opencode[1].includes('.config') && p.opencode[1].includes('opencode'), 'fallback: ' + p.opencode[1]);
  });
});
