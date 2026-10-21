// =============================================================================
// scripts/install-schedule.mjs — 宿主调度器安装（薄壳）
// =============================================================================
// 平台逻辑全部在 src/core/scheduler.mjs（systemd/cron/launchd/schtasks 四后端）。
// 本脚本只做：解析本机路径 → install()（幂等收敛）→ 按真实状态给退出码。
// 关键语义：install() 会把"存在但被禁用"的任务重新启用；退出码以
// status.enabled 为准，绝不以"命令返回 0"冒充安装成功。
// =============================================================================
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { userHome } from '../src/core/exec.mjs';
import { createScheduler } from '../src/core/scheduler.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = userHome();

const scheduler = createScheduler({ repo: REPO, home: HOME });
const result = scheduler.install();
const st = result.status;

for (const note of result.notes ?? []) {
  if (note) console.log('[schedule] ' + note);
}

if (st.enabled) {
  console.log(`[schedule] ✅ ${st.backend} 已启用（每 5 分钟）— ${st.detail}`);
  process.exit(0);
}

console.error(`[schedule] ✗ ${st.backend} 未启用 — ${st.detail}`);
console.error('  手动排查：npm run schedule -- --status');
process.exit(1);
