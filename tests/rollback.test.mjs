// =============================================================================
// tests/rollback.test.mjs — P3: rollback script (GAP4)
// =============================================================================
// Verifies that rollback can restore the newest .bak.<ts> backup for a given
// config path, picking the newest among multiple, and handling absent backups
// gracefully. The adapters (omo.mjs, opencode.mjs) already create backups via
// base.mjs:backup() — this script restores them.
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findNewestBackup, restoreFromBackup, rollbackPaths } from '../scripts/rollback.mjs';

let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-rollback-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('P3: rollback — findNewestBackup', () => {
  it('returns the newest .bak.* file (lexicographic ISO sort)', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(`${cfg}.bak.2026-08-27T09-00-00-000Z`, 'old');
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, 'newer');
    writeFileSync(`${cfg}.bak.2026-08-27T08-00-00-000Z`, 'oldest');

    assert.equal(findNewestBackup(cfg), `${cfg}.bak.2026-08-27T10-00-00-000Z`);
  });

  it('returns single backup when only one exists', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, 'only');
    assert.equal(findNewestBackup(cfg), `${cfg}.bak.2026-08-27T10-00-00-000Z`);
  });

  it('returns empty string when no backup exists', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    assert.equal(findNewestBackup(cfg), '');
  });

  it('ignores files that do not match the .bak. prefix', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(cfg, 'current');
    writeFileSync(`${cfg}.swp`, 'noise');
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, 'real-backup');
    assert.equal(findNewestBackup(cfg), `${cfg}.bak.2026-08-27T10-00-00-000Z`);
  });
});

describe('P3: rollback — restoreFromBackup', () => {
  it('restores newest backup over corrupted file', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, 'good-content');
    writeFileSync(cfg, 'garbage');

    const restored = restoreFromBackup(cfg);
    assert.equal(restored, `${cfg}.bak.2026-08-27T10-00-00-000Z`);
    assert.equal(readFileSync(cfg, 'utf8'), 'good-content');
  });

  it('picks newest among multiple backups', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(`${cfg}.bak.2026-08-27T08-00-00-000Z`, 'oldest');
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, 'newest');
    writeFileSync(cfg, 'garbage');

    restoreFromBackup(cfg);
    assert.equal(readFileSync(cfg, 'utf8'), 'newest');
  });

  it('returns empty string and leaves file untouched when no backup', () => {
    const cfg = join(scratch, 'cfg.jsonc');
    writeFileSync(cfg, 'untouched');

    const restored = restoreFromBackup(cfg);
    assert.equal(restored, '');
    assert.equal(readFileSync(cfg, 'utf8'), 'untouched');
  });
});

describe('P3: rollback — rollbackPaths (batch)', () => {
  it('restores multiple paths in one call', () => {
    const omo = join(scratch, 'omo.jsonc');
    const oc = join(scratch, 'opencode.jsonc');
    const agents = join(scratch, 'AGENTS.md');

    for (const [p, content] of [
      [omo, 'omo-good'],
      [oc, 'oc-good'],
      [agents, 'agents-good'],
    ]) {
      writeFileSync(p, content);
      writeFileSync(`${p}.bak.2026-08-27T10-00-00-000Z`, content);
    }
    // Corrupt all
    writeFileSync(omo, 'garbage');
    writeFileSync(oc, 'garbage');
    writeFileSync(agents, 'garbage');

    const report = rollbackPaths([omo, oc, agents]);
    assert.equal(report.restored.length, 3);
    assert.equal(readFileSync(omo, 'utf8'), 'omo-good');
    assert.equal(readFileSync(oc, 'utf8'), 'oc-good');
    assert.equal(readFileSync(agents, 'utf8'), 'agents-good');
  });

  it('reports skipped paths with no backup', () => {
    const cfg = join(scratch, 'no-backup.jsonc');
    writeFileSync(cfg, 'untouched');

    const report = rollbackPaths([cfg]);
    assert.equal(report.restored.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(readFileSync(cfg, 'utf8'), 'untouched');
  });

  it('handles mixed: some restored, some skipped', () => {
    const withBak = join(scratch, 'has-backup.jsonc');
    const noBak = join(scratch, 'no-backup.jsonc');
    writeFileSync(withBak, 'good');
    writeFileSync(`${withBak}.bak.2026-08-27T10-00-00-000Z`, 'good');
    writeFileSync(withBak, 'garbage');
    writeFileSync(noBak, 'untouched');

    const report = rollbackPaths([withBak, noBak]);
    assert.equal(report.restored.length, 1);
    assert.equal(report.skipped.length, 1);
    assert.equal(readFileSync(withBak, 'utf8'), 'good');
  });
});

describe('P3: rollback drill (full cycle)', () => {
  it('simulates install→corrupt→restore: sentinel survives', () => {
    const cfg = join(scratch, 'omo.jsonc');
    const goodContent = JSON.stringify(
      { '[opencode]': { agents: { sisyphus: { model: 'glm-5.2', permission: {} } } } },
      null, 2
    );
    writeFileSync(cfg, goodContent);

    // Install creates a backup (simulating base.mjs:backup())
    writeFileSync(`${cfg}.bak.2026-08-27T10-00-00-000Z`, goodContent);

    // Bad install corrupts (loses model)
    writeFileSync(cfg, JSON.stringify({ '[opencode]': { agents: { sisyphus: { permission: {} } } } }, null, 2));

    // Rollback restores
    restoreFromBackup(cfg);

    const restored = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.equal(restored['[opencode]'].agents.sisyphus.model, 'glm-5.2');
  });
});
