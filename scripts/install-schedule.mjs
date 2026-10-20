// =============================================================================
// scripts/install-schedule.mjs — 宿主调度器自动安装（三平台）
// =============================================================================
// 探测顺序（D2）：
//   win32  → schtasks（每 5 分钟）
//   darwin → launchd（~/Library/LaunchAgents/dev.relic.sync.plist，StartInterval=300）
//   linux  → systemd user timer → crontab 回退
// 幂等：已有条目即跳过。
// =============================================================================
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { userHome } from '../src/core/exec.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = userHome();
const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
};
const die = (m) => { console.error('[schedule] ' + m); process.exit(1); };

const PLATFORM = process.platform;

if (PLATFORM === 'win32') {
  // ─── Windows：schtasks（每 5 分钟）────────────────────────────────
  // v2（2026-09-21）→v3（2026-09-22）：弹窗整改 vbs 静默包装保留；DSH 存活
  // 门控已迁入 scripts/sync.mjs 第 0 步（全平台通用，任一 harness 消费者
  // 探测 + isTTY 手动直通），vbs 卸门控只管静默。部署形态不变：vbs 复制到
  // %LOCALAPPDATA%\relic\sync-silent.vbs（__REPO__ 占位符换本机引擎路径），
  // /TR 指向副本——git pull 永不覆盖在跑包装器。
  const q = run('schtasks', ['/Query', '/TN', 'relic-sync']);
  const workDir = join(HOME, 'AppData', 'Local', 'relic');
  const vbsSrc = join(REPO, 'scripts', 'sync-silent.vbs');
  const vbsDst = join(workDir, 'sync-silent.vbs');
  const tr = `wscript.exe "${vbsDst}"`;
  if (!q.ok) {
    mkdirSync(workDir, { recursive: true });
    const vbsBody = readFileSync(vbsSrc, 'utf8').replaceAll('__REPO__', REPO);
    writeFileSync(vbsDst, vbsBody);
    const ins = run('schtasks', ['/Create', '/TN', 'relic-sync', '/SC', 'MINUTE', '/MO', '5', '/TR', tr]);
    if (ins.ok) console.log('[schedule] ✅ schtasks 已创建（每 5 分钟，静默包装 ' + vbsDst + '）');
    else die('schtasks 创建失败：' + ins.out + '\n  手动等价：schtasks /Create /TN relic-sync /SC MINUTE /MO 5 /TR "' + tr + '"');
    process.exit(ins.ok ? 0 : 1);
  }
  // 已有任务：对齐到静默包装（升级路径——旧 /TR 是 cmd 直弹窗形态）
  const cur = run('schtasks', ['/Query', '/TN', 'relic-sync', '/V', '/FO', 'LIST']);
  if (!cur.out.includes(vbsDst)) {
    mkdirSync(workDir, { recursive: true });
    const vbsBody = readFileSync(vbsSrc, 'utf8').replaceAll('__REPO__', REPO);
    writeFileSync(vbsDst, vbsBody);
    const chg = run('schtasks', ['/Change', '/TN', 'relic-sync', '/TR', tr]);
    if (chg.ok) console.log('[schedule] ✅ 已迁移到静默包装（旧 /TR 弹窗形态退役）');
    else die('schtasks /Change 失败：' + chg.out + '\n  手动等价：schtasks /Change /TN relic-sync /TR "' + tr + '"');
  } else {
    console.log('[schedule] ✅ schtasks 已是静默包装形态');
  }
  process.exit(0);
}

if (PLATFORM === 'darwin') {
  // ─── macOS：launchd（一等支持，补 v7 欠账）─────────────────────────
  const label = 'dev.relic.sync';
  const plDir = join(HOME, 'Library', 'LaunchAgents');
  const plPath = join(plDir, label + '.plist');
  mkdirSync(plDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${HOME}/.relic-sync.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.relic-sync.log</string>
</dict>
</plist>
`;
  writeFileSync(plPath, plist);
  run('launchctl', ['unload', plPath]);            // 幂等：先卸旧
  const load = run('launchctl', ['load', plPath]);
  if (load.ok) console.log('[schedule] ✅ launchd 已加载（每 5 分钟，' + plPath + '）');
  else die('launchctl load 失败：' + load.out + '（plist 已写好，请检查权限）');
  process.exit(load.ok ? 0 : 1);
}

// ─── Linux：systemd → cron ───────────────────────────────────────────
const sysd = run('systemctl', ['--user', 'is-system-running']);
if (sysd.ok || !sysd.out.includes('Failed to connect')) {
  const dir = join(HOME, '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'relic-sync.service'), `[Unit]
Description=relic sync (pull --ff-only + generate + skeleton gate)

[Service]
Type=oneshot
WorkingDirectory=${REPO}
ExecStart=/usr/bin/env npm run sync
`);
  writeFileSync(join(dir, 'relic-sync.timer'), `[Unit]
Description=relic sync every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`);
  run('systemctl', ['--user', 'daemon-reload']);
  const en = run('systemctl', ['--user', 'enable', '--now', 'relic-sync.timer']);
  console.log(en.ok ? '[schedule] ✅ systemd user timer 已启用（每 5 分钟）' : '[schedule] systemd enable 失败：' + en.out);
  console.log('[schedule] 建议执行：sudo loginctl enable-linger $USER  （关终端后 timer 存活）');
  process.exit(en.ok ? 0 : 1);
}

// cron 回退（sh -c 仅 POSIX 路径使用）
const line = `*/5 * * * * cd ${REPO} && npm run sync >> ~/.relic-sync.log 2>&1`;
const cur = run('crontab', ['-l']).out;
if (cur.includes('relic sync') || cur.includes('npm run sync')) {
  console.log('[schedule] ✅ crontab 已有 relic sync 条目'); process.exit(0);
}
const next = (cur.trim() + '\n' + line + '\n').replace(/^\n/, '');
const ins = process.platform === 'win32' ? { ok: false, out: 'cron not on win32' } : run('sh', ['-c', `printf '%s' "${next.replace(/"/g, '\"')}" | crontab -`]);
console.log(ins.ok ? '[schedule] ✅ cron 已安装（每 5 分钟）' : '[schedule] crontab 写入失败（权限？）——请手动加：\n  ' + line);
process.exit(ins.ok ? 0 : 1);
