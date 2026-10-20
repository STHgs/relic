// =============================================================================
// tests/git-ops.test.mjs — git 操作封装测试
// =============================================================================
// 在真实 scratch git repo 中测试所有 git-ops 函数。
// 不 mock git——用 child_process.execSync 真实 init/commit/branch。
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  hasRemote, getRemoteUrl, addRemote,
  currentBranch, createBranch, checkout, ensureBranch,
  commitAll, listBranches, shortHash, createTag,
} from '../src/core/git-ops.mjs';

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-git-'));
  // 初始化真实 git repo
  execSync('git init', { cwd: scratch, encoding: 'utf8' });
  execSync('git config user.email test@test.com', { cwd: scratch, encoding: 'utf8' });
  execSync('git config user.name Test', { cwd: scratch, encoding: 'utf8' });
  // 初始 commit
  writeFileSync(join(scratch, 'README.md'), 'test');
  execSync('git add -A && git commit -m "init"', { cwd: scratch, encoding: 'utf8' });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('hasRemote / getRemoteUrl', () => {
  it('hasRemote returns false when no remote', () => {
    assert.equal(hasRemote({ cwd: scratch }), false);
  });

  it('hasRemote returns true after addRemote', () => {
    addRemote('origin', 'https://github.com/test/repo.git', { cwd: scratch });
    assert.equal(hasRemote({ cwd: scratch }), true);
  });

  it('getRemoteUrl returns empty string when no remote', () => {
    assert.equal(getRemoteUrl({ cwd: scratch }), '');
  });

  it('getRemoteUrl returns url after addRemote', () => {
    addRemote('origin', 'https://github.com/test/repo.git', { cwd: scratch });
    assert.equal(
      getRemoteUrl({ cwd: scratch }),
      'https://github.com/test/repo.git'
    );
  });
});

describe('currentBranch / createBranch / checkout', () => {
  it('currentBranch returns initial branch name', () => {
    const branch = currentBranch({ cwd: scratch });
    // git init 默认分支可能是 master 或 main
    assert.ok(branch === 'master' || branch === 'main');
  });

  it('createBranch creates and switches to new branch', () => {
    createBranch('feature-test', { cwd: scratch });
    assert.equal(currentBranch({ cwd: scratch }), 'feature-test');
  });

  it('checkout switches to existing branch', () => {
    createBranch('feature-test', { cwd: scratch });
    checkout('master', { cwd: scratch });
    assert.equal(currentBranch({ cwd: scratch }), 'master');
  });

  it('ensureBranch does not fail if branch exists', () => {
    createBranch('feature-test', { cwd: scratch });
    checkout('master', { cwd: scratch });
    ensureBranch('feature-test', { cwd: scratch });
    // should not throw
    assert.ok(true);
  });

  it('ensureBranch creates branch if not exists', () => {
    ensureBranch('new-branch', { cwd: scratch });
    // branch should exist now (not checked out, but exists)
    const branches = listBranches('new-branch', { cwd: scratch });
    assert.ok(branches.includes('new-branch'));
  });
});

describe('commitAll', () => {
  it('commits all changes and returns hash', () => {
    writeFileSync(join(scratch, 'new.txt'), 'content');
    const hash = commitAll('add new file', { cwd: scratch });
    assert.ok(hash.length > 0);
    assert.match(hash, /^[0-9a-f]{40}$/);
  });
});

describe('listBranches', () => {
  it('lists branches matching pattern', () => {
    createBranch('deploy-20260828-1', { cwd: scratch });
    checkout('master', { cwd: scratch });
    createBranch('deploy-20260828-2', { cwd: scratch });
    checkout('master', { cwd: scratch });
    createBranch('feature-x', { cwd: scratch });
    checkout('master', { cwd: scratch });

    const deploys = listBranches('deploy-*', { cwd: scratch });
    assert.equal(deploys.length, 2);
    assert.ok(deploys.includes('deploy-20260828-1'));
    assert.ok(deploys.includes('deploy-20260828-2'));
  });

  it('returns empty array for non-matching pattern', () => {
    const result = listBranches('nonexistent-*', { cwd: scratch });
    assert.equal(result.length, 0);
  });
});

describe('shortHash', () => {
  it('returns short hash of current HEAD', () => {
    const hash = shortHash({ cwd: scratch });
    assert.match(hash, /^[0-9a-f]{7,}$/);
  });
});

describe('createTag', () => {
  it('creates a tag', () => {
    createTag('v1.0', { cwd: scratch });
    // verify tag exists
    const tags = execSync('git tag', { cwd: scratch, encoding: 'utf8' }).trim();
    assert.ok(tags.includes('v1.0'));
  });
});
