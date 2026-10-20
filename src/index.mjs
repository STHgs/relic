// =============================================================================
// src/index.mjs — relic 公共 API 门面
// =============================================================================
// 一条龙：load → validate → generate → install
// 这是用户/上层 skill 调用 relic 的唯一入口。
//
// 用法（编程式）:
//   import { pipeline } from './src/index.mjs';
//   const r = await pipeline({ policiesPath: './policies.yaml', dryRun: true });
// =============================================================================

import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { loadPolicies } from './core/loader.mjs';
import { createValidator } from './core/validator.mjs';
import { generate } from './orchestrator/generate.mjs';
import { loadProfile } from './core/module-loader.mjs';
import { loadHabitsView } from './core/habits.mjs';

const validate = createValidator();

/**
 * @typedef {Object} PipelineOptions
 * @property {string} policiesPath      policies.yaml 绝对路径
 * @property {boolean} [dryRun]        true=仅预览不写盘
 * @property {string} [home]          HOME 目录
 * @property {string} [profile]       profile id（方向 3）；若 manifest 有 profiles 段且未传则用 default
 * @property {string} [modulesDir]    modules/ 目录（默认 <manifestDir>/modules）
 */

/**
 * 一条龙跑完 load→validate→generate→install。
 * 若 manifest 有 profiles 段 或 传了 profile 参数 → 走 loadProfile（方向 3 模块化模式）；
 * 否则走 loadPolicies（单文件模式）。
 * @param {PipelineOptions} opts
 * @returns {Promise<{ok:boolean, stage:string, errors?:string[], fileMaps?:object, report?:object, policies?:object}>}
 */
export async function pipeline(opts) {
  const { policiesPath, dryRun = false, home = process.env.HOME, profile, modulesDir } = opts;

  // 分支：检测 manifest 是否有 profiles 段
  let policies;
  try {
    const raw = parse(readFileSync(policiesPath, 'utf8'));
    const hasProfiles = Array.isArray(raw.profiles) && raw.profiles.length > 0;
    if (hasProfiles || profile) {
      const r = loadProfile({ manifestPath: policiesPath, modulesDir, profileName: profile });
      if (!r.ok) {
        return { ok: false, stage: 'load', errors: r.errors };
      }
      policies = r.policies;
    } else {
      policies = loadPolicies(policiesPath);
      const v = validate(policies);
      if (!v.ok) {
        return { ok: false, stage: 'validate', errors: v.errors, policies: v.doc };
      }
      policies = v.doc;
    }
  } catch (e) {
    return { ok: false, stage: 'load', errors: [e.message] };
  }

  // 本机习惯视图（纯度不变量）：与 generate CLI 同点注入——渲染器只吃显式输入
  if (policies.meta) policies.meta.habits = loadHabitsView();

  // generate (and install if not dryRun)
  const g = await generate(policies, { home, dryRun });
  return {
    ok: g.ok,
    stage: 'generate',
    fileMaps: g.fileMaps,
    report: g.report,
    policies,
  };
}

// 也导出底层模块，便于高级用法
export { loadPolicies, parsePolicies } from './core/loader.mjs';
export { createValidator, createModuleValidator } from './core/validator.mjs';
export { generate } from './orchestrator/generate.mjs';
export { loadProfile, mergeFragments } from './core/module-loader.mjs';
export { injectRule, buildPermissionYaml, buildWorkflowYaml } from './core/inject.mjs';
export { detectPermissionConflict, detectWorkflowConflict, detectCrossModuleConflicts } from './core/conflict.mjs';
export { renderAgentsMd } from './render/agents-md.mjs';
