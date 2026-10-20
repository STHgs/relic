// =============================================================================
// src/core/git-ops.mjs — Git 操作封装
// =============================================================================
// 封装 git CLI 操作，供 deploy/export 脚本使用。
// 所有操作通过注入 execSync 可测试（测试用真实 git init scratch repo）。
//
// 设计原则：
//   - 每个函数做一件事，返回明确结果
//   - execSync 封装为可注入的依赖，便于 mock
//   - 错误抛出带上下文，不静默吞掉
// =============================================================================

import { execSync } from 'child_process';

/**
 * @typedef {Object} GitOpsOpts
 * @property {string} [cwd]           工作目录，默认 process.cwd()
 * @property {(cmd: string, opts: object) => Buffer} [exec]  execSync 注入（测试 mock）
 */

/**
 * 执行 git 命令，返回 stdout（trim）。
 * @param {string} cmd
 * @param {GitOpsOpts} [opts]
 * @returns {string}
 */
function runGit(cmd, opts = {}) {
  const { cwd = process.cwd(), exec = execSync } = opts;
  try {
    return exec(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`git ${cmd} failed: ${stderr}`);
  }
}

/**
 * 检测当前仓库是否有 remote。
 * @param {GitOpsOpts} [opts]
 * @returns {boolean}
 */
export function hasRemote(opts = {}) {
  try {
    const out = runGit('git remote', opts);
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * 获取 remote URL（第一个 remote）。
 * @param {GitOpsOpts} [opts]
 * @returns {string}  remote URL，无则返回 ''
 */
export function getRemoteUrl(opts = {}) {
  try {
    const remotes = runGit('git remote', opts);
    if (!remotes) return '';
    const first = remotes.split('\n')[0].trim();
    return runGit(`git remote get-url ${first}`, opts);
  } catch {
    return '';
  }
}

/**
 * 添加 remote。
 * @param {string} name   remote 名（通常 'origin'）
 * @param {string} url     仓库 URL
 * @param {GitOpsOpts} [opts]
 */
export function addRemote(name, url, opts = {}) {
  runGit(`git remote add ${name} ${url}`, opts);
}

/**
 * 用 gh CLI 创建 GitHub 仓库并设为 origin。
 * @param {string} repoName   仓库名
 * @param {{ private?: boolean, cwd?: string, exec?: Function }} [opts]
 * @returns {string}  仓库 URL
 */
export function createRepo(repoName, opts = {}) {
  const { private: isPrivate = true, cwd = process.cwd(), exec = execSync } = opts;
  const visibility = isPrivate ? '--private' : '--public';
  const url = exec(
    `gh repo create ${repoName} ${visibility} --source=. --remote=origin --push 2>&1 || true`,
    { cwd, encoding: 'utf8' }
  ).trim();
  // gh repo create --source=. 会自动 add remote + push
  // 提取仓库 URL
  try {
    return getRemoteUrl({ cwd, exec });
  } catch {
    return `https://github.com/STHgs/${repoName}.git`;
  }
}

/**
 * 获取当前分支名。
 * @param {GitOpsOpts} [opts]
 * @returns {string}
 */
export function currentBranch(opts = {}) {
  return runGit('git rev-parse --abbrev-ref HEAD', opts);
}

/**
 * 创建并切换到新分支。
 * @param {string} name
 * @param {GitOpsOpts} [opts]
 */
export function createBranch(name, opts = {}) {
  runGit(`git checkout -b ${name}`, opts);
}

/**
 * 切换到已有分支。
 * @param {string} name
 * @param {GitOpsOpts} [opts]
 */
export function checkout(name, opts = {}) {
  runGit(`git checkout ${name}`, opts);
}

/**
 * 确保分支存在，不存在则从当前 HEAD 创建。
 * @param {string} name
 * @param {GitOpsOpts} [opts]
 */
export function ensureBranch(name, opts = {}) {
  try {
    runGit(`git rev-parse --verify ${name}`, opts);
  } catch {
    runGit(`git branch ${name}`, opts);
  }
}

/**
 * git add -A && git commit。
 * @param {string} message  commit message
 * @param {GitOpsOpts} [opts]
 * @returns {string}  commit hash
 */
export function commitAll(message, opts = {}) {
  runGit('git add -A', opts);
  runGit(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);
  return runGit('git rev-parse HEAD', opts);
}

/**
 * push 分支到 remote（-u 设上游）。
 * @param {string} branch
 * @param {GitOpsOpts} [opts]
 */
export function pushBranch(branch, opts = {}) {
  runGit(`git push -u origin ${branch}`, opts);
}

/**
 * 创建 tag。
 * @param {string} name  tag 名
 * @param {GitOpsOpts} [opts]
 */
export function createTag(name, opts = {}) {
  runGit(`git tag ${name}`, opts);
}

/**
 * push tag 到 remote。
 * @param {string} name
 * @param {GitOpsOpts} [opts]
 */
export function pushTag(name, opts = {}) {
  runGit(`git push origin ${name}`, opts);
}

/**
 * 列出所有本地+远程分支，过滤匹配 pattern 的。
 * @param {string} pattern  分支名前缀或 glob（如 'deploy-*'）
 * @param {GitOpsOpts} [opts]
 * @returns {string[]}  分支名列表
 */
export function listBranches(pattern, opts = {}) {
  const raw = runGit('git branch --list --all', opts);
  return raw
    .split('\n')
    .map((l) => l.replace(/^[* ]+/, '').replace(/^remotes\/[^/]+\//, '').trim())
    .filter(Boolean)
    .filter((b) => {
      if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return re.test(b);
      }
      return b === pattern;
    });
}

/**
 * 获取当前 HEAD 的 short hash。
 * @param {GitOpsOpts} [opts]
 * @returns {string}
 */
export function shortHash(opts = {}) {
  return runGit('git rev-parse --short HEAD', opts);
}
