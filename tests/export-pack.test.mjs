// =============================================================================
// tests/export-pack.test.mjs — 导出打包逻辑测试
// =============================================================================
// 测试 collectFiles / renderHandoff / writeHandoff / packTarGz。
// 用 scratch 目录模拟 relic 项目结构。
// =============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  collectFiles,
  renderHandoff,
  writeHandoff,
  packTarGz,
} from '../src/core/export-pack.mjs';

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'relic-export-'));
  // 模拟 relic 项目结构
  const dirs = ['modules', 'src/core', 'scripts', 'tests', 'node_modules', '.git', 'generated', 'output/v1', 'interaction'];
  for (const d of dirs) {
    mkdirSync(join(scratch, d), { recursive: true });
  }
  // 写入应该包含的文件
  writeFileSync(join(scratch, 'policies.yaml'), 'meta:');
  writeFileSync(join(scratch, 'schema.json'), '{}');
  writeFileSync(join(scratch, 'package.json'), '{}');
  writeFileSync(join(scratch, 'package-lock.json'), '{}');
  writeFileSync(join(scratch, '.gitattributes'), '* text=auto');
  writeFileSync(join(scratch, '.gitignore'), 'node_modules/');
  writeFileSync(join(scratch, 'modules', 'test.yaml'), 'id: test');
  writeFileSync(join(scratch, 'src', 'core', 'test.mjs'), 'export default {}');
  writeFileSync(join(scratch, 'scripts', 'deploy.mjs'), '#!/usr/bin/env node');
  writeFileSync(join(scratch, 'tests', 'test.test.mjs'), 'import {} from "node:test"');
  // 写入应该排除的文件
  writeFileSync(join(scratch, 'node_modules', 'pkg.json'), '{}');
  writeFileSync(join(scratch, '.git', 'config'), '[core]');
  writeFileSync(join(scratch, 'generated', 'out.jsonc'), '{}');
  writeFileSync(join(scratch, 'output', 'v1', 'plan.md'), '# plan');
  writeFileSync(join(scratch, 'interaction', 'screenshot.png'), 'fake');
  writeFileSync(join(scratch, 'file.bak.2026'), 'backup');
  writeFileSync(join(scratch, 'archive.tar.gz'), 'fake archive');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('collectFiles', () => {
  it('collects only included files', () => {
    const files = collectFiles(scratch);
    // 应包含
    assert.ok(files.includes('policies.yaml'));
    assert.ok(files.includes('schema.json'));
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('package-lock.json'));
    assert.ok(files.includes('.gitattributes'));
    assert.ok(files.includes('.gitignore'));
    assert.ok(files.includes('modules/test.yaml'));
    assert.ok(files.includes('src/core/test.mjs'));
    assert.ok(files.includes('scripts/deploy.mjs'));
    assert.ok(files.includes('tests/test.test.mjs'));
  });

  it('excludes node_modules, .git, generated, output, interaction', () => {
    const files = collectFiles(scratch);
    for (const f of files) {
      assert.ok(!f.includes('node_modules'), `should not include node_modules: ${f}`);
      assert.ok(!f.includes('.git/'), `should not include .git/: ${f}`);
      assert.ok(!f.includes('generated/'), `should not include generated/: ${f}`);
      assert.ok(!f.includes('output/'), `should not include output/: ${f}`);
      assert.ok(!f.includes('interaction/'), `should not include interaction/: ${f}`);
    }
  });

  it('excludes .bak and .tar.gz files', () => {
    const files = collectFiles(scratch);
    assert.ok(!files.includes('file.bak.2026'));
    assert.ok(!files.includes('archive.tar.gz'));
  });
});

describe('renderHandoff', () => {
  it('renders HANDOFF.md with correct content', () => {
    const content = renderHandoff({
      branch: 'deploy-20260828-1',
      commit: 'abc1234567890abcdef1234567890abcdef12345',
      shortHash: 'abc1234',
      exportedAt: new Date('2026-08-28T12:00:00Z'),
      profile: 'full',
    });

    assert.ok(content.includes('deploy-20260828-1'));
    assert.ok(content.includes('abc1234567890abcdef1234567890abcdef12345'));
    assert.ok(content.includes('abc1234'));
    assert.ok(content.includes('2026-08-28T12:00:00.000Z'));
    assert.ok(content.includes('该分支生命周期已结束'));
    assert.ok(content.includes('npm run deploy'));
  });
});

describe('writeHandoff', () => {
  it('writes HANDOFF.md to dest dir', () => {
    const destDir = join(scratch, 'dest');
    mkdirSync(destDir, { recursive: true });
    writeHandoff({
      branch: 'deploy-20260828-1',
      commit: 'abc1234567890abcdef1234567890abcdef12345',
      shortHash: 'abc1234',
    }, destDir);

    const handoffPath = join(destDir, 'HANDOFF.md');
    assert.equal(existsSync(handoffPath), true);
    const content = readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('deploy-20260828-1'));
  });
});

describe('packTarGz', () => {
  it('creates tar.gz archive with all files + HANDOFF.md', () => {
    const files = collectFiles(scratch);
    const destPath = join(scratch, 'export-test.tar.gz');
    const handoffInfo = {
      branch: 'deploy-20260828-1',
      commit: 'abc1234567890abcdef1234567890abcdef12345',
      shortHash: 'abc1234',
    };

    packTarGz(scratch, files, destPath, handoffInfo);

    // 验证文件存在
    assert.equal(existsSync(destPath), true);

    // 验证 tar.gz 内容
    const list = execSync(`tar tzf "${destPath}"`, { encoding: 'utf8' }).trim().split('\n');
    assert.ok(list.some((f) => f.includes('policies.yaml')));
    assert.ok(list.some((f) => f.includes('HANDOFF.md')));
    assert.ok(!list.some((f) => f.includes('node_modules')));
    assert.ok(!list.some((f) => f.includes('.git/')));
  });
});
