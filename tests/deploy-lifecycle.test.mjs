// =============================================================================
// tests/deploy-lifecycle.test.mjs — deploy 分支生命周期测试
// =============================================================================
// 纯函数测试，无 I/O（cleanupStaleSkills 除外，用 scratch 目录）。
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  formatDate,
  nextDeployBranch,
  isDeployBranch,
  cleanupStaleSkills,
} from '../src/core/deploy-lifecycle.mjs';

describe('formatDate', () => {
  it('formats date as YYYYMMDD', () => {
    assert.equal(formatDate(new Date(2026, 7, 28)), '20260828'); // month is 0-indexed
  });

  it('pads single digit month and day', () => {
    assert.equal(formatDate(new Date(2026, 0, 5)), '20260105');
  });
});

describe('nextDeployBranch', () => {
  it('returns deploy-YYYYMMDD-1 when no existing branches', () => {
    const result = nextDeployBranch([], new Date(2026, 7, 28));
    assert.equal(result, 'deploy-20260828-1');
  });

  it('increments n when same-date branches exist', () => {
    const existing = ['deploy-20260828-1', 'deploy-20260828-2'];
    const result = nextDeployBranch(existing, new Date(2026, 7, 28));
    assert.equal(result, 'deploy-20260828-3');
  });

  it('returns 1 when only different-date branches exist', () => {
    const existing = ['deploy-20260827-5', 'deploy-20260827-6'];
    const result = nextDeployBranch(existing, new Date(2026, 7, 28));
    assert.equal(result, 'deploy-20260828-1');
  });

  it('handles non-sequential existing branches', () => {
    const existing = ['deploy-20260828-1', 'deploy-20260828-3', 'deploy-20260828-5'];
    const result = nextDeployBranch(existing, new Date(2026, 7, 28));
    assert.equal(result, 'deploy-20260828-6');
  });

  it('ignores non-matching branches', () => {
    const existing = ['main', 'master', 'feature-x', 'deploy-20260828-1'];
    const result = nextDeployBranch(existing, new Date(2026, 7, 28));
    assert.equal(result, 'deploy-20260828-2');
  });
});

describe('isDeployBranch', () => {
  it('returns true for valid deploy branch name', () => {
    assert.equal(isDeployBranch('deploy-20260828-1'), true);
  });

  it('returns false for non-deploy branch', () => {
    assert.equal(isDeployBranch('main'), false);
    assert.equal(isDeployBranch('master'), false);
    assert.equal(isDeployBranch('feature-x'), false);
  });

  it('returns false for malformed deploy branch', () => {
    assert.equal(isDeployBranch('deploy-20260828'), false);
    assert.equal(isDeployBranch('deploy-20260828-'), false);
    assert.equal(isDeployBranch('deploy-2026-0828-1'), false);
  });
});

describe('cleanupStaleSkills', () => {
  let scratch;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'relic-cleanup-'));
    // 模拟 ~/.config/opencode/skill/ 结构
    mkdirSync(join(scratch, '.config', 'opencode', 'skill', 'workflow'), { recursive: true });
    mkdirSync(join(scratch, '.config', 'opencode', 'skill', 'permission'), { recursive: true });
    writeFileSync(join(scratch, '.config', 'opencode', 'skill', 'workflow', 'SKILL.md'), 'test');
    writeFileSync(join(scratch, '.config', 'opencode', 'skill', 'permission', 'SKILL.md'), 'test');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('removes skill subdirectories', () => {
    const removed = cleanupStaleSkills(scratch);
    assert.equal(removed.length, 2);
    // skill dir should now be empty
    const skillDir = join(scratch, '.config', 'opencode', 'skill');
    const entries = readdirSync(skillDir);
    assert.equal(entries.length, 0);
  });

  it('returns empty array when skill dir does not exist', () => {
    const result = cleanupStaleSkills('/nonexistent/path');
    assert.deepEqual(result, []);
  });
});
