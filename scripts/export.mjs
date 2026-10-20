#!/usr/bin/env node
// =============================================================================
// scripts/export.mjs — Export CLI 入口
// =============================================================================
// 导出封存：当前 relic 副本（deploy 分支）→ 可移植包 + 分支封存
//
// 流程：
//   1. 确认当前分支是 deploy-* 分支
//   2. 收集文件（排除 node_modules/.git/generated/output/interaction/等）
//   3. 生成 HANDOFF.md（声明分支生命周期已结束）
//   4. 打 tar.gz 到工作区根目录
//   5. git tag deploy-<name>-archived
//   6. git push origin <tag>
//   7. 输出报告
//
// 用法：node scripts/export.mjs [--dest <dir>] [--dry-run]
// =============================================================================

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __argContent = (() => { const i = process.argv.indexOf('--content'); return i >= 0 ? process.argv[i + 1] : null; })();
const rootDir = __argContent ? resolve(__argContent) : resolve(__dirname, '..');  // --content 指向同步库（内容操作对象）

import {
  currentBranch, createTag, pushTag, shortHash, commitAll,
} from '../src/core/git-ops.mjs';
import { isDeployBranch } from '../src/core/deploy-lifecycle.mjs';
import { collectFiles, packTarGz } from '../src/core/export-pack.mjs';

// ─── CLI 参数解析 ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const destIdx = args.findIndex((a) => a.startsWith('--dest'));
const destDir = destIdx >= 0
  ? resolve(args[destIdx + 1] || '')
  : '/mnt/e/AIworkspace';

// ─── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  const report = {
    ok: false,
    branch: '',
    commit: '',
    shortHash: '',
    archive: '',
    tag: '',
    errors: [],
  };

  const gitOpts = { cwd: rootDir };

  // Step 1: 确认当前分支是 deploy-* 分支
  const branch = currentBranch(gitOpts);
  if (!isDeployBranch(branch)) {
    report.errors.push(
      `当前分支 "${branch}" 不是 deploy-* 分支。` +
      '请在 deploy 分支上运行 export。'
    );
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  report.branch = branch;

  // 获取 commit hash
  const { currentBranch: _cb, ...rest } = {};
  const fullHash = execSync('git rev-parse HEAD', {
    cwd: rootDir, encoding: 'utf8',
  }).trim();
  report.commit = fullHash;
  report.shortHash = shortHash(gitOpts);

  // Step 2: 收集文件
  const files = collectFiles(rootDir);

  // Step 3: 构造 handoff info
  const handoffInfo = {
    branch,
    commit: fullHash,
    shortHash: report.shortHash,
    exportedAt: new Date(),
  };

  // Step 4: 打 tar.gz
  const archiveName = `relic-export-${branch}-${report.shortHash}.tar.gz`;
  const archivePath = resolve(destDir, archiveName);
  report.archive = archivePath;

  if (dryRun) {
    report.files = files;
    report.handoff = handoffInfo;
    console.log(JSON.stringify({ ...report, ok: true, skipped: 'dryRun' }, null, 2));
    process.exit(0);
  }

  packTarGz(rootDir, files, archivePath, handoffInfo);

  // Step 5: git tag
  const tagName = `${branch}-archived`;
  report.tag = tagName;
  try {
    createTag(tagName, gitOpts);
  } catch (e) {
    // tag 可能已存在，不致命
    report.tag = `${tagName} (already exists)`;
  }

  // Step 6: git push tag
  try {
    pushTag(tagName, gitOpts);
  } catch (e) {
    report.errors.push(`pushTag: ${e.message}`);
  }

  // Step 7: 输出报告
  report.ok = report.errors.length === 0;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
