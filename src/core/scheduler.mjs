// =============================================================================
// src/core/scheduler.mjs — 宿主调度器统一抽象（四后端一致语义）
// =============================================================================
// 背景：各平台定时器的"安装/停用/状态"原先散在 install-schedule.mjs、
// uninstall-core.deactivate、wizard 的 /api/status 三处，各自只看退出码，
// 导致三类漂移：
//   - 任务被禁用后再部署不会重新启用（Windows 实测事故）
//   - deactivate 只停 systemd，cron 行的 relic 任务继续运行（Linux 回退路径）
//   - macOS launchd 停用不持久（plist 留在 LaunchAgents，下次登录自动加载），
//     且状态探测根本没有 macOS 分支
//
// 本模块把四后端收敛到同一接口：
//   status()  → { backend, installed, enabled, running, detail }
//   install() → 幂等收敛（缺失则创建、执行体漂移则对齐、最后确保 enabled）
//   enable() / disable() → 显式启停
//
// running 语义：能查询运行态的后端给 boolean；cron/launchd/schtasks 无法廉价
// 判定"此刻是否在跑"时给 null（不要假装 true）。
// =============================================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { run as defaultRun, userHome } from './exec.mjs';

export const CRON_MARKER = '# relic-sync';
export const SCHTASKS_TASK = 'relic-sync';
export const LAUNCHD_LABEL = 'dev.relic.sync';

// ─── 纯解析器（可单测） ───────────────────────────────────────────────

/**
 * 解析 `systemctl --user show -p K,V` 的 key=value 输出。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseSystemctlShow(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 解析 schtasks /Query /XML 的关键字段（只取 <Settings> 段内的 Enabled 与电池项）。
 * @param {string} xml
 * @returns {{enabled: boolean|null, disallowStartIfOnBatteries: boolean|null, stopIfGoingOnBatteries: boolean|null}}
 */
export function parseSchtasksXml(xml) {
  const text = String(xml);
  const settingsMatch = /<Settings>([\s\S]*?)<\/Settings>/i.exec(text);
  const settings = settingsMatch ? settingsMatch[1] : text;
  const readBool = (name) => {
    const m = new RegExp(`<${name}>\\s*(true|false)\\s*</${name}>`, 'i').exec(settings);
    return m ? m[1].toLowerCase() === 'true' : null;
  };
  return {
    enabled: readBool('Enabled'),
    disallowStartIfOnBatteries: readBool('DisallowStartIfOnBatteries'),
    stopIfGoingOnBatteries: readBool('StopIfGoingOnBatteries'),
  };
}

/**
 * 从 crontab 文本中筛出 relic 相关行（标记行 + 旧版无标记但指向本 repo 的行）。
 * @param {string} text
 * @param {string} repo
 * @returns {string[]}
 */
export function findCronRelicLines(text, repo) {
  const repoNorm = String(repo).replace(/\\/g, '/').replace(/\/+$/, '');
  return String(text)
    .split('\n')
    .filter((line) => {
      if (!line.trim() || line.trim().startsWith('#')) return false;
      if (line.includes(CRON_MARKER)) return true;
      return line.includes('npm run sync') && line.replace(/\\/g, '/').includes(repoNorm);
    });
}

/**
 * 解析 `launchctl print-disabled gui/<uid>` 中某 label 是否被持久禁用。
 * @param {string} text
 * @param {string} [label]
 * @returns {boolean}
 */
export function parseLaunchctlDisabled(text, label = LAUNCHD_LABEL) {
  const re = new RegExp(`"${label.replace(/\./g, '\\.')}"\\s*=>\\s*(true|disabled)`, 'i');
  return re.test(String(text));
}

// ─── 后端实现 ────────────────────────────────────────────────────────

/**
 * @typedef {object} SchedulerStatus
 * @property {'systemd'|'cron'|'launchd'|'schtasks'} backend
 * @property {boolean} installed
 * @property {boolean} enabled
 * @property {boolean|null} running
 * @property {string} detail
 *
 * @typedef {{ok: boolean, status: SchedulerStatus, notes: string[]}} SchedulerResult
 */

function systemdBackend({ home, repo, runFn, fsx }) {
  const dir = join(home, '.config', 'systemd', 'user');
  const servicePath = join(dir, 'relic-sync.service');
  const timerPath = join(dir, 'relic-sync.timer');
  const serviceUnit = `[Unit]
Description=relic sync (pull --ff-only + generate + skeleton gate)

[Service]
Type=oneshot
WorkingDirectory=${repo}
ExecStart=/usr/bin/env npm run sync
`;
  const timerUnit = `[Unit]
Description=relic sync every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`;
  const ENABLED_STATES = new Set(['enabled', 'enabled-runtime', 'static', 'indirect', 'generated']);

  const status = () => {
    const q = runFn('systemctl', ['--user', 'show', 'relic-sync.timer', '--no-pager', '-p', 'UnitFileState,ActiveState,NextElapseUSecRealtime']);
    const kv = parseSystemctlShow(q.ok ? q.stdout : (q.stdout || ''));
    const installed = q.ok && Boolean(kv.UnitFileState);
    const enabled = installed && ENABLED_STATES.has(kv.UnitFileState);
    return {
      backend: 'systemd',
      installed,
      enabled,
      running: installed ? kv.ActiveState === 'active' : null,
      detail: q.ok
        ? `UnitFileState=${kv.UnitFileState || '?'} ActiveState=${kv.ActiveState || '?'}`
        : `systemctl 不可用：${(q.stderr || q.stdout || '').trim() || 'unknown'}`,
    };
  };

  const ensureUnits = () => {
    fsx.mkdirSync(dir, { recursive: true });
    if (!fsx.existsSync(servicePath) || fsx.readFileSync(servicePath, 'utf8') !== serviceUnit) {
      fsx.writeFileSync(servicePath, serviceUnit);
    }
    if (!fsx.existsSync(timerPath) || fsx.readFileSync(timerPath, 'utf8') !== timerUnit) {
      fsx.writeFileSync(timerPath, timerUnit);
    }
    runFn('systemctl', ['--user', 'daemon-reload']);
  };

  const enable = () => {
    const q = runFn('systemctl', ['--user', 'enable', '--now', 'relic-sync.timer']);
    return { ok: q.ok, status: status(), notes: q.ok ? [] : [((q.stderr || q.stdout) || '').trim()] };
  };

  return {
    id: 'systemd',
    status,
    install() {
      ensureUnits();
      const r = enable();
      return {
        ok: r.status.enabled,
        status: r.status,
        notes: ['建议 sudo loginctl enable-linger $USER（关终端后 timer 存活）', ...r.notes],
      };
    },
    enable,
    disable() {
      const q = runFn('systemctl', ['--user', 'disable', '--now', 'relic-sync.timer']);
      return { ok: q.ok, status: status(), notes: [] };
    },
  };
}

function cronBackend({ repo, runFn }) {
  const line = `*/5 * * * * cd ${repo} && npm run sync >> ~/.relic-sync.log 2>&1 ${CRON_MARKER}`;

  const readCrontab = () => {
    const q = runFn('crontab', ['-l']);
    return { ok: q.ok, text: q.ok ? q.stdout : '' };
  };
  const writeCrontab = (text) => {
    const tmp = join(tmpdir(), `relic-crontab-${process.pid}-${Date.now()}.txt`);
    fsWrite(tmp, text);
    const q = runFn('crontab', [tmp]);
    fsRemove(tmp);
    return q;
  };
  // 小工具走注入的 fsx 之外的最小实现（crontab 只发生在 POSIX）
  const fsWrite = (p, text) => writeFileSync(p, text);
  const fsRemove = (p) => { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } };

  const status = () => {
    const { text } = readCrontab();
    const lines = findCronRelicLines(text, repo);
    return {
      backend: 'cron',
      installed: lines.length > 0,
      enabled: lines.length > 0,
      running: null,
      detail: lines.length > 0 ? lines[0].trim() : 'crontab 无 relic 条目',
    };
  };

  const install = () => {
    const { text } = readCrontab();
    const lines = findCronRelicLines(text, repo);
    if (lines.length === 1 && lines[0] === line) {
      return { ok: true, status: status(), notes: [] };
    }
    const kept = text.split('\n').filter((l) => !lines.includes(l)).join('\n');
    const prefix = kept === '' || kept.endsWith('\n') ? kept : kept + '\n';
    const next = prefix + line + '\n';
    const q = writeCrontab(next);
    return { ok: q.ok, status: status(), notes: q.ok ? [] : [((q.stderr || '') || '').trim()] };
  };

  return {
    id: 'cron',
    status,
    install,
    enable: install,
    disable() {
      const { text } = readCrontab();
      const lines = findCronRelicLines(text, repo);
      if (lines.length === 0) return { ok: true, status: status(), notes: [] };
      const next = text.split('\n').filter((l) => !lines.includes(l)).join('\n');
      const q = writeCrontab(next);
      return { ok: q.ok, status: status(), notes: [] };
    },
  };
}

function launchdBackend({ home, repo, runFn, fsx }) {
  const dir = join(home, 'Library', 'LaunchAgents');
  const plistPath = join(dir, `${LAUNCHD_LABEL}.plist`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const domain = uid === null ? 'gui' : `gui/${uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>WorkingDirectory</key><string>${repo}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${home}/.relic-sync.log</string>
  <key>StandardErrorPath</key><string>${home}/.relic-sync.log</string>
</dict>
</plist>
`;

  const printDisabled = () => {
    const q = runFn('launchctl', ['print-disabled', domain]);
    return q.ok ? parseLaunchctlDisabled(q.stdout) : false;
  };

  const status = () => {
    const installed = fsx.existsSync(plistPath);
    const loaded = installed ? runFn('launchctl', ['print', target]).ok : false;
    const disabled = installed ? printDisabled() : false;
    return {
      backend: 'launchd',
      installed,
      enabled: installed && !disabled,
      running: installed ? loaded : null,
      detail: installed
        ? `plist=${plistPath} loaded=${loaded} disabledFlag=${disabled}`
        : 'plist 不存在',
    };
  };

  const bootstrap = () => {
    const q = runFn('launchctl', ['bootstrap', domain, plistPath]);
    if (q.ok) return q;
    return runFn('launchctl', ['load', '-w', plistPath]);
  };

  const enable = () => {
    runFn('launchctl', ['enable', target]);
    const q = bootstrap();
    return { ok: q.ok, status: status(), notes: q.ok ? [] : [((q.stderr || q.stdout) || '').trim()] };
  };

  return {
    id: 'launchd',
    status,
    install() {
      fsx.mkdirSync(dir, { recursive: true });
      if (!fsx.existsSync(plistPath) || fsx.readFileSync(plistPath, 'utf8') !== plist) {
        fsx.writeFileSync(plistPath, plist);
      }
      runFn('launchctl', ['bootout', target]);
      return enable();
    },
    enable,
    disable() {
      const q = runFn('launchctl', ['bootout', target]);
      runFn('launchctl', ['disable', target]);
      return { ok: true, notes: q.ok ? [] : ['job 未加载（已确保下次登录不自动加载）'], status: status() };
    },
  };
}

function schtasksBackend({ home, repo, runFn, fsx }) {
  const workDir = join(home, 'AppData', 'Local', 'relic');
  const vbsDst = join(workDir, 'sync-silent.vbs');
  const vbsSrc = join(repo, 'scripts', 'sync-silent.vbs');
  const tr = `wscript.exe "${vbsDst}"`;
  const batteryScript = [
    "try {",
    `$t = Get-ScheduledTask -TaskName '${SCHTASKS_TASK}' -ErrorAction Stop;`,
    '$s = $t.Settings;',
    'if ($s.DisallowStartIfOnBatteries -or $s.StopIfGoingOnBatteries) {',
    '$s.DisallowStartIfOnBatteries = $false;',
    '$s.StopIfGoingOnBatteries = $false;',
    '$s.StartWhenAvailable = $true;',
    `Set-ScheduledTask -TaskName '${SCHTASKS_TASK}' -Settings $s | Out-Null`,
    '}',
    '} catch { exit 1 }',
  ].join(' ');

  const query = () => runFn('schtasks', ['/Query', '/TN', SCHTASKS_TASK, '/XML']);

  const status = () => {
    const q = query();
    if (!q.ok) {
      return { backend: 'schtasks', installed: false, enabled: false, running: null, detail: 'schtasks 任务不存在' };
    }
    const parsed = parseSchtasksXml(q.stdout);
    return {
      backend: 'schtasks',
      installed: true,
      enabled: parsed.enabled === true,
      running: null,
      detail: `Enabled=${parsed.enabled} batteryStart=${parsed.disallowStartIfOnBatteries} batteryStop=${parsed.stopIfGoingOnBatteries}`,
    };
  };

  const ensureVbs = () => {
    fsx.mkdirSync(workDir, { recursive: true });
    let body = null;
    try { body = fsx.readFileSync(vbsSrc, 'utf8').replaceAll('__REPO__', repo); } catch { body = null; }
    if (!body) return;
    if (!fsx.existsSync(vbsDst) || fsx.readFileSync(vbsDst, 'utf8') !== body) {
      fsx.writeFileSync(vbsDst, body);
    }
  };

  const fixBattery = () => {
    const parsed = parseSchtasksXml(query().stdout || '');
    if (parsed.disallowStartIfOnBatteries !== true && parsed.stopIfGoingOnBatteries !== true) return false;
    const q = runFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', batteryScript]);
    return q.ok;
  };

  const enable = () => {
    runFn('schtasks', ['/Change', '/TN', SCHTASKS_TASK, '/ENABLE']);
    return { ok: status().enabled, status: status(), notes: [] };
  };

  return {
    id: 'schtasks',
    status,
    install() {
      const notes = [];
      let st = status();
      if (!st.installed) {
        ensureVbs();
        const created = runFn('schtasks', ['/Create', '/TN', SCHTASKS_TASK, '/SC', 'MINUTE', '/MO', '5', '/TR', tr, '/F']);
        if (!created.ok) notes.push(((created.stderr || created.stdout) || '').trim());
      } else {
        if (!query().stdout.includes(vbsDst)) {
          ensureVbs();
          const changed = runFn('schtasks', ['/Change', '/TN', SCHTASKS_TASK, '/TR', tr]);
          if (!changed.ok) notes.push(((changed.stderr || '') || '').trim());
        }
      }
      st = status();
      if (st.installed && !st.enabled) {
        runFn('schtasks', ['/Change', '/TN', SCHTASKS_TASK, '/ENABLE']);
      }
      if (st.installed && fixBattery()) notes.push('已允许电池供电时启动（DisallowStartIfOnBatteries=false）');
      st = status();
      return { ok: st.enabled, status: st, notes };
    },
    enable,
    disable() {
      const q = runFn('schtasks', ['/Change', '/TN', SCHTASKS_TASK, '/DISABLE']);
      return { ok: q.ok, status: status(), notes: [] };
    },
  };
}

// ─── 平台选择 ────────────────────────────────────────────────────────

/**
 * Linux 上判断 systemd user 会话是否可用（不可用则回退 cron）。
 * 判据沿既有实现：`systemctl --user is-system-running` 成功，或输出不是连接失败。
 * @returns {boolean}
 */
function systemdUsable(runFn) {
  const q = runFn('systemctl', ['--user', 'is-system-running']);
  const text = `${q.stdout || ''}${q.stderr || ''}`;
  if (q.ok) return true;
  return !/Failed to connect|No such file or directory|command not found|not found/i.test(text);
}

/**
 * 创建当前平台的调度器后端。
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {string} [opts.home]
 * @param {string} [opts.repo]
 * @param {(cmd:string,args:string[],opts?:object)=>{ok:boolean,stdout?:string,stderr?:string}} [opts.runFn]
 * @param {object} [opts.fsx]  fs 注入（测试用）
 * @returns {{id: string, status: () => SchedulerStatus, install: () => SchedulerResult, enable: () => SchedulerResult, disable: () => SchedulerResult}}
 */
export function createScheduler(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? userHome();
  const repo = opts.repo ?? process.cwd();
  const runFn = opts.runFn ?? defaultRun;
  const fsx = {
    existsSync, mkdirSync, writeFileSync, readFileSync,
    ...(opts.fsx ?? {}),
  };
  const ctx = { home, repo, runFn, fsx };

  if (platform === 'win32') return schtasksBackend(ctx);
  if (platform === 'darwin') return launchdBackend(ctx);
  return systemdUsable(runFn) ? systemdBackend(ctx) : cronBackend(ctx);
}
