// =============================================================================
// src/adapters/dsh.mjs — DeepSeek Harness (dsh) 平台适配器
// =============================================================================
// dsh 的 permission 模型只有 session 级 ask/never + sandbox mode，不支持
// pattern 级拦截（与 opencode/omo 的 pattern→ask/deny 模型本质不同）。
// 用户决策（2026-09-05）：放弃 pattern 硬约束，全部靠 agent 自治。
//
// 因此 dsh adapter 只产 AGENTS.md（与 claude adapter 同构）：
//   - 所有 permission（含 runtime enforcement）全部渲染进 AGENTS.md 文本，
//     降级为 advisory——靠模型自律，不进 dsh runtime。
//   - detect: ~/.dsh 目录存在
//   - install: 写 ~/.dsh/AGENTS.md
//
// FileMap keys: { 'AGENTS.md' } only
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { renderAgentsMd } from '../render/agents-md.mjs';
import { backup, writeWithHeader, emptyReport, isContentUnchanged } from './base.mjs';
import { platformPaths, firstExisting } from '../core/paths.mjs';

/** @type {import('./base.mjs').PlatformAdapter} */
export default {
  id: 'dsh',

  detect(env) {
    // 四层解析链（声明>env>约定）：env 对象透传（隔离真实环境，测试可注入干净 env）
    const candidates = platformPaths(env.home, { env: env.env ?? process.env }).dsh;
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
    const candidates = platformPaths(home, { env: opts.env ?? process.env }).dsh;
    const dshDir = firstExisting(candidates, existsSync) ?? candidates[0];
    const agentsMdPath = join(dshDir, 'AGENTS.md');

    if (opts.dryRun) {
      report.skipped.push('dsh (dryRun)');
      return report;
    }
    if (!fileMap['AGENTS.md']) {
      report.skipped.push('dsh (no AGENTS.md in map)');
      return report;
    }
    try {
      // A1：内容比对短路——内容未变则跳过 backup+write（消除冗余 .bak）
      if (isContentUnchanged(agentsMdPath, fileMap['AGENTS.md'])) {
        report.skipped.push('dsh (unchanged)');
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
