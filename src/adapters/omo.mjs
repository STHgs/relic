// =============================================================================
// src/adapters/omo.mjs — OMO (Oh-My-OpenCode) 平台适配器
// =============================================================================
// 治理哲学转变（用户拍板 2026-09-15）：去除运行时 permission 注入。
// OMO 叠加在 OpenCode 之上，其治理文本由 opencode 适配器写的
// ~/.config/opencode/AGENTS.md 送达（OpenCode V2 会注入所有 agent）。
// 因此本适配器成为显式 no-op：detect 报告平台在场，不产出/不改写任何文件。
// （历史：v4.1 曾深合并 sisyphus.permission 进 omo.jsonc；已退役。）
// =============================================================================

import { existsSync } from 'fs';
import { posix } from 'path';
const join = posix.join;  // 正斜杠标准（与 paths.mjs 对齐；Node fs 兼容 win）
import { emptyReport } from './base.mjs';
import { platformPaths, firstExisting } from '../core/paths.mjs';

/** @type {import('./base.mjs').PlatformAdapter} */
export default {
  id: 'omo',

  detect(env) {
    const candidates = platformPaths(env.home, { env: env.env ?? process.env }).omo;
    return firstExisting(candidates, (d) => env.existsSync(join(d, 'omo.jsonc'))) !== null;
  },

  generate(_policies, _env) {
    // route A no-op：治理文本由 opencode 适配器统一送达，本平台无独立产物
    return {};
  },

  install(_fileMap, opts) {
    const report = emptyReport();
    if (opts.dryRun) {
      report.skipped.push('omo (dryRun)');
    } else {
      report.skipped.push('omo (route A no-op: governance delivered via opencode AGENTS.md)');
    }
    return report;
  },
};
