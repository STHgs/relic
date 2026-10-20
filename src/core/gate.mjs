// =============================================================================
// src/core/gate.mjs — 通用同步门控（全平台，任一 harness 消费者探测）
// =============================================================================
// 设计（2026-09-22 通用化）：
//   - 门控语义：定时器上下文（无 TTY）下，任一 harness 进程在场才执行 sync；
//     全部不在场 = 无消费者 = 静默跳过（exit 0 + gate 日志一条）。
//   - 手动调用（有 TTY 或 --no-gate）永不门控——用户手动跑必有意图。
//   - 平台探测：posix 用 pgrep -f；win32 用 tasklist /v + findstr（vbs 的 WMI
//     逻辑移植为命令行版；无需 PowerShell，保持零依赖）。
//   - 进程签名表：harness id → 命令行特征（正/反斜杠双写兼容 win 路径）。
//     首版硬编码 + 结构留配置化接口（将来加 harness 进内容库配置）。
// =============================================================================
import { join } from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { run } from './exec.mjs';

/** harness 进程签名表（命令行特征，匹配大小写不敏感） */
const HARNESS_SIGNATURES = {
  dsh: ['@deepseek-ai/dsh', '@deepseek-ai\\dsh', 'dsh serve', 'dsh web'],
  opencode: ['opencode'],
  omo: ['omo.jsonc', 'oh-my-openagent', 'omo serve'],
  codex: ['codex', '.codex'],   // CLI/IDE/Desktop 全线（进程命令行含 codex 或 home 路径）
};

/**
 * 探测一个进程签名是否在场（跨平台）。
 * @param {string} signature
 * @returns {boolean}
 */
export function probeSignature(signature) {
  if (process.platform === 'win32') {
    // tasklist /v 带窗口标题但不带完整命令行（可靠度受限）；
    // wmic process get commandline 是完整版（Win11 起 wmic 逐步退役，
    // 但 schtasks 场景仍普遍可用；失败即视为探测失败→门控放行，保守不误跳）
    const r = run('wmic', ['process', 'get', 'commandline']);
    if (!r.ok) return true;  // 探测失败保守放行（宁可空转不误跳同步）
    return r.stdout.toLowerCase().includes(signature.toLowerCase());
  }
  const r = run('pgrep', ['-f', '-i', signature]);
  return r.ok;  // pgrep 找到=exit 0
}

/**
 * 门控判定：任一 harness 的任一签名在场 → ok:true。
 * @param {{probe?: (sig:string)=>boolean}} [opts] 探测函数注入（测试用）
 * @returns {{ok:boolean, alive:string[], probed:string[], reason:string}}
 */
export function gateCheck(opts = {}) {
  const probe = opts.probe ?? probeSignature;
  const alive = [];
  const probed = [];
  for (const [harness, signatures] of Object.entries(HARNESS_SIGNATURES)) {
    for (const sig of signatures) {
      probed.push(`${harness}:${sig}`);
      if (probe(sig)) alive.push(harness);
    }
  }
  return {
    ok: alive.length > 0,
    alive: [...new Set(alive)],
    probed,
    reason: alive.length > 0
      ? `consumers alive: ${[...new Set(alive)].join(', ')}`
      : 'no harness process alive (no consumer for sync output)',
  };
}

/**
 * gate 日志路径（平台惯例状态目录）。
 * @returns {string}
 */
export function gateLogPath() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');
    return join(local, 'relic', 'sync-gate.log');
  }
  const state = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local', 'state');
  return join(state, 'relic', 'sync-gate.log');
}

/**
 * 追加一条门控判定日志（best effort，失败不阻塞）。
 * @param {{action:'run'|'skip', reason:string, invokedBy?:string}} entry
 */
export function appendGateLog(entry) {
  try {
    const p = gateLogPath();
    mkdirSync(join(p, '..'), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(p, `${ts} action=${entry.action} ${entry.reason}${entry.invokedBy ? ' by=' + entry.invokedBy : ''}\n`);
  } catch { /* 日志失败永不阻塞同步 */ }
}
