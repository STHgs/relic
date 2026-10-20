// =============================================================================
// scripts/sync.mjs — `npm run sync` 同步原语 CLI（平台无关）
// =============================================================================
// 用法：
//   node scripts/sync.mjs                 拉取 + generate + 哨兵自检 + 写 .last-sync
//   node scripts/sync.mjs --init-deploy   把当前 clone 标记为只读部署位（.relic-deploy
//                                         + pre-commit 护栏，拒绝一切本地提交）
// 宿主调度器接入见 docs/SYNC.md（systemd / cron / Task Scheduler / launchd）。
// 语义保证：工作区脏 / 分叉 / 哨兵缺失 → 退出码 1，绝不静默调和。
// =============================================================================
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runSync, deployGuardHook } from '../src/core/sync-core.mjs';
import { renderAgentsMd } from '../src/render/agents-md.mjs';
import { loadProfile } from '../src/core/module-loader.mjs';
import { buildProbePolicies, assertGolden, checkDeterminism } from '../src/core/skeleton.mjs';
import { loadHabitsView } from '../src/core/habits.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 内容库发现链：--content 参数 > RELIC_CONTENT_REPO env > relic.config.json > 约定路径 ----
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
function discoverContentRepo() {
  const explicit = argOf('--content') || process.env.RELIC_CONTENT_REPO;
  if (explicit) return resolve(explicit);
  const cfgPath = join(REPO_ROOT, 'relic.config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.contentRepo) return resolve(cfg.contentRepo);
    } catch { /* 损坏配置走约定路径 */ }
  }
  return join(process.env.HOME, '.config', 'relic-sync');
}
const CONTENT_REPO = discoverContentRepo();
const CONTENT_POLICIES = join(CONTENT_REPO, 'policies.yaml');

// ---- 通用同步门控（第 0 步，2026-09-22 全平台统一）----
// 语义：仅定时器上下文（无 TTY）判"无 harness 消费者则跳过"；手动调用永全量。
// 历史：门控原在 win vbs 包装层（fdaf102），本迁移为 sync 内置——任一 harness 通用。
import { gateCheck, appendGateLog } from '../src/core/gate.mjs';
if (!process.stdout.isTTY && !process.argv.includes('--no-gate')) {
  const gate = gateCheck();
  if (!gate.ok) {
    appendGateLog({ action: 'skip', reason: gate.reason, invokedBy: 'timer' });
    console.log(`[relic] gate: ${gate.reason} — sync skipped`);
    process.exit(0);  // 门控跳过=正常退出（非失败）
  }
  appendGateLog({ action: 'run', reason: gate.reason, invokedBy: 'timer' });
}
if (!existsSync(CONTENT_POLICIES)) {
  console.error(`[relic] 内容库不存在：${CONTENT_POLICIES}
  首次部署请运行：npm run init-sync        （新建身份）
  或多平台接入：git clone <你的同步库> ${CONTENT_REPO}`);
  process.exit(1);
}

// Windows 适配：数组化经 exec.mjs（win32 shell 解析；POSIX 行为不变）
import { run as runExec, userHome } from '../src/core/exec.mjs';
const exec = (cmd, cwd) => {
  const parts = cmd.split(' ');
  return runExec(parts[0], parts.slice(1), { cwd });
};

const generateRun = () => new Promise((res) => {
  // generate 在引擎跑，内容来自内容库（--policies）；runtimeRoot=内容根（manifest 目录不变量）
  // win32 真机修复（2026-09-16）：
  //   ① 经 exec.mjs run()——win32 走 shell 解析 npm.cmd（原裸 spawnSync('npm') 恒 ENOENT）；
  //   ② 子进程 HOME 显式补 userHome()——schtasks/原生 PowerShell 无 HOME，而 generate CLI
  //     的 home 默认取 process.env.HOME，缺省时 detect 全盲、sync 空转不写。
  //   POSIX 行为不变（shell:false + HOME=HOME）。
  const r = runExec('npm', ['run', 'generate', '--', '--policies', CONTENT_POLICIES], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', HOME: userHome() },
  });
  if (!r.ok) {
    res({ ok: false, written: [], errors: [r.stderr || 'npm run generate failed'] });
    return;
  }
  // CLI 输出 JSON 报告（可能带 npm 前缀行，取最后一个 JSON 对象）
  const out = r.stdout || '';
  const start = out.indexOf('{');
  try {
    const report = JSON.parse(out.slice(start));
    res({ ok: report.ok !== false, written: report.written || [], errors: report.errors || [] });
  } catch {
    res({ ok: true, written: [], errors: [] });
  }
});

const args = process.argv.slice(2);

if (args.includes('--init-deploy')) {
  const marker = resolve(REPO_ROOT, '.relic-deploy');
  writeFileSync(marker, 'deploy-only clone; guard installed\n');
  const hookPath = resolve(REPO_ROOT, '.git/hooks/pre-commit');
  writeFileSync(hookPath, deployGuardHook(), { mode: 0o755 });
  console.log('[relic] deploy marker written + pre-commit guard installed:');
  console.log('  ' + marker);
  console.log('  ' + hookPath);
  process.exit(0);
}

// ---- 骨架门禁（generate 前拦截；原则：骨架静态，用户区提交触碰骨架=违法）----
const GOLDEN_PATH = resolve(REPO_ROOT, 'tests/fixtures/golden-skeleton.md');
const goldenText = readFileSync(GOLDEN_PATH, 'utf8');
const gateA = assertGolden(renderAgentsMd(buildProbePolicies()), goldenText);
if (!gateA.ok) {
  console.error(`[relic] skeleton gate A FAILED: ${gateA.reason}`);
  process.exit(1);
}
let skeletonState = null;
{
  // 断言 B v2（确定性守卫）：渲染必须是输入的纯函数；输入变化即重录
  const lp = loadProfile({ manifestPath: CONTENT_POLICIES });
  if (!lp.ok) { console.error('[relic] skeleton gate: loadProfile failed: ' + lp.errors.join('; ')); process.exit(1); }
  const statePath = join(CONTENT_REPO, '.last-sync');
  let prevInputSig = null, prevOutputSha = null;
  if (existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      prevInputSig = st.inputSig ?? null; prevOutputSha = st.outputSha ?? null;
    } catch { /* 损坏状态视为首次 */ }
  }
  // 本机习惯视图：与 generate 管线取同一份（gate B 输入闭合——易变输入必须登记，
  // 否则库一改/跨天排序变化会被误判为"同输入不同输出"）
  const habitsView = loadHabitsView();
  const gateB = checkDeterminism({
    contentCommit: exec('git rev-parse HEAD', CONTENT_REPO).stdout.trim(),
    goldenText,
    rendererText: readFileSync(resolve(REPO_ROOT, 'src/render/agents-md.mjs'), 'utf8'),
    outputText: renderAgentsMd({ ...lp.policies, meta: { ...lp.policies.meta, habits: habitsView } }),
    habitsView,
    prevInputSig, prevOutputSha,
  });
  if (!gateB.ok) {
    console.error(`[relic] determinism gate B FAILED: ${gateB.reason}`);
    process.exit(1);
  }
  skeletonState = { inputSig: gateB.inputSig, outputSha: gateB.outputSha };
}

const result = await runSync({
  exec,
  cwd: CONTENT_REPO,   // git 语义（脏拒/ff-only/分叉拒）作用于内容库
  generateRun,
  read: (p) => readFileSync(p, 'utf8'),
  writeState: (p, s) => writeFileSync(join(CONTENT_REPO, p), s),
});

if (result.ok) {
  // 门禁状态持久化（成功部署后才记录，失败不落账）
  if (skeletonState) {
    const statePath = join(CONTENT_REPO, '.last-sync');
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      writeFileSync(statePath, JSON.stringify({ ...st, ...skeletonState }, null, 2) + '\n');
    } catch { /* 状态合并失败不致命 */ }
  }
  console.log(`[relic] sync OK — commit ${String(result.commit).slice(0, 8)}${result.pulled ? ' (pulled)' : ' (already current)'}; generated ${result.generated.length} file(s); skeleton gate A+B PASS`);
  process.exit(0);
}
console.error(`[relic] sync FAILED at stage "${result.stage}": ${result.reason}`);
process.exit(1);
