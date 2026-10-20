#!/usr/bin/env node
// =============================================================================
// scripts/console-shortcut.mjs — 安装/移除「relic 控制台」快捷方式
// =============================================================================
// 用法：node scripts/console-shortcut.mjs           安装（幂等）
//       node scripts/console-shortcut.mjs --remove 移除
// 平台：win32 开始菜单+桌面 .cmd；linux 应用菜单+桌面 .desktop；其他跳过。
// =============================================================================
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userHome } from '../src/core/exec.mjs';
import { shortcutFiles } from '../src/core/console-service.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const remove = process.argv.includes('--remove');

const files = shortcutFiles({ home: userHome(), repo: REPO });

if (files.length === 0) {
  console.log('[console-shortcut] 当前平台不创建快捷方式；启动用 `npm run console`');
  process.exit(0);
}

if (remove) {
  let removed = 0;
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    try {
      rmSync(f.path, { force: true });
      removed++;
      console.log(`[console-shortcut] 已移除 ${f.path}`);
    } catch (e) {
      console.log(`[console-shortcut] 移除失败 ${f.path}: ${e.message}`);
    }
  }
  console.log(`[console-shortcut] 完成（移除 ${removed} 个）`);
  process.exit(0);
}

for (const f of files) {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content, 'utf8');
  if (f.mode) {
    try { chmodSync(f.path, f.mode); } catch { /* Windows 无 chmod 语义 */ }
  }
  console.log(`[console-shortcut] 已创建 ${f.path}`);
}
console.log('[console-shortcut] 双击快捷方式即可按需启动控制台');
