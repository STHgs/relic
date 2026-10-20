// =============================================================================
// tests/orchestrator.test.mjs — T10 orchestrator + index.mjs 测试
// =============================================================================
// O1: 所有 3 平台 fake-present 时 dryRun 报告 written:[]/skipped:[]/errors:[]
// O2: 没平台在场时 skipped 列全部 3 适配器，written:[]
// O3: index.mjs pipeline load→validate→generate→install(dryRun) 返回连贯的 InstallReport
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { posix, join as fsJoin } from 'path';
const join = posix.join;  // 正斜杠标准（路径比较用）
import { stringify } from 'yaml';
import { generate } from '../src/orchestrator/generate.mjs';
import { pipeline } from '../src/index.mjs';

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(fsJoin(tmpdir(), 'relic-orch-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const goodPolicies = {
  meta: { version: 2, description: 'orchestrator test' },
  permissions: [
    {
      id: 'sudo-ask',
      intent: 'Require confirmation before privilege escalation',
      applies_to: ['primary'],
      enforcement: 'runtime',
      tool: 'bash',
      patterns: [{ pattern: 'sudo *', action: 'ask' }],
      action: 'ask',
    },
  ],
  workflows: [],
  risk_levels: { low: [], medium: [], high: [] },
  personas: [],
  modules: [],
};

const makeEnv = (present) => {
  const home = '/fake-home';
  const paths = new Set();
  if (present.opencode) paths.add(join(home, '.config', 'opencode', 'opencode.jsonc'));
  if (present.omo) paths.add(join(home, '.omo', 'omo.jsonc'));
  if (present.claude) paths.add(join(home, '.claude'));
  if (present.dsh) paths.add(join(home, '.dsh'));
  if (present.codex) paths.add(join(home, '.codex'));
  return { home, env: {}, existsSync: (p) => paths.has(p) };  // env:{} 隔离真实 DSH_HOME/XDG 泄漏（CI runner XDG 劫持候选序）
};

describe('O1: all 3 platforms fake-present, dryRun → no writes, no errors', () => {
  it('returns ok=true with written:[] and skipped listing all 4 as dryRun', async () => {
    const env = makeEnv({ opencode: true, omo: true, dsh: true, codex: true });  // claude 已退役
    // 注入 env 进 generate：需要传 existsSync 和 home
    const r = await generate(goodPolicies, {
      home: env.home,
      dryRun: true,
      existsSync: env.existsSync,
      env: env.env,  // 干净 env 透传（CI runner 环境隔离）
    });
    assert.equal(r.ok, true);
    assert.equal(r.report.errors.length, 0);
    assert.equal(r.report.written.length, 0);  // dryRun 不写
    // 4 个适配器都检测到了，各有一条 dryRun skipped
    const dryRunSkips = r.report.skipped.filter((s) => s.includes('dryRun'));
    assert.equal(dryRunSkips.length, 4);
    // fileMaps 四个都有
    assert.ok(r.fileMaps.opencode, 'opencode fileMap present');
    assert.ok(r.fileMaps.omo, 'omo fileMap present');
    assert.ok(r.fileMaps.dsh, 'dsh fileMap present');
    assert.ok(r.fileMaps.codex, 'codex fileMap present');
  });
});

describe('O2: no platform present → skipped lists all 3, written:[]', () => {
  it('all 4 adapters in skipped as not-detected, fileMaps empty', async () => {
    const env = makeEnv({ opencode: false, omo: false, claude: false, dsh: false, codex: false });
    const r = await generate(goodPolicies, {
      home: env.home,
      dryRun: false,  // 即使非 dryRun，没检测到也不写
      existsSync: env.existsSync,
      env: env.env,
    });
    assert.equal(r.ok, true);
    assert.equal(r.report.written.length, 0);
    const notDetected = r.report.skipped.filter((s) => s.includes('not detected'));
    assert.equal(notDetected.length, 4);  // claude retired; codex added
    assert.equal(Object.keys(r.fileMaps).length, 0);
  });
});

describe('O3: index.mjs pipeline load→validate→generate(dryRun)', () => {
  it('returns coherent report from pipeline', async () => {
    const policiesPath = join(scratch, 'policies.yaml');
    writeFileSync(policiesPath, stringify(goodPolicies));
    const r = await pipeline({
      policiesPath,
      dryRun: true,
      home: '/nonexistent-no-platforms',
    });
    assert.equal(r.ok, true);
    assert.equal(r.stage, 'generate');
    assert.ok(r.report, 'has report');
    assert.ok(r.policies, 'has policies');
    assert.equal(r.policies.meta.version, 2);
  });

  it('pipeline fails on load when file missing', async () => {
    const r = await pipeline({
      policiesPath: join(scratch, 'nope.yaml'),
      dryRun: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'load');
    assert.ok(r.errors.length > 0);
  });

  it('pipeline fails on validate with bad policies', async () => {
    const policiesPath = join(scratch, 'bad.yaml');
    writeFileSync(policiesPath, stringify({
      meta: { version: 2, description: 'bad' },
      permissions: [{
        id: 'x',
        intent: 'x',  // minLength 5
        applies_to: ['primary'],
        enforcement: 'hook',  // dropped
        tool: 'bash',
        action: 'ask',
      }],
    }));
    const r = await pipeline({
      policiesPath,
      dryRun: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validate');
    assert.ok(r.errors.length > 0);
  });
});
