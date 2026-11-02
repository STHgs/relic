// =============================================================================
// src/core/sandbox-access.mjs — 沙箱主体只读授权（Windows + Codex）
// =============================================================================
// 背景（2026-11-02）：Codex 在 Windows 上用独立受限令牌 + 本地组 CodexSandboxUsers
//   运行沙箱命令，工作区外路径默认读不到 → 沙箱里的 Codex 读不了 relic 规则正文
//   （AGENTS.md 索引指向 <contentRepo>/modules/*.yaml）与习惯库。
//
// 语义（用户拍板）：
//   · 只处理 Windows + Codex；其他平台/其他 harness 明确 no-op（Linux/mac 读不受限，
//     DSH 是 WRITE_RESTRICTED——只拦写不拦读）。
//   · 只授【只读】ACE（RX），只对指定目录，只加不删，不改所有权。
//   · 授权前必须由人确认（--apply / 控制台按钮）；探测（check）永远只读。
// =============================================================================

import { existsSync } from 'fs';

export const CODEX_PRINCIPAL = 'CodexSandboxUsers';
export const ACE_SUFFIX = '(OI)(CI)(RX)';

/** 授权边界说明（CLI 与控制台共用原文）。 */
export function boundaryText(principal = CODEX_PRINCIPAL) {
  return [
    `· 只授予 1 个本地组（${principal}）、只对下列目录及其子项、只读 + 遍历 (RX)`,
    '· 不加写权限、不改所有权、不动其他目录、不删除既有 ACE',
    '· 效果：Codex 沙箱内的进程可读这些文件，仍不能修改；其他进程权限不变',
    '· 撤销：icacls "<目录>" /remove:g "' + principal + '"',
  ].join('\n');
}

/** 授权必要性说明（为什么要它）。 */
export function necessityText() {
  return [
    'Codex 在 Windows 上以独立沙箱主体（本地组 CodexSandboxUsers）运行命令，',
    '工作区外的路径默认读不到 —— 沙箱内的 Codex 会读不到 relic 规则/流程正文',
    '（AGENTS.md 索引指向内容库 modules/*.yaml）与习惯库 learned.yaml。',
    '本步骤只补只读访问；relic 从不要求沙箱拥有任何写权限。',
  ].join('\n');
}

const norm = (p) => p.replace(/\\/g, '/');

/**
 * 探测当前平台是否需要/是否已完成沙箱只读授权。只读，不修改任何状态。
 * @param {object} opts
 * @param {string} [opts.platform] 覆盖 process.platform（测试用）
 * @param {string[]} opts.dirs 需要可读的目录（内容库、习惯库目录）
 * @param {(cmd:string, args:string[])=>{ok:boolean,stdout:string,stderr:string}} opts.exec
 * @param {(p:string)=>boolean} [opts.existsSync]
 * @returns {{applicable:boolean, platform:string, reason:string, principal:string,
 *            groupExists:boolean, dirs:{path:string,exists:boolean,granted:boolean,command:string}[],
 *            needsGrant:boolean, necessity:string, boundary:string, revoke:string[]}}
 */
export function planSandboxAccess(opts) {
  const platform = opts.platform || process.platform;
  const exec = opts.exec;
  const exists = opts.existsSync || existsSync;
  const principal = opts.principal || CODEX_PRINCIPAL;
  const dirs = (opts.dirs || []).filter(Boolean);
  const base = {
    platform,
    principal,
    necessity: necessityText(),
    boundary: boundaryText(principal),
    revoke: dirs.map((d) => `icacls "${norm(d)}" /remove:g "${principal}"`),
  };

  if (platform !== 'win32') {
    return {
      ...base,
      applicable: false,
      reason: '非 Windows：Linux/mac 的沙箱（bwrap/seatbelt）不限制读取，无需授权',
      groupExists: false,
      dirs: [],
      needsGrant: false,
    };
  }

  const group = exec('net', ['localgroup', principal]);
  const groupExists = group.ok;
  const dirReports = dirs.map((d) => {
    const exists_ = exists(d);
    let granted = false;
    if (exists_) {
      const acl = exec('icacls', [norm(d)]);
      granted = acl.ok && new RegExp(principal, 'i').test(acl.stdout);
    }
    return { path: norm(d), exists: exists_, granted, command: `icacls "${norm(d)}" /grant "${principal}:${ACE_SUFFIX}"` };
  });
  const needsGrant = groupExists && dirReports.some((d) => d.exists && !d.granted);

  let reason;
  if (!groupExists) reason = `本地组 ${principal} 不存在（该机未启用过 Codex 沙箱）——无需授权`;
  else if (needsGrant) reason = 'Codex 沙箱主体缺少对 relic 数据目录的只读访问';
  else if (dirReports.every((d) => !d.exists)) reason = '目标目录都还不存在——等首次部署/首次学习后再检查';
  else reason = '已授权（全部目录可读）';

  return { ...base, applicable: true, reason, groupExists, dirs: dirReports, needsGrant };
}

/**
 * 执行授权（幂等：已授权的目录不再改）。调用方必须先征得用户同意。
 * @param {object} opts
 * @param {string} [opts.platform]
 * @param {string[]} opts.dirs
 * @param {(cmd:string, args:string[])=>{ok:boolean,stdout:string,stderr:string}} opts.exec
 * @param {(p:string)=>boolean} [opts.existsSync]
 * @param {boolean} [opts.dryRun] 只返回命令不执行
 * @returns {{ok:boolean, dryRun:boolean, applied:{path:string,command:string,ok:boolean,stderr:string}[],
 *            skipped:{path:string,reason:string}[], verify:{path:string,granted:boolean}[]}}
 */
export function applySandboxAccess(opts) {
  const platform = opts.platform || process.platform;
  const exec = opts.exec;
  const dryRun = opts.dryRun === true;
  const plan = planSandboxAccess(opts);
  const applied = [];
  const skipped = [];

  if (!plan.applicable) {
    return { ok: true, dryRun, applied, skipped: [{ path: '-', reason: plan.reason }], verify: [] };
  }
  if (!plan.groupExists) {
    return { ok: true, dryRun, applied, skipped: [{ path: '-', reason: plan.reason }], verify: [] };
  }

  for (const d of plan.dirs) {
    if (!d.exists) { skipped.push({ path: d.path, reason: '目录不存在' }); continue; }
    if (d.granted) { skipped.push({ path: d.path, reason: '已授权' }); continue; }
    if (dryRun) { applied.push({ path: d.path, command: d.command, ok: true, stderr: '' }); continue; }
    const r = exec('icacls', [d.path, '/grant', `${plan.principal}:${ACE_SUFFIX}`]);
    applied.push({ path: d.path, command: d.command, ok: r.ok, stderr: (r.stderr || '').trim().slice(0, 300) });
  }

  const verify = dryRun ? [] : plan.dirs
    .filter((d) => d.exists)
    .map((d) => {
      const acl = exec('icacls', [d.path]);
      return { path: d.path, granted: acl.ok && new RegExp(plan.principal, 'i').test(acl.stdout) };
    });

  const ok = applied.every((a) => a.ok) && verify.every((v) => v.granted);
  return { ok, dryRun, applied, skipped, verify, plan };
}
