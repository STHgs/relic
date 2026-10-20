// =============================================================================
// tests/adapters.test.mjs — T8 三适配器测试
// =============================================================================
// A1: opencode FileMap keys = { opencode.agent.jsonc, AGENTS.md }
// A2: omo FileMap keys = { omo.permission.jsonc }；resolveAgents 角色→agent 名
// A3: opencode role-flattening——所有 runtime 权限在 general/build/explore 三 agent
//     下出现且 permission map 一致
// A4: claude FileMap keys = { AGENTS.md } only — NO claude.hooks.json（F1=DROP 验证）
// A5: round-trip 稳定——generate(parse(stringify(generate(p)))) 字节一致
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { posix, resolve, join as fsJoin, dirname } from 'path';
const join = posix.join;  // 正斜杠标准（路径比较/断言用——detect/Set 匹配）
// dirname/resolve/fsJoin = 原生平台版（真实 fs 路径推导用）
import { parse, stringify } from 'yaml';
import { tmpdir } from 'os';
import { createValidator } from '../src/core/validator.mjs';
import opencodeAdapter from '../src/adapters/opencode.mjs';
import omoAdapter from '../src/adapters/omo.mjs';
import dshAdapter from '../src/adapters/dsh.mjs';
import codexAdapter from '../src/adapters/codex.mjs';

const realPlatform = process.platform;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const goodYaml = readFileSync(resolve(FIXTURES, 'policies-good.yaml'), 'utf8');
const policies = createValidator()(parse(goodYaml)).doc;

const fakeEnv = (paths, home = '/fake') => ({ home, env: { RELIC_CONTENT_REPO: '/nonexistent-repo' }, existsSync: (p) => paths.has(p) });  // env 隔离：DSH_HOME/XDG/声明层（真实 harness-paths.json 会跨层泄漏进测试）

describe('A1: opencode FileMap keys (route A)', () => {
  const fm = opencodeAdapter.generate(policies, fakeEnv(new Set()));
  it('has AGENTS.md only (runtime injection retired)', () => {
    assert.deepEqual(Object.keys(fm).sort(), ['AGENTS.md']);
  });
  it('AGENTS.md contains self-compliance governance', () => {
    assert.match(fm['AGENTS.md'], /治理约束（自律执行）/);
    assert.ok(!fm['AGENTS.md'].includes('运行时强制'), 'must not claim runtime enforcement');
  });
});

describe('A2: omo route A no-op', () => {
  const fm = omoAdapter.generate(policies, fakeEnv(new Set()));
  it('produces no artifacts (governance via opencode AGENTS.md)', () => {
    assert.deepEqual(Object.keys(fm), []);
  });
  it('install reports skipped no-op reason', () => {
    const r = omoAdapter.install({}, { home: '/nonexistent', dryRun: false });
    assert.equal(r.written.length, 0);
    assert.ok(r.skipped.some((x) => x.includes('no-op')));
  });
});

describe('A3: opencode route A', () => {
  const fm = opencodeAdapter.generate(policies, fakeEnv(new Set()));
  it('FileMap = AGENTS.md only (no runtime permission injection)', () => {
    assert.deepEqual(Object.keys(fm), ['AGENTS.md']);
  });
  it('AGENTS.md contains 治理约束 self-compliance table', () => {
    assert.match(fm['AGENTS.md'], /## 治理约束（自律执行）/);
    assert.match(fm['AGENTS.md'], /deny 级条目任何情况下不得执行/);
  });
});

describe('A5: round-trip stability', () => {
  const fm1 = opencodeAdapter.generate(policies, fakeEnv(new Set()));
  const fm2 = opencodeAdapter.generate(
    parse(stringify(policies)),
    fakeEnv(new Set())
  );
  it('opencode FileMap byte-identical after stringify→parse round-trip', () => {
    assert.equal(fm1['opencode.agent.jsonc'], fm2['opencode.agent.jsonc']);
    assert.equal(fm1['AGENTS.md'], fm2['AGENTS.md']);
  });

  const fmOmo1 = omoAdapter.generate(policies, fakeEnv(new Set()));
  const fmOmo2 = omoAdapter.generate(parse(stringify(policies)), fakeEnv(new Set()));
  it('omo FileMap byte-identical after round-trip', () => {
    assert.equal(fmOmo1['omo.permission.jsonc'], fmOmo2['omo.permission.jsonc']);
  });

  // claude round-trip 断言随适配器退役移除（route A 同构逻辑已由 A3/A6 覆盖）
});

describe('adapter.detect()', () => {
  it('opencode detects when config present', () => {
    const home = '/fake';
    const env = fakeEnv(new Set([join(home, '.config', 'opencode', 'opencode.jsonc')]), home);
    assert.equal(opencodeAdapter.detect(env), true);
  });
  it('opencode does not detect when absent', () => {
    assert.equal(opencodeAdapter.detect(fakeEnv(new Set())), false);
  });
  it('omo detects when ~/.omo/omo.jsonc present', () => {
    const home = '/fake';
    const env = fakeEnv(new Set([join(home, '.omo', 'omo.jsonc')]), home);
    assert.equal(omoAdapter.detect(env), true);
  });
});

describe('adapter.install() dryRun', () => {
  const home = '/nonexistent-dry-run-path';
  it('opencode dryRun returns skipped, no written, no errors', () => {
    const r = opencodeAdapter.install(
      { 'AGENTS.md': '# x' },
      { home, dryRun: true }
    );
    assert.equal(r.written.length, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(r.skipped.length > 0);
  });
  it('omo dryRun returns skipped (route A no-op)', () => {
    const r = omoAdapter.install({}, { home, dryRun: true });
    assert.equal(r.written.length, 0);
    assert.ok(r.skipped.length > 0);
  });
});

describe('A6: dsh FileMap keys', () => {
  const fm = dshAdapter.generate(policies, fakeEnv(new Set()));
  it('keys = [AGENTS.md] only', () => {
    assert.deepEqual(Object.keys(fm), ['AGENTS.md']);
  });
  it('AGENTS.md content has 治理约束 section', () => {
    assert.match(fm['AGENTS.md'], /## 治理约束/);
  });
});

describe('A6b: dsh round-trip stability', () => {
  const fm1 = dshAdapter.generate(policies, fakeEnv(new Set()));
  const fm2 = dshAdapter.generate(parse(stringify(policies)), fakeEnv(new Set()));
  it('dsh FileMap byte-identical after stringify→parse round-trip', () => {
    assert.equal(fm1['AGENTS.md'], fm2['AGENTS.md']);
  });
});

describe('A6c: dsh adapter.detect() (posix behavior)', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('dsh detects when ~/.dsh dir present', () => {
    const home = '/fake';
    const env = fakeEnv(new Set([join(home, '.dsh')]), home);
    assert.equal(dshAdapter.detect(env), true);
  });
  it('dsh does not detect when absent', () => {
    assert.equal(dshAdapter.detect(fakeEnv(new Set())), false);
  });
});

describe('A6d: dsh adapter.install() dryRun', () => {
  const home = '/nonexistent-dry-run-path';
  it('dsh dryRun returns skipped, no written, no errors', () => {
    const r = dshAdapter.install(
      { 'AGENTS.md': '# x' },
      { home, dryRun: true }
    );
    assert.equal(r.written.length, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(r.skipped.length > 0);
  });
  it('dsh dryRun skips when no AGENTS.md in map', () => {
    const r = dshAdapter.install({}, { home, dryRun: true });
    assert.equal(r.written.length, 0);
    assert.ok(r.skipped.length > 0);
  });
});

// ─── A1: content-equality short-circuit (unchanged → skip) ───────────────
// 验证内容未变时不产生 .bak、不写盘——源头消除冗余备份。
describe('A7: install unchanged → skip (A1 content-equality)', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  let scratch;
  beforeEach(() => { scratch = mkdtempSync(fsJoin(tmpdir(), 'relic-a1-')); });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('opencode: same content → skipped, no .bak, no written', () => {
    const ocDir = join(scratch, '.config', 'opencode');
    mkdirSync(ocDir, { recursive: true });
    const agentsMdPath = join(ocDir, 'AGENTS.md');
    const content = '# governance v1';
    writeFileSync(agentsMdPath, content, 'utf8');

    const r = opencodeAdapter.install({ 'AGENTS.md': content }, { home: scratch, dryRun: false, env: {} });
    assert.equal(r.written.length, 0);
    assert.equal(r.backups.length, 0);
    assert.ok(r.skipped.some((x) => x.includes('unchanged')), `expected unchanged in skipped: ${r.skipped}`);
    // no .bak files created
    const baks = readdirSync(ocDir).filter((f) => f.includes('.bak.'));
    assert.equal(baks.length, 0);
  });

  it('opencode: different content → written + backup (normal path)', () => {
    const ocDir = join(scratch, '.config', 'opencode');
    mkdirSync(ocDir, { recursive: true });
    const agentsMdPath = join(ocDir, 'AGENTS.md');
    writeFileSync(agentsMdPath, '# old', 'utf8');

    const r = opencodeAdapter.install({ 'AGENTS.md': '# new' }, { home: scratch, dryRun: false, env: {} });
    assert.equal(r.written.length, 1);
    assert.equal(r.backups.length, 1);
  });

  it('dsh: same content → skipped, no .bak, no written', () => {
    const dshDir = join(scratch, '.dsh');
    mkdirSync(dshDir, { recursive: true });
    const agentsMdPath = join(dshDir, 'AGENTS.md');
    const content = '# governance v1';
    writeFileSync(agentsMdPath, content, 'utf8');

    const r = dshAdapter.install({ 'AGENTS.md': content }, { home: scratch, dryRun: false, env: { RELIC_CONTENT_REPO: '/nonexistent-repo' } });
    assert.equal(r.written.length, 0);
    assert.equal(r.backups.length, 0);
    assert.ok(r.skipped.some((x) => x.includes('unchanged')), `expected unchanged in skipped: ${r.skipped}`);
    const baks = readdirSync(dshDir).filter((f) => f.includes('.bak.'));
    assert.equal(baks.length, 0);
  });

  it('dsh: different content → written + backup (normal path)', () => {
    const dshDir = join(scratch, '.dsh');
    mkdirSync(dshDir, { recursive: true });
    const agentsMdPath = join(dshDir, 'AGENTS.md');
    writeFileSync(agentsMdPath, '# old', 'utf8');

    const r = dshAdapter.install({ 'AGENTS.md': '# new' }, { home: scratch, dryRun: false, env: {} });
    assert.equal(r.written.length, 1);
    assert.equal(r.backups.length, 1);
  });
});

describe('A8: codex FileMap keys (route A)', () => {
  const fm = codexAdapter.generate(policies, fakeEnv(new Set()));
  it('FileMap = AGENTS.md only', () => {
    assert.deepEqual(Object.keys(fm), ['AGENTS.md']);
  });
  it('AGENTS.md contains self-compliance governance', () => {
    assert.match(fm['AGENTS.md'], /治理约束（自律执行）/);
    assert.ok(!fm['AGENTS.md'].includes('运行时强制'), 'must not claim runtime enforcement');
  });
});

describe('A8b: codex round-trip stability', () => {
  const fm1 = codexAdapter.generate(policies, fakeEnv(new Set()));
  const fm2 = codexAdapter.generate(parse(stringify(policies)), fakeEnv(new Set()));
  it('FileMap byte-identical after round-trip', () => {
    assert.equal(fm1['AGENTS.md'], fm2['AGENTS.md']);
  });
});

describe('A8c: codex detect (env isolated, posix behavior)', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  it('detects when ~/.codex dir present', () => {
    const home = '/fake';
    const env = fakeEnv(new Set([join(home, '.codex')]), home);
    assert.equal(codexAdapter.detect(env), true);
  });
  it('does not detect when absent', () => {
    assert.equal(codexAdapter.detect(fakeEnv(new Set())), false);
  });
  it('CODEX_HOME env candidate probed before convention', () => {
    const home = '/fake';
    const env = fakeEnv(new Set(['/custom/codex']), home);
    env.env = { CODEX_HOME: '/custom/codex' };
    // 声明层同时隔离：env 加 RELIC_CONTENT_REPO 指向不存在路径
    env.env.RELIC_CONTENT_REPO = '/nonexistent-repo';
    assert.equal(codexAdapter.detect(env), true);
  });
});

describe('A8d: codex install dryRun + unchanged skip (posix behavior)', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });
  const home = mkdtempSync(fsJoin(tmpdir(), 'relic-a8d-'));  // 真实 tmpdir（fsJoin：真实 fs 操作用平台原生分隔符）
  it('dryRun returns skipped, no written, no errors', () => {
    const r = codexAdapter.install({ 'AGENTS.md': '# x' }, { home, dryRun: true, env: {} });
    assert.equal(r.written.length, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(r.skipped.length > 0);
  });
  it('fresh install (no existing file) -> attempts write (not unchanged short-circuit)', () => {
    const r = codexAdapter.install({ 'AGENTS.md': '# v-' + Date.now() }, { home, dryRun: false, env: { RELIC_CONTENT_REPO: '/nonexistent-repo' } });
    // tmpdir 存在但 .codex/AGENTS.md 不存在 → 走写入分支（非 unchanged 短路）
    assert.ok(!r.skipped.some((x) => x.includes('unchanged')), 'must not short-circuit on fresh install');
    assert.ok(r.errors.length === 0 || r.written.length === 1, 'reached write branch');
  });
});
