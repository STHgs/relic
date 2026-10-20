// =============================================================================
// src/core/exec.mjs — 平台无关命令执行 + HOME 归一化（Windows 适配核心）
// =============================================================================
// 设计（D1/D4）：
//   - run(cmd, args)：数组化命令，消灭字符串拼接与注入面；win32 经 shell 解析
//     npm.cmd 等（POSIX 不用 shell，行为不变）
//   - runChain(steps)：顺序执行 + 短路（替代 'a && b'），失败即停并返回失败步
//   - userHome()：USERPROFILE(win) > HOME > os.homedir() 归一化
//   - headless env：清 askpass、禁终端挂掉（沿 sync 既有加固）
// =============================================================================
import { spawnSync } from 'child_process';
import { homedir } from 'os';

const HEADLESS_ENV = () => ({ ...process.env, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' });

/**
 * 平台无关命令执行。
 * @param {string} cmd   可执行文件（git/npm/node/…）
 * @param {string[]} args 参数数组（禁止字符串拼接命令）
 * @param {object} [opts] spawnSync 透传（cwd/stdio/encoding…）
 * @returns {{ok:boolean, stdout:string, stderr:string, status:number|null}}
 */
export function run(cmd, args, opts = {}) {
  // win32 shell:true 时 args 数组被拼为字符串——引号/空格会被 cmd.exe 吞。
  // 修法：win 上把 cmd+args 拼成一个命令串传给 shell（args 里的引号手动转义）
  const isWin = process.platform === 'win32';
  let finalCmd = cmd;
  let finalArgs = args;
  let useShell = false;
  if (isWin) {
    // 检查是否需要 shell（npm.cmd 等 .cmd 文件需要）
    const needsShell = cmd.endsWith('.cmd') || cmd === 'npm' || cmd === 'npx' || cmd === 'schtasks' || cmd === 'wmic';
    if (needsShell) {
      useShell = true;
      finalCmd = [cmd, ...args.map(a => a.includes(' ') ? `"${a}"` : a)].join(' ');
      finalArgs = [];
    }
    // 不需要 shell 的（node/git）直接 spawn——win 也能找到
  }
  const r = spawnSync(finalCmd, finalArgs, {
    encoding: 'utf8',
    env: HEADLESS_ENV(),
    shell: useShell,
    ...opts,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
  };
}

/**
 * 顺序执行 + 短路（替代 'a && b' 链）。
 * @param {{cmd:string, args:string[], opts?:object}[]} steps
 * @returns {{ok:boolean, failed?:{cmd:string, stderr:string}, last:{stdout:string}}}
 */
export function runChain(steps) {
  let last = { stdout: '' };
  for (const s of steps) {
    last = run(s.cmd, s.args, s.opts || {});
    if (!last.ok) return { ok: false, failed: { cmd: `${s.cmd} ${s.args.join(' ')}`, stderr: last.stderr }, last };
  }
  return { ok: true, last };
}

/**
 * 用户主目录归一化：USERPROFILE（win32 原生）> HOME（WSL/POSIX）> os.homedir()。
 * @returns {string}
 */
export function userHome() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}
