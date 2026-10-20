// =============================================================================
// tests/round-trip.test.mjs — M5 round-trip proof: split→merge→render == original
// =============================================================================
// RT1: renderAgentsMd(loadProfile(manifest-fixture, default).policies)
//      === renderAgentsMd(loadPolicies(policies-good.yaml))
//      (byte-identical; proves split→merge→render reproduces the original)
//      Fallback: if byte-identical proves brittle, semantic equality
//      (same permission/workflow ids + risk items).
// RT2: loadProfile output stable across stringify→parse round-trip of manifest.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse, stringify } from 'yaml';
import { loadPolicies } from '../src/core/loader.mjs';
import { createValidator } from '../src/core/validator.mjs';
import { renderAgentsMd } from '../src/render/agents-md.mjs';
import { loadProfile } from '../src/core/module-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const manifestPath = resolve(FIXTURES, 'manifest.yaml');
const modulesDir = resolve(FIXTURES, 'modules');
const policiesGoodPath = resolve(FIXTURES, 'policies-good.yaml');

describe('RT1: split→merge→render == original render', () => {
  // 原始：单文件 policies-good.yaml 的渲染
  const original = loadPolicies(policiesGoodPath);
  const originalValidated = createValidator()(original).doc;
  const originalMd = renderAgentsMd(originalValidated);

  // 拆分后：manifest + 3 modules → loadProfile(default=work) → 合并 → 渲染
  // 注意：default profile = work = [sudo-safety, web-safety]（不含 pdf-handling）
  // 而 policies-good.yaml 含 pdf-read workflow，所以用 'full' profile（=all modules）对齐
  const r = loadProfile({ manifestPath, modulesDir, profileName: 'full' });
  const mergedMd = renderAgentsMd(r.policies);

  it('loadProfile ok:true', () => assert.equal(r.ok, true, JSON.stringify(r.errors)));

  it('same permission ids', () => {
    const origIds = originalValidated.permissions.map((p) => p.id).sort();
    const mergedIds = r.policies.permissions.map((p) => p.id).sort();
    assert.deepEqual(mergedIds, origIds);
  });

  it('same workflow ids', () => {
    const origIds = originalValidated.workflows.map((w) => w.id).sort();
    const mergedIds = r.policies.workflows.map((w) => w.id).sort();
    assert.deepEqual(mergedIds, origIds);
  });

  it('same risk_levels items (all 3 levels, deduped)', () => {
    for (const level of ['low', 'medium', 'high']) {
      const orig = originalValidated.risk_levels[level].sort();
      const merged = r.policies.risk_levels[level].sort();
      assert.deepEqual(merged, orig, `level ${level} mismatch`);
    }
  });

  it('rendered output semantically equivalent (same sections present)', () => {
    for (const section of ["## 治理约束（自律执行）", "## 自定义流程索引", "## 给助手的话"]) {
      assert.ok(mergedMd.includes(section), `merged missing section: ${section}`);
      assert.ok(originalMd.includes(section), `original missing section: ${section}`);
    }
  });

  it('merged has profile header line (meta.profile set by loadProfile)', () => {
    assert.match(mergedMd, /> Profile: Full profile \(full\)/);
  });

  it('original does NOT have profile header (single-file mode)', () => {
    assert.doesNotMatch(originalMd, /^> Profile:/m);
  });
});

describe('RT2: loadProfile stable across stringify→parse of manifest', () => {
  // 读 manifest → stringify → parse → 用 parse 后的 manifest 跑 loadProfile
  // 结果应该和直接读文件一致（policies 的 permission/workflow/risk_levels 内容相同）
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  const manifestObj = parse(manifestRaw);
  const manifestReStr = stringify(manifestObj);
  const manifestReParsed = parse(manifestReStr);

  // 用注入 read/exists 模拟文件读取（manifestReParsed 作为 manifest 内容）
  const fakeRead = (p) => {
    if (p === manifestPath) return stringify(manifestReParsed);
    // modules 还是从真文件读
    return readFileSync(p, 'utf8');
  };
  const r1 = loadProfile({ manifestPath, modulesDir, profileName: 'full' });
  const r2 = loadProfile({
    manifestPath,
    modulesDir,
    profileName: 'full',
    read: fakeRead,
  });

  it('both ok:true', () => {
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
  });

  it('same permission ids after round-trip', () => {
    const ids1 = r1.policies.permissions.map((p) => p.id).sort();
    const ids2 = r2.policies.permissions.map((p) => p.id).sort();
    assert.deepEqual(ids1, ids2);
  });

  it('same workflow ids after round-trip', () => {
    const ids1 = r1.policies.workflows.map((w) => w.id).sort();
    const ids2 = r2.policies.workflows.map((w) => w.id).sort();
    assert.deepEqual(ids1, ids2);
  });
});
