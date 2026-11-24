// =============================================================================
// tests/renderer-purity.test.mjs — 渲染器纯度契约（Hermeticity contract，2026-10-09）
// =============================================================================
// 事故背景：habits-v2 曾让渲染器直接读本机习惯库（~/.config/relic-habits/learned.yaml），
//   于是 golden 基线随"bump 那台机器"的状态漂移：换台机器门禁必然 FAIL（CI 红）、
//   同步在 generate 前被硬拦截。本文件是这条不变量的守护测试（防复发）。
//
// H1 行为证：本机库在磁盘上存在与否/内容如何，都不得影响同一 policies 的渲染产物
// H2 源码证：渲染器不得触碰 fs / 时钟 / 环境变量（机器输入一律经 policies.meta 显式注入）
// H3 分支证：探针必须撑满条件段（偏好表 + ⭐ 固化段 + 易变区标记），否则结构永不进 golden
// H4 注入证：视图显式传入时，数据与易变区标记/溯源正确渲染（功能未被砍掉）
// =============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentsMd } from '../src/render/agents-md.mjs';
import { loadProfile } from '../src/core/module-loader.mjs';
import { buildProbePolicies, PROBE_MARK } from '../src/core/skeleton.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lp = loadProfile({ manifestPath: resolve(REPO, 'template', 'policies.yaml') });
const policies = lp.policies;

/** 造一个隔离 HOME；withStore=true 时写入一条内容醒目的本机习惯。 */
function fakeHome(withStore) {
  const home = mkdtempSync(join(tmpdir(), 'relic-purity-'));
  if (withStore) {
    const dir = join(home, '.config', 'relic-habits');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'learned.yaml'),
      'entries:\n  - type: style\n    observation: 极大影响的偏好甲\n    evidence: e\n    recorded: 2026-01-01\n    hits: 9\n    lastHit: 2026-10-01\n');
  }
  return home;
}

describe('H1: render output is independent of on-disk machine state', () => {
  it('same policies render byte-identically with and without a local habits store', () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = fakeHome(true);
      delete process.env.USERPROFILE;
      const withStore = renderAgentsMd(policies);
      process.env.HOME = fakeHome(false);
      const withoutStore = renderAgentsMd(policies);
      assert.equal(withStore, withoutStore, 'renderer must not read machine-local state (purity invariant)');
      assert.ok(!withStore.includes('极大影响的偏好甲'), 'store content must never leak into a bare render');
    } finally {
      process.env.HOME = prevHome;
      if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
    }
  });
});

describe('H2: renderer source touches no fs / clock / env', () => {
  it('no fs, clock, env access or habits-store import in the renderer module', () => {
    const src = readFileSync(resolve(REPO, 'src/render/agents-md.mjs'), 'utf8');
    const forbidden = ['readFileSync', 'existsSync', 'writeFileSync', 'mkdirSync', 'new Date', 'process.env', 'core/habits.mjs'];
    for (const token of forbidden) {
      assert.ok(!src.includes(token), `renderer must not reference ${token}`);
    }
  });
});

describe('H3: probe covers every conditional section (else golden cannot lock it)', () => {
  const probeRender = renderAgentsMd(buildProbePolicies());
  it('top-preferences table is exercised', () => {
    assert.ok(probeRender.includes('| 偏好 | 依据 | 命中 |'));
    assert.ok(probeRender.includes(`| ${PROBE_MARK} |`));
  });
  it('solidify section is exercised', () => {
    assert.ok(probeRender.includes('### ⭐ 固化申请指令'));
  });
  it('both volatile markers are exercised, with probe placeholders (markers are data, not skeleton)', () => {
    assert.ok(probeRender.includes(`<!-- BEGIN RELIC-VOLATILE:habits-top store=${PROBE_MARK} date=${PROBE_MARK} -->`));
    assert.ok(probeRender.includes('<!-- END RELIC-VOLATILE:habits-top -->'));
    assert.ok(probeRender.includes(`<!-- BEGIN RELIC-VOLATILE:habits-solidify store=${PROBE_MARK} date=${PROBE_MARK} -->`));
    assert.ok(probeRender.includes('<!-- END RELIC-VOLATILE:habits-solidify -->'));
  });
});

describe('H4: explicit view injection still delivers the feature (not removed)', () => {
  const view = {
    date: '2026-10-09',
    digest: 'abcd1234',
    top: [{ observation: '偏好甲', evidence: '依据甲', hits: 2 }, { observation: '偏好乙', evidence: '依据乙', hits: 1 }],
    solidify: [{ observation: '偏好甲', evidence: '依据甲', hits: 3 }],
  };
  const md = renderAgentsMd({ ...policies, meta: { ...policies.meta, habits: view } });
  it('renders the top table rows from the injected view', () => {
    assert.match(md, /\| 偏好甲 \| 依据甲 \| 2 \|/);
    assert.match(md, /\| 偏好乙 \| 依据乙 \| 1 \|/);
  });
  it('renders the solidify request from the injected view', () => {
    assert.match(md, /固化申请指令/);
    assert.match(md, /已命中 3 次/);
  });
  it('carries provenance (store digest + date) in the volatile markers', () => {
    assert.match(md, /<!-- BEGIN RELIC-VOLATILE:habits-top store=abcd1234 date=2026-10-09 -->/);
    assert.match(md, /<!-- BEGIN RELIC-VOLATILE:habits-solidify store=abcd1234 date=2026-10-09 -->/);
  });
  it('with no view: headers stay, but no volatile content/markers (portable artifact)', () => {
    const bare = renderAgentsMd(policies);
    assert.ok(bare.includes('## 学习与适应（v2：分层记忆）'));
    assert.ok(!bare.includes('RELIC-VOLATILE'));
    assert.ok(!bare.includes('| 偏好 | 依据 | 命中 |'));
  });
});
