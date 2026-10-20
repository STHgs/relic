#!/usr/bin/env node
// =============================================================================
// scripts/cleanup-backups.mjs — .bak.* 历史残留去重 + rotation 工具（B1）
// =============================================================================
// 用法：
//   node scripts/cleanup-backups.mjs                       # 默认扫描 relic 写的路径，保留 10 个变更点
//   node scripts/cleanup-backups.mjs --keep 20             # 保留 20 个
//   node scripts/cleanup-backups.mjs --dry-run             # 只报告不删
//   node scripts/cleanup-backups.mjs --path <dir>         # 自定义扫描目录（递归找 .bak.*）
//
// 机制：
//   1. 扫描目标路径下所有 .bak.* 文件（按文件名时间戳排序——ISO 8601 字典序 = 时间序）
//   2. 逐个计算 sha256，识别"内容变更点"（与前一个保留的 .bak 内容不同 = 变更点）
//   3. 保留最近 N 个变更点（各 1 个 .bak），删其余冗余 .bak
//   4. 幂等：再跑一次无 .bak 可删
//
// 设计：
//   - "变更点"= 内容 hash 不同于前一个保留的 .bak；相邻相同内容只留最新的一个
//   - 按 N 保留 = 保留最近 N 个"不同内容"的 .bak，而非最近 N 个 .bak 文件
//   - dryRun 只报告，不删
// =============================================================================
import { readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';

// ─── 默认扫描路径（relic install 写的 4 个位置）─────────────────────────
function defaultTargets() {
  const home = homedir();
  return [
    join(home, '.config', 'opencode'),   // opencode AGENTS.md.bak.*
    join(home, '.dsh'),                   // dsh AGENTS.md.bak.*
    join(home, '.omo'),                   // omo（route A no-op，历史 .bak 兼容）
  ];
}

// ─── 参数解析 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const keepIdx = argv.indexOf('--keep');
const keep = keepIdx >= 0 ? parseInt(argv[keepIdx + 1], 10) || 10 : 10;
const pathIdx = argv.indexOf('--path');
const customPath = pathIdx >= 0 ? argv[pathIdx + 1] : null;
const targets = customPath ? [customPath] : defaultTargets();

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────

/**
 * 计算 sha256。
 * @param {string} absPath
 * @returns {string}
 */
function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * 扫描目录下所有 .bak.* 文件，按文件名时间戳排序（字典序 = 时间序）。
 * @param {string} dir
 * @returns {{path:string, name:string, dir:string}[]}  按"原始文件路径"分组
 */
function findBackupsInDir(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.includes('.bak.')) continue;
    result.push({ path: join(dir, entry.name), name: entry.name, dir });
  }
  return result;
}

/**
 * 按"原始文件"（去掉 .bak.<ts> 后缀）分组。
 * @param {{path:string,name:string,dir:string}[]} backups
 * @returns {Map<string, {path:string,name:string,dir:string}[]>}
 */
function groupByOriginal(backups) {
  const groups = new Map();
  for (const b of backups) {
    // name = "AGENTS.md.bak.2026-08-27T10-43-12-137Z"
    const orig = b.name.split('.bak.')[0];
    if (!groups.has(orig)) groups.set(orig, []);
    groups.get(orig).push(b);
  }
  // 每组按 name 排序（字典序 = 时间序，最新在后）
  for (const arr of groups.values()) arr.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return groups;
}

/**
 * 对一组 .bak（同一原始文件）去重 + 保留最近 N 个变更点。
 * @param {{path:string,name:string}[]} bakList  按时间排序（旧→新）
 * @param {number} keepN  保留变更点数
 * @returns {{keep:string[], delete:string[]}}
 */
function dedupeGroup(bakList, keepN) {
  if (bakList.length === 0) return { keep: [], delete: [] };

  // 从最新往回扫，识别变更点（hash 不同于"上一个保留的"= 变更点）
  const changePoints = [];  // 变更点 .bak（最新→最旧）
  let lastHash = null;
  for (let i = bakList.length - 1; i >= 0; i--) {
    const hash = sha256(bakList[i].path);
    if (hash !== lastHash) {
      changePoints.push({ bak: bakList[i], hash });
      lastHash = hash;
    }
    // 冗余 .bak（hash 和上一个保留的相同）= 删除候选
  }

  // 保留最近 keepN 个变更点
  const keepSet = new Set();
  const keep = [];
  for (let i = 0; i < Math.min(keepN, changePoints.length); i++) {
    keepSet.add(changePoints[i].bak.path);
    keep.push(changePoints[i].bak.path);
  }
  const del = bakList.filter((b) => !keepSet.has(b.path)).map((b) => b.path);
  return { keep, delete: del };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────
let totalKeep = 0;
let totalDelete = 0;
const summary = [];

for (const dir of targets) {
  const all = findBackupsInDir(dir);
  if (all.length === 0) { summary.push(`${dir}: no .bak files`); continue; }

  const groups = groupByOriginal(all);
  for (const [orig, bakList] of groups) {
    const { keep: keepPaths, delete: delPaths } = dedupeGroup(bakList, keep);
    totalKeep += keepPaths.length;
    totalDelete += delPaths.length;

    const label = `${dir}/${orig}`;
    if (delPaths.length === 0) {
      summary.push(`${label}: ${bakList.length} .bak, keep ${keepPaths.length}, nothing to delete`);
    } else {
      summary.push(`${label}: ${bakList.length} .bak → keep ${keepPaths.length}, delete ${delPaths.length}`);
      if (dryRun) {
        for (const d of delPaths) summary.push(`  [dry-run] would delete: ${basename(d)}`);
      } else {
        for (const d of delPaths) {
          try { unlinkSync(d); } catch { /* best effort */ }
        }
      }
    }
  }
}

console.log('═══════════════════════════════════════════════');
console.log(`  relic backup cleanup${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`  keep=${keep} unique change points per original file`);
console.log('═══════════════════════════════════════════════');
for (const line of summary) console.log('  ' + line);
console.log('');
console.log(`  Total: keep ${totalKeep}, delete ${totalDelete}${dryRun ? ' (would delete)' : ' (deleted)'}`);
