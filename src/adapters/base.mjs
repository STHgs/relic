// =============================================================================
// src/adapters/base.mjs — Platform adapter 基础契约 + 共享辅助
// =============================================================================
// 每个具体适配器（opencode/omo/claude）实现这个契约。
// 设计原则（自 foundation-plan §2）：
//   - detect(env) 纯读，true iff 该平台在环境中存在
//   - generate(policies, env) 纯函数：policies → {filename: content}，无 I/O，确定
//   - install(fileMap, opts) 应用 FileMap（backup → write/merge/symlink），幂等
//
// 注：本阶段（W2/T7）只提供契约（typedef）和两个共享辅助：
//   - backup(path, {dryRun})  写前备份到 .bak.<ts>
//   - writeWithHeader(path, content, {header, dryRun})  带生成注释头写入
// install 具体逻辑（deep-merge / replace / symlink）由各适配器在 T8 实现。
// =============================================================================

import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ─── 类型契约（JSDoc typedef，供适配器实现者与 @ts-check 参考）──────────
/**
 * @typedef {Object} AdapterEnv
 * @property {string} home  当前 HOME 目录绝对路径
 * @property {(p: string) => boolean} existsSync  fs.existsSync 注入（便于测试 mock）
 */

/**
 * @typedef {Record<string, string>} FileMap
 * filename → file content（纯数据，无 I/O）
 */

/**
 * @typedef {Object} InstallReport
 * @property {boolean} ok
 * @property {string[]} written   实际写入的绝对路径
 * @property {string[]} backups   生成的备份路径（.bak.<ts>）
 * @property {string[]} skipped   未检测到的平台 / 文件未变更
 * @property {string[]} errors    人类可读的错误描述
 */

/**
 * @typedef {Object} InstallOpts
 * @property {string} home
 * @property {boolean} dryRun  true = 仅报告，不写
 */

/**
 * @typedef {Object} PlatformAdapter
 * @property {string} id
 * @property {(env: AdapterEnv) => boolean} detect
 *     纯 fs 读；true iff 该平台在 env 中存在
 * @property {(policies: object, env: AdapterEnv) => FileMap} generate
 *     纯函数：policies → {filename: content}。无 I/O，无 env 变更，确定
 * @property {(fileMap: FileMap, opts: InstallOpts) => InstallReport} install
 *     应用 FileMap（backup → write/merge/symlink）。幂等。dryRun=true → 仅报告
 */

// ─── 共享辅助：备份 + 带头写入 ────────────────────────────────────────

/**
 * 备份文件到 `<path>.bak.<ts>`。幂等：不存在则跳过。
 * @param {string} absPath  要备份的文件绝对路径
 * @param {{ dryRun?: boolean, now?: () => Date }} [opts]
 * @returns {string} 备份文件路径，或 ''（源不存在 / dryRun 跳过）
 */
export function backup(absPath, opts = {}) {
  const { dryRun = false, now = () => new Date() } = opts;
  if (!existsSync(absPath)) return '';
  const ts = now().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${absPath}.bak.${ts}`;
  if (!dryRun) copyFileSync(absPath, bakPath);
  return bakPath;
}

/**
 * 带生成注释头写入文件。若目录不存在则创建。
 * @param {string} absPath    目标绝对路径
 * @param {string} content    文件正文（不含头）
 * @param {{ header?: string, dryRun?: boolean }} [opts]
 *   - header: 生成注释头（默认用 relic 标准头）
 *   - dryRun: true = 仅报告，不写
 * @returns {string} 实际写入的绝对路径，或 '' （dryRun 跳过）
 */
export function writeWithHeader(absPath, content, opts = {}) {
  const {
    header = [
      '// =============================================================================',
      '// 部分自动生成 — agent 键由 relic 生成，provider/model/key/mcp 为用户维护。',
      '// 源: relic manifest+modules（经 schema.json v2 校验）',
      `// 生成时间: ${new Date().toISOString()}`,
      '// =============================================================================',
      '',
    ].join('\n'),
    dryRun = false,
  } = opts;

  if (dryRun) return '';
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, header + content, 'utf8');
  return absPath;
}

// ─── 通用：构造空 InstallReport ────────────────────────────────────────
/**
 * 构造一个空 InstallReport，供适配器 install 实现累积字段用。
 * @returns {InstallReport}
 */
export function emptyReport() {
  return { ok: true, written: [], backups: [], skipped: [], errors: [] };
}

// ─── JSONC 解析辅助 ─────────────────────────────────────────────────────
// 从现网 install.sh:50-78 / :123-139 的 stripJsonc 提取、去重、共享。
// install 阶段读 JSONC（带注释的 JSON）时，注释会丢失但结构保留——
// 这是现网已确立的语义（install.sh:41 注释明确说明），relic 原样保留。

/**
 * 去除 JSONC 文本的注释（// 行注释 + /* 块注释），返回纯 JSON 文本。
 * 字符串内的 // 和 /* 不受影响（状态机跟踪 in-string 状态）。
 * 忠实端口自现网 install.sh:50-78。
 * @param {string} text
 * @returns {string}  去注释后的纯 JSON 文本
 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += next || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 解析 JSONC 文本（去注释后 JSON.parse）。纯函数，无 I/O。
 * @param {string} text
 * @returns {object}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/**
 * 读 JSONC 文件并解析。I/O 封装：readFileSync + parseJsonc。
 * @param {string} absPath  绝对路径
 * @returns {object}
 */
export function readJsonc(absPath) {
  return parseJsonc(readFileSync(absPath, 'utf-8'));
}

// ─── 内容比对（A1：源头消除冗余备份）──────────────────────────────────
// install 前比对"当前文件内容 == 即将写入的内容"；相同则跳过 backup+write，
// 从源头消除"内容未变也产生 .bak"的冗余。文件不存在 → 返回 false（需写）。

/**
 * 判断目标文件内容是否与 newContent 完全相同。
 * @param {string} absPath      目标文件绝对路径
 * @param {string} newContent  即将写入的新内容
 * @returns {boolean}  true=内容相同可跳过写入；false=文件不存在或内容不同需写入
 */
export function isContentUnchanged(absPath, newContent) {
  if (!existsSync(absPath)) return false;
  const current = readFileSync(absPath, 'utf8');
  return current === newContent;
}
