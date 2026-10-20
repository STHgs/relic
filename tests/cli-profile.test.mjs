// =============================================================================
// tests/cli-profile.test.mjs — M4 CLI --profile / --module tests
// =============================================================================
// G4: generate --policies <manifest> --profile work --dry-run → exit 0, fileMaps
// G5: generate --policies <manifest> --profile nope → exit 1, stage:load
// G6: generate --policies <manifest> (no --profile, has default) → exit 0
// I5: inject --type=permission --module sudo-safety --dry-run → exit 0, yamlSnippet
// I6: inject --module sudo-safety --apply (isolated) → writes fragment, validates
// I7: inject --module unknown-id → exit 1
// E1: existing cli.test.mjs G1-G3 + I1-I4 still pass (single-file mode, unchanged)
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO = resolve(import.meta.dirname, '..');
const GEN_CLI = join(REPO, 'src', 'orchestrator', 'generate.mjs');
const INJECT_CLI = join(REPO, 'src', 'core', 'inject.mjs');
const MANIFEST = join(REPO, 'tests', 'fixtures', 'manifest.yaml');
const MODULES_DIR = join(REPO, 'tests', 'fixtures', 'modules');

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-cli-prof-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// 环境无关性：自带 fake HOME（含各平台 detect 标记），不依赖运行机器布局（同 cli.test）
const FAKE_HOME = join(tmpdir(), 'relic-cli-profile-fake-home');
mkdirSync(join(FAKE_HOME, '.config', 'opencode'), { recursive: true });
writeFileSync(join(FAKE_HOME, '.config', 'opencode', 'opencode.jsonc'), '{}');
mkdirSync(join(FAKE_HOME, '.omo'), { recursive: true });
writeFileSync(join(FAKE_HOME, '.omo', 'omo.jsonc'), '{}');
mkdirSync(join(FAKE_HOME, '.dsh'), { recursive: true });

const runCli = (cli, args, opts = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd || REPO,
    env: { ...process.env, HOME: FAKE_HOME, XDG_CONFIG_HOME: '', DSH_HOME: '', OPENCODE_CONFIG: '', ...(opts.env || {}) },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

describe('G4: generate --profile work --dry-run', () => {
  const r = runCli(GEN_CLI, ['--policies', MANIFEST, '--profile', 'work', '--dry-run']);
  const out = parseJson(r.stdout);
  it('exits 0', () => assert.equal(r.code, 0));
  it('ok:true', () => assert.ok(out && out.ok === true));
  it('fileMaps has opencode/omo', () => {
    assert.ok(out.fileMaps.opencode);
    assert.ok(out.fileMaps.omo);
  });
});

describe('G5: generate --profile nope → exit 1, stage:load', () => {
  const r = runCli(GEN_CLI, ['--policies', MANIFEST, '--profile', 'nope', '--dry-run']);
  const err = parseJson(r.stderr);
  it('exits 1', () => assert.equal(r.code, 1));
  it('stage:load', () => assert.equal(err.stage, 'load'));
  it('error mentions unknown profile', () => {
    assert.match(JSON.stringify(err.errors), /nope/);
  });
});

describe('G6: generate (no --profile, manifest has default) → exit 0', () => {
  const r = runCli(GEN_CLI, ['--policies', MANIFEST, '--dry-run']);
  const out = parseJson(r.stdout);
  it('exits 0', () => assert.equal(r.code, 0));
  it('ok:true (default profile auto-used)', () => assert.ok(out && out.ok === true));
});

describe('I5: inject --module sudo-safety --dry-run', () => {
  const rule = {
    id: 'docker-ask',
    intent: 'Confirm before docker commands',
    applies_to: ['primary'],
    enforcement: 'runtime',
    tool: 'bash',
    patterns: [{ pattern: 'docker *', action: 'ask' }],
    action: 'ask',
  };
  const r = runCli(INJECT_CLI, ['--type=permission', '--module', 'sudo-safety', '--policies', MANIFEST, '--dry-run', JSON.stringify(rule)]);
  const out = parseJson(r.stdout);
  it('exits 0', () => assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`));
  it('ok:true', () => assert.ok(out && out.ok === true));
  it('has yamlSnippet', () => assert.ok(out.yamlSnippet));
});

describe('I6: inject --module sudo-safety --apply (isolated)', () => {
  it('writes rule to fragment, validates, exit 0', () => {
    const isoManifest = join(scratch, 'manifest.yaml');
    const isoModules = join(scratch, 'modules');
    copyFileSync(MANIFEST, isoManifest);
    // 复制全部 3 个模块（default profile = work 需要 sudo-safety + web-safety）
    for (const id of ['sudo-safety', 'web-safety', 'pdf-handling']) {
      mkdirSync(join(isoModules, id), { recursive: true });
      copyFileSync(join(MODULES_DIR, id, 'module.yaml'), join(isoModules, id, 'module.yaml'));
    }

    const rule = {
      id: 'docker-ask',
      intent: 'Confirm before docker commands',
      applies_to: ['primary'],
      enforcement: 'runtime',
      tool: 'bash',
      patterns: [{ pattern: 'docker *', action: 'ask' }],
      action: 'ask',
    };
    const r = runCli(INJECT_CLI, ['--type=permission', '--module', 'sudo-safety', '--policies', isoManifest, '--apply', JSON.stringify(rule)], {
      // env 隔离：HOME 假 + DSH_HOME/XDG 清空（真实 DSH_HOME 会劫持候选序导致写真实 ~/.dsh）
      env: { HOME: join(scratch, 'fake-home'), DSH_HOME: '', XDG_CONFIG_HOME: '', OPENCODE_CONFIG: '' },
    });
    const out = parseJson(r.stdout);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(out && out.ok === true);
    const after = readFileSync(join(isoModules, 'sudo-safety', 'module.yaml'), 'utf8');
    assert.match(after, /docker-ask/);
  });
});

describe('I7: inject --module unknown-id → exit 1', () => {
  const rule = { id: 'x', intent: 'Test rule', applies_to: ['primary'], enforcement: 'runtime', tool: 'bash', patterns: [{ pattern: 'x *' }], action: 'ask' };
  const r = runCli(INJECT_CLI, ['--type=permission', '--module', 'no-such-mod', '--policies', MANIFEST, '--dry-run', JSON.stringify(rule)]);
  it('exits 1', () => assert.equal(r.code, 1));
  it('error mentions fragment not found', () => {
    const err = parseJson(r.stderr);
    assert.match(err.error, /not found/);
  });
});
