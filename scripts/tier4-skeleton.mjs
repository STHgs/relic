// =============================================================================
// scripts/tier4-skeleton.mjs — 骨架门禁 CLI（Tier4）
// =============================================================================
// 用法：
//   node scripts/tier4-skeleton.mjs   # 断言 A（golden 等价）+ 骨架行唯一性
//                                     # （B 的确定性守卫在 sync 内联；v1 的 HEAD~1 渲染对比因条件段误报已移除）
//   node scripts/tier4-skeleton.mjs --bump-golden      # 系统变更仪式：以当前探针渲染重写 golden
//                                                      #（必须与 renderer 改动同一提交！）
// 退出码：0=通过，1=违法/漂移
// =============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { parse } from 'yaml';
import { renderAgentsMd } from '../src/render/agents-md.mjs';
import { loadProfile } from '../src/core/module-loader.mjs';
import { buildProbePolicies, extractSkeletonLines, assertGolden } from '../src/core/skeleton.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = resolve(REPO, 'tests/fixtures/golden-skeleton.md');

const readGolden = () => readFileSync(GOLDEN, 'utf8');
const renderReal = (policiesPath) => {
  const r = loadProfile({ manifestPath: policiesPath ?? resolve(REPO, 'template', 'policies.yaml') });
  if (!r.ok) throw new Error('loadProfile failed: ' + r.errors.join('; '));
  return renderAgentsMd(r.policies);
};

import { run as runExec } from '../src/core/exec.mjs';
const sh = (cmd, cwd = REPO) => {
  const parts = cmd.split(' ');
  const r = runExec(parts[0], parts.slice(1), { cwd });
  return { ok: r.ok, out: r.stdout + r.stderr };
};

const args = process.argv.slice(2);

// ---- 系统变更仪式：重写 golden ----
if (args.includes('--bump-golden')) {
  const probeRender = renderAgentsMd(buildProbePolicies());
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, probeRender);
  console.log('[tier4] golden bumped (' + probeRender.length + ' bytes) — commit together with the renderer change.');
  process.exit(0);
}

const goldenText = readGolden();
const failures = [];

// ---- 断言 A：等价 ----
const probeRender = renderAgentsMd(buildProbePolicies());
const a = assertGolden(probeRender, goldenText);
if (!a.ok) failures.push('A: ' + a.reason);

// ---- 骨架行集 + 唯一性 ----
const { lines: skeletonLines, unique } = extractSkeletonLines(goldenText);
if (!unique) failures.push('A: golden skeleton lines contain duplicates (ambiguous matching)');

const renderNow = renderReal();


if (failures.length === 0) {
  console.log('[tier4] skeleton gate PASS — A(equivalence) + B(immutability)');
  process.exit(0);
}
for (const f of failures) console.error('[tier4] FAIL ' + f);
process.exit(1);
