// Real local Git repositories, injected npm only: no network and no live HOME writes.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { upgradeSteps, discoverUpgradeContent } from '../src/core/upgrade-core.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ok = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '' });
const fail = (stderr = 'injected failure', status = 1) => ({ ok: false, status, stdout: '', stderr });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relic-upgrade-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'engine'), content = join(root, 'content repo');
  const home = join(root, 'home'), config = join(root, 'gitconfig');
  mkdirSync(home); mkdirSync(repo); writeFileSync(config, '');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    RELIC_CONTENT_REPO: join(root, 'must-not-discover-live-content'), GIT_TERMINAL_PROMPT: '0' };
  const gitResult = (args, cwd = repo) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
  };
  const git = (args, cwd = repo) => {
    const r = gitResult(args, cwd); assert.equal(r.ok, true, `${args.join(' ')}: ${r.stderr}`); return r.stdout.trim();
  };
  git(['init', '-b', 'main']);
  writeFileSync(join(repo, 'version.txt'), 'old');
  git(['add', '.']); git(['commit', '-m', 'old']);
  const original = git(['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'version.txt'), 'new');
  git(['add', '.']); git(['commit', '-m', 'new']);
  const target = git(['rev-parse', 'HEAD']);
  git(['tag', 'v-test']);
  const engineOrigin = join(root, 'engine.git');
  git(['clone', '--bare', repo, engineOrigin]);
  git(['remote', 'add', 'origin', engineOrigin]);
  git(['checkout', '-b', 'stable', original]);
  const contentOrigin = join(root, 'content.git');
  git(['init', '--bare', '-b', 'main', contentOrigin]);
  git(['clone', contentOrigin, content]);
  writeFileSync(join(content, 'policies.yaml'), 'meta: {version: 2}\npermissions: []\n');
  writeFileSync(join(content, 'engine.lock'), JSON.stringify({ engine: 'relic-source', tag: 'old', commit: original }) + '\n');
  git(['add', '.'], content); git(['commit', '-m', 'content'], content); git(['push', 'origin', 'main'], content);
  const lockBefore = readFileSync(join(content, 'engine.lock'), 'utf8');
  const calls = [], events = [];
  let intercept = () => null;
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    const injected = intercept(cmd, args, opts);
    if (injected) return injected;
    if (cmd === 'git') return gitResult(args, opts.cwd);
    if (cmd === 'npm') return ok(args[0] === 'test' ? '# tests 1\n# pass 1\n# fail 0\n' : '');
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { root, repo, content, home, env, git, original, target, engineOrigin, contentOrigin, lockBefore, calls, events,
    intercept(fn) { intercept = fn; },
    async upgrade(overrides = {}) {
      const gen = upgradeSteps({ repo, content, target: 'v-test', home, env, run, now: () => '2026-10-20T00:00:00Z', ...overrides });
      while (true) { const event = await gen.next(); if (event.done) return event.value; events.push(event.value); }
    },
    npmCalls() { return calls.filter(c => c.cmd === 'npm').map(c => c.args.join(' ')); },
    lock() { return readFileSync(join(content, 'engine.lock'), 'utf8'); },
    noDeploy() { assert.ok(!calls.some(c => c.cmd === 'npm' && c.args[1] === 'sync')); assert.equal(this.lock(), lockBefore); },
  };
}

it('upgrade: success pins exact commit, forces sync, uses same content and confirms remote lock', async t => {
  const f = fixture(t); const result = await f.upgrade();
  assert.equal(result.commit, f.target);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.target);
  const sync = f.calls.find(c => c.cmd === 'npm' && c.args[1] === 'sync');
  assert.deepEqual(sync.args, ['run', 'sync', '--', '--no-gate', '--content', f.content]);
  assert.equal(sync.env.HOME, f.home);
  assert.deepEqual(f.npmCalls().slice(0, 3), ['ci', 'test', 'run check:skeleton']);
  const remoteLock = JSON.parse(f.git(['--git-dir', f.contentOrigin, 'show', 'main:engine.lock']));
  assert.equal(remoteLock.commit, f.target);
  assert.equal(remoteLock.pinned, '2026-10-20T00:00:00Z');
  assert.equal(f.git(['status', '--porcelain'], f.content), '');
  assert.match(f.events.at(-1).message, /已确认推送/);
});

for (const [label, trigger] of [
  ['dependencies', a => a[0] === 'ci'],
  ['test', a => a[0] === 'test'],
  ['skeleton', a => a[1] === 'check:skeleton'],
]) {
  it(`upgrade: ${label} failure restores original branch and dependencies, never deploys`, async t => {
    const f = fixture(t); let failed = false;
    f.intercept((cmd, args) => { if (cmd === 'npm' && trigger(args) && !failed) { failed = true; return fail(label); } });
    await assert.rejects(f.upgrade(), error => error.message.startsWith(`[${label}]`) && error.message.includes(label));
    assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
    assert.equal(f.git(['branch', '--show-current']), 'stable');
    assert.equal(f.npmCalls().filter(c => c === 'ci').length, 2);
    f.noDeploy();
  });
}

it('upgrade: detached original HEAD is restored on test failure', async t => {
  const f = fixture(t); f.git(['checkout', '--detach', f.original]);
  f.intercept((cmd, args) => cmd === 'npm' && args[0] === 'test' ? fail() : null);
  await assert.rejects(f.upgrade(), /已恢复原引擎/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
  assert.equal(f.git(['branch', '--show-current']), ''); f.noDeploy();
});

it('upgrade: nonzero TAP failures reject even if command exits zero', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => cmd === 'npm' && args[0] === 'test' ? ok('# fail 1\n') : null);
  await assert.rejects(f.upgrade(), /测试未全绿/); f.noDeploy();
});

it('upgrade: original dependency restore failure is explicit, not claimed restored', async t => {
  const f = fixture(t); let ci = 0;
  f.intercept((cmd, args) => {
    if (cmd === 'npm' && args[0] === 'ci' && ++ci === 2) return fail('restore dependency failed');
    if (cmd === 'npm' && args[0] === 'test') return fail();
  });
  await assert.rejects(f.upgrade(), /自动恢复未完成.*原版本依赖恢复失败/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original); f.noDeploy();
});

it('upgrade: dirty engine or content is rejected before checkout or npm', async t => {
  for (const which of ['repo', 'content']) {
    const f = fixture(t); writeFileSync(join(f[which], 'untracked.txt'), 'user edit');
    await assert.rejects(f.upgrade(), /工作树不干净/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
    assert.equal(readFileSync(join(f[which], 'untracked.txt'), 'utf8'), 'user edit');
    assert.equal(f.npmCalls().length, 0); f.noDeploy();
  }
});

it('upgrade: failed status query fails closed before fetch or checkout', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => cmd === 'git' && args[0] === 'status' ? fail('status unreadable') : null);
  await assert.rejects(f.upgrade(), /status unreadable/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original); f.noDeploy();
});

it('upgrade: invalid target never checks out or installs', async t => {
  const f = fixture(t);
  await assert.rejects(f.upgrade({ target: 'missing-tag' }), /rev-parse/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
  assert.equal(f.npmCalls().length, 0); f.noDeploy();
});

it('upgrade: local-only content commit is rejected, not accidentally pushed', async t => {
  const f = fixture(t);
  writeFileSync(join(f.content, 'local.txt'), 'local');
  f.git(['add', '.'], f.content); f.git(['commit', '-m', 'local'], f.content);
  await assert.rejects(f.upgrade(), /merge-base/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original); f.noDeploy();
});

it('upgrade: sync failure preserves target and possible partial output, leaves lock untouched', async t => {
  const f = fixture(t), output = join(f.root, 'AGENTS.md');
  f.intercept((cmd, args) => {
    if (cmd === 'npm' && args[1] === 'sync') { writeFileSync(output, 'partial write'); return fail('adapter failed'); }
  });
  await assert.rejects(f.upgrade(), /sync 可能已部分写入.*保留目标引擎/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.target);
  assert.equal(readFileSync(output, 'utf8'), 'partial write');
  assert.equal(f.lock(), f.lockBefore);
  assert.equal(f.npmCalls().filter(c => c === 'ci').length, 1);
  assert.ok(!f.events.some(e => /升级完成/.test(e.message)));
});

for (const failure of ['add', 'commit', 'push']) {
  it(`upgrade: lock ${failure} failure rejects with post-deploy state, never claims success`, async t => {
    const f = fixture(t);
    f.intercept((cmd, args, opts) => cmd === 'git' && opts.cwd === f.content && args[0] === failure ? fail(`${failure} denied`) : null);
    await assert.rejects(f.upgrade(), failure === 'push' ? /已本地提交.*远端发布未确认/ : /engine.lock 尚未确认提交/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.target);
    assert.equal(JSON.parse(f.lock()).commit, f.target);
    assert.ok(!f.events.some(e => /升级完成/.test(e.message)));
    assert.equal(JSON.parse(f.git(['--git-dir', f.contentOrigin, 'show', 'main:engine.lock'])).commit, f.original);
  });
}

it('upgrade: repeated successful upgrade keeps lock timestamp and content commit unchanged', async t => {
  const f = fixture(t); await f.upgrade();
  const before = f.git(['rev-parse', 'HEAD'], f.content), lock = f.lock();
  await f.upgrade();
  assert.equal(f.git(['rev-parse', 'HEAD'], f.content), before);
  assert.equal(f.lock(), lock);
});

it('upgrade: checkout failure never installs or claims rollback', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => cmd === 'git' && args[0] === 'checkout' ? fail('checkout refused') : null);
  await assert.rejects(f.upgrade(), /checkout refused/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
  assert.equal(f.npmCalls().length, 0); f.noDeploy();
});

it('upgrade: dirty files created by failed test are preserved and block automatic recovery', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => {
    if (cmd === 'npm' && args[0] === 'test') { writeFileSync(join(f.repo, 'new-user-file'), 'keep'); return fail(); }
  });
  await assert.rejects(f.upgrade(), /自动恢复未完成/);
  assert.equal(readFileSync(join(f.repo, 'new-user-file'), 'utf8'), 'keep');
  assert.equal(f.git(['rev-parse', 'HEAD']), f.target); f.noDeploy();
});

it('upgrade: concurrent HEAD move is not overwritten or published', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => {
    if (cmd === 'npm' && args[1] === 'check:skeleton') f.git(['checkout', '--detach', f.original]);
  });
  await assert.rejects(f.upgrade(), /HEAD 已改变[\s\S]*拒绝覆盖/);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.original); f.noDeploy();
});

it('upgrade: HEAD move during sync refuses an incorrect engine.lock', async t => {
  const f = fixture(t);
  f.intercept((cmd, args) => { if (cmd === 'npm' && args[1] === 'sync') f.git(['checkout', '--detach', f.original]); });
  await assert.rejects(f.upgrade(), /拒绝写入错误版本锁/);
  assert.equal(f.lock(), f.lockBefore);
  assert.ok(!f.events.some(e => /升级完成/.test(e.message)));
});

it('upgrade: content discovery honors argument > env > config > home', t => {
  const root = mkdtempSync(join(tmpdir(), 'relic-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = { repo: root, env: {}, home: root };
  assert.equal(discoverUpgradeContent(base), join(root, '.config', 'relic-sync'));
  writeFileSync(join(root, 'relic.config.json'), JSON.stringify({ contentRepo: join(root, 'configured') }));
  assert.equal(discoverUpgradeContent(base), join(root, 'configured'));
  assert.equal(discoverUpgradeContent({ ...base, env: { RELIC_CONTENT_REPO: join(root, 'env') } }), join(root, 'env'));
  assert.equal(discoverUpgradeContent({ ...base, env: { RELIC_CONTENT_REPO: join(root, 'env') }, content: join(root, 'explicit') }), join(root, 'explicit'));
});

it('upgrade CLI rejects incomplete and unknown options before operations', () => {
  for (const args of [['--tag'], ['--content'], ['--bogus']]) {
    const r = spawnSync(process.execPath, [join(source, 'scripts/upgrade.mjs'), ...args], { cwd: source, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /FAILED/);
  }
});

it('wizard upgrade delegates to shared core without dirty auto-commit or platform test bypass', () => {
  const wizard = readFileSync(join(source, 'scripts/wizard.mjs'), 'utf8');
  const body = wizard.slice(wizard.indexOf('async function* upgradePipeline()'), wizard.indexOf('// ─── HTTP 服务器'));
  assert.match(body, /yield\* upgradeSteps\(\{ repo: REPO \}\)/);
  assert.doesNotMatch(body, /wizardPreSyncClean\(DEFAULT_CONTENT\)|const isWin|git.*commit/);
});
