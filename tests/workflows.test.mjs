// =============================================================================
// tests/workflows.test.mjs — 验证主 policies.yaml 的 workflow 索引渲染
// =============================================================================
// A3 验证（骨架化架构）：add-permission 和 add-workflow 在索引表中出现。
// 详细步骤不再渲染进 AGENTS.md，留在 policies.yaml inline + module.yaml 中。
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { loadProfile } from '../src/core/module-loader.mjs';
import { renderAgentsMd } from '../src/render/agents-md.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const r = loadProfile({
  manifestPath: resolve(REPO, 'template', 'policies.yaml'),
  modulesDir: resolve(REPO, 'template', 'modules'),
});
const policies = r.policies;
const md = renderAgentsMd(policies);

describe('A3: add-permission workflow in index', () => {
  it('appears in the index table', () => {
    assert.match(md, /\| add-permission \|/);
  });
  it('has high priority in index', () => {
    assert.match(md, /\| add-permission \| high \|/);
  });
  it('trigger condition mentions permission rules', () => {
    assert.match(md, /permission rule/);
  });
  it('file path column points to modules/', () => {
    assert.match(md, /modules\/\?\/add-permission/);
  });
});

describe('A3: add-workflow workflow in index', () => {
  it('appears in the index table', () => {
    assert.match(md, /\| add-workflow \|/);
  });
  it('has high priority in index', () => {
    assert.match(md, /\| add-workflow \| high \|/);
  });
  it('trigger condition mentions workflow', () => {
    assert.match(md, /workflow/);
  });
});

describe('A3: both workflows NOT rendered with detailed steps', () => {
  it('does NOT contain 标准流程 section header', () => {
    assert.doesNotMatch(md, /## 标准流程/);
  });
  it('does NOT contain numbered steps for add-permission', () => {
    assert.doesNotMatch(md, /### add-permission \[high\]/);
    assert.doesNotMatch(md, /inject\.mjs --type=permission/);
  });
  it('does NOT contain numbered steps for add-workflow', () => {
    assert.doesNotMatch(md, /### add-workflow \[high\]/);
    assert.doesNotMatch(md, /inject\.mjs --type=workflow/);
  });
});
