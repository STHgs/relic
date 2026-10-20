// tests/setup-script.test.mjs — 启动器批处理静态语法守卫
// =============================================================================
// 背景：relic-setup.cmd 用 `> "%TEMP%\relic-setup.ps1" ( echo ... ) ` 生成 PowerShell
// payload。批处理在**解析期**扫描括号块，块内 echo 文案出现未转义的 `)` 会提前闭合
// 块，整段变成非法命令，脚本直接崩——双击只看到窗口一闪（2026-10-20 真实事故，
// 因 Gitee 回退文案里写入了 `(Gitee mirror not published yet)`）。
//
// 该错误无法在 Linux/macOS 上被执行验证，故用静态扫描兜底：
//   echo 行去掉 `^x` 转义对后，不得残留 `( ) & | < >`（这些都是 cmd 元字符，
//   在括号块/重定向语境下必须转义，否则解析期崩溃）。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['relic-setup.cmd', 'install.cmd'];

for (const file of FILES) {
  test(`${file}: echo 文案不得含未转义的 cmd 元字符`, () => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const offenders = [];
    text.split(/\r?\n/).forEach((line, idx) => {
      const m = line.match(/^\s*echo\b(.*)$/i);
      if (!m) return;
      // 去掉所有 `^x` 转义对（`^)`、`^( `、`^>` …），剩余字符直接暴露给 cmd
      const unescaped = m[1].replace(/\^./g, '');
      if (/[()&|<>]/.test(unescaped)) offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [],
      `echo 行含未转义元字符（cmd 解析期会崩溃）：\n${offenders.join('\n')}`);
  });
}

// ---------------------------------------------------------------------------
// 2026-10-20 起改为「纯 PowerShell 安装器 + Release zip 分发」：
// 批处理只做 3 行 launcher，不再用 echo 拼装 PS 代码（上一版事故的根因）。
// ---------------------------------------------------------------------------
test('relic-setup.cmd: 纯 launcher，不再 echo 生成 PowerShell 代码', () => {
  const text = readFileSync(join(ROOT, 'relic-setup.cmd'), 'utf8');
  assert.match(text, /powershell -NoProfile -ExecutionPolicy Bypass -File/,
    'launcher 应直接调用 -File 执行同目录 ps1');
  assert.match(text, /relic-setup\.ps1/, 'zip 布局：ps1 与 cmd 同级');
  assert.match(text, /scripts\\setup\.ps1/, '仓库布局：ps1 在 scripts/ 下');
  assert.doesNotMatch(text, /echo[^\r\n]*powershell/i,
    '不得再通过 echo 生成 PowerShell 代码（转义事故根源）');
});

test('scripts/setup.ps1: UTF-8 BOM + 关键守卫', () => {
  const buf = readFileSync(join(ROOT, 'scripts', 'setup.ps1'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf],
    'PS 5.1 读中文脚本需要 UTF-8 BOM');
  const text = buf.toString('utf8');
  assert.match(text, /\$ErrorActionPreference = 'Stop'/);
  assert.match(text, /git clone https:\/\/github\.com\/STHgs\/relic\.git/);
  assert.match(text, /scripts[\\/]wizard\.mjs/, '最后应启动向导');
});

test('.github/workflows/release.yml: tag 触发并打包 zip 资产', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(text, /tags: \['v\*'\]/);
  assert.match(text, /relic-setup\.zip/);
  assert.match(text, /gh release create|gh release upload/);
});
