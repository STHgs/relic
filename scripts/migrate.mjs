#!/usr/bin/env node
// =============================================================================
// scripts/migrate.mjs — 旧布局 → ~/.relic 迁移 CLI（v1.0.0）
// =============================================================================
// 用法：
//   npm run migrate                      # 预览（dry-run，不写盘）
//   npm run migrate -- --apply           # 执行迁移（失败自动回滚）
//   npm run migrate -- --apply --force   # 内容库有未提交改动也迁移（不推荐）
//   npm run migrate -- --status          # 只看旧布局/备份/待清理状态
//   npm run migrate -- --cleanup-backup  # 删除 <root>/state/migrate-backup-* 备份
//
// 正常入口（sync/status/bootstrap/upgrade/uninstall/wizard）会自动迁移；
// 本 CLI 用于手动预览、强制重试与备份清理。
// =============================================================================
import { planMigration, migrateLayout, manageBackups, sweepPendingEngineRemoval } from '../src/core/migrate-layout.mjs';
import { relicLayout, relicRoot } from '../src/core/relic-root.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const L = relicLayout(relicRoot());

function printPlan(plan) {
  console.log(`[migrate] 根目录：${plan.root}`);
  console.log(`[migrate] 备份目录：${plan.backup}`);
  if (!plan.needed) {
    console.log('[migrate] 已是目标布局，无需迁移');
    return;
  }
  console.log('[migrate] 待迁移：');
  for (const u of plan.units) {
    console.log(`  - ${u.id}: ${u.from} → ${u.to}${u.isSelf ? '（当前引擎：复制后延迟清理）' : ''}`);
  }
}

try {
  if (has('--cleanup-backup')) {
    const r = manageBackups({ cleanup: true });
    for (const d of r.removed || []) console.log(`[migrate] 已删除备份 ${d}`);
    for (const e of r.errors || []) console.error(`[migrate] 删除失败 ${e}`);
    process.exit(r.ok ? 0 : 1);
  }

  const plan = planMigration();
  if (has('--status')) {
    printPlan(plan);
    const backups = manageBackups({});
    console.log(`[migrate] 备份目录（${backups.dirs.length}）：`);
    for (const d of backups.dirs) console.log(`  - ${d}`);
    const swept = sweepPendingEngineRemoval();
    if (swept) console.log(`[migrate] 待清理旧引擎：${JSON.stringify(swept)}`);
    process.exit(0);
  }

  printPlan(plan);
  if (!plan.needed) process.exit(0);
  if (!has('--apply')) {
    console.log('\n[migrate] 预览模式：确认无误后运行 npm run migrate -- --apply');
    process.exit(0);
  }

  const r = migrateLayout({ apply: true, force: has('--force') });
  if (!r.ok) {
    console.error(`[migrate] 失败：${r.reason || '未知错误'}`);
    if (r.rollbackErrors?.length) console.error('[migrate] 回滚问题：' + r.rollbackErrors.join('; '));
    process.exit(1);
  }
  for (const s of r.steps || []) console.log(`[migrate] ✓ ${s.id}: ${s.detail}`);
  console.log(`[migrate] 完成。备份保留在 ${r.backup}`);
  console.log('[migrate] 确认新布局正常后可清理备份：npm run migrate -- --cleanup-backup');
  process.exit(0);
} catch (e) {
  console.error(`[migrate] 异常：${e.message}`);
  process.exit(1);
}
