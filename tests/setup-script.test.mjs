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
