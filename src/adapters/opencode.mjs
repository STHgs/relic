// =============================================================================
// src/adapters/opencode.mjs — OpenCode 原生平台适配器
// =============================================================================
// 治理哲学转变（用户拍板 2026-09-15）：完全去除运行时 permission 硬约束，
// 全平台统一 route A——只产 AGENTS.md，约束全量渲染、agent 自律执行。
// （历史：v4.1 曾只注入 PRIMARY_AGENT=general 的 runtime permission；
//   更早的 role-flattening 多 agent 注入已于 2026-09-15 清理退役。）
//
// FileMap keys: { 'AGENTS.md' }
// install: 写 ~/.config/opencode/AGENTS.md（写前处理 symlink）
// =============================================================================

import { existsSync, lstatSync, unlinkSync } from 'fs';
import { posix } from 'path';
const join = posix.join;  // 正斜杠标准（与 paths.mjs 对齐；Node fs 兼容 win）
import { renderAgentsMd } from '../render/agents-md.mjs';
import { backup, writeWithHeader, emptyReport, isContentUnchanged } from './base.mjs';
import { platformPaths, firstExisting } from '../core/paths.mjs';

/** @type {import('./base.mjs').PlatformAdapter} */
export default {
  id: 'opencode',

  detect(env) {
    // 四层解析链（声明>env>约定）+ win32 双路径；env 对象透传隔离真实环境
    const dirs = platformPaths(env.home, { env: env.env ?? process.env }).opencode;
    return firstExisting(dirs, (d) => env.existsSync(join(d, 'opencode.jsonc'))) !== null;
  },

  generate(policies, _env) {
    return { 'AGENTS.md': renderAgentsMd(policies) };
  },

  install(fileMap, opts) {
    const report = emptyReport();
    const home = opts.home;
    // install 同样按候选序：优先已存在目录；全新安装写第一个候选（env 注入对称）
    const dirs = platformPaths(home, { env: opts.env ?? process.env }).opencode;
    const target = firstExisting(dirs, (d) => existsSync(join(d, 'opencode.jsonc')))
      ?? firstExisting(dirs, existsSync)
      ?? dirs[0];
    const agentsMdPath = join(target, 'AGENTS.md');

    if (opts.dryRun) {
      report.skipped.push('opencode (dryRun)');
      return report;
    }
    if (!fileMap['AGENTS.md']) {
      report.skipped.push('opencode (no AGENTS.md in map)');
      return report;
    }
    try {
      // A1：内容比对短路——内容未变则跳过 backup+write（消除冗余 .bak）
      if (isContentUnchanged(agentsMdPath, fileMap['AGENTS.md'])) {
        report.skipped.push('opencode (unchanged)');
        return report;
      }
      const bak = backup(agentsMdPath, opts);
      if (bak) report.backups.push(bak);
      // 历史现场曾把 AGENTS.md 软链到 generated/ 缓存——写前先摘除 symlink
      if (existsSync(agentsMdPath) && lstatSync(agentsMdPath).isSymbolicLink()) {
        unlinkSync(agentsMdPath);
      }
      writeWithHeader(agentsMdPath, fileMap['AGENTS.md'], { header: '' });
      report.written.push(agentsMdPath);
    } catch (e) {
      report.ok = false;
      report.errors.push(`AGENTS.md: ${e.message}`);
    }
    return report;
  },
};
