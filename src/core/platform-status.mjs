// =============================================================================
// src/core/platform-status.mjs — 治理状态探测（控制台自愈的只读底座）
// =============================================================================
// 解决的问题：控制台原先只回答"AGENTS.md 是否存在"，无法区分
//   - 未安装该 harness
//   - 已安装但从未部署治理（新装工具、桌面版首次运行）
//   - 已部署但内容过期（sync 未跑、任务被禁用）
//   - 内容库声明了自定义路径但该路径已不存在
//
// 本模块只读、纯逻辑（fs 可注入），供控制台 /api/status 与 `npm run status` 共用。
// 真正的写入动作仍走 pipeline()（见 /api/redeploy），此处不做任何修改。
// =============================================================================

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { platformPaths, readDeclaredPaths } from './paths.mjs';

/** 治理文本的注入哨兵（AGENTS.md 是否真的由 relic 写出） */
export const SENTINEL = 'RELIC IS RUNNING';

/** 平台 id → 展示名（顺序即控制台行序） */
export const PLATFORM_NAMES = {
  dsh: 'DSH',
  opencode: 'OpenCode',
  codex: 'Codex',
};

const AGENTS_FILE = 'AGENTS.md';

/**
 * 单平台状态判定。
 * @param {object} args
 * @param {string} args.id 平台 id
 * @param {string[]} args.candidates 候选目录（声明 > env > 约定）
 * @param {object} args.fsx 注入的 fs 接口
 * @param {object|null} args.renderMap 本次渲染产物（{ id: { 'AGENTS.md': string } }），用于判定内容是否过期
 * @returns {{detected:boolean,target:string|null,governed:boolean,healthy:boolean,stale:boolean}}
 */
function inspectPlatform({ id, candidates, fsx, renderMap }) {
  const exists = fsx.existsSync;
  const detected = candidates.some((p) => exists(p));
  const target = candidates.find((p) => exists(p)) ?? null;
  if (!target) return { detected: false, target: null, governed: false, healthy: false, stale: false };

  const filePath = join(target, AGENTS_FILE);
  const governed = exists(filePath);
  let healthy = false;
  let stale = false;
  if (governed) {
    let current = null;
    try {
      current = fsx.readFileSync(filePath, 'utf8');
      healthy = current.includes(SENTINEL);
    } catch {
      healthy = false;
    }
    // 过期判定 = 与本次渲染产物不一致（而非 mtime：内容未变时 sync 不写盘，
    // mtime 会一直停留在上次真实变更，按时间判会误报）
    const rendered = renderMap?.[id]?.[AGENTS_FILE];
    if (typeof rendered === 'string' && current !== null) {
      stale = current !== rendered;
    }
  }
  return { detected, target, governed, healthy, stale };
}

/**
 * 汇总所有平台的治理状态。
 * @param {object} opts
 * @param {string} opts.home 归一化用户主目录（exec.userHome()）
 * @param {object} [opts.env] 环境变量（缺省 process.env；测试注入干净 env）
 * @param {string} [opts.contentRepo] 内容库根（声明层来源）
 * @param {object} [opts.renderMap] 本次渲染产物（{ id: { 'AGENTS.md': string } }），用于判定过期
 * @param {object} [opts.fsx] fs 注入 { existsSync, readFileSync }
 * @returns {{
 *   platforms: Array<object>,
 *   ungoverned: string[],
 *   stale: string[],
 *   declaredMissing: Array<{id:string,path:string}>,
 *   governedCount: number,
 * }}
 */
export function collectPlatformStatus(opts) {
  if (!opts || !opts.home) throw new Error('collectPlatformStatus: home 必填');
  const fsx = {
    existsSync,
    readFileSync,
    ...(opts.fsx ?? {}),
  };
  const env = opts.env ?? process.env;
  const renderMap = opts.renderMap ?? null;
  const candidatesByPlatform = platformPaths(opts.home, { env, contentRepo: opts.contentRepo });
  const declared = readDeclaredPaths(opts.contentRepo, env);

  const platforms = Object.entries(PLATFORM_NAMES).map(([id, name]) => {
    const candidates = candidatesByPlatform[id] ?? [];
    const state = inspectPlatform({ id, candidates, fsx, renderMap });
    const declaredPath = typeof declared[id] === 'string' && declared[id] ? declared[id] : null;
    const declaredExists = declaredPath ? fsx.existsSync(declaredPath) : null;
    const status = state.governed
      ? (state.stale ? 'stale' : 'governed')
      : (state.detected ? 'ungoverned' : 'absent');
    return {
      id,
      name,
      candidates,
      declaredPath,
      declaredExists,
      ...state,
      status,
    };
  });

  return {
    platforms,
    ungoverned: platforms.filter((p) => p.status === 'ungoverned').map((p) => p.id),
    stale: platforms.filter((p) => p.status === 'stale').map((p) => p.id),
    declaredMissing: platforms
      .filter((p) => p.declaredPath && !p.declaredExists)
      .map((p) => ({ id: p.id, path: p.declaredPath })),
    governedCount: platforms.filter((p) => p.governed).length,
  };
}

/**
 * 把 pipeline() 的扁平部署报告整理成控制台可消费的形状。
 * （orchestrator 报告不含平台归属，因此只做汇总；逐平台状态由 collectPlatformStatus 复采。）
 * @param {{ok?:boolean, report?:{written?:string[],skipped?:string[],errors?:string[]}}} result
 * @returns {{ok:boolean,written:string[],skipped:string[],errors:string[],writtenCount:number}}
 */
export function summarizeDeployReport(result) {
  const rep = result?.report ?? {};
  const written = rep.written ?? [];
  const skipped = rep.skipped ?? [];
  const errors = rep.errors ?? [];
  return {
    ok: Boolean(result?.ok),
    written,
    skipped,
    errors,
    writtenCount: written.length,
  };
}
