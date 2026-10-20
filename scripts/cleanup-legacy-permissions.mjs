#!/usr/bin/env node
// =============================================================================
// scripts/cleanup-legacy-permissions.mjs — 一次性清理旧版多 agent permission
// =============================================================================
// 架构修订（v4.1 findings-staging D 节）：relic 只治主 agent。
// 旧版注入了 build/explore（opencode）和 hephaestus/atlas/sisyphus-junior（omo）
// 的 permission——这些在"只治主 agent"架构下是遗留，应清理。
//
// 清理规则：
//   opencode.jsonc: 删 agent.build / agent.explore 整条（它们本就是 relic 注入的，
//     非用户自定义；OpenCode 内置默认会接管）
//   omo.jsonc: 只删 [opencode].agents.<非主agent>.permission 字段——保留 agent
//     条目本身（还有 model/fallback_models），OMO TS 工厂会接管 permission
//
// 主 agent（opencode=general, omo=sisyphus）不动——由 generate 更新。
// 用法：node scripts/cleanup-legacy-permissions.mjs [--include-primary]
//   --include-primary：2026-09-15 全量去硬约束后，主 agent 的注入也一并清除
// =============================================================================

import { readJsonc, writeWithHeader } from '../src/adapters/base.mjs';
import { join } from 'path';
import { homedir } from 'os';

const INCLUDE_PRIMARY = process.argv.includes('--include-primary');  // 2026-09-15 去硬约束：连同主 agent 一起清
const OPENCODE_PRIMARY = 'general';
const OMO_PRIMARY = 'sisyphus';
const OPENCODE_CONFIG = join(homedir(), '.config', 'opencode', 'opencode.jsonc');
const OMO_CONFIG = join(homedir(), '.omo', 'omo.jsonc');

let changed = false;

// ─── opencode.jsonc: 删非主 agent 的 permission 字段（保留 agent 条目 + mode） ─
// 不删整条 agent——OpenCode V2 的 default_agent fallback 链依赖 build 等存在。
// 只删 relic 注入的 permission，让平台内置默认接管。
try {
  const oc = readJsonc(OPENCODE_CONFIG);
  const agents = oc.agent || {};
  let deleted = 0;
  const deletedNames = [];
  for (const [name, agent] of Object.entries(agents)) {
    if (name === OPENCODE_PRIMARY && !INCLUDE_PRIMARY) continue;
    if (agent.permission) {
      delete agent.permission;
      deleted++;
      deletedNames.push(name);
    }
  }
  if (deleted > 0) {
    oc.agent = agents;
    writeWithHeader(OPENCODE_CONFIG, JSON.stringify(oc, null, 2) + '\n');
    console.log(`opencode.jsonc: deleted permission from ${deleted} legacy agent(s): ${deletedNames.join(', ')}`);
    changed = true;
  } else {
    console.log('opencode.jsonc: no legacy permissions to delete');
  }
} catch (e) {
  console.error(`opencode.jsonc cleanup failed: ${e.message}`);
}

// ─── omo.jsonc: 删非主 agent 的 permission 字段（保留 agent 条目） ──────
try {
  const omo = readJsonc(OMO_CONFIG);
  const agents = omo['[opencode]']?.agents || {};
  let deleted = 0;
  const deletedNames = [];
  for (const [name, agent] of Object.entries(agents)) {
    if (name === OMO_PRIMARY && !INCLUDE_PRIMARY) continue;
    if (agent.permission) {
      delete agent.permission;
      deleted++;
      deletedNames.push(name);
    }
  }
  if (deleted > 0) {
    omo['[opencode]'].agents = agents;
    writeWithHeader(OMO_CONFIG, JSON.stringify(omo, null, 2) + '\n');
    console.log(`omo.jsonc: deleted permission from ${deleted} legacy agent(s): ${deletedNames.join(', ')}`);
    changed = true;
  } else {
    console.log('omo.jsonc: no legacy permissions to delete');
  }
} catch (e) {
  console.error(`omo.jsonc cleanup failed: ${e.message}`);
}

if (changed) {
  console.log('\n清理完成。现在可跑 `npm run generate` 注入新（只主 agent）permission。');
} else {
  console.log('\n无需清理。');
}
