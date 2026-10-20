// =============================================================================
// scripts/bootstrap.mjs — 一键部署入口（新用户：clone 后唯一要敲的命令）
// =============================================================================
// 流程：环境自检 → 内容库判定（新建身份 init-sync / clone 已有 / 已存在跳过）→
//       npm install → 首次 sync（门禁+部署+哨兵）→ 调度器安装 → 交付报告
// 幂等：可重复运行；已就绪的步骤自动跳过。
// =============================================================================
import { spawnSync } from 'child_process';
import { run as runExec } from '../src/core/exec.mjs';  // win32 shell 解析 npm.cmd（同步既有修复）
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => {
  // win32 经 exec.mjs（shell 解析 npm.cmd）；POSIX 行为不变；stdio inherit 透传交互
  const r = runExec(cmd, args, { encoding: 'utf8', ...(opts.inherit ? { stdio: 'inherit' } : {}), ...opts });
  return { ok: r.ok, out: (r.stdout || '') + (r.stderr || '') };
};
const ask = (q) => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});
const log = (m) => console.log('[bootstrap] ' + m);

// 1. 环境自检
const need = [];
if (!run('node', ['--version']).ok) need.push('node >= 20（https://nodejs.org）');
else {
  const v = parseInt(run('node', ['--version']).out.slice(1), 10);
  if (v < 20) need.push(`node >= 20 需要（当前 ${v}）`);
}
if (!run('git', ['--version']).ok) need.push('git');
if (!run('gh', ['--version']).ok) {
  // gh 仅 --provider github 的 init-sync 需要；gitee 默认流程只要 git+node
  console.log('[bootstrap] 提示：gh CLI 未安装——同步库将默认走 Gitee（无需 gh）；若要用 GitHub 托管（--provider github），请安装 https://cli.github.com');
}
if (need.length > 0) { console.error('[bootstrap] 缺少前置：\n  ' + need.join('\n  ')); process.exit(1); }
log('环境自检通过（node/git/gh）');

// 2. 内容库判定
const cfgPath = join(REPO, 'relic.config.json');
const defaultContent = join(process.env.HOME, '.config', 'relic-sync');
const contentReady = existsSync(cfgPath)
  ? existsSync(join(JSON.parse(readFileSync(cfgPath, 'utf8')).contentRepo, 'policies.yaml'))
  : existsSync(join(defaultContent, 'policies.yaml'));

if (!contentReady) {
  const mode = await ask('未发现身份内容库。1=新建身份（Gitee 私有库，令牌粘贴一次） 2=接入已有同步库（填 URL） [1] ');
  if (mode === '2') {
    const url = await ask('同步库 URL: ');
    const r = run('git', ['clone', url, defaultContent], { inherit: true });
    if (!r.ok) process.exit(1);
  } else {
    const r = run('npm', ['run', 'init-sync'], { cwd: REPO, inherit: true });
    if (!r.ok) process.exit(1);
  }
} else {
  log('内容库已就绪，跳过初始化');
}

// 3. 引擎依赖
if (!existsSync(join(REPO, 'node_modules'))) {
  if (!run('npm', ['install'], { cwd: REPO, inherit: true }).ok) process.exit(1);
} else log('引擎依赖已存在，跳过 npm install');

// 4. 首次 sync（骨架门禁 + generate + 部署 + 哨兵）
const s = run('npm', ['run', 'sync'], { cwd: REPO, inherit: true });
if (!s.ok) { console.error('[bootstrap] 首次 sync 失败，排查后重跑 bootstrap'); process.exit(1); }

// 5. 调度器
run('node', [join(REPO, 'scripts', 'install-schedule.mjs')], { cwd: REPO, inherit: true });

log('✅ 部署完成。改规则：编辑内容库 modules/<id>/module.yaml → commit+push → 5 分钟内全域生效');
log('   升级引擎：npm run upgrade -- --tag <tag>');
