#!/usr/bin/env node
// =============================================================================
// scripts/tier1-equivalence.mjs — Tier-1 generate-only equivalence harness
// =============================================================================
// P5: Verifies that relic's generate produces content-equivalent artifacts to
// the live agent-governance generated/ output, when given the same source rules.
//
// Method:
//   1. Load live policies.yaml (~/.config/opencode/agent-governance/policies.yaml)
//   2. Generate omo + opencode artifacts using relic adapters (bypass detect)
//   3. Read live generated/ artifacts
//   4. Deep-compare parsed JSON content (stripJsonc both sides)
//   5. Assert rule-count parity
//
// Q2 decision: only verify opencode + omo (Claude not a near-term target).
//
// Usage:
//   node scripts/tier1-equivalence.mjs
//   (uses live env paths by default)
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse } from 'yaml';
import assert from 'node:assert/strict';
import { createValidator } from '../src/core/validator.mjs';
import { parseJsonc } from '../src/adapters/base.mjs';
import omoAdapter from '../src/adapters/omo.mjs';
import opencodeAdapter from '../src/adapters/opencode.mjs';

const GOV_DIR = join(homedir(), '.config', 'opencode', 'agent-governance');
const LIVE_POLICIES = join(GOV_DIR, 'policies.yaml');
const LIVE_GENERATED = join(GOV_DIR, 'generated');

/**
 * Recursively deep-compare two JSON-compatible objects (key-order independent).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count total leaf permission entries across all agents.
 * @param {object} obj  parsed omo.permission.jsonc or opencode.agent.jsonc
 * @returns {number}
 */
function countPermEntries(obj) {
  let count = 0;
  for (const agent of Object.values(obj)) {
    const perm = agent.permission || {};
    for (const toolRules of Object.values(perm)) {
      if (typeof toolRules === 'string') {
        count += 1;
      } else {
        count += Object.keys(toolRules).length;
      }
    }
  }
  return count;
}

/**
 * Run the Tier-1 generate-only equivalence comparison.
 * @param {{ livePoliciesPath?: string, liveGeneratedDir?: string }} [opts]
 * @returns {{ pass: boolean, differences: string[], checks: {name:string, pass:boolean, detail?:string}[] }}
 */
export function runTier1Comparison(opts = {}) {
  const livePoliciesPath = opts.livePoliciesPath || LIVE_POLICIES;
  const liveGeneratedDir = opts.liveGeneratedDir || LIVE_GENERATED;

  const result = { pass: true, differences: [], checks: [] };

  // 1. Check live env exists
  if (!existsSync(livePoliciesPath)) {
    return {
      pass: false,
      differences: [`live policies.yaml not found: ${livePoliciesPath}`],
      checks: [{ name: 'env', pass: false, detail: 'live env absent' }],
    };
  }
  if (!existsSync(liveGeneratedDir)) {
    return {
      pass: false,
      differences: [`live generated/ not found: ${liveGeneratedDir}`],
      checks: [{ name: 'env', pass: false, detail: 'live generated/ absent' }],
    };
  }
  result.checks.push({ name: 'env', pass: true });

  // 2. Load + validate live policies.yaml
  const raw = parse(readFileSync(livePoliciesPath, 'utf8'));
  const validate = createValidator();
  const v = validate(raw);
  let policies;
  if (v.ok) {
    result.checks.push({ name: 'validation', pass: true, detail: 'live policies.yaml passes relic schema v2' });
    policies = v.doc;
  } else {
    // Schema mismatch — fall back to raw (adapters only need permissions array)
    result.checks.push({
      name: 'validation',
      pass: false,
      detail: `schema v2 rejected live policies (expected — format may differ); using raw: ${v.errors.slice(0, 3).join('; ')}`,
    });
    policies = raw;
  }

  // 3. Generate artifacts with relic adapters (bypass detect — fake all platforms)
  const fakeEnv = { home: '/tier1-fake', existsSync: () => true };
  const relicOmoFm = omoAdapter.generate(policies, fakeEnv);
  const relicOcFm = opencodeAdapter.generate(policies, fakeEnv);

  // 4. Read live generated/ artifacts
  const liveOmoRaw = readFileSync(join(liveGeneratedDir, 'omo.permission.jsonc'), 'utf8');
  const liveOcRaw = readFileSync(join(liveGeneratedDir, 'opencode.agent.jsonc'), 'utf8');

  const relicOmo = parseJsonc(relicOmoFm['omo.permission.jsonc']);
  const liveOmo = parseJsonc(liveOmoRaw);
  const relicOc = parseJsonc(relicOcFm['opencode.agent.jsonc']);
  const liveOc = parseJsonc(liveOcRaw);

  // 5. Compare omo.permission.jsonc
  const relicOmoAgents = Object.keys(relicOmo).sort();
  const liveOmoAgents = Object.keys(liveOmo).sort();
  if (jsonEqual(relicOmoAgents, liveOmoAgents)) {
    result.checks.push({ name: 'omo: agent count', pass: true, detail: `${relicOmoAgents.length} agents` });
  } else {
    result.pass = false;
    result.differences.push(`omo: agent list mismatch: relic=[${relicOmoAgents}] live=[${liveOmoAgents}]`);
    result.checks.push({ name: 'omo: agent count', pass: false });
  }
  // Deep compare permission per agent
  let omoPermMatch = true;
  for (const agent of liveOmoAgents) {
    if (!jsonEqual(relicOmo[agent]?.permission, liveOmo[agent]?.permission)) {
      omoPermMatch = false;
      result.differences.push(`omo: permission mismatch for agent "${agent}"`);
    }
  }
  result.checks.push({ name: 'omo: permission content', pass: omoPermMatch });

  // 6. Compare opencode.agent.jsonc
  const relicOcAgents = Object.keys(relicOc).sort();
  const liveOcAgents = Object.keys(liveOc).sort();
  if (jsonEqual(relicOcAgents, liveOcAgents)) {
    result.checks.push({ name: 'opencode: agent count', pass: true, detail: `${relicOcAgents.length} agents` });
  } else {
    result.pass = false;
    result.differences.push(`opencode: agent list mismatch: relic=[${relicOcAgents}] live=[${liveOcAgents}]`);
    result.checks.push({ name: 'opencode: agent count', pass: false });
  }
  // Deep compare permission per agent (mode may differ — that's OK, relic sets its own)
  let ocPermMatch = true;
  for (const agent of liveOcAgents) {
    if (!jsonEqual(relicOc[agent]?.permission, liveOc[agent]?.permission)) {
      ocPermMatch = false;
      result.differences.push(`opencode: permission mismatch for agent "${agent}"`);
    }
  }
  result.checks.push({ name: 'opencode: permission content', pass: ocPermMatch });

  // 7. Rule-count parity
  const relicOmoCount = countPermEntries(relicOmo);
  const liveOmoCount = countPermEntries(liveOmo);
  const relicOcCount = countPermEntries(relicOc);
  const liveOcCount = countPermEntries(liveOc);
  if (relicOmoCount === liveOmoCount && relicOcCount === liveOcCount) {
    result.checks.push({
      name: 'rule-count parity',
      pass: true,
      detail: `omo: ${relicOmoCount}==${liveOmoCount}, opencode: ${relicOcCount}==${liveOcCount}`,
    });
  } else {
    result.pass = false;
    result.differences.push(`rule-count mismatch: omo ${relicOmoCount}!=${liveOmoCount}, opencode ${relicOcCount}!=${liveOcCount}`);
    result.checks.push({ name: 'rule-count parity', pass: false });
  }

  return result;
}

// ─── CLI entry ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('═══════════════════════════════════════════════');
  console.log('  relic Tier-1 generate-only equivalence');
  console.log('═══════════════════════════════════════════════\n');

  const r = runTier1Comparison();

  for (const c of r.checks) {
    const mark = c.pass ? '✓' : '✗';
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (r.differences.length > 0) {
    console.log('\n  Differences:');
    for (const d of r.differences) {
      console.log(`    - ${d}`);
    }
  }
  console.log(`\n  Overall: ${r.pass ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(r.pass ? 0 : 1);
}
