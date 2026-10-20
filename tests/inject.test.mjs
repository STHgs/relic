// =============================================================================
// tests/inject.test.mjs — T9 inject 测试
// =============================================================================
// I1: dry-run yamlSnippet re-parses to patterns=[{pattern,...}] (objects, NOT strings)
//     —— bug#1 inject 层修复的定证
// I2: apply 时 ajv 校验失败 → 回滚，policies.yaml 字节级还原，rolledBack:true
// I3: exit-code 语义保留（0 成功 / 2 id-clash / 3 validation-rolledBack / 4 install-failed）
//     （relic 用 blocked 字段表达，不调 process.exit；调用方自行映射）
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse, stringify } from 'yaml';
import { injectRule, buildPermissionYaml } from '../src/core/inject.mjs';

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-inject-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const basePolicies = {
  meta: { version: 2, description: 'inject test base' },
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

const policiesPath = () => join(scratch, 'policies.yaml');
const writeBase = () => writeFileSync(policiesPath(), stringify(basePolicies));

describe('I1: dry-run emits patterns as objects (bug #1 fix)', () => {
  it('yamlSnippet re-parses to [{pattern}] objects, never ["strings"]', async () => {
    writeBase();
    const newRule = {
      id: 'docker-ask',
      intent: 'Confirm before running docker commands',
      applies_to: ['primary'],
      enforcement: 'runtime',
      tool: 'bash',
      patterns: [{ pattern: 'docker *', action: 'ask' }],
      action: 'ask',
    };
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: newRule,
      dryRun: true,
    });
    assert.equal(r.ok, true);

    // 把 yamlSnippet 包进 permissions 段再 parse，验证 patterns 是对象数组
    const wrapped = `permissions:\n${r.yamlSnippet}\n`;
    const parsed = parse(wrapped);
    const injected = parsed.permissions[0];
    assert.ok(Array.isArray(injected.patterns), 'patterns is array');
    assert.equal(typeof injected.patterns[0], 'object', 'patterns[0] is object');
    assert.equal(injected.patterns[0].pattern, 'docker *');
    assert.equal(injected.patterns[0].action, 'ask');
  });

  it('buildPermissionYaml emits - pattern: "..." not - "..."', () => {
    const rule = {
      id: 'x',
      intent: 'Test rule for yaml format',
      applies_to: ['primary'],
      enforcement: 'runtime',
      tool: 'bash',
      patterns: [{ pattern: 'rm *' }],
      action: 'deny',
    };
    const yaml = buildPermissionYaml(rule);
    assert.match(yaml, /-\s+pattern:\s+"rm \*"/);
    assert.doesNotMatch(yaml, /\s+-\s+"rm \*"\s*$/m); // no bare-string form
  });

  it('patterns emitted for non-bash tools too (predecessor only emitted for bash)', async () => {
    writeBase();
    const newRule = {
      id: 'ext-tmp-allow',
      intent: 'Allow access to tmp without ask',
      applies_to: ['all'],
      enforcement: 'runtime',
      tool: 'external_directory',
      patterns: [{ pattern: '/tmp/*', action: 'allow' }],
      action: 'ask',
    };
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: newRule,
      dryRun: true,
    });
    const wrapped = `permissions:\n${r.yamlSnippet}\n`;
    const parsed = parse(wrapped);
    const injected = parsed.permissions[0];
    assert.equal(injected.tool, 'external_directory');
    assert.ok(injected.patterns, 'patterns present for non-bash tool');
    assert.equal(injected.patterns[0].pattern, '/tmp/*');
  });
});

describe('I2: apply with ajv-failing rule rolls back', () => {
  it('restores policies.yaml byte-for-byte and reports rolledBack:true', async () => {
    writeBase();
    const before = readFileSync(policiesPath(), 'utf-8');

    // 故意造一条会触发 ajv 失败的规则：缺 intent（schema minLength 5）
    const badRule = {
      id: 'bad-rule',
      intent: 'x',  // minLength 5 → 失败
      applies_to: ['primary'],
      enforcement: 'runtime',
      tool: 'bash',
      patterns: [{ pattern: 'foo *' }],
      action: 'ask',
    };
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: badRule,
      dryRun: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, 'validation_failed');
    assert.equal(r.rolledBack, true);
    const after = readFileSync(policiesPath(), 'utf-8');
    assert.equal(after, before, 'policies.yaml restored byte-for-byte');
  });
});

describe('I3: blocked semantics (exit-code equivalent)', () => {
  it('id clash → blocked=id_conflict (exit 2 equivalent)', async () => {
    writeBase();
    const dup = { ...basePolicies.permissions[0] };  // same id 'sudo-ask'
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: dup,
      dryRun: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, 'id_conflict');
  });

  it('validation fail → blocked=validation_failed (exit 3 equivalent)', async () => {
    writeBase();
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: {
        id: 'bad',
        intent: 'x',
        applies_to: ['primary'],
        enforcement: 'runtime',
        tool: 'bash',
        patterns: [{ pattern: 'foo *' }],
        action: 'ask',
      },
      dryRun: false,
    });
    assert.equal(r.blocked, 'validation_failed');
  });

  it('install fail → blocked=install_failed (exit 4 equivalent)', async () => {
    writeBase();
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: {
        id: 'good-rule',
        intent: 'A valid intent string here',
        applies_to: ['primary'],
        enforcement: 'runtime',
        tool: 'bash',
        patterns: [{ pattern: 'foo *' }],
        action: 'ask',
      },
      dryRun: false,
      onInstall: async () => ({ ok: false, errors: ['simulated install failure'] }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, 'install_failed');
    assert.equal(r.rolledBack, true);
  });

  it('happy path: apply valid rule → ok:true, no rollback', async () => {
    writeBase();
    const r = await injectRule({
      policiesPath: policiesPath(),
      type: 'permission',
      rule: {
        id: 'docker-ask',
        intent: 'Confirm before running docker commands',
        applies_to: ['primary'],
        enforcement: 'runtime',
        tool: 'bash',
        patterns: [{ pattern: 'docker *', action: 'ask' }],
        action: 'ask',
      },
      dryRun: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.newCount, 2);
    assert.equal(r.rolledBack, undefined);
  });
});
