// =============================================================================
// tests/exec.test.mjs — 平台无关执行层（Windows 适配 D1/D4）
// =============================================================================
// E1: run 数组化执行（node -e）
// E2: run 失败语义（非零退出）
// E3: runChain 顺序 + 短路
// E4: userHome 归一化（HOME/USERPROFILE/homedir 三级）
// E5: headless env（GIT_TERMINAL_PROMPT=0 注入）
// =============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, runChain, userHome } from '../src/core/exec.mjs';

describe('E1: run array-form execution', () => {
  it('executes node -e and captures stdout', () => {
    const r = run(process.execPath, ['-e', 'console.log("hi")']);
    assert.equal(r.ok, true);
    assert.equal(r.stdout.trim(), 'hi');
  });
});

describe('E2: run failure semantics', () => {
  it('non-zero exit -> ok:false + stderr captured', () => {
    const r = run(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)']);
    assert.equal(r.ok, false);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /boom/);
  });
});

describe('E3: runChain sequential + short-circuit', () => {
  it('runs steps in order when all succeed', () => {
    const r = runChain([
      { cmd: process.execPath, args: ['-e', 'console.log(1)'] },
      { cmd: process.execPath, args: ['-e', 'console.log(2)'] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.last.stdout.replace(/\[\d+m/g, '').trim(), '2');
  });
  it('stops at first failure with failed step info', () => {
    let secondRan = false;
    const r = runChain([
      { cmd: process.execPath, args: ['-e', 'process.exit(7)'] },
      { cmd: process.execPath, args: ['-e', 'secondRan = true'] },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.failed.cmd, /-e/);
    assert.equal(secondRan, false);
  });
});

describe('E4: userHome normalization', () => {
  it('returns a non-empty absolute path (platform-aware)', () => {
    const h = userHome();
    assert.ok(h && h.length > 0);
    // POSIX 路径以 / 开头；win 路径以盘符开头（C:\ / D:\ 等）
    if (process.platform === 'win32') {
      assert.ok(/^[A-Z]:[\\/]/.test(h), `win path: ${h}`);
    } else {
      assert.ok(h.startsWith('/'), `posix path: ${h}`);
    }
  });
  it('prefers USERPROFILE when set (win32 semantics)', () => {
    const orig = process.env.USERPROFILE;
    process.env.USERPROFILE = '/fake/win/profile';
    try { assert.equal(userHome(), '/fake/win/profile'); }
    finally { if (orig === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = orig; }
  });
});

describe('E5: headless env injection', () => {
  it('child sees GIT_TERMINAL_PROMPT=0', () => {
    const r = run(process.execPath, ['-e', 'console.log(process.env.GIT_TERMINAL_PROMPT)']);
    assert.equal(r.stdout.trim(), '0');
  });
});
