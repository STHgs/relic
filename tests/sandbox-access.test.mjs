// =============================================================================
// tests/sandbox-access.test.mjs — 沙箱只读授权（Windows + Codex）单元测试
// =============================================================================
// 全部注入 exec/existsSync 桩，不执行任何真实命令、不修改任何 ACL。
// 覆盖：平台判定、组探测、ACE 探测、命令文案（含边界/撤销）、dry-run、
//   幂等（已授权不再执行）、失败透出、目录不存在跳过。
// =============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planSandboxAccess, applySandboxAccess, boundaryText, CODEX_PRINCIPAL, ACE_SUFFIX } from '../src/core/sandbox-access.mjs';

const DIRS = ['C:\\Users\\A\\.config\\relic-sync', 'C:\\Users\\A\\.config\\relic-habits'];

/** 可编程 exec 桩 */
function makeExec({ groupExists = true, grantedDirs = [], failGrant = false } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'net') return { ok: groupExists, stdout: '', stderr: groupExists ? '' : '组不存在' };
    if (cmd === 'icacls' && args[1] === '/grant') {
      return failGrant ? { ok: false, stdout: '', stderr: '拒绝访问' } : { ok: true, stdout: '已处理 1 个文件', stderr: '' };
    }
    if (cmd === 'icacls') {
      const hit = grantedDirs.some((d) => d.replace(/\\/g, '/') === String(args[0]).replace(/\\/g, '/'));
      return { ok: true, stdout: hit ? `NT AUTHORITY\\SYSTEM:(I)(F)\n${CODEX_PRINCIPAL}:(I)(RX)\n` : 'CREATOR OWNER:(I)(F)\n', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const existsAll = () => true;

describe('S1: 平台判定', () => {
  it('非 Windows → 不适用、无需授权', () => {
    const { exec } = makeExec();
    const plan = planSandboxAccess({ platform: 'linux', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(plan.applicable, false);
    assert.equal(plan.needsGrant, false);
    assert.match(plan.reason, /bwrap|读取/);
  });
});

describe('S2: 组与 ACE 探测', () => {
  it('本地组不存在 → 跳过（该机没启用过 Codex 沙箱）', () => {
    const { exec } = makeExec({ groupExists: false });
    const plan = planSandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(plan.applicable, true);
    assert.equal(plan.groupExists, false);
    assert.equal(plan.needsGrant, false);
    assert.match(plan.reason, /不存在/);
  });

  it('组存在且已授权 → needsGrant=false', () => {
    const norm = DIRS.map((d) => d.replace(/\\/g, '/'));
    const { exec } = makeExec({ grantedDirs: norm });
    const plan = planSandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(plan.needsGrant, false);
    assert.ok(plan.dirs.every((d) => d.granted));
  });

  it('组存在但未授权 → needsGrant=true 且命令含 (OI)(CI)(RX)', () => {
    const { exec } = makeExec({ grantedDirs: [] });
    const plan = planSandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(plan.needsGrant, true);
    for (const d of plan.dirs) {
      assert.match(d.command, /icacls/);
      assert.ok(d.command.includes(`${CODEX_PRINCIPAL}:${ACE_SUFFIX}`));
    }
  });

  it('目录不存在不算未授权', () => {
    const { exec } = makeExec({ grantedDirs: [] });
    const plan = planSandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: () => false });
    assert.equal(plan.needsGrant, false);
    assert.ok(plan.dirs.every((d) => d.exists === false));
  });

  it('撤销命令随 plan 提供', () => {
    const { exec } = makeExec();
    const plan = planSandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(plan.revoke.length, 2);
    for (const c of plan.revoke) assert.match(c, /\/remove:g/);
  });
});

describe('S3: 授权执行', () => {
  it('dry-run 不调用 icacls /grant', () => {
    const { exec, calls } = makeExec({ grantedDirs: [] });
    const r = applySandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.applied.length, 2);
    assert.equal(calls.filter((c) => c[1] === '/grant').length, 0);
  });

  it('执行授权并验证通过', () => {
    const { exec, calls } = makeExec({ grantedDirs: [] });
    // 授权后 icacls 复查返回已授权
    let granted = false;
    const exec2 = (cmd, args) => {
      if (cmd === 'icacls' && args[1] === '/grant') { granted = true; return exec(cmd, args); }
      if (cmd === 'icacls') {
        return granted
          ? { ok: true, stdout: `${CODEX_PRINCIPAL}:(I)(RX)\n`, stderr: '' }
          : exec(cmd, args);
      }
      return exec(cmd, args);
    };
    const r = applySandboxAccess({ platform: 'win32', dirs: DIRS, exec: exec2, existsSync: existsAll });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 2);
    assert.ok(r.verify.every((v) => v.granted));
    assert.equal(calls.filter((c) => c[1] === '/grant').length, 0, '原桩不应被 /grant 调用');
  });

  it('已授权目录跳过（幂等）', () => {
    const norm = DIRS.map((d) => d.replace(/\\/g, '/'));
    const { exec, calls } = makeExec({ grantedDirs: norm });
    const r = applySandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 2);
    assert.equal(calls.filter((c) => c[1] === '/grant').length, 0);
  });

  it('授权失败透出 stderr 且 ok=false', () => {
    const { exec } = makeExec({ grantedDirs: [], failGrant: true });
    const r = applySandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(r.ok, false);
    assert.ok(r.applied.every((a) => a.ok === false));
    assert.match(r.applied[0].stderr, /拒绝访问/);
  });

  it('组不存在时不做任何修改', () => {
    const { exec, calls } = makeExec({ groupExists: false });
    const r = applySandboxAccess({ platform: 'win32', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 0);
    assert.equal(calls.filter((c) => c[1] === '/grant').length, 0);
  });

  it('非 Windows 平台 no-op', () => {
    const { exec, calls } = makeExec();
    const r = applySandboxAccess({ platform: 'linux', dirs: DIRS, exec, existsSync: existsAll });
    assert.equal(r.applied.length, 0);
    assert.equal(calls.length, 0);
  });
});

describe('S4: 文案', () => {
  it('边界文案包含只读、只加不删、撤销', () => {
    const b = boundaryText();
    assert.match(b, /只读/);
    assert.match(b, /不改所有权/);
    assert.match(b, /不删除既有 ACE/);
    assert.match(b, /remove:g/);
  });
});
