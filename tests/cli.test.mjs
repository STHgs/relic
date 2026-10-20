// =============================================================================
// tests/cli.test.mjs — CLI 入口测试（generate + inject）
// =============================================================================
// 用 spawnSync 跑真实 CLI 进程，验证：
//   G1: generate --dry-run 退出 0 + stdout 合法 JSON + 含 fileMaps
//   G2: generate 缺 policies 参数文件 → 退出 1
//   G3: generate 不存在的 policies → 退出 1
//   I1: inject --type=permission --dry-run 退出 0 + stdout JSON 含 yamlSnippet
//   I2: inject 缺 --type → 退出 1
//   I3: inject --apply 后 generate（apply 真写路径用隔离临时 policies.yaml 测，避免污染项目 policies）
//   I4: inject id 冲突 → 退出 2
// =============================================================================

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { stringify } from 'yaml';

const REPO = resolve(import.meta.dirname, '..');
const GEN_CLI = join(REPO, 'src', 'orchestrator', 'generate.mjs');
const INJECT_CLI = join(REPO, 'src', 'core', 'inject.mjs');
const POLICIES = join(REPO, 'template', 'policies.yaml');
const MODULES_DIR = join(REPO, 'template', 'modules');

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-cli-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// 环境无关性（测试权威性原则）：自带 fake HOME，四个平台标记目录齐全 → adapters 全部
// detected。不依赖运行机器的真实布局（CI runner 上没有任何平台目录）。
const FAKE_HOME = join(tmpdir(), 'relic-cli-fake-home');
mkdirSync(join(FAKE_HOME, '.config', 'opencode'), { recursive: true });
writeFileSync(join(FAKE_HOME, '.config', 'opencode', 'opencode.jsonc'), '{}');  // detect 的是文件
mkdirSync(join(FAKE_HOME, '.omo'), { recursive: true });
writeFileSync(join(FAKE_HOME, '.omo', 'omo.jsonc'), '{}');  // detect 的是文件
mkdirSync(join(FAKE_HOME, '.dsh'), { recursive: true });

const runCli = (cli, args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd || REPO,
    env: { ...process.env, HOME: FAKE_HOME, XDG_CONFIG_HOME: '', DSH_HOME: '', OPENCODE_CONFIG: '', RELIC_CONTENT_REPO: '/nonexistent-repo-isolated', ...(opts.env || {}) },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const parseJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

describe('G1: generate --dry-run', () => {
  const r = runCli(GEN_CLI, ['--policies', POLICIES, '--dry-run']);
  const out = parseJson(r.stdout);

  it('exits 0', () => assert.equal(r.code, 0));
  it('stdout is valid JSON', () => assert.ok(out, `stdout was: ${r.stdout.slice(0, 200)}`));
  it('ok:true', () => assert.equal(out.ok, true));
  it('dryRun:true', () => assert.equal(out.dryRun, true));
  it('has fileMaps with opencode/omo/dsh', () => {
    assert.ok(out.fileMaps, 'fileMaps present');
    assert.ok(out.fileMaps.opencode, 'opencode present');
    assert.ok(out.fileMaps.omo, 'omo present');
    assert.ok(out.fileMaps.dsh, 'dsh present');
  });
  it('skipped lists all 4 as dryRun', () => {
    const dryRunSkips = out.skipped.filter((s) => s.includes('dryRun'));
    assert.equal(dryRunSkips.length, 3);
  });
});

describe('G2: generate with missing --policies file → exit 1', () => {
  // 自包含路径：不依赖 beforeEach 建立的 scratch（describe 体执行时序因运行模式而异）
  const r = runCli(GEN_CLI, ['--policies', join(tmpdir(), 'relic-cli-g2-nope.yaml')]);
  it('exits 1', () => assert.equal(r.code, 1));
  it('stderr has error JSON', () => {
    const e = parseJson(r.stderr);
    assert.ok(e && e.ok === false);
    assert.match(e.error, /not found/i);
  });
});

describe('G3: generate with invalid policies (schema fail) → exit 1', () => {
  const badPath = join(tmpdir(), 'relic-cli-g3-bad.yaml');
  writeFileSync(badPath, stringify({
    meta: { version: 2, description: 'bad' },
    permissions: [{
      id: 'x', intent: 'x', applies_to: ['primary'],
      enforcement: 'hook',  // dropped
      tool: 'bash', action: 'ask',
    }],
  }));
  const r = runCli(GEN_CLI, ['--policies', badPath, '--dry-run']);
  it('exits 1', () => assert.equal(r.code, 1));
  it('stderr mentions validate stage + enforcement', () => {
    const e = parseJson(r.stderr);
    assert.equal(e.stage, 'validate');
    assert.match(JSON.stringify(e.errors), /enforcement/i);
  });
});

describe('I1: inject --type=permission --dry-run', () => {
  const rule = {
    id: 'test-cli-rule',
    intent: 'Test rule for CLI verification',
    applies_to: ['primary'],
    enforcement: 'runtime',
    tool: 'bash',
    patterns: [{ pattern: 'testcmd *', action: 'ask' }],
    action: 'ask',
  };
  const r = runCli(INJECT_CLI, ['--type=permission', '--dry-run', '--policies', POLICIES, JSON.stringify(rule)]);
  const out = parseJson(r.stdout);

  it('exits 0', () => assert.equal(r.code, 0));
  it('stdout is valid JSON', () => assert.ok(out));
  it('ok:true', () => assert.equal(out.ok, true));
  it('mode:dry-run', () => assert.equal(out.mode, 'dry-run'));
  it('has yamlSnippet', () => assert.ok(out.yamlSnippet));
  it('yamlSnippet emits patterns as objects (- pattern: "...")', () => {
    assert.match(out.yamlSnippet, /-\s+pattern:\s+"testcmd \*"/);
    assert.doesNotMatch(out.yamlSnippet, /-\s+"testcmd \*"\s*$/);
  });
});

describe('I2: inject missing --type → exit 1', () => {
  const r = runCli(INJECT_CLI, ['--dry-run', '{"id":"x"}']);
  it('exits 1', () => assert.equal(r.code, 1));
  it('stderr mentions --type', () => assert.match(r.stderr, /--type/));
});

describe('I3: inject --apply writes + runs generate (isolated policies)', () => {
  // 隔离 manifest + modules 副本（manifest 模式需要 modules/ 目录）。
  // 自建隔离目录（describe 体执行时序因运行模式而异，不用 beforeEach-scratch）。
  const isoRoot = mkdtempSync(join(tmpdir(), 'relic-cli-i3-'));
  after(() => rmSync(isoRoot, { recursive: true, force: true }));
  const isoPolicies = join(isoRoot, 'policies.yaml');
  const isoModules = join(isoRoot, 'modules');
  copyFileSync(POLICIES, isoPolicies);
  // 动态复制全部模块（default profile = full 需要注册表内所有模块；硬编码清单会漏新模块）
  for (const ent of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    mkdirSync(join(isoModules, ent.name), { recursive: true });
    copyFileSync(join(MODULES_DIR, ent.name, 'module.yaml'), join(isoModules, ent.name, 'module.yaml'));
  }

  const rule = {
    id: 'iso-test-rule',
    intent: 'Isolated test rule for apply mode',
    applies_to: ['primary'],
    enforcement: 'runtime',
    tool: 'bash',
    patterns: [{ pattern: 'iso-cmd *', action: 'ask' }],
    action: 'ask',
  };
  // HOME 指向不存在的临时目录，generate 不会真写任何平台配置（都 not detected）
  const r = runCli(INJECT_CLI, ['--type=permission', '--apply', '--policies', isoPolicies, JSON.stringify(rule)], {
    env: { HOME: join(isoRoot, 'fake-home') },  // 不存在 → 全部 not detected，绝不真写
  });
  const out = parseJson(r.stdout);

  it('exits 0', () => assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`));
  it('ok:true', () => assert.equal(out.ok, true));
  it('mode:apply', () => assert.equal(out.mode, 'apply'));
  it('newCount = previousCount + 1', () => assert.equal(out.newCount, out.previousCount + 1));
  it('rule was actually written to isolated policies.yaml', () => {
    const after = readFileSync(isoPolicies, 'utf8');
    assert.match(after, /iso-test-rule/);
  });
});

describe('I4: inject id clash → exit 2', () => {
  // 拆分后 policies.yaml 是 manifest；inline 留 add-permission/add-workflow 两条入口 workflow。
  // 用 add-permission 的 id 注入 type=workflow → 触发 id clash（exit 2）。
  const dup = {
    id: 'add-permission',  // 已存在于 manifest inline workflows
    intent: 'Duplicate to trigger id clash',
    steps: ['step one', 'step two'],
  };
  const r = runCli(INJECT_CLI, ['--type=workflow', '--dry-run', '--policies', POLICIES, JSON.stringify(dup)]);
  const out = parseJson(r.stdout);
  it('exits 2', () => assert.equal(r.code, 2));
  it('blocked:id_conflict', () => assert.equal(out.blocked, 'id_conflict'));
});
