#!/usr/bin/env node
// =============================================================================
// scripts/deploy.mjs — Deploy CLI 入口
// =============================================================================
// 热插拔部署：当前 relic 副本 → 现网 + git 分支生命周期
//
// 流程：
//   1. 检测 git remote → 无则引导建仓库
//   2. 确保 base 分支（main）
//   3. 创建 deploy 分支：deploy-<YYYYMMDD>-<n>
//   4. npm run generate（真写现网 + 备份）
//   5. 清理旧产物（残留 skill 文件等）
//   6. git add -A && git commit
//   7. git push -u origin <deploy 分支>
//   8. 输出报告 + 提示重启 session
//
// 用法：node scripts/deploy.mjs [--profile <id>] [--repo <name>] [--dry-run]
// =============================================================================

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __argContent = (() => { const i = process.argv.indexOf('--content'); return i >= 0 ? process.argv[i + 1] : null; })();
const rootDir = __argContent ? resolve(__argContent) : resolve(__dirname, '..');  // --content 指向同步库（内容操作对象）

import {
  hasRemote, getRemoteUrl, addRemote, createRepo,
  currentBranch, createBranch, ensureBranch, checkout,
  commitAll, pushBranch, listBranches, shortHash,
} from '../src/core/git-ops.mjs';
import { nextDeployBranch, cleanupStaleSkills } from '../src/core/deploy-lifecycle.mjs';
import { generate } from '../src/orchestrator/generate.mjs';
import { loadProfile } from '../src/core/module-loader.mjs';
import { loadPolicies } from '../src/core/loader.mjs';
import { createValidator } from '../src/core/validator.mjs';

// ─── CLI 参数解析 ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const profileIdx = args.findIndex((a) => a.startsWith('--profile'));
const profileName = profileIdx >= 0 ? (args[profileIdx + 1] || '') : undefined;
const repoIdx = args.findIndex((a) => a.startsWith('--repo'));
const repoName = repoIdx >= 0 ? (args[repoIdx + 1] || 'relic') : 'relic';

// ─── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  const report = {
    ok: false,
    branch: '',
    remote: '',
    generate: null,
    commit: '',
    cleanup: [],
    errors: [],
  };

  const gitOpts = { cwd: rootDir };

  // Step 1: 检测 git remote
  if (!hasRemote(gitOpts)) {
    if (dryRun) {
      report.skipped = 'no remote (dryRun)';
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }
    console.error('未检测到 git remote。');
    console.error('选项：');
    console.error('  1. 用 --repo <name> 新建 GitHub 私有仓库（默认名：relic）');
    console.error('  2. 手动 git remote add origin <url> 后重跑');
    if (args.includes('--repo') || true) {
      console.error(`→ 正在用 gh 创建仓库 "${repoName}"...`);
      try {
        const url = createRepo(repoName, { cwd: rootDir, private: true });
        report.remote = url;
        console.error(`  ✓ 仓库已创建：${url}`);
      } catch (e) {
        report.errors.push(`createRepo: ${e.message}`);
        console.error(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }
  } else {
    report.remote = getRemoteUrl(gitOpts);
  }

  // Step 2: 确保 base 分支（main）
  const cur = currentBranch(gitOpts);
  if (cur !== 'main') {
    if (dryRun) {
      report.skipped = `current branch: ${cur} (dryRun)`;
    } else {
      // 如果 main 不存在，从当前分支创建
      ensureBranch('main', gitOpts);
      checkout('main', gitOpts);
    }
  }

  // Step 3: 创建 deploy 分支
  const existing = listBranches('deploy-*', gitOpts);
  const branchName = nextDeployBranch(existing);
  report.branch = branchName;

  if (dryRun) {
    console.log(JSON.stringify({ ...report, skipped: 'dryRun' }, null, 2));
    process.exit(0);
  }

  createBranch(branchName, gitOpts);

  // Step 4: generate（真写现网）
  const policiesPath = resolve(rootDir, 'policies.yaml');
  if (!existsSync(policiesPath)) {
    report.errors.push(`policies.yaml not found: ${policiesPath}`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  let policies;
  const manifestRaw = parse(readFileSync(policiesPath, 'utf8'));
  const hasProfiles = Array.isArray(manifestRaw.profiles) && manifestRaw.profiles.length > 0;

  if (hasProfiles || profileName) {
    const r = loadProfile({ manifestPath: policiesPath, profileName });
    if (!r.ok) {
      report.errors.push(`loadProfile: ${r.errors.join('; ')}`);
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    policies = r.policies;
  } else {
    policies = loadPolicies(policiesPath);
    const validate = createValidator();
    const v = validate(policies);
    if (!v.ok) {
      report.errors.push(`validate: ${v.errors.join('; ')}`);
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    policies = v.doc;
  }

  const genResult = await generate(policies, { dryRun: false });
  report.generate = {
    ok: genResult.ok,
    written: genResult.report.written,
    backups: genResult.report.backups,
    skipped: genResult.report.skipped,
    errors: genResult.report.errors,
  };

  if (!genResult.ok) {
    report.errors.push('generate failed');
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Step 5: 清理旧产物
  report.cleanup = cleanupStaleSkills(process.env.HOME);

  // Step 6: git commit
  report.commit = commitAll(`deploy: ${branchName}`, gitOpts);

  // Step 7: git push
  try {
    pushBranch(branchName, gitOpts);
  } catch (e) {
    report.errors.push(`push: ${e.message}`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Step 8: 输出报告
  report.ok = true;
  report.note = '重启 OpenCode session 以刷新 skill 注册表';
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
