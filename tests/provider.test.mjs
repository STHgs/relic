// =============================================================================
// tests/provider.test.mjs — 托管平台抽象（gitee 默认 / github 可选）
// =============================================================================
// PR1: getProvider 元数据 + 未知 provider 报错
// PR2: giteeCreateRepo 三态（成功/401 令牌无效/400 已存在）
// PR3: giteeWhoami（有效令牌取 login / 401 报 reason）
// PR4: giteeRepoExists（200=存在 / 404=不存在）
// PR5: tokenGuidance（gitee 有 / github null）
// PR6: repoUrl 两个平台的构造
// 全部 mock fetchImpl——零网络依赖（测试权威性原则）
// =============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, tokenGuidance, giteeCreateRepo, giteeWhoami, giteeRepoExists } from '../src/core/provider.mjs';

const mockFetch = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, body });

describe('PR1: getProvider metadata', () => {
  it('gitee is default', () => {
    const p = getProvider();
    assert.equal(p.id, 'gitee');
    assert.equal(p.host, 'gitee.com');
  });
  it('github optional', () => {
    const p = getProvider('github');
    assert.equal(p.host, 'github.com');
  });
  it('unknown provider throws', () => {
    assert.throws(() => getProvider('gitlab'), /unknown provider/);
  });
});

describe('PR2: giteeCreateRepo three states', () => {
  it('201/200 success returns fullName', async () => {
    const r = await giteeCreateRepo({ name: 'x', token: 't', fetchImpl: mockFetch(201, { full_name: 'u/x' }) });
    assert.equal(r.ok, true);
    assert.equal(r.fullName, 'u/x');
  });
  it('401 -> token invalid reason', async () => {
    const r = await giteeCreateRepo({ name: 'x', token: 'bad', fetchImpl: mockFetch(401, {}) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /令牌无效/);
  });
  it('400 -> exists/invalid reason', async () => {
    const r = await giteeCreateRepo({ name: 'exists', token: 't', fetchImpl: mockFetch(400, {}) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /已存在|不合法/);
  });
});

describe('PR3: giteeWhoami', () => {
  it('valid token returns login', async () => {
    const r = await giteeWhoami({ token: 't', fetchImpl: mockFetch(200, { login: 'alice' }) });
    assert.equal(r.ok, true);
    assert.equal(r.login, 'alice');
  });
  it('401 -> reason', async () => {
    const r = await giteeWhoami({ token: 'bad', fetchImpl: mockFetch(401, {}) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /令牌无效/);
  });
});

describe('PR4: giteeRepoExists', () => {
  it('200 -> exists', async () => {
    const r = await giteeRepoExists({ user: 'u', name: 'x', token: 't', fetchImpl: mockFetch(200, {}) });
    assert.equal(r.exists, true);
  });
  it('404 -> not exists', async () => {
    const r = await giteeRepoExists({ user: 'u', name: 'none', token: 't', fetchImpl: mockFetch(404, {}) });
    assert.equal(r.exists, false);
  });
});

describe('PR5: tokenGuidance', () => {
  it('gitee has guidance with token page', () => {
    const g = tokenGuidance('gitee');
    assert.match(g, /personal_access_tokens/);
    assert.match(g, /projects/);
  });
  it('github -> null (gh CLI takes over)', () => {
    assert.equal(tokenGuidance('github'), null);
  });
});

describe('PR6: repoUrl construction', () => {
  it('gitee url', () => {
    assert.equal(getProvider('gitee').repoUrl('alice', 'relic-sync'), 'https://gitee.com/alice/relic-sync.git');
  });
  it('github url', () => {
    assert.equal(getProvider('github').repoUrl('alice', 'relic-sync'), 'https://github.com/alice/relic-sync.git');
  });
});
