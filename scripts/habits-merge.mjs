// =============================================================================
// scripts/habits-merge.mjs — 习惯提案合并 CLI
// =============================================================================
// 日常由 `npm run sync`（每 5 分钟）自动执行；本 CLI 用于急用/排查/配置扫描根。
//
//   npm run habits:merge                    # 合并所有扫描根下的提案
//   npm run habits:merge -- --dry-run       # 只预览，不写库不推进偏移
//   npm run habits:merge -- --json          # 机器可读
//   npm run habits:merge -- --pending       # 只看各工作区待合并行数
//   npm run habits:merge -- --roots ~/a,~/b # 临时覆盖扫描根（不落盘）
//   npm run habits:merge -- --list-roots    # 查看当前注册的扫描根
//   npm run habits:merge -- --add-root ~/x  # 注册一个扫描根
//   npm run habits:merge -- --vacuum        # 清空已合并前缀（无 agent 会话时执行）
// =============================================================================

import { mergeHabitProposals, countPendingProposals, vacuumProposals, readSources, writeSources } from '../src/core/habits-ingest.mjs';
import { readHabits, HABITS_FILE } from '../src/core/habits.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const rootsArg = valueOf('--roots');
const overrideRoots = rootsArg ? rootsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
const asJson = flag('--json');

const print = (obj) => {
  if (asJson) { console.log(JSON.stringify(obj, null, 2)); return; }
};

// ── --list-roots ────────────────────────────────────────────────────────
if (flag('--list-roots')) {
  const s = readSources();
  if (asJson) print({ roots: s.roots, origin: s.origin });
  else {
    console.log(`扫描根（来源：${s.origin}）`);
    for (const r of s.roots) console.log('  ' + r);
    if (s.roots.length === 0) console.log('  （空——用 npm run habits:merge -- --add-root <路径> 注册）');
  }
  process.exit(0);
}

// ── --add-root ──────────────────────────────────────────────────────────
const addRoot = valueOf('--add-root');
if (addRoot) {
  const cur = readSources();
  const roots = writeSources([...cur.roots, addRoot]);
  if (asJson) print({ roots });
  else {
    console.log('已注册扫描根：');
    for (const r of roots) console.log('  ' + r);
  }
  process.exit(0);
}

// ── --pending ───────────────────────────────────────────────────────────
if (flag('--pending')) {
  const r = countPendingProposals({ roots: overrideRoots || undefined });
  if (asJson) { print(r); process.exit(0); }
  console.log(`扫描根：${r.roots.length} 个，提案总数：${r.total} 行`);
  for (const f of r.files) console.log(`  ${f.pending.toString().padStart(3)} 行  ${f.path}`);
  if (r.total === 0) console.log('  （无待合并提案）');
  process.exit(0);
}

// ── --vacuum ────────────────────────────────────────────────────────────
if (flag('--vacuum')) {
  const r = vacuumProposals({ roots: overrideRoots || undefined });
  if (asJson) { print(r); process.exit(0); }
  if (r.vacuumed.length === 0) console.log('没有可清理的已合并前缀');
  for (const v of r.vacuumed) console.log(`已清理 ${v.removedBytes} 字节：${v.path}`);
  process.exit(0);
}

// ── 默认：合并 ──────────────────────────────────────────────────────────
const dryRun = flag('--dry-run');
const r = mergeHabitProposals({ dryRun, roots: overrideRoots || undefined });

if (asJson) {
  print(r);
  process.exit(0);
}

const store = readHabits();
console.log(`[relic] habits ${dryRun ? '(dry-run) ' : ''}合并完成`);
console.log(`  扫描根 ${r.roots.length} 个 / 提案文件 ${r.scanned} 个`);
console.log(`  新增 ${r.applied} 条，命中 +${r.hits}，拒绝 ${r.rejected.length} 条，淘汰 ${r.evicted} 条`);
console.log(`  库内 ${store.entries.length} 条：${HABITS_FILE()}`);
for (const f of r.files) {
  console.log(`  · ${f.path}：消费 ${f.records} 行（新增 ${f.applied} / 命中 ${f.hits}）${f.deferred ? '，有限流留待下次' : ''}`);
}
for (const x of r.rejected.slice(0, 10)) console.log(`  ⚠ 拒绝 ${x.path}:${x.line} — ${x.reason}`);
if (r.skipped.length > 0) {
  for (const s of r.skipped) console.log(`  - 跳过 ${s.path}（${s.reason}）`);
}
process.exit(0);
