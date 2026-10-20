// =============================================================================
// src/core/console-service.mjs — 按需控制台的纯逻辑（可测试，不碰进程）
// =============================================================================
// 设计（方案 B：窗口即进程）：
//   - 控制台不常驻。双击「relic 控制台」或在引擎克隆跑 `npm run console`
//     才启动 wizard 前台进程；关闭窗口=停止控制台。
//   - 单实例：启动前探测 17777–17779 的 /api/version，已在跑则只开浏览器。
//   - 治理与 relic-sync 定时任务独立于控制台，关窗口不影响。
// =============================================================================
import { join } from 'node:path';

/** 控制台端口顺延范围（与 wizard.mjs 的 PORT_START 保持一致） */
export const CONSOLE_PORTS = [17777, 17778, 17779];

/**
 * 探测已在运行的控制台端口。
 * @param {object} [opts]
 * @param {number[]} [opts.ports] 候选端口
 * @param {Function} [opts.fetchImpl] fetch 注入（测试）
 * @param {number} [opts.timeoutMs] 单端口超时
 * @returns {Promise<number|null>} 命中的端口，或 null
 */
export async function probeConsolePort(opts = {}) {
  const { ports = CONSOLE_PORTS, fetchImpl = globalThis.fetch, timeoutMs = 1200 } = opts;
  for (const port of ports) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res && res.ok) return port;
    } catch { /* 该端口无服务，试下一个 */ }
  }
  return null;
}

/** @param {number} port */
export function consoleUrl(port) {
  return `http://localhost:${port}`;
}

/**
 * 生成控制台快捷方式文件规格（纯函数：给定平台/home/repo 返回内容与路径）。
 * - win32：开始菜单 + 桌面各一个 .cmd（CRLF；含 pause 保留报错）
 * - linux：应用菜单 + 桌面 .desktop（Terminal=true）
 * - 其他平台（含 darwin）：不建文件，用 `npm run console`
 * @param {object} opts
 * @param {string} opts.home 用户主目录（userHome()）
 * @param {string} opts.repo 引擎克隆绝对路径
 * @param {string} [opts.platform]
 * @param {string} [opts.appData] win32 APPDATA（缺省 home/AppData/Roaming）
 * @returns {{path: string, content: string, mode?: number}[]}
 */
export function shortcutFiles(opts = {}) {
  const { home, repo, platform = process.platform, appData } = opts;
  if (!home || !repo) throw new Error('shortcutFiles 需要 home 与 repo');

  const files = [];
  const crlf = (s) => s.replace(/\n/g, '\r\n');

  if (platform === 'win32') {
    const roaming = appData || join(home, 'AppData', 'Roaming');
    const startMenu = join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const desktop = join(home, 'Desktop');
    const body = [
      '@echo off',
      'title relic 控制台',
      `cd /d "${repo}"`,
      'node scripts\\console.mjs',
      'echo.',
      'echo relic 控制台已停止。治理与定时同步不受影响；关闭本窗口即可。',
      'pause',
    ].join('\n');
    const content = crlf(body);
    files.push({ path: join(startMenu, 'relic 控制台.cmd'), content });
    files.push({ path: join(desktop, 'relic 控制台.cmd'), content });
  } else if (platform === 'linux') {
    const apps = join(home, '.local', 'share', 'applications');
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=relic 控制台',
      'Comment=按需启动 relic 管理控制台（关闭窗口即停止）',
      `Exec=node "${repo}/scripts/console.mjs"`,
      `Path=${repo}`,
      'Terminal=true',
      'Categories=Development;',
      '',
    ].join('\n');
    const mode = 0o755;
    files.push({ path: join(apps, 'relic-console.desktop'), content, mode });
    files.push({ path: join(home, 'Desktop', 'relic-console.desktop'), content, mode });
  }
  return files;
}
