// =============================================================================
// tests/validator.test.mjs — T3 ajv 校验器测试
// =============================================================================
// 断言（foundation-plan §10 V1-V5）：
//   V1  policies-good 验证 ok:true，默认值已填（priority='normal'、alternatives=[]、
//       risk_levels 三档齐全、personas=[]、modules=[]）
//   V2  policies-bad-patterns-strings 拒收，错误涉及 patterns/对象（毛病 #1 schema 层）
//   V3  policies-bad-hook 拒收，错误涉及 enforcement 枚举（毛病 #2，F1 丢 hook）
//   V4  bash 规则缺 patterns 拒收（schema if/then，毛病 #3 的"手检遗漏"被契约接手）
//   V5  未知顶层字段拒收（additionalProperties:false，毛病 #3 漂移修复）
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from 'yaml';
import { createValidator } from '../src/core/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const fixture = (name) => parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const validate = createValidator();

describe('V1: policies-good validates and defaults applied', () => {
  const r = validate(fixture('policies-good.yaml'));
  it('returns ok:true', () => assert.equal(r.ok, true, JSON.stringify(r.errors)));
  it('meta.version === 2', () => assert.equal(r.doc.meta.version, 2));
  it('workflows[0].priority defaults to "normal" when omitted', () => {
    const w = r.doc.workflows.find((x) => x.id === 'pdf-read');
    assert.equal(w.priority, 'normal');
  });
  it('alternatives defaults to [] when omitted (on external-dir-ask)', () => {
    const p = r.doc.permissions.find((x) => x.id === 'external-dir-ask');
    assert.deepEqual(p.alternatives, []);
  });
  it('risk_levels fully populated', () => {
    assert.deepEqual(r.doc.risk_levels, {
      low: ['pip install known public libraries'],
      medium: ['webfetch any URL'],
      high: ['mount or umount disks'],
    });
  });
  it('personas and modules default to []', () => {
    assert.deepEqual(r.doc.personas, []);
    assert.deepEqual(r.doc.modules, []);
  });
});

describe('V2: patterns as bare strings rejected (bug #1 schema layer)', () => {
  const r = validate(fixture('policies-bad-patterns-strings.yaml'));
  it('rejects', () => assert.equal(r.ok, false));
  it('error mentions patterns / object', () => {
    const joined = r.errors.join('\n');
    assert.match(joined, /patterns/i);
  });
});

describe('V3: enforcement: hook rejected (bug #2, F1 = DROP)', () => {
  const r = validate(fixture('policies-bad-hook.yaml'));
  it('rejects', () => assert.equal(r.ok, false));
  it('error mentions enforcement enum', () => {
    const joined = r.errors.join('\n');
    assert.match(joined, /enforcement/i);
  });
});

describe('V4: bash permission with no patterns rejected (schema if/then)', () => {
  const noPatterns = {
    meta: { version: 2, description: 'bash rule missing patterns' },
    permissions: [{
      id: 'deny-all-bash',
      intent: 'Deny every bash invocation blanketly',
      applies_to: ['all'],
      enforcement: 'runtime',
      tool: 'bash',
      action: 'deny',
      // patterns intentionally omitted → schema if/then should require it
    }],
  };
  const r = validate(noPatterns);
  it('rejects', () => assert.equal(r.ok, false));
  it('error mentions patterns required', () => {
    const joined = r.errors.join('\n');
    assert.match(joined, /patterns/i);
  });
});

describe('V5: unknown top-level field rejected (additionalProperties:false)', () => {
  const withUnknown = {
    meta: { version: 2, description: 'has unknown field' },
    permissions: [],
    unknown_section: { foo: 'bar' },
  };
  const r = validate(withUnknown);
  it('rejects', () => assert.equal(r.ok, false));
  it('error mentions additional properties', () => {
    const joined = r.errors.join('\n');
    assert.match(joined, /additional|not allowed/i);
  });
});
