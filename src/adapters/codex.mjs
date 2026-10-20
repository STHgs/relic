// =============================================================================
// src/adapters/codex.mjs — OpenAI Codex（CLI / IDE / Desktop 全线）适配器
// =============================================================================
// 形态（2026-09-23 调研实证）：
//   - Codex 全产品线统一读 AGENTS.md：全局 = Codex home（默认 ~/.codex）的
//     AGENTS.md；项目层从 git root 走到 cwd 拼接（我们不碰项目层，只注全局）
//   - home 可整体搬家：CODEX_HOME env（官方支持）
//   - win32 home 解析 = USERPROFILE（doctor/desktop.rs 实证）
//   - 治理哲学：route A 纯劝导（与 dsh/opencode 同构）——只产 AGENTS.md
//   - override 机制（AGENTS.override.md 优先级更高）属用户主权区，relic 不碰
//
// FileMap keys: { 'AGENTS.md' } only
// install: 写 <codex-home>/AGENTS.md
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { renderAgentsMd } from '../render/agents-md.mjs';
import { backup, writeWithHeader, emptyReport, isContentUnchanged } from './base.mjs';
import { platformPaths, firstExisting } from '../core/paths.mjs';

/** @type {import('./base.mjs').PlatformAdapter} */
export default {
  id: 'codex',

  detect(env) {
    // 四层解析链（声明>env>约定）：任一候选存在即在装
    const candidates = platformPaths(env.home, { env: env.env ?? process.env }).codex;
    return firstExisting(candidates, (d) => env.existsSync(d)) !== null;
  },

  generate(policies, _env) {
    return { 'AGENTS.md': renderAgentsMd(policies) };
  },

  install(fileMap, opts) {
    const report = emptyReport();
    const home = opts.home;
    // 安装跟随已存在目录（用户自定义优先）；全新安装写首个候选
    // env 注入对称（同 detect）：测试可传 opts.env:{} 隔离真实环境
    const candidates = platformPaths(home, { env: opts.env ?? process.env }).codex;
    const codexDir = firstExisting(candidates, existsSync) ?? candidates[0];
    const agentsMdPath = join(codexDir, 'AGENTS.md');

    if (opts.dryRun) {
      report.skipped.push('codex (dryRun)');
      return report;
    }
    if (!fileMap['AGENTS.md']) {
      report.skipped.push('codex (no AGENTS.md in map)');
      return report;
    }
    try {
      // A1：内容比对短路——内容未变则跳过 backup+write（消除冗余 .bak）
      if (isContentUnchanged(agentsMdPath, fileMap['AGENTS.md'])) {
        report.skipped.push('codex (unchanged)');
        return report;
      }
      const bak = backup(agentsMdPath, opts);
      if (bak) report.backups.push(bak);
      writeWithHeader(agentsMdPath, fileMap['AGENTS.md'], { header: '' });
      report.written.push(agentsMdPath);
    } catch (e) {
      report.ok = false;
      report.errors.push(`AGENTS.md: ${e.message}`);
    }
    return report;
  },
};
