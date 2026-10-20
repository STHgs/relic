// tests/console.test.mjs — 按需控制台逻辑测试（端口探测 / 快捷方式规格）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeConsolePort, consoleUrl, shortcutFiles, CONSOLE_PORTS } from '../src/core/console-service.mjs';

test('probeConsolePort: 命中首个可用端口', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const port = Number(url.match(/:(\d+)\//)[1]);
    return { ok: port === 17778 };
  };
  const port = await probeConsolePort({ fetchImpl });
  assert.equal(port, 17778);
  assert.deepEqual(seen.map(u => Number(u.match(/:(\d+)\//)[1])), [17777, 17778]);
});

test('probeConsolePort: 全部不可用 → null', async () => {
  const fetchImpl = async () => ({ ok: false });
  assert.equal(await probeConsolePort({ fetchImpl }), null);
});

test('probeConsolePort: fetch 抛错不致命', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await probeConsolePort({ fetchImpl }), null);
});

test('probeConsolePort: 使用默认端口序列', async () => {
  const fetchImpl = async () => ({ ok: false });
  await probeConsolePort({ fetchImpl });
  assert.deepEqual(CONSOLE_PORTS, [17777, 17778, 17779]);
});

test('consoleUrl: localhost 形式', () => {
  assert.equal(consoleUrl(17779), 'http://localhost:17779');
});

test('shortcutFiles(win32): 开始菜单 + 桌面 .cmd，CRLF，含 pause', () => {
  const files = shortcutFiles({ platform: 'win32', home: 'C:\\Users\\u', repo: 'C:\\Users\\u\\relic', appData: 'C:\\Users\\u\\AppData\\Roaming' });
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.ok(f.path.endsWith('relic 控制台.cmd'), f.path);
    assert.match(f.path, /Start Menu|Desktop/);
    assert.ok(f.content.includes('node scripts\\console.mjs'));
    assert.ok(f.content.includes('pause'));
    assert.ok(f.content.includes('\r\n'), '必须是 CRLF（.cmd 不能是 LF）');
    assert.ok(!f.content.includes('\n\n'), '不得混用裸 LF');
  }
});

test('shortcutFiles(linux): .desktop，Terminal=true，可执行位', () => {
  const files = shortcutFiles({ platform: 'linux', home: '/home/u', repo: '/home/u/relic' });
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.ok(f.path.endsWith('relic-console.desktop'));
    assert.ok(f.content.includes('Exec=node "/home/u/relic/scripts/console.mjs"'));
    assert.ok(f.content.includes('Terminal=true'));
    assert.equal(f.mode, 0o755);
  }
});

test('shortcutFiles(darwin): 不创建快捷方式', () => {
  assert.deepEqual(shortcutFiles({ platform: 'darwin', home: '/Users/u', repo: '/Users/u/relic' }), []);
});

test('shortcutFiles: 缺 home/repo 抛错', () => {
  assert.throws(() => shortcutFiles({ platform: 'linux' }), /home/);
});
