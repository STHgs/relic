// =============================================================================
// tests/tier2-sentinel.test.mjs — P6: Tier-2 install-semantics sentinel
// =============================================================================
// Verifies that relic install preserves non-governance sentinel fields
// (model/fallback_models/provider/sharing) in real config files.
// This is the NON-NEGOTIABLE gate for migration.
//
// Uses a fakehome seeded with sentinels → relic install → assert survival.
// Depends on P1 (omo deep-merge) + P2 (opencode shallow-merge) being fixed.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTier2Sentinel } from '../scripts/tier2-sentinel.mjs';

describe('P6: Tier-2 install-semantics sentinel', () => {
  it('all sentinels survive relic install (omo + opencode)', async () => {
    const r = await runTier2Sentinel();
    assert.equal(
      r.pass,
      true,
      `Tier-2 sentinel check failed. Failures:\n  - ${r.failures.join('\n  - ')}`
    );
  });

  it('omo: model sentinel survives', async () => {
    const r = await runTier2Sentinel();
    const c = r.checks.find((x) => x.name === 'omo: model survives');
    assert.ok(c, 'check missing');
    assert.equal(c.pass, true, c.detail);
  });

  it('omo: fallback_models sentinel survives', async () => {
    const r = await runTier2Sentinel();
    const c = r.checks.find((x) => x.name === 'omo: fallback_models survives');
    assert.ok(c, 'check missing');
    assert.equal(c.pass, true, c.detail);
  });

  it('opencode: provider sentinel survives', async () => {
    const r = await runTier2Sentinel();
    const c = r.checks.find((x) => x.name === 'opencode: provider survives');
    assert.ok(c, 'check missing');
    assert.equal(c.pass, true, c.detail);
  });

  it('opencode: sharing sentinel survives', async () => {
    const r = await runTier2Sentinel();
    const c = r.checks.find((x) => x.name === 'opencode: sharing survives');
    assert.ok(c, 'check missing');
    assert.equal(c.pass, true, c.detail);
  });

  it('permission untouched + AGENTS.md governance delivered (route A)', async () => {
    const r = await runTier2Sentinel();
    const omoC = r.checks.find((x) => x.name === 'omo: permission untouched by install');
    const ocC = r.checks.find((x) => x.name === 'opencode: permission untouched by install')
      ?? r.checks.find((x) => x.name === 'opencode: AGENTS.md governance delivered');
    assert.ok(omoC && ocC, 'checks missing');
    assert.equal(omoC.pass, true, `omo: ${omoC.detail}`);
    assert.equal(ocC.pass, true, `opencode: ${ocC.detail}`);
  });
});
