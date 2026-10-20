// =============================================================================
// tests/module-loader.test.mjs — M2 loader/merger/cross-conflict tests
// =============================================================================
// L1:  loadProfile(manifest, default) → merged doc with ALL default-profile modules' rules
// L2:  loadProfile(manifest, 'personal') → strict subset (fewer permissions)
// L3:  loadProfile(manifest, 'unknown') → ok:false, error names unknown profile
// L4:  manifest with no default:true + no profileName → ok:false
// L5:  mergeFragments is pure (same inputs → same output)
// L6:  risk_levels merged per-level + deduped
// L7:  fragment id ≠ directory name → ok:false (triple-check)
// L8:  profile references unknown module id → ok:false
// L9:  two modules same permission id → ok:false, idClashes non-empty
// L10: two modules overlapping bash patterns different ids → ok:true, permissionConflicts non-empty
// L11: enabled:false module referenced by profile → skipped, not in merged
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { loadProfile, mergeFragments } from '../src/core/module-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const manifestPath = resolve(FIXTURES, 'manifest.yaml');
const modulesDir = resolve(FIXTURES, 'modules');

const load = (profileName) => loadProfile({ manifestPath, modulesDir, profileName });

describe('L1: loadProfile(default) returns all default-profile modules', () => {
  const r = load();  // default = work = [sudo-safety, web-safety]
  it('ok:true', () => assert.equal(r.ok, true, JSON.stringify(r.errors)));
  it('has sudo-ask + external-dir-ask permissions (from both modules)', () => {
    const ids = r.policies.permissions.map((p) => p.id);
    assert.ok(ids.includes('sudo-ask'));
    assert.ok(ids.includes('external-dir-ask'));
  });
  it('meta.profile set to work', () => {
    assert.equal(r.policies.meta.profile.id, 'work');
  });
});

describe('L2: loadProfile(personal) is a strict subset', () => {
  const r = load('personal');  // [pdf-handling] only
  it('ok:true', () => assert.equal(r.ok, true));
  it('has FEWER permissions than default (0 vs 2)', () => {
    const def = load();
    assert.equal(r.policies.permissions.length, 0);
    assert.ok(def.policies.permissions.length > r.policies.permissions.length);
  });
  it('has pdf-read workflow (from pdf-handling module)', () => {
    const ids = r.policies.workflows.map((w) => w.id);
    assert.ok(ids.includes('pdf-read'));
  });
  it('does NOT have sudo-ask (not in personal profile)', () => {
    const ids = r.policies.permissions.map((p) => p.id);
    assert.ok(!ids.includes('sudo-ask'));
  });
});

describe('L3: unknown profile → ok:false', () => {
  const r = load('nope');
  it('ok:false', () => assert.equal(r.ok, false));
  it('error names the unknown profile', () => {
    assert.match(r.errors.join(' '), /nope/);
  });
});

describe('L4: no default + no profileName → ok:false', () => {
  const manifest = {
    meta: { version: 2, description: 'no default' },
    permissions: [],
    modules: [{ id: 'x', name: 'X' }],
    profiles: [{ id: 'a', name: 'A', modules: ['x'] }],
  };
  it('ok:false with clear error', () => {
    // 用一个内联 manifest（无 default:true）
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l4-'));
    const mPath = join(scratch, 'manifest.yaml');
    writeFileSync(mPath, yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules', 'x'), { recursive: true });
    writeFileSync(join(scratch, 'modules', 'x', 'module.yaml'), 'id: x\npermissions: []\n');
    const r = loadProfile({ manifestPath: mPath, modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /default:true|--profile/i);
  });
});

describe('L5: mergeFragments is pure', () => {
  const manifest = {
    meta: { version: 2, description: 'pure' },
    permissions: [],
    workflows: [],
    risk_levels: { low: [], medium: [], high: [] },
    personas: [],
    modules: [],
    profiles: [],
  };
  const fragments = [
    { id: 'a', doc: { id: 'a', permissions: [{ id: 'r1', intent: 'Test rule one', applies_to: ['primary'], enforcement: 'runtime', tool: 'bash', patterns: [{ pattern: 'a *' }], action: 'ask' }], workflows: [], risk_levels: { low: [], medium: [], high: [] } } },
  ];
  const profile = { id: 'work', name: 'Work', modules: ['a'] };
  const a = mergeFragments(manifest, fragments, profile);
  const b = mergeFragments(manifest, fragments, profile);
  it('same inputs → same output', () => {
    assert.deepEqual(a, b);
  });
});

describe('L6: risk_levels merged per-level + deduped', () => {
  const manifest = {
    meta: { version: 2, description: 'risk' },
    permissions: [],
    workflows: [],
    risk_levels: { low: ['base-low'], medium: [], high: ['base-high'] },
    personas: [],
    modules: [],
    profiles: [],
  };
  const fragments = [
    { id: 'a', doc: { id: 'a', permissions: [], workflows: [], risk_levels: { low: ['frag-low', 'base-low'], medium: ['frag-med'], high: [] } } },
  ];
  const profile = { id: 'work', name: 'Work', modules: ['a'] };
  const merged = mergeFragments(manifest, fragments, profile);
  it('low has base-low + frag-low (deduped)', () => {
    assert.deepEqual(merged.risk_levels.low, ['base-low', 'frag-low']);
  });
  it('medium has frag-med', () => {
    assert.deepEqual(merged.risk_levels.medium, ['frag-med']);
  });
  it('high has base-high only', () => {
    assert.deepEqual(merged.risk_levels.high, ['base-high']);
  });
});

describe('L7: fragment id ≠ directory name → ok:false', () => {
  it('triple-check fails', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l7-'));
    const manifest = {
      meta: { version: 2, description: 'triple' },
      permissions: [],
      modules: [{ id: 'correct-id', name: 'Correct' }],
      profiles: [{ id: 'work', name: 'Work', modules: ['correct-id'], default: true }],
    };
    writeFileSync(join(scratch, 'manifest.yaml'), yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules', 'correct-id'), { recursive: true });
    writeFileSync(join(scratch, 'modules', 'correct-id', 'module.yaml'), 'id: wrong-id\npermissions: []\n');
    const r = loadProfile({ manifestPath: join(scratch, 'manifest.yaml'), modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /wrong-id|correct-id/);
  });
});

describe('L8: profile references unknown module → ok:false', () => {
  it('ok:false naming the unknown module', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l8-'));
    const manifest = {
      meta: { version: 2, description: 'unknown-mod' },
      permissions: [],
      modules: [{ id: 'real-mod', name: 'Real' }],
      profiles: [{ id: 'work', name: 'Work', modules: ['fake-mod'], default: true }],
    };
    writeFileSync(join(scratch, 'manifest.yaml'), yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules'), { recursive: true });
    const r = loadProfile({ manifestPath: join(scratch, 'manifest.yaml'), modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /fake-mod/);
  });
});

describe('L9: two modules same permission id → ok:false (idClashes)', () => {
  it('ok:false, conflicts.idClashes non-empty', () => {
    const badDir = resolve(FIXTURES, 'modules-bad-dupe-id');
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l9-'));
    const manifest = {
      meta: { version: 2, description: 'dupe' },
      permissions: [],
      modules: [{ id: 'bad-dupe-a', name: 'A' }, { id: 'bad-dupe-b', name: 'B' }],
      profiles: [{ id: 'work', name: 'Work', modules: ['bad-dupe-a', 'bad-dupe-b'], default: true }],
    };
    writeFileSync(join(scratch, 'manifest.yaml'), yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules', 'bad-dupe-a'), { recursive: true });
    mkdirSync(join(scratch, 'modules', 'bad-dupe-b'), { recursive: true });
    copyFileSync(join(badDir, 'module-a.yaml'), join(scratch, 'modules', 'bad-dupe-a', 'module.yaml'));
    copyFileSync(join(badDir, 'module-b.yaml'), join(scratch, 'modules', 'bad-dupe-b', 'module.yaml'));
    const r = loadProfile({ manifestPath: join(scratch, 'manifest.yaml'), modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, false);
    assert.ok(r.conflicts && r.conflicts.idClashes.length > 0, 'idClashes non-empty');
    assert.equal(r.conflicts.idClashes[0].id, 'dupe-rule');
  });
});

describe('L10: overlapping bash patterns different ids → ok:true (non-blocking)', () => {
  it('ok:true, permissionConflicts non-empty', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l10-'));
    const manifest = {
      meta: { version: 2, description: 'overlap' },
      permissions: [],
      modules: [{ id: 'mod-a', name: 'A' }, { id: 'mod-b', name: 'B' }],
      profiles: [{ id: 'work', name: 'Work', modules: ['mod-a', 'mod-b'], default: true }],
    };
    writeFileSync(join(scratch, 'manifest.yaml'), yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules', 'mod-a'), { recursive: true });
    mkdirSync(join(scratch, 'modules', 'mod-b'), { recursive: true });
    writeFileSync(join(scratch, 'modules', 'mod-a', 'module.yaml'),
      'id: mod-a\npermissions:\n  - id: rule-a\n    intent: Rule A overlapping with B\n    applies_to: [primary]\n    enforcement: runtime\n    tool: bash\n    patterns:\n      - pattern: "rm * /mnt/c/*"\n        action: ask\n    action: ask\n');
    writeFileSync(join(scratch, 'modules', 'mod-b', 'module.yaml'),
      'id: mod-b\npermissions:\n  - id: rule-b\n    intent: Rule B overlapping with A\n    applies_to: [primary]\n    enforcement: runtime\n    tool: bash\n    patterns:\n      - pattern: "rm * /mnt/c/Users/*"\n        action: ask\n    action: ask\n');
    const r = loadProfile({ manifestPath: join(scratch, 'manifest.yaml'), modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, true);
    assert.ok(r.conflicts.permissionConflicts.length > 0, 'permissionConflicts non-empty (non-blocking)');
  });
});

describe('L11: enabled:false module → skipped', () => {
  it('module not in merged output', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'relic-l11-'));
    const manifest = {
      meta: { version: 2, description: 'disabled' },
      permissions: [],
      modules: [
        { id: 'active-mod', name: 'Active' },
        { id: 'disabled-mod', name: 'Disabled', enabled: false },
      ],
      profiles: [{ id: 'work', name: 'Work', modules: ['active-mod', 'disabled-mod'], default: true }],
    };
    writeFileSync(join(scratch, 'manifest.yaml'), yamlStringify(manifest));
    mkdirSync(join(scratch, 'modules', 'active-mod'), { recursive: true });
    mkdirSync(join(scratch, 'modules', 'disabled-mod'), { recursive: true });
    writeFileSync(join(scratch, 'modules', 'active-mod', 'module.yaml'),
      'id: active-mod\npermissions:\n  - id: active-rule\n    intent: Active rule that should be present\n    applies_to: [primary]\n    enforcement: runtime\n    tool: bash\n    patterns:\n      - pattern: "active *"\n        action: ask\n    action: ask\n');
    writeFileSync(join(scratch, 'modules', 'disabled-mod', 'module.yaml'),
      'id: disabled-mod\npermissions:\n  - id: disabled-rule\n    intent: Disabled rule that should be absent\n    applies_to: [primary]\n    enforcement: runtime\n    tool: bash\n    patterns:\n      - pattern: "disabled *"\n        action: ask\n    action: ask\n');
    const r = loadProfile({ manifestPath: join(scratch, 'manifest.yaml'), modulesDir: join(scratch, 'modules') });
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(r.ok, true);
    const ids = r.policies.permissions.map((p) => p.id);
    assert.ok(ids.includes('active-rule'), 'active rule present');
    assert.ok(!ids.includes('disabled-rule'), 'disabled rule absent');
  });
});
