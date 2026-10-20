// =============================================================================
// src/core/provider.mjs — 托管平台抽象（gitee 默认 / github 可选）
// =============================================================================
// 设计（2026-09-29 用户拍板：新用户默认 gitee，增强大陆可达性）：
//   - provider 收敛全部平台差异：建库 API / 仓库 URL / 存在性检查 / 认证引导
//   - gitee（默认）：API v5（POST /api/v5/user/repos），access_token 认证，
//     令牌生成页 https://gitee.com/profile/personal_access_tokens（勾选 projects）
//   - github：沿用 gh CLI（既有实现平移，--provider github 时用）
//   - HTTP 全部注入（fetchImpl）——单测 mock，不碰真网
// =============================================================================

/** 各 provider 的静态描述（引导文案 + URL 构造） */
const PROVIDERS = {
  gitee: {
    id: 'gitee',
    host: 'gitee.com',
    tokenPage: 'https://gitee.com/profile/personal_access_tokens',
    tokenScopeHint: '勾选 projects 权限',
    repoUrl: (user, name) => `https://gitee.com/${user}/${name}.git`,
    apiUrl: (path) => `https://gitee.com/api/v5${path}`,
    helpHint: 'gitee.com → 设置 → 安全设置 → 私人令牌',
  },
  github: {
    id: 'github',
    host: 'github.com',
    // github 走 gh CLI 设备码流，无独立令牌引导
    tokenPage: null,
    tokenScopeHint: null,
    repoUrl: (user, name) => `https://github.com/${user}/${name}.git`,
    apiUrl: (path) => `https://api.github.com${path}`,
    helpHint: 'gh CLI (https://cli.github.com)',
  },
};

/**
 * 取 provider 元数据。
 * @param {'gitee'|'github'} [id='gitee']
 * @returns {object}
 */
export function getProvider(id = 'gitee') {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${id} (available: gitee, github)`);
  return p;
}

/**
 * Gitee 建库（POST /user/repos）。
 * @param {object} p
 * @param {string} p.name        仓库名
 * @param {string} p.token       私人令牌（projects 权限）
 * @param {(url:string, init:object)=>Promise<{ok:boolean, status:number, body:object}>} [p.fetchImpl]
 *        HTTP 注入（测试 mock）；缺省用全局 fetch。
 * @returns {Promise<{ok:boolean, status:number, reason?:string, fullName?:string}>}
 */
export async function giteeCreateRepo({ name, token, fetchImpl }) {
  const doFetch = fetchImpl ?? ((u, i) => fetch(u, i).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) })));
  const r = await doFetch('https://gitee.com/api/v5/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  if (r.ok) {
    return { ok: true, status: r.status, fullName: r.body?.full_name || '' };
  }
  const map = {
    400: '请求参数错误（仓库已存在或不合法）',
    401: '令牌无效或未勾选 projects 权限',
    403: '令牌权限不足',
  };
  return { ok: false, status: r.status, reason: map[r.status] || r.body?.message || `HTTP ${r.status}` };
}

/**
 * Gitee 查当前用户（GET /user）——令牌有效性 + 取用户名。
 * @param {object} p
 * @param {string} p.token
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{ok:boolean, login?:string, reason?:string}>}
 */
export async function giteeWhoami({ token, fetchImpl }) {
  const doFetch = fetchImpl ?? ((u) => fetch(u).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) })));
  const r = await doFetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
  if (r.ok && r.body?.login) return { ok: true, login: r.body.login };
  return { ok: false, reason: r.status === 401 ? '令牌无效' : `HTTP ${r.status}` };
}

/**
 * Gitee 查仓库存在性（GET /repos/{user}/{repo}）。
 * @param {object} p
 * @param {string} p.user
 * @param {string} p.name
 * @param {string} p.token
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<{exists:boolean}>}
 */
export async function giteeRepoExists({ user, name, token, fetchImpl }) {
  const doFetch = fetchImpl ?? ((u) => fetch(u).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) })));
  const r = await doFetch(`https://gitee.com/api/v5/repos/${user}/${name}?access_token=${encodeURIComponent(token)}`);
  return { exists: r.ok && r.status === 200 };
}

/**
 * 令牌引导提示（gitee 专用；github 返回 null——gh CLI 自己接管）。
 * @param {'gitee'|'github'} [id='gitee']
 * @returns {string|null}
 */
export function tokenGuidance(id = 'gitee') {
  const p = getProvider(id);
  if (!p.tokenPage) return null;
  return [
    `请到 ${p.tokenPage} 生成私人令牌：`,
    `  ${p.tokenScopeHint} → 生成后立即复制（只显示一次）`,
    `  然后：git credential approve（首次 push 时粘贴亦可）`,
  ].join('\n');
}
