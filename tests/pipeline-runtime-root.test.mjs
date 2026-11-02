// tests/pipeline-runtime-root.test.mjs — 程序化 pipeline 的工作流路径根注入
// 背景：REST/控制台的 dry-run 渲染若不注入 runtimeRoot，索引表会退化为
// "modules/?/..." 占位，导致与真实产物误判为"内容过期"，并让再部署写出错误路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from '../src/index.mjs';

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'relic-rt-'));
  mkdirSync(join(home, '.dsh'));   // 让 dsh 适配器 detect 为真（CI 无真实 home 布局）
  return home;
}

test('RT1: 传 runtimeRoot → 索引表用该根拼工作流路径', async () => {
  const home = tmpHome();
  try {
    const r = await pipeline({
      policiesPath: 'template/policies.yaml',
      home,
      dryRun: true,
      runtimeRoot: '/RT',
    });
    assert.equal(r.ok, true);
    const text = r.fileMaps.dsh['AGENTS.md'];
    assert.match(text, /\/RT\/policies\.yaml/);
    assert.doesNotMatch(text, /modules\/\?\//);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('RT2: 不传 runtimeRoot → 退化为占位提示（保持原行为）', async () => {
  const home = tmpHome();
  try {
    const r = await pipeline({ policiesPath: 'template/policies.yaml', home, dryRun: true });
    assert.equal(r.ok, true);
    assert.match(r.fileMaps.dsh['AGENTS.md'], /modules\/\?\//);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
