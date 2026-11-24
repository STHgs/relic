// =============================================================================
// scripts/sandbox-access.mjs — 沙箱只读授权 CLI（Windows + Codex）
// =============================================================================
//   npm run sandbox-access                    # 只探测（默认，不修改任何状态）
//   npm run sandbox-access -- --apply        # 授权（TTY 下需回车确认）
//   npm run sandbox-access -- --apply --yes  # 非交互执行（脚本/控制台）
//   npm run sandbox-access -- --revoke       # 打印撤销命令（不执行）
//
// 只处理 Windows + Codex：Linux/mac 的沙箱不限制读取；DSH 是 WRITE_RESTRICTED（只拦写）。
// 授权范围：仅本地组 CodexSandboxUsers、仅内容库与习惯库目录、仅 (OI)(CI)(RX)。
// =============================================================================

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { run, userHome } from '../src/core/exec.mjs';
import { planSandboxAccess, applySandboxAccess } from '../src/core/sandbox-access.mjs';
import { HABITS_DIR } from '../src/core/habits.mjs';

const HOME = userHome();
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);

function contentRepo() {
  const i = argv.indexOf('--content');
  if (i >= 0) return resolve(argv[i + 1]);
  if (process.env.RELIC_CONTENT_REPO) return resolve(process.env.RELIC_CONTENT_REPO);
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'relic.config.json'), 'utf8'));
    if (cfg.contentRepo) return resolve(cfg.contentRepo);
  } catch { /* 走约定路径 */ }
  return join(HOME, '.config', 'relic-sync');
}

const dirs = [contentRepo(), HABITS_DIR()];
const exec = (cmd, args) => run(cmd, args);

const plan = planSandboxAccess({ dirs, exec });

function printPlan() {
  console.log('[relic] 沙箱只读访问检查');
  console.log(`  平台：${plan.platform}　主体：${plan.principal}`);
  console.log(`  结论：${plan.reason}`);
  if (!plan.applicable) return;
  for (const d of plan.dirs) {
    const state = !d.exists ? '目录不存在' : d.granted ? '已授权' : '未授权';
    console.log(`  · ${state.padEnd(6)} ${d.path}`);
  }
  if (plan.needsGrant) {
    console.log('\n  为什么需要：');
    for (const l of plan.necessity.split('\n')) console.log('  ' + l);
    console.log('\n  将执行：');
    for (const d of plan.dirs) if (d.exists && !d.granted) console.log(`    ${d.command}`);
    console.log('\n  授权边界：');
    for (const l of plan.boundary.split('\n')) console.log('  ' + l);
  }
}

if (flag('--revoke')) {
  console.log('撤销只读授权：');
  for (const c of plan.revoke) console.log('  ' + c);
  process.exit(0);
}

if (!flag('--apply')) {
  printPlan();
  process.exit(0);
}

// ── 授权（需确认） ──────────────────────────────────────────────────────
if (!plan.applicable || !plan.groupExists || !plan.needsGrant) {
  printPlan();
  process.exit(0);
}

async function confirm() {
  if (flag('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.error('[relic] 非交互环境需显式 --yes 才会修改 ACL（未做任何修改）');
    return false;
  }
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('确认授权以上只读访问？(y/N) ', res));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

printPlan();
if (!(await confirm())) { console.log('已取消，未做任何修改'); process.exit(0); }

const r = applySandboxAccess({ dirs, exec });
for (const a of r.applied) console.log(`  ${a.ok ? '✓' : '✗'} ${a.path}${a.ok ? '' : ' — ' + a.stderr}`);
for (const s of r.skipped) console.log(`  - 跳过 ${s.path}（${s.reason}）`);
for (const v of r.verify) console.log(`  验证 ${v.granted ? '✓ 可读' : '✗ 仍不可读'}：${v.path}`);
if (!r.ok) {
  console.error('授权未完全成功；撤销命令见上（--revoke）');
  process.exit(1);
}
console.log('完成：Codex 沙箱现可只读访问 relic 数据目录。');
process.exit(0);
