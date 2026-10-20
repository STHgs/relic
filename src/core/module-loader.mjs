// =============================================================================
// src/core/module-loader.mjs — 方向 3 核心：profile 加载 + fragment 合并
// =============================================================================
// loadProfile: 读 manifest → 校验 → 解析 profile → 从 registry 解析模块 →
//              读+校验每个 fragment → mergeFragments → 校验合并结果 → 跨模块冲突检测
// mergeFragments: 纯合并函数（无 I/O），供 loadProfile 和测试复用
//
// 设计原则（自 direction3-plan §4）：
//   - loadProfile 注入 read/exists/validate/validateModule，便于测试 mock
//   - mergeFragments 是纯函数，确定顺序（profile.modules 顺序），保证 round-trip 稳定
//   - 合并后 meta.profile = {id, name}，供渲染器标注当前 profile
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { parse } from 'yaml';
import { createValidator, createModuleValidator } from './validator.mjs';
import { detectCrossModuleConflicts } from './conflict.mjs';

const validate = createValidator();
const validateModule = createModuleValidator();

/**
 * 纯合并：把 manifest 的 inline rules + 各 fragment 的 rules 合并成一个 policies 对象。
 * @param {object} manifest     已校验的 manifest（含 meta, profiles, modules registry, 可选 inline rules）
 * @param {{id:string, doc:object}[]} fragments  已加载+校验的模块片段（按 profile.modules 顺序）
 * @param {object} profile      当前激活的 profile 条目（{id, name, ...}）
 * @returns {object} 合并后的 policies 对象（meta 带 profile；modules/profiles 清空）
 */
export function mergeFragments(manifest, fragments, profile) {
  // inline rules from manifest (always-on)
  const inlinePerms = manifest.permissions || [];
  const inlineWfs = manifest.workflows || [];
  const inlineRisk = manifest.risk_levels || { low: [], medium: [], high: [] };

  // concat fragment rules in order
  const fragPerms = fragments.flatMap((f) => f.doc.permissions || []);
  const fragWfs = fragments.flatMap((f) => f.doc.workflows || []);

  // risk_levels: per-level concat + dedup (preserve first-seen order)
  const mergeLevel = (level) => {
    const seen = new Set();
    const result = [];
    for (const item of [...(inlineRisk[level] || []), ...fragments.flatMap((f) => (f.doc.risk_levels?.[level]) || [])]) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
    return result;
  };

  // workflow -> source module 溯源（roadmap 索引用；inline 入口流程记为 'manifest'）
  const workflowSources = {};
  for (const w of inlineWfs) workflowSources[w.id] = 'manifest';
  for (const f of fragments) for (const w of (f.doc.workflows || [])) workflowSources[w.id] = f.id;

  const merged = {
    meta: {
      ...manifest.meta,
      profile: { id: profile.id, name: profile.name },
      workflowSources,
    },
    permissions: [...inlinePerms, ...fragPerms],
    workflows: [...inlineWfs, ...fragWfs],
    risk_levels: {
      low: mergeLevel('low'),
      medium: mergeLevel('medium'),
      high: mergeLevel('high'),
    },
    personas: manifest.personas || [],
    modules: [],
    profiles: [],
  };

  return merged;
}

/**
 * 加载一个 profile：读 manifest → 校验 → 解析 profile → 读模块 → 合并 → 校验 → 冲突检测。
 * @param {object} opts
 * @param {string} opts.manifestPath      policies.yaml (manifest) 绝对路径
 * @param {string} [opts.modulesDir]      modules/ dir; default <manifestDir>/modules
 * @param {string} [opts.profileName]     profile id; omit → use default:true
 * @param {(p:string)=>string} [opts.read]   readFileSync inject (tests)
 * @param {(p:string)=>boolean} [opts.exists] existsSync inject (tests)
 * @returns {{ok:boolean, policies?:object, profile?:object, conflicts?:object, errors?:string[]}}
 */
export function loadProfile(opts) {
  const {
    manifestPath,
    modulesDir,
    profileName,
    read = (p) => readFileSync(p, 'utf8'),
    exists = (p) => existsSync(p),
  } = opts;

  const manifestDir = dirname(manifestPath);
  const modDir = modulesDir || join(manifestDir, 'modules');

  // 1. 读 + 解析 manifest
  if (!exists(manifestPath)) {
    return { ok: false, errors: [`manifest not found: ${manifestPath}`] };
  }
  let manifest;
  try {
    manifest = parse(read(manifestPath));
  } catch (e) {
    return { ok: false, errors: [`manifest parse error: ${e.message}`] };
  }

  // 2. 校验 manifest（full v2 schema）
  const mv = validate(manifest);
  if (!mv.ok) {
    return { ok: false, errors: ['manifest validation: ' + mv.errors.join('; ')] };
  }
  manifest = mv.doc;

  // 3. 检查有无 profiles 段
  const profiles = manifest.profiles || [];
  if (profiles.length === 0) {
    return { ok: false, errors: ['manifest has no profiles section; use loadPolicies for single-file mode'] };
  }

  // 4. 解析 profile
  let profile;
  if (profileName) {
    profile = profiles.find((p) => p.id === profileName);
    if (!profile) {
      return { ok: false, errors: [`unknown profile: ${profileName}; available: ${profiles.map((p) => p.id).join(', ')}`] };
    }
  } else {
    profile = profiles.find((p) => p.default === true);
    if (!profile) {
      return { ok: false, errors: ['no --profile given and no profile marked default:true; available: ' + profiles.map((p) => p.id).join(', ')] };
    }
  }

  // 5. 解析 modules from registry
  const registry = manifest.modules || [];
  const registryIds = new Set(registry.map((m) => m.id));
  let modIds;
  if (profile.modules === 'all') {
    modIds = registry.filter((m) => m.enabled !== false).map((m) => m.id);
  } else {
    modIds = profile.modules;
    // 校验引用的 id 都在 registry
    for (const id of modIds) {
      if (!registryIds.has(id)) {
        return { ok: false, errors: [`profile "${profile.id}" references unknown module: ${id}; registry has: ${[...registryIds].join(', ')}`] };
      }
    }
    // 过滤 enabled:false
    modIds = modIds.filter((id) => {
      const entry = registry.find((m) => m.id === id);
      if (entry && entry.enabled === false) {
        // skip + warn (not error)
        return false;
      }
      return true;
    });
  }

  // 6. 读 + 校验每个 fragment
  const fragments = [];
  for (const id of modIds) {
    const fragPath = join(modDir, id, 'module.yaml');
    if (!exists(fragPath)) {
      return { ok: false, errors: [`module fragment not found: ${fragPath}`] };
    }
    let frag;
    try {
      frag = parse(read(fragPath));
    } catch (e) {
      return { ok: false, errors: [`fragment ${id} parse error: ${e.message}`] };
    }
    // triple-check: fragment id must match directory name AND registry id
    if (frag.id !== id) {
      return { ok: false, errors: [`fragment id "${frag.id}" ≠ directory "${id}" (triple-check fail)`] };
    }
    // validate as moduleFragment
    const fv = validateModule(frag);
    if (!fv.ok) {
      return { ok: false, errors: [`fragment ${id} validation: ${fv.errors.join('; ')}`] };
    }
    fragments.push({ id, doc: fv.doc });
  }

  // 7. 合并
  const merged = mergeFragments(manifest, fragments, profile);

  // 8. 校验合并结果（full v2）
  const mergedV = validate(merged);
  if (!mergedV.ok) {
    return { ok: false, errors: ['merged validation: ' + mergedV.errors.join('; ')] };
  }

  // 9. 跨模块冲突检测
  const conflicts = detectCrossModuleConflicts(mergedV.doc.permissions, mergedV.doc.workflows);
  if (!conflicts.ok) {
    return { ok: false, conflicts, errors: ['cross-module id clashes: ' + conflicts.idClashes.map((c) => c.id).join(', ')] };
  }

  return {
    ok: true,
    policies: mergedV.doc,
    profile,
    conflicts,
  };
}
