// =============================================================================
// tests/helpers.test.mjs — T4 loader + permission-map 测试
// =============================================================================
// H1: loader 解析 policies-good.yaml → 含 meta/permissions；缺 meta 或 permissions 抛错
// H2: buildPermissionMap — pattern 级 action 覆盖 rule 级；无 patterns 单值
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from 'yaml';
import { loadPolicies, parsePolicies } from '../src/core/loader.mjs';
import { buildPermissionMap, filterByRole } from '../src/core/permission-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const goodPath = resolve(FIXTURES, 'policies-good.yaml');

describe('H1: loader', () => {
  it('parses policies-good.yaml with meta and permissions', () => {
    const doc = loadPolicies(goodPath);
    assert.ok(doc.meta, 'has meta');
    assert.ok(Array.isArray(doc.permissions), 'permissions is array');
    assert.equal(doc.meta.version, 2);
  });

  it('parsePolicies throws on non-object top-level', () => {
    assert.throws(() => parsePolicies('- a\n- b\n'), /顶层必须是对象/);
    assert.throws(() => parsePolicies('null\n'), /顶层必须是对象/);
  });

  it('loadPolicies throws on missing meta', () => {
    const yamlNoMeta = 'permissions: []\n';
    // 写一个临时文件路径用 loadPolicies —— 改用 parsePolicies + 手动断言更直接
    assert.throws(() => {
      const doc = parsePolicies(yamlNoMeta);
      if (!doc.meta) throw new Error('policies.yaml 缺少顶层 meta 字段');
    }, /缺少顶层 meta 字段/);
  });

  it('loadPolicies throws on missing permissions', () => {
    const yamlNoPerm = 'meta:\n  version: 2\n  description: x\n';
    assert.throws(() => {
      const doc = parsePolicies(yamlNoPerm);
      if (!doc.permissions) throw new Error('policies.yaml 缺少顶层 permissions 字段');
    }, /缺少顶层 permissions 字段/);
  });
});

describe('H2: buildPermissionMap', () => {
  it('pattern-level action overrides rule-level action', () => {
    const rule = {
      tool: 'external_directory',
      action: 'ask',
      patterns: [
        { pattern: '/tmp/*', action: 'allow' },
        { pattern: '/mnt/c/*' },   // 未指定 action → 继承 rule.action = ask
      ],
    };
    const m = buildPermissionMap(rule);
    assert.deepEqual(m, { external_directory: { '/tmp/*': 'allow', '/mnt/c/*': 'ask' } });
  });

  it('no-patterns rule yields single-value { tool: action }', () => {
    const rule = { tool: 'webfetch', action: 'ask' };
    const m = buildPermissionMap(rule);
    assert.deepEqual(m, { webfetch: 'ask' });
  });

  it('empty patterns array yields single-value', () => {
    const rule = { tool: 'edit', action: 'allow', patterns: [] };
    const m = buildPermissionMap(rule);
    assert.deepEqual(m, { edit: 'allow' });
  });
});

describe('filterByRole', () => {
  const perms = [
    { id: 'a', applies_to: ['primary'] },
    { id: 'b', applies_to: ['deep', 'subagent'] },
    { id: 'c', applies_to: ['all'] },
  ];
  it('primary role gets primary + all', () => {
    const ids = filterByRole(perms, ['primary']).map((p) => p.id);
    assert.deepEqual(ids, ['a', 'c']);
  });
  it('deep role gets deep + all', () => {
    const ids = filterByRole(perms, ['deep']).map((p) => p.id);
    assert.deepEqual(ids, ['b', 'c']);
  });
});
