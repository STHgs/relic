// =============================================================================
// tests/schema-modules.test.mjs — M1 schema v2 additive changes for direction 3
// =============================================================================
// S1: manifest.yaml validates ok:true; defaults applied (profiles, modules registry)
// S2: each module fragment validates as moduleFragment (standalone via inline schema)
// S3: profile with modules:all validates; profile with modules:[ids] validates
// S4: profile missing id (or name/modules) → rejected by ajv
// S5: moduleFragment with a malformed permission (bare-string pattern) → rejected
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from 'yaml';
import Ajv from 'ajv';
import { createValidator } from '../src/core/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const fixture = (name) => parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const validate = createValidator();

// Inline moduleFragment validator (M1 uses this; M2 will provide createModuleValidator)
// Build a self-contained schema with definitions so $ref resolves.
const schemaDoc = JSON.parse(readFileSync(resolve(__dirname, '..', 'schema.json'), 'utf8'));
const ajvInline = new Ajv({ allErrors: true, useDefaults: true, strict: false, strictSchema: false });
const moduleFragmentSchema = {
  ...schemaDoc.definitions.moduleFragment,
  definitions: schemaDoc.definitions,  // bring definitions so $ref to permission/workflow resolves
};
const validateModule = ajvInline.compile(moduleFragmentSchema);

describe('S1: manifest.yaml validates + defaults applied', () => {
  const doc = fixture('manifest.yaml');
  const r = validate(doc);
  it('validates ok:true', () => assert.equal(r.ok, true, JSON.stringify(r.errors)));
  it('modules registry has 3 entries', () => assert.equal(r.doc.modules.length, 3));
  it('profiles has 3 entries (work/personal/full)', () => assert.equal(r.doc.profiles.length, 3));
  it('work profile is default:true', () => {
    const work = r.doc.profiles.find((p) => p.id === 'work');
    assert.equal(work.default, true);
  });
  it('modules enabled defaults to true', () => {
    for (const m of r.doc.modules) {
      assert.equal(m.enabled, true, `module ${m.id} should default enabled:true`);
    }
  });
});

describe('S2: module fragments validate as moduleFragment', () => {
  for (const id of ['sudo-safety', 'web-safety', 'pdf-handling']) {
    it(`modules/${id}/module.yaml validates`, () => {
      const frag = parse(readFileSync(resolve(FIXTURES, 'modules', id, 'module.yaml'), 'utf8'));
      const ok = validateModule(frag);
      assert.equal(ok, true, `module ${id} should validate: ${ajvInline.errorsText(validateModule.errors)}`);
    });
  }
  it('fragment id required (missing id rejected)', () => {
    const bad = { permissions: [] };
    assert.equal(validateModule(bad), false);
  });
});

describe('S3: profile modules field accepts array or "all"', () => {
  it('profile with modules:[ids] validates', () => {
    const doc = fixture('manifest.yaml');
    const r = validate(doc);
    assert.equal(r.ok, true);
    const work = r.doc.profiles.find((p) => p.id === 'work');
    assert.ok(Array.isArray(work.modules));
  });
  it('profile with modules:"all" validates', () => {
    const doc = fixture('manifest.yaml');
    const r = validate(doc);
    const full = r.doc.profiles.find((p) => p.id === 'full');
    assert.equal(full.modules, 'all');
  });
});

describe('S4: profile missing required fields → rejected', () => {
  it('profile missing id → rejected', () => {
    const doc = {
      meta: { version: 2, description: 'x' },
      permissions: [],
      profiles: [{ name: 'NoId', modules: 'all' }],
    };
    const r = validate(doc);
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.errors), /id/);
  });
  it('profile missing modules → rejected', () => {
    const doc = {
      meta: { version: 2, description: 'x' },
      permissions: [],
      profiles: [{ id: 'x', name: 'NoModules' }],
    };
    const r = validate(doc);
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.errors), /modules/);
  });
});

describe('S5: moduleFragment with malformed permission → rejected', () => {
  it('fragment with bare-string patterns → rejected (reuses permission definition)', () => {
    const badFrag = {
      id: 'bad-frag',
      permissions: [{
        id: 'x',
        intent: 'Bad bare string pattern test case',
        applies_to: ['primary'],
        enforcement: 'runtime',
        tool: 'bash',
        patterns: ['sudo *'],  // bare string, should be {pattern:...} object
        action: 'ask',
      }],
    };
    const ok = validateModule(badFrag);
    assert.equal(ok, false, 'should reject bare-string patterns');
  });
});
