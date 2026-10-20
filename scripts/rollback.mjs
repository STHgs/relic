#!/usr/bin/env node
// =============================================================================
// scripts/rollback.mjs — restore newest .bak.<ts> backup for config paths
// =============================================================================
// GAP4 fix: provides a rollback mechanism for relic install.
//
// The adapters (omo.mjs, opencode.mjs) create backups via base.mjs:backup()
// as `<path>.bak.<ts>` (ts = ISO date with [:.]→-). This script finds the
// newest backup for each path and restores it.
//
// Usage:
//   node scripts/rollback.mjs [path1] [path2] ...
//   (no args = restore all 3 known paths for current HOME)
//
// Timestamps are ISO 8601 → lexicographically sortable, so sorting filenames
// alphabetically yields newest-last (we take the last element).
// =============================================================================

import { readdirSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';

/** Default paths restored when no args given (the 3 files relic install writes). */
export const DEFAULT_PATHS = [
  join(homedir(), '.omo', 'omo.jsonc'),
  join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
  join(homedir(), '.config', 'opencode', 'AGENTS.md'),
];

/**
 * Find the newest `.bak.<ts>` backup for a given absolute path.
 * @param {string} absPath  the original config file path
 * @returns {string}  the newest backup path, or '' if none found
 */
export function findNewestBackup(absPath) {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const prefix = `${base}.bak.`;

  if (!existsSync(dir)) return '';

  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort(); // ISO timestamps are lexicographically sortable

  if (candidates.length === 0) return '';
  return join(dir, candidates[candidates.length - 1]);
}

/**
 * Restore the newest backup for a path, overwriting the current file.
 * @param {string} absPath  the config file path to restore
 * @returns {string}  the backup path that was restored, or '' if no backup
 */
export function restoreFromBackup(absPath) {
  const bak = findNewestBackup(absPath);
  if (!bak) return '';
  mkdirSync(dirname(absPath), { recursive: true });
  copyFileSync(bak, absPath);
  return bak;
}

/**
 * Batch-restore backups for multiple paths.
 * @param {string[]} paths  absolute paths to restore
 * @returns {{ restored: {path:string, backup:string}[], skipped: string[], errors: string[] }}
 */
export function rollbackPaths(paths) {
  const report = { restored: [], skipped: [], errors: [] };
  for (const p of paths) {
    try {
      const bak = restoreFromBackup(p);
      if (bak) {
        report.restored.push({ path: p, backup: bak });
      } else {
        report.skipped.push(`${p} (no backup found)`);
      }
    } catch (e) {
      report.errors.push(`${p}: ${e.message}`);
    }
  }
  return report;
}

// ─── CLI entry (only when run directly, not imported) ──────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PATHS;

  console.log('═══════════════════════════════════════════════');
  console.log('  relic rollback');
  console.log('═══════════════════════════════════════════════');

  const report = rollbackPaths(paths);
  for (const r of report.restored) {
    console.log(`  ✓ ${r.path}`);
    console.log(`    ← ${r.backup}`);
  }
  for (const s of report.skipped) {
    console.log(`  ⚠ skipped: ${s}`);
  }
  for (const e of report.errors) {
    console.log(`  ✗ error: ${e}`);
  }
  console.log(
    `\n  Restored: ${report.restored.length}, ` +
      `Skipped: ${report.skipped.length}, ` +
      `Errors: ${report.errors.length}`
  );
}
