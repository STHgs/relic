// =============================================================================
// src/core/deploy-lifecycle.mjs — Deploy 分支生命周期管理
// =============================================================================
// 纯函数模块，无 I/O（除了 cleanupStaleSkills）。
// deploy 分支命名规则：deploy-<YYYYMMDD>-<n>，n 从 1 递增。
// =============================================================================

import { existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * 格式化日期为 YYYYMMDD。
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 从分支名提取序号。
 * @param {string} branch  如 "deploy-20260828-1"
 * @returns {number}  序号，不匹配返回 0
 */
function extractSeq(branch) {
  const m = branch.match(/^deploy-\d{8}-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 根据已有分支和日期，计算下一个 deploy 分支名。
 * @param {string[]} existingBranches  已有分支列表
 * @param {Date} [date]  日期，默认当前
 * @returns {string}  如 "deploy-20260828-1"
 */
export function nextDeployBranch(existingBranches, date = new Date()) {
  const dateStr = formatDate(date);
  const prefix = `deploy-${dateStr}-`;
  const seqs = existingBranches
    .filter((b) => b.startsWith(prefix))
    .map(extractSeq)
    .filter((n) => n > 0);
  const maxSeq = seqs.length > 0 ? Math.max(...seqs) : 0;
  return `${prefix}${maxSeq + 1}`;
}

/**
 * 判断分支名是否是 deploy 分支。
 * @param {string} branch
 * @returns {boolean}
 */
export function isDeployBranch(branch) {
  return /^deploy-\d{8}-\d+$/.test(branch);
}

/**
 * 清理残留的 skill 文件。
 * 删除 ~/.config/opencode/skill/ 下的所有子目录和文件。
 * relic 不再使用 skill（Q1 决策：A3 workflow 渲染替代），
 * 但旧部署可能残留 skill 文件。
 * @param {string} home  HOME 目录
 * @returns {string[]}  已删除的路径列表
 */
export function cleanupStaleSkills(home) {
  const skillDir = join(home, '.config', 'opencode', 'skill');
  if (!existsSync(skillDir)) return [];

  const removed = [];
  const entries = readdirSync(skillDir);
  for (const entry of entries) {
    const path = join(skillDir, entry);
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // 删除失败不阻断 deploy，但记录
      removed.push(`${path} (FAILED)`);
    }
  }
  return removed;
}
