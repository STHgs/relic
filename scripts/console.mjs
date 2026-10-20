#!/usr/bin/env node
// =============================================================================
// scripts/console.mjs — 按需启动 relic 控制台（单实例，窗口即进程）
// =============================================================================
// 用法：npm run console   （或双击「relic 控制台」快捷方式）
//   已在运行 → 只打开浏览器，退出
//   未运行   → 前台启动 wizard.mjs；关闭本窗口 = 停止控制台
// 治理与 relic-sync 定时任务独立运行，关窗口不影响。
// =============================================================================
import { spawn, exec } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeConsolePort, consoleUrl } from '../src/core/console-service.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 用系统默认浏览器打开 URL（失败静默） */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch { /* 无 GUI 环境忽略 */ }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = await probeConsolePort();
  if (port) {
    console.log(`[console] 控制台已在运行 → ${consoleUrl(port)}（仅打开浏览器）`);
    openBrowser(consoleUrl(port));
    process.exit(0);
  }
  console.log('[console] 启动控制台（关闭本窗口即停止；治理与定时同步不受影响）');
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'wizard.mjs')], {
    cwd: REPO,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
