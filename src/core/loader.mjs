// =============================================================================
// src/core/loader.mjs — policies.yaml 读取 + 解析
// =============================================================================
// 职责单一：读 YAML 文件 → 解析 → 抛错（若缺 meta 或 permissions）。
// 不做 schema 校验（那是 validator.mjs 的事），不做合并（那是将来模块化的事）。
//
// 导出:
//   loadPolicies(path) → policiesObject  （缺关键字段时抛错）
//   parsePolicies(yamlString) → policiesObject
// =============================================================================

import { readFileSync } from 'fs';
import { parse } from 'yaml';

/**
 * 解析 policies YAML 字符串。不校验 schema，但要求顶层是对象。
 * @param {string} yamlString
 * @returns {object}
 * @throws {Error} 若 YAML 解析失败或顶层不是对象
 */
export function parsePolicies(yamlString) {
  const doc = parse(yamlString);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('policies.yaml 顶层必须是对象，实际: ' + (doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc));
  }
  return doc;
}

/**
 * 从磁盘读取 policies.yaml 并解析。
 * @param {string} absPath  policies.yaml 绝对路径
 * @returns {object}
 * @throws {Error} 若文件缺失、解析失败、或缺 meta/permissions 顶层字段
 */
export function loadPolicies(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const doc = parsePolicies(raw);
  if (!doc.meta) {
    throw new Error(`policies.yaml 缺少顶层 meta 字段: ${absPath}`);
  }
  if (!doc.permissions) {
    throw new Error(`policies.yaml 缺少顶层 permissions 字段: ${absPath}`);
  }
  return doc;
}
