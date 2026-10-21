// =============================================================================
// scripts/schedule.mjs — 调度器状态 / 启停 CLI（三平台同一命令）
// =============================================================================
// 用法：
//   npm run schedule                  → 查看状态
//   npm run schedule -- --status      → 同上
//   npm run schedule -- --enable      → 启用（幂等收敛）
//   npm run schedule -- --disable     → 停用（持久：Windows 禁用任务 / launchd 禁用标记 + bootout / cron 删行）
//
// 退出码：0 = 目标状态已达成；1 = 未达成（详见输出）。
// =============================================================================
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { userHome } from '../src/core/exec.mjs';
import { createScheduler } from '../src/core/scheduler.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = userHome();
const arg = process.argv[2] ?? '--status';

const scheduler = createScheduler({ repo: REPO, home: HOME });

const fmt = (st) =>
  `${st.backend}: installed=${st.installed} enabled=${st.enabled} running=${st.running === null ? 'unknown' : st.running}`;

if (arg === '--status') {
  const st = scheduler.status();
  console.log(`[schedule] ${fmt(st)}`);
  console.log(`[schedule] ${st.detail}`);
  process.exit(st.enabled ? 0 : 1);
}

if (arg === '--enable') {
  const r = scheduler.enable();
  for (const n of r.notes ?? []) if (n) console.log('[schedule] ' + n);
  console.log(`[schedule] ${fmt(r.status)}`);
  process.exit(r.status.enabled ? 0 : 1);
}

if (arg === '--disable') {
  const r = scheduler.disable();
  console.log(`[schedule] ${fmt(r.status)}`);
  process.exit(r.status.enabled ? 1 : 0);
}

console.error(`[schedule] 未知参数：${arg}`);
console.error('  可用：--status | --enable | --disable');
process.exit(2);
