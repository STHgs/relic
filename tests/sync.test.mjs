// =============================================================================
// tests/sync.test.mjs — Tier3 同步语义（scratch 仓库，零平台依赖）
// =============================================================================
// S1: 远端前进 → ff 拉取 + generate + .last-sync 带新 commit
// S2: 本地脏 → 拒绝，generate 不被调用
// S3: 本地分叉（本地领先且有分叉提交）→ 拒绝 force 同步
// S4: 写出的 AGENTS.md 缺哨兵 → 失败于 sentinel 阶段
// S5: 远端无新提交 → pulled=false，generate 仍执行（幂等刷新产物）
// =============================================================================
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { runSync, deployGuardHook } from '../src/core/sync-core.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relic-sync-test-'));
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const exec = (cmd, cwd) => {
  try { return { ok: true, stdout: sh(cmd, cwd), stderr: '' }; }
  catch (e) { return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message }; }
};

let origin, clone1;
mkdirSync(join(scratch, 'out'), { recursive: true });
const outPath = join(scratch, 'out', 'AGENTS.md');
const fakeSentinelMd = (p) => { writeFileSync(p, '# AGENTS.md\nRELIC IS RUNNING @ test\n'); return p; };

before(() => {
  origin = join(scratch, 'origin.git');
  sh(`git init --bare -b main ${origin}`, scratch);
  const seed = join(scratch, 'seed');
  mkdirSync(seed);
  sh('git init -b main .', seed);
  sh('git config user.email t@t', seed); sh('git config user.name t', seed);
  writeFileSync(join(seed, 'README.md'), 'v1\n');
  sh('git add -A', seed); sh('git commit -m v1', seed);
  sh(`git remote add origin ${origin}`, seed); sh(`git push -q origin main`, seed);
  clone1 = join(scratch, 'clone1');
  sh(`git clone -q ${origin} ${clone1}`, scratch);
  sh('git config user.email t@t', clone1); sh('git config user.name t', clone1);
});

after(() => { rmSync(scratch, { recursive: true, force: true }); });

// 产物与状态一律写到 clone 之外（clone 内未跟踪文件会被脏检查拦截）
const outDir = join(scratch, 'out');
const makeSync = (clone, generateImpl, readImpl) => ({
  exec,
  cwd: clone,
  generateRun: generateImpl,
  read: readImpl || ((p) => readFileSync(p, 'utf8')),
  writeState: (p, s) => writeFileSync(join(outDir, p), s),
});

describe('S1: remote advanced -> ff pull + generate + state', () => {
  it('pulls, regenerates, records new commit', async () => {
    const seed = join(scratch, 'seed');
    writeFileSync(join(seed, 'README.md'), 'v2\n');
    sh('git add -A && git commit -m v2 && git push -q origin main', seed);
    let generated = 0;
    const r = await runSync(makeSync(clone1, async () => { generated += 1; fakeSentinelMd(outPath); return { ok: true, written: [outPath], errors: [] }; }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.pulled, true);
    assert.equal(generated, 1);
    const state = JSON.parse(readFileSync(join(outDir, '.last-sync'), 'utf8'));
    assert.match(state.commit, /^[0-9a-f]{40}$/);
    assert.equal(state.pulled, true);
  });
});

describe('S2: dirty working tree -> refuse, no generate', () => {
  it('aborts at dirty stage without calling generate', async () => {
    writeFileSync(join(clone1, 'uncommitted.txt'), 'dirt');
    let generated = 0;
    const r = await runSync(makeSync(clone1, async () => { generated += 1; return { ok: true, written: [], errors: [] }; }));
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'dirty');
    assert.equal(generated, 0);
    rmSync(join(clone1, 'uncommitted.txt'), { force: true });
  });
});

describe('S3: diverged local -> refuse force-sync', () => {
  it('aborts at diverged stage', async () => {
    // 本地造一个远端没有的提交，再让远端前进 → 分叉
    writeFileSync(join(clone1, 'local-only.txt'), 'x');
    sh('git add -A', clone1); sh('git commit -m local-divergence', clone1);
    const seed = join(scratch, 'seed');
    writeFileSync(join(seed, 'README.md'), 'v3\n');
    sh('git add -A', seed); sh('git commit -m v3', seed); sh('git push -q origin main', seed);
    const r = await runSync(makeSync(clone1, async () => ({ ok: true, written: [], errors: [] })));
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'diverged');
    // 复原：回到远端顶端，供后续用例
    sh('git reset --hard origin/main', clone1);
  });
});

describe('S4: sentinel missing in written AGENTS.md -> fail', () => {
  it('aborts at sentinel stage', async () => {
    const badPath = join(outDir, 'AGENTS.md');
    writeFileSync(badPath, '# AGENTS.md without sentinel\n');
    const r = await runSync(makeSync(clone1, async () => ({ ok: true, written: [badPath], errors: [] })));
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sentinel');
  });
});

describe('S5: already current -> pulled=false, still generates', () => {
  it('idempotent refresh', async () => {
    sh('git reset --hard origin/main', clone1);
    sh(`git fetch -q ${origin} main`, clone1);
    let generated = 0;
    const r = await runSync(makeSync(clone1, async () => { generated += 1; fakeSentinelMd(outPath); return { ok: true, written: [outPath], errors: [] }; }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.pulled, false);
    assert.equal(generated, 1);
  });
});

describe('S6: deploy guard hook content', () => {
  it('rejects commits with explanatory message', () => {
    const hook = deployGuardHook();
    assert.match(hook, /deploy clone is read-only/);
    assert.match(hook, /exit 1/);
  });
});
