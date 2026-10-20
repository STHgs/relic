// =============================================================================
// src/core/paths.mjs — harness 位置四层解析链（自定义安装支持，2026-09-23）
// =============================================================================
// 业界共识发现链（调研 DSH/OpenCode/Claude Code/chezmoi/XDG 后定稿）：
//   第 1 层 显式声明：内容库 harness-paths.json（用户亲口说，绝对可靠，跨机同步）
//   第 2 层 标准环境变量：各 harness 官方 env（DSH_HOME/OPENCODE_CONFIG）
//                       + XDG_CONFIG_HOME（Linux 标准配置根，~/.config 仅为默认）
//   第 3 层 harness settings 反推（待实施，列于 AGENTS.md 候选队列）
//   第 4 层 约定路径兜底（默认安装用户零感知）
// 调用方签名不变：输入 home，输出候选路径数组（按优先序，detect 逐个探测）。
// =============================================================================

import { existsSync, readFileSync } from 'fs';
import { join, dirname, posix } from 'path';
import { userHome } from './exec.mjs';

/**
 * 读内容库的 harness-paths.json（第 1 层显式声明）。
 * @param {string} [contentRepo] 内容库根；缺省走发现链约定路径
 * @returns {object} { [harnessId]: path }（文件缺失/损坏返回 {}，永不抛）
 */
function readDeclaredPaths(contentRepo, optsEnv = process.env) {
  try {
    const repo = contentRepo
      || (optsEnv.RELIC_CONTENT_REPO)
      || (() => {
        // 引擎侧 relic.config.json 的 contentRepo（同 sync 发现链，只读不引依赖）
        for (const cfg of [join(process.cwd(), 'relic.config.json')]) {
          if (existsSync(cfg)) {
            try { return JSON.parse(readFileSync(cfg, 'utf8')).contentRepo; } catch { /* fallthrough */ }
          }
        }
        return join(userHome(), '.config', 'relic-sync');
      })();
    const p = join(repo, 'harness-paths.json');
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/**
 * XDG 标准配置根：$XDG_CONFIG_HOME 或 ~/.config（spec 规范；仅绝对路径合法）。
 * @param {string} home
 * @returns {string}
 */
function xdgConfigHome(home, env = process.env) {
  const x = env.XDG_CONFIG_HOME;
  return x && x.startsWith('/') ? x : posix.join(String(home).replace(/\\/g, '/'), '.config');
}

/**
 * 各适配器在指定 home 下的候选目录（按优先序：声明 > env > 约定）。
 * @param {string} home  归一化用户主目录（exec.userHome()）
 * @param {object} [opts]
 * @param {string} [opts.contentRepo]  内容库根（声明层读取；测试注入用）
 * @returns {{ opencode: string[], dsh: string[], omo: string[], codex: string[] }}
 */
export function platformPaths(home, opts = {}) {
  // env 注入面：测试/调用方可传干净 env（环境无关原则）；缺省读 process.env
  const env = opts.env ?? process.env;
  const declared = readDeclaredPaths(opts.contentRepo, env);   // 第 1 层
  const xdg = xdgConfigHome(home, env);                   // 第 2 层（XDG 标准件）

  // Unified path construction with path.join (cross-platform separator)
  const isWin = process.platform === 'win32';
  const h = String(home).replace(/\\/g, '/');  // 正斜杠归一（Node fs 在 win 上兼容 /）
  const pj = posix.join;  // 始终正斜杠——双端行为一致

  const dsh = [
    ...(declared.dsh ? [declared.dsh] : []),
    ...(env.DSH_HOME ? [env.DSH_HOME] : []),
    pj(h, '.dsh'),
  ];
  const omo = [
    ...(declared.omo ? [declared.omo] : []),
    ...(env.OMO_HOME ? [env.OMO_HOME] : []),
    pj(h, '.omo'),
  ];
  const codex = [
    ...(declared.codex ? [declared.codex] : []),
    ...(env.CODEX_HOME ? [env.CODEX_HOME] : []),
    pj(h, '.codex'),
  ];
  const opencode = isWin
    ? [
        ...(declared.opencode ? [declared.opencode] : []),
        ...(env.OPENCODE_CONFIG ? [posix.dirname(env.OPENCODE_CONFIG)] : []),
        pj(h, 'AppData', 'Roaming', 'opencode'),
        pj(h, '.config', 'opencode'),
      ]
    : [
        ...(declared.opencode ? [declared.opencode] : []),
        ...(env.OPENCODE_CONFIG ? [posix.dirname(env.OPENCODE_CONFIG)] : []),
        pj(xdg, 'opencode'),
      ];

  return { dsh, opencode, omo, codex };
}

/**
 * 在候选路径中找到第一个存在的目录；全不存在返回 null。
 * @param {string[]} candidates
 * @param {(p:string)=>boolean} exists
 * @returns {string|null}
 */
export function firstExisting(candidates, exists) {
  for (const c of candidates) if (exists(c)) return c;
  return null;
}
