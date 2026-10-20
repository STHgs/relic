// =============================================================================
// src/core/export-pack.mjs — 导出打包逻辑
// =============================================================================
// 纯逻辑模块，收集文件 + 生成 HANDOFF.md + 打 tar.gz。
// 不依赖外部 tar 命令，用 Node 内置 zlib 自实现 tar 写入。
//
// 文件清单（include）：
//   policies.yaml, modules/, src/, schema.json, package.json,
//   package-lock.json, scripts/, tests/, .gitattributes, .gitignore
// 排除（exclude）：
//   node_modules/, .git/, generated/, *.bak.*, output/, interaction/,
//   *.tar.gz
// =============================================================================

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, relative, dirname } from 'path';
import { execSync } from 'child_process';

// ─── 文件收集 ──────────────────────────────────────────────────────────

/** @type {string[]} 顶层 include 的文件和目录 */
const INCLUDE_TOP = [
  'policies.yaml',
  'schema.json',
  'package.json',
  'package-lock.json',
  '.gitattributes',
  '.gitignore',
  'modules',
  'src',
  'scripts',
  'tests',
];

/** @type {string[]}  排除的路径模式（路径片段匹配） */
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'generated',
  'output',
  'interaction',
];

/** @type {string[]}  排除的文件后缀 */
const EXCLUDE_SUFFIXES = [
  '.bak',
  '.tar.gz',
];

/**
 * 判断路径是否应排除。
 * @param {string} relPath  相对于 root 的路径
 * @returns {boolean}
 */
function shouldExclude(relPath) {
  const parts = relPath.split('/');
  for (const p of EXCLUDE_PATTERNS) {
    if (parts.includes(p)) return true;
  }
  for (const suf of EXCLUDE_SUFFIXES) {
    if (relPath.endsWith(suf)) return true;
  }
  return false;
}

/**
 * 递归收集目录下所有文件（相对路径列表）。
 * @param {string} rootDir  根目录
 * @returns {string[]}  相对路径列表
 */
export function collectFiles(rootDir) {
  const result = [];

  function walk(dir, relBase) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (shouldExclude(rel)) continue;

      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        result.push(rel);
      }
    }
  }

  for (const top of INCLUDE_TOP) {
    const fullTop = join(rootDir, top);
    if (!existsSync(fullTop)) continue;

    const stat = statSync(fullTop);
    if (stat.isDirectory()) {
      walk(fullTop, top);
    } else if (stat.isFile()) {
      if (!shouldExclude(top)) result.push(top);
    }
  }

  return result.sort();
}

// ─── HANDOFF.md 生成 ────────────────────────────────────────────────────

/**
 * @typedef {Object} HandoffInfo
 * @property {string} branch    源分支名
 * @property {string} commit    最终 commit hash
 * @property {string} shortHash short hash
 * @property {Date} [exportedAt] 导出时间
 * @property {string} [profile]  profile 名
 */

/**
 * 生成 HANDOFF.md 内容。
 * @param {HandoffInfo} info
 * @returns {string}
 */
export function renderHandoff(info) {
  const ts = (info.exportedAt || new Date()).toISOString();
  const profile = info.profile || 'full (default)';

  return `# relic 导出包 — 交接声明

> 本包自 relic deploy 分支封存，生命周期已结束。

## 来源

- 分支：${info.branch}
- 最终 commit：${info.commit}
- Short hash：${info.shortHash}
- 封存时间：${ts}
- Profile：${profile}

## 生命周期声明

该分支生命周期已结束。此包为该部署的完整快照，不再接收更新。

## 导入指引

1. 解压：\`tar xzf relic-export-${info.branch}-${info.shortHash}.tar.gz\`
2. 进入目录：\`cd relic-export-${info.branch}-${info.shortHash}\`
3. 安装依赖：\`npm install\`
4. 部署到现网：\`npm run deploy\`
   - 会创建新的 deploy 分支（新生命周期开始）
   - 会询问 GitHub 仓库（如无则自动新建）
`;
}

/**
 * 将 HANDOFF.md 写入指定目录。
 * @param {HandoffInfo} info
 * @param {string} destDir  目标目录
 */
export function writeHandoff(info, destDir) {
  const content = renderHandoff(info);
  writeFileSync(join(destDir, 'HANDOFF.md'), content, 'utf8');
}

// ─── tar.gz 打包 ────────────────────────────────────────────────────────

/**
 * 打包文件列表为 tar.gz。
 * 用系统 tar 命令（Linux/WSL/macOS 都有，可靠性远高于自实现）。
 * 如有 handoffInfo，先写 HANDOFF.md 到临时目录，一并打包。
 *
 * @param {string} rootDir     源目录
 * @param {string[]} files     相对路径列表（不含 HANDOFF.md）
 * @param {string} destPath    目标 .tar.gz 路径
 * @param {HandoffInfo} [handoffInfo]  如有则追加 HANDOFF.md
 */
export function packTarGz(rootDir, files, destPath, handoffInfo) {
  // 如有 handoffInfo，先写 HANDOFF.md 到 rootDir 临时目录，加入文件列表
  let allFiles = [...files];
  let tmpDir = null;
  if (handoffInfo) {
    tmpDir = join(rootDir, '.relic-handoff-tmp');
    mkdirSync(tmpDir, { recursive: true });
    writeHandoff(handoffInfo, tmpDir);
    allFiles.push('.relic-handoff-tmp/HANDOFF.md');
  }

  try {
    execSync(
      `tar czf "${destPath}" -C "${rootDir}" ${allFiles.map((f) => `"${f}"`).join(' ')}`,
      { encoding: 'utf8' }
    );
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}
