#!/usr/bin/env node
// =============================================================================
// scripts/tier2-sentinel.mjs — Tier-2 install-semantics sentinel harness
// =============================================================================
// P6 (depends P1+P2): Verifies that relic install preserves non-governance
// sentinel fields in real config files. This is the NON-NEGOTIABLE gate
// for migration — if any sentinel is missing after install, migration is blocked.
//
// Method (fakehome):
//   1. Create fakehome with ~/.omo/omo.jsonc (sentinels: model, fallback_models)
//      and ~/.config/opencode/opencode.jsonc (sentinels: provider, model, sharing)
//   2. Generate artifacts from relic policies (test fixtures)
//   3. Run relic install (adapters use GAP1 deep-merge + GAP2 shallow-merge)
//   4. Assert all 4 sentinels survive + permission values match expected
//
// Usage:
//   node scripts/tier2-sentinel.mjs
// =============================================================================

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import assert from 'node:assert/strict';
import { readFileSync as readRaw } from 'fs';
import { createValidator } from '../src/core/validator.mjs';
import { generate } from '../src/orchestrator/generate.mjs';
import { parseJsonc } from '../src/adapters/base.mjs';

// Use relic's own test fixture policies (single-file, schema-valid)
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_POLICIES = resolve(__dirname, '..', 'tests', 'fixtures', 'policies-good.yaml');

// ─── Sentinel definitions ─────────────────────────────────────────────
const OMO_SENTINELS = {
  model: 'glm-5.2',
  fallback_models: ['gpt-4o', 'claude-3.5-sonnet'],
};
const OC_SENTINELS = {
  provider: { name: 'openai', api_key: 'sk-test-xxx' },
  model: 'gpt-4o',
  sharing: { enabled: true, endpoint: 'http://localhost:3000' },
};

/**
 * Seed a fakehome with realistic config files containing sentinels.
 * @param {string} home
 */
function seedFakehome(home) {
  // ~/.omo/omo.jsonc with sentinels + comments (JSONC)
  const omoDir = join(home, '.omo');
  mkdirSync(omoDir, { recursive: true });
  writeFileSync(
    join(omoDir, 'omo.jsonc'),
    [
      '// my omo config — do not lose model/fallback',
      '{',
      '  "[opencode]": {',
      '    "agents": {',
      `      "sisyphus": { "model": "${OMO_SENTINELS.model}", "fallback_models": ${JSON.stringify(OMO_SENTINELS.fallback_models)} },`,
      '      "hephaestus": { "model": "heph-model" }',
      '    }',
      '  }',
      '}',
    ].join('\n')
  );

  // ~/.config/opencode/opencode.jsonc with sentinels + comments
  const ocDir = join(home, '.config', 'opencode');
  mkdirSync(ocDir, { recursive: true });
  writeFileSync(
    join(ocDir, 'opencode.jsonc'),
    [
      '// my opencode config',
      '{',
      `  "provider": ${JSON.stringify(OC_SENTINELS.provider)},`,
      `  "model": "${OC_SENTINELS.model}",`,
      `  "sharing": ${JSON.stringify(OC_SENTINELS.sharing)},`,
      '  "agent": {',
      '    "myCustomAgent": { "mode": "primary", "custom": true }',
      '  }',
      '}',
    ].join('\n')
  );
}

/**
 * Run the Tier-2 sentinel survival check.
 * @param {{ policiesPath?: string }} [opts]
 * @returns {{ pass: boolean, checks: {name:string, pass:boolean, detail?:string}[], failures: string[] }}
 */
export async function runTier2Sentinel(opts = {}) {
  const policiesPath = opts.policiesPath || FIXTURE_POLICIES;
  const result = { pass: true, checks: [], failures: [] };

  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'relic-tier2-'));
    seedFakehome(scratch);

    // 捕获种子 permission（route A 断言基准：install 后必须原样）
    const seedOmo = parseJsonc(readFileSync(join(scratch, '.omo', 'omo.jsonc'), 'utf8'));
    const seedOmoSisyphusPerm = seedOmo?.['[opencode]']?.agents?.sisyphus?.permission ?? null;
    const seedOc = parseJsonc(readFileSync(join(scratch, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
    const seedOcGeneralPerm = seedOc?.agent?.general?.permission ?? null;

    // Load + validate policies
    const raw = parse(readRaw(policiesPath, 'utf8'));
    const validate = createValidator();
    const v = validate(raw);
    if (!v.ok) {
      return {
        pass: false,
        checks: [{ name: 'policies validation', pass: false, detail: v.errors.slice(0, 3).join('; ') }],
        failures: ['policies.yaml failed schema validation'],
      };
    }
    result.checks.push({ name: 'policies validation', pass: true });

    // Generate + install (real install, not dryRun)
    const g = await generate(v.doc, { home: scratch, dryRun: false, env: {} })  // env:{} 隔离（CI runner XDG/DSH_HOME 泄漏）;
    if (!g.ok) {
      result.pass = false;
      result.failures.push(`generate/install failed: ${g.report.errors.join('; ')}`);
      result.checks.push({ name: 'install', pass: false, detail: g.report.errors.join('; ') });
      return result;
    }
    result.checks.push({
      name: 'install succeeded',
      pass: true,
      detail: `${g.report.written.length} files written`,
    });

    // ─── Read post-install configs ───────────────────────────────────
    const omoPath = join(scratch, '.omo', 'omo.jsonc');
    const ocPath = join(scratch, '.config', 'opencode', 'opencode.jsonc');

    const omo = parseJsonc(readFileSync(omoPath, 'utf8'));
    const oc = parseJsonc(readFileSync(ocPath, 'utf8'));

    // ─── omo sentinels ────────────────────────────────────────────────
    const sisyphus = omo?.['[opencode]']?.agents?.sisyphus || {};

    // model survives
    const modelOk = sisyphus.model === OMO_SENTINELS.model;
    result.checks.push({
      name: 'omo: model survives',
      pass: modelOk,
      detail: `model="${sisyphus.model}"`,
    });
    if (!modelOk) { result.pass = false; result.failures.push(`omo model lost: expected "${OMO_SENTINELS.model}", got "${sisyphus.model}"`); }

    // fallback_models survives
    const fbOk = JSON.stringify(sisyphus.fallback_models) === JSON.stringify(OMO_SENTINELS.fallback_models);
    result.checks.push({
      name: 'omo: fallback_models survives',
      pass: fbOk,
      detail: `fallback_models=${JSON.stringify(sisyphus.fallback_models)}`,
    });
    if (!fbOk) { result.pass = false; result.failures.push('omo fallback_models lost'); }

    // hephaestus agent survives (not destroyed by merge)
    const hephOk = omo?.['[opencode]']?.agents?.hephaestus?.model === 'heph-model';
    result.checks.push({
      name: 'omo: hephaestus agent survives',
      pass: hephOk,
      detail: `hephaestus.model="${omo?.['[opencode]']?.agents?.hephaestus?.model}"`,
    });
    if (!hephOk) { result.pass = false; result.failures.push('omo hephaestus agent lost'); }

    // ─── opencode sentinels ───────────────────────────────────────────
    // provider survives
    const providerOk = JSON.stringify(oc.provider) === JSON.stringify(OC_SENTINELS.provider);
    result.checks.push({
      name: 'opencode: provider survives',
      pass: providerOk,
      detail: `provider=${JSON.stringify(oc.provider)}`,
    });
    if (!providerOk) { result.pass = false; result.failures.push('opencode provider lost'); }

    // model survives
    const ocModelOk = oc.model === OC_SENTINELS.model;
    result.checks.push({
      name: 'opencode: model survives',
      pass: ocModelOk,
      detail: `model="${oc.model}"`,
    });
    if (!ocModelOk) { result.pass = false; result.failures.push(`opencode model lost: expected "${OC_SENTINELS.model}", got "${oc.model}"`); }

    // sharing survives
    const sharingOk = JSON.stringify(oc.sharing) === JSON.stringify(OC_SENTINELS.sharing);
    result.checks.push({
      name: 'opencode: sharing survives',
      pass: sharingOk,
      detail: `sharing=${JSON.stringify(oc.sharing)}`,
    });
    if (!sharingOk) { result.pass = false; result.failures.push('opencode sharing lost'); }

    // custom agent survives (shallow merge preserves other agents)
    const customAgentOk = oc?.agent?.myCustomAgent?.custom === true;
    result.checks.push({
      name: 'opencode: custom agent survives',
      pass: customAgentOk,
      detail: `myCustomAgent.custom=${oc?.agent?.myCustomAgent?.custom}`,
    });
    if (!customAgentOk) { result.pass = false; result.failures.push('opencode custom agent lost'); }

    // ─── configs untouched (route A: no runtime injection) ───────────
    // 2026-09-15 去硬约束：install 不得改写 opencode.jsonc / omo.jsonc 的 permission。
    // 种子里预置的 permission 字段必须原样保留（或若种子无则保持无）。
    const omoPermUntouched = JSON.stringify(sisyphus?.permission ?? null) === JSON.stringify(seedOmoSisyphusPerm);
    result.checks.push({
      name: 'omo: permission untouched by install',
      pass: omoPermUntouched,
      detail: `sisyphus.permission = ${JSON.stringify(sisyphus?.permission ?? null)}`,
    });
    if (!omoPermUntouched) { result.pass = false; result.failures.push('omo permission mutated by install'); }

    const ocPermUntouched = JSON.stringify(oc?.agent?.general?.permission ?? null) === JSON.stringify(seedOcGeneralPerm);
    result.checks.push({
      name: 'opencode: permission untouched by install',
      pass: ocPermUntouched,
      detail: `general.permission = ${JSON.stringify(oc?.agent?.general?.permission ?? null)}`,
    });
    if (!ocPermUntouched) { result.pass = false; result.failures.push('opencode permission mutated by install'); }

    // AGENTS.md 哨兵：治理文本必须写入且含自律约束表与哨兵指令
    const ocAgentsMd = existsSync(join(scratch, '.config', 'opencode', 'AGENTS.md'))
      ? readFileSync(join(scratch, '.config', 'opencode', 'AGENTS.md'), 'utf8') : '';
    const agentsMdOk = ocAgentsMd.includes('## 治理约束（自律执行）') && ocAgentsMd.includes('RELIC IS RUNNING');
    result.checks.push({
      name: 'opencode: AGENTS.md governance delivered',
      pass: agentsMdOk,
      detail: `AGENTS.md ${ocAgentsMd.length} bytes`,
    });
    if (!agentsMdOk) { result.pass = false; result.failures.push('opencode AGENTS.md governance missing'); }

    return result;
  } catch (e) {
    result.pass = false;
    result.failures.push(`harness error: ${e.message}\n${e.stack}`);
    return result;
  } finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ─── CLI entry ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    console.log('═══════════════════════════════════════════════');
    console.log('  relic Tier-2 install-semantics sentinel');
    console.log('═══════════════════════════════════════════════\n');

    const r = await runTier2Sentinel();

    for (const c of r.checks) {
      const mark = c.pass ? '✓' : '✗';
      console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    if (r.failures.length > 0) {
      console.log('\n  Failures:');
      for (const f of r.failures) {
        console.log(`    - ${f}`);
      }
    }
    console.log(`\n  Overall: ${r.pass ? 'PASS ✅ — all sentinels survived' : 'FAIL ❌ — sentinel lost, migration BLOCKED'}`);
    process.exit(r.pass ? 0 : 1);
  })();
}
