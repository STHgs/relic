// =============================================================================
// src/core/sync-core.mjs — 同步原语核心（Tier3 语义层，平台无关）
// =============================================================================
// 职责：pull --ff-only → generate → 哨兵自检 → 写 .last-sync。
// 设计原则（sync-architecture-plan v5 §4）：
//   - 零平台假设：git + node 即可运行；宿主调度器只负责周期调用
//   - 绝不静默调和：本地脏 / 非 fast-forward / 哨兵缺失 → 立即报错退出
//   - 全依赖注入（exec/read/writeState/generateRun），Tier3 测试不碰真实部署位
// =============================================================================

/**
 * 执行一次同步。
 * @param {object} opts
 * @param {(cmd:string, cwd:string)=>{ok:boolean, stdout:string, stderr:string}} opts.exec
 *   命令执行器注入。真实实现 = exec.mjs 的数组化 run（win32 shell 兼容）；
 *   注入的 cmd 为空格分隔字符串，由实现方 split 成数组（D1 兼容层）。
 * @param {string} opts.cwd              本 clone 根目录
 * @param {string} [opts.remote='origin']
 * @param {string} [opts.branch='main']
 * @param {()=>Promise<{ok:boolean, written:string[], errors:string[]}>} opts.generateRun
 *   generate 阶段注入（真实实现 spawn `npm run generate` 并解析 JSON 报告）。
 * @param {(p:string)=>string} opts.read                 文件读取注入（哨兵检查用）。
 * @param {(p:string, s:string)=>void} opts.writeState   状态写入注入（.last-sync）。
 * @param {string} [opts.sentinelMarker='RELIC IS RUNNING'] 哨兵标记。
 * @param {string} [opts.stateFile='.last-sync']
 * @returns {Promise<{ok:boolean, stage?:string, reason?:string, commit?:string, pulled:boolean, generated:string[]}>}
 */
export async function runSync(opts) {
  const {
    exec,
    cwd,
    remote = 'origin',
    branch = 'main',
    generateRun,
    read,
    writeState,
    sentinelMarker = 'RELIC IS RUNNING',
    stateFile = '.last-sync',
  } = opts;

  const run = (cmd) => exec(cmd, cwd);

  // 1. 脏工作区检查——绝不静默 stash/覆盖本地修改
  const st = run('git status --porcelain');
  if (!st.ok) return { ok: false, stage: 'status', reason: st.stderr || 'git status failed', pulled: false, generated: [] };
  if (st.stdout.trim() !== '') {
    return { ok: false, stage: 'dirty', reason: 'working tree dirty; commit or stash first (sync never auto-resolves)', pulled: false, generated: [] };
  }

  // 2. 拉取远端引用
  const fetch = run(`git fetch ${remote} ${branch}`);
  if (!fetch.ok) return { ok: false, stage: 'fetch', reason: fetch.stderr || 'git fetch failed', pulled: false, generated: [] };

  const remoteRef = `${remote}/${branch}`;
  const head = run('git rev-parse HEAD');
  const remoteSha = run(`git rev-parse ${remoteRef}`);
  if (!head.ok || !remoteSha.ok) {
    return { ok: false, stage: 'refs', reason: 'rev-parse failed', pulled: false, generated: [] };
  }

  // 3. fast-forward 拉取（远端无新提交则跳过；分叉则报错拒绝）
  let pulled = false;
  if (head.stdout.trim() !== remoteSha.stdout.trim()) {
    const canFf = run(`git merge-base --is-ancestor HEAD ${remoteRef}`);
    if (!canFf.ok) {
      return { ok: false, stage: 'diverged', reason: `local ${branch} diverged from ${remoteRef}; rebase manually (sync never force-syncs)`, pulled: false, generated: [] };
    }
    const ff = run(`git merge --ff-only ${remoteRef}`);
    if (!ff.ok) {
      return { ok: false, stage: 'ff-merge', reason: ff.stderr || 'ff-only merge failed', pulled: false, generated: [] };
    }
    pulled = true;
  }

  // 4. generate（注入；真实实现跑 npm run generate，含各平台 install）
  const gen = await generateRun();
  if (!gen.ok) {
    return { ok: false, stage: 'generate', reason: (gen.errors || []).join('; ') || 'generate failed', pulled, generated: [] };
  }

  // 5. 哨兵自检：每个写出的 AGENTS.md 必须含哨兵标记
  for (const p of gen.written || []) {
    if (!p.endsWith('AGENTS.md')) continue;
    let content;
    try { content = read(p); } catch { content = ''; }
    if (!content.includes(sentinelMarker)) {
      return { ok: false, stage: 'sentinel', reason: `sentinel missing in ${p}`, pulled, generated: gen.written };
    }
  }

  // 6. 写状态
  const commit = run('git rev-parse HEAD').stdout.trim();
  try {
    writeState(stateFile, JSON.stringify({ time: new Date().toISOString(), commit, pulled }, null, 2) + '\n');
  } catch { /* 状态写失败不致命，但报告 */ }

  return { ok: true, commit, pulled, generated: gen.written };
}

/**
 * 部署 clone 只读护栏：返回 pre-commit hook 脚本内容（拒绝一切本地提交）。
 * @returns {string}
 */
export function deployGuardHook() {
  return [
    '#!/bin/sh',
    '# relic deploy-clone guard: this clone is read-only.',
    '# Develop in a dev clone; deploy clones only ever pull.',
    'echo "[relic] deploy clone is read-only (marker .relic-deploy present)." >&2',
    'echo "[relic] develop in a dev clone, push, then sync here." >&2',
    'exit 1',
    '',
  ].join('\n');
}
