// =============================================================================
// tests/scheduler.test.mjs — 调度器四后端统一语义测试
// =============================================================================
// S1: 纯解析器（systemctl show / schtasks XML / crontab / launchctl disabled）
// S2: systemd —— 已禁用 → install() 后 enabled（收敛）
// S3: cron —— 旧版无标记行被重写为标记行；disable 删行；backend 选择
// S4: launchd —— install 会 bootstrap；disable 会 bootout + 持久 disable 标记
// S5: schtasks —— 禁用任务 install() 调 /ENABLE；电池项触发 PowerShell 修正
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSystemctlShow,
  parseSchtasksXml,
  findCronRelicLines,
  parseLaunchctlDisabled,
  createScheduler,
} from '../src/core/scheduler.mjs';

function tmp(label) {
  return mkdtempSync(join(tmpdir(), `relic-sched-${label}-`));
}

const NO_SYSTEMD = { ok: false, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' };

// ─── S1: 解析器 ────────────────────────────────────────────────────────

describe('S1: 解析器', () => {
  it('parseSystemctlShow 解析 key=value（值含 = 时只切首个）', () => {
    const kv = parseSystemctlShow('UnitFileState=enabled\nActiveState=active\nX=a=b\n\n');
    assert.equal(kv.UnitFileState, 'enabled');
    assert.equal(kv.ActiveState, 'active');
    assert.equal(kv.X, 'a=b');
  });

  it('parseSchtasksXml 读 Settings 段 Enabled 与电池项', () => {
    const xml = `<Task><Settings><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
      <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries><Enabled>false</Enabled>
      </Settings><Triggers><Enabled>true</Enabled></Triggers></Task>`;
    const p = parseSchtasksXml(xml);
    assert.equal(p.enabled, false, 'Settings.Enabled 优先，不被 Trigger 的 Enabled 干扰');
    assert.equal(p.disallowStartIfOnBatteries, true);
    assert.equal(p.stopIfGoingOnBatteries, true);
  });

  it('findCronRelicLines 命中标记行与旧版指向本 repo 的行', () => {
    const text = [
      '0 3 * * * /usr/bin/backup',
      '*/5 * * * * cd /home/u/relic && npm run sync >> ~/.relic-sync.log 2>&1',
      '*/5 * * * * cd /home/u/relic && npm run sync >> ~/.relic-sync.log 2>&1 # relic-sync',
      '*/5 * * * * cd /opt/other && npm run sync',
    ].join('\n');
    const lines = findCronRelicLines(text, '/home/u/relic');
    assert.equal(lines.length, 2);
  });

  it('parseLaunchctlDisabled 识别禁用标记', () => {
    assert.equal(parseLaunchctlDisabled('"dev.relic.sync" => true\n'), true);
    assert.equal(parseLaunchctlDisabled('"dev.relic.sync" => false\n'), false);
    assert.equal(parseLaunchctlDisabled('"other" => true\n'), false);
  });
});

// ─── S2: systemd 收敛 ──────────────────────────────────────────────────

describe('S2: systemd install 收敛', () => {
  it('已禁用 → install() 调 enable --now 并回到 enabled', () => {
    const calls = [];
    const state = { file: 'disabled', active: 'inactive' };
    const runFn = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args.includes('is-system-running')) return { ok: true, stdout: 'running', stderr: '' };
      if (args.includes('show')) return { ok: true, stdout: `UnitFileState=${state.file}\nActiveState=${state.active}\n`, stderr: '' };
      if (args.includes('daemon-reload')) return { ok: true, stdout: '', stderr: '' };
      if (args.includes('enable')) { state.file = 'enabled'; state.active = 'active'; return { ok: true, stdout: '', stderr: '' }; }
      if (args.includes('disable')) { state.file = 'disabled'; state.active = 'inactive'; return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    };
    const home = tmp('systemd');
    const s = createScheduler({ platform: 'linux', home, repo: '/repo', runFn });
    const before = s.status();
    assert.equal(before.backend, 'systemd');
    assert.equal(before.installed, true);
    assert.equal(before.enabled, false);

    const r = s.install();
    assert.equal(r.ok, true);
    assert.equal(r.status.enabled, true);
    assert.ok(calls.some(c => c.includes('enable --now')), '必须真的调用 enable --now');

    const d = s.disable();
    assert.equal(d.status.enabled, false);
    rmSync(home, { recursive: true, force: true });
  });
});

// ─── S3: cron 重写与删除 ──────────────────────────────────────────────

describe('S3: cron 后端', () => {
  function makeCronEnv(initial) {
    const repo = '/home/u/relic';
    const store = { text: initial };
    const calls = [];
    const runFn = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'systemctl') return NO_SYSTEMD;
      if (cmd !== 'crontab') return { ok: false, stdout: '', stderr: 'no' };
      if (args[0] === '-l') return { ok: true, stdout: store.text, stderr: '' };
      store.text = readFileSync(args[0], 'utf8');
      return { ok: true, stdout: '', stderr: '' };
    };
    const home = tmp('cron');
    return { repo, store, calls, home, s: createScheduler({ platform: 'linux', home, repo, runFn }) };
  }

  it('无 systemd 时回退 cron；旧版无标记行被重写为标记行', () => {
    const { s, store, repo } = makeCronEnv(
      '0 3 * * * /usr/bin/backup\n*/5 * * * * cd /home/u/relic && npm run sync >> ~/.relic-sync.log 2>&1\n',
    );
    assert.equal(s.status().backend, 'cron');
    const r = s.install();
    assert.equal(r.ok, true);
    const relicLines = findCronRelicLines(store.text, repo);
    assert.equal(relicLines.length, 1, '旧行被替换而不是重复追加');
    assert.ok(relicLines[0].includes('# relic-sync'));
    assert.ok(store.text.includes('/usr/bin/backup'), '非 relic 行保留');
  });

  it('disable 删除 relic 行，其他 cron 行不动', () => {
    const { s, store, repo } = makeCronEnv('0 3 * * * /usr/bin/backup\n');
    s.install();
    assert.equal(findCronRelicLines(store.text, repo).length, 1);
    const r = s.disable();
    assert.equal(r.status.enabled, false);
    assert.equal(findCronRelicLines(store.text, repo).length, 0);
    assert.ok(store.text.includes('/usr/bin/backup'));
  });
});

// ─── S4: launchd ──────────────────────────────────────────────────────

describe('S4: launchd', () => {
  it('install 写 plist 并 bootstrap；disable 持久禁用', () => {
    const calls = [];
    const state = { loaded: false, disabled: false };
    const runFn = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd !== 'launchctl') return { ok: false, stdout: '', stderr: 'no' };
      if (args[0] === 'print') return { ok: state.loaded, stdout: '', stderr: '' };
      if (args[0] === 'print-disabled') return { ok: true, stdout: `"dev.relic.sync" => ${state.disabled}\n`, stderr: '' };
      if (args[0] === 'bootstrap' || args[0] === 'load') { state.loaded = true; return { ok: true, stdout: '', stderr: '' }; }
      if (args[0] === 'bootout') { state.loaded = false; return { ok: true, stdout: '', stderr: '' }; }
      if (args[0] === 'disable') { state.disabled = true; return { ok: true, stdout: '', stderr: '' }; }
      if (args[0] === 'enable') { state.disabled = false; return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };
    const home = tmp('launchd');
    const s = createScheduler({ platform: 'darwin', home, repo: '/repo', runFn });
    const r = s.install();
    assert.equal(r.ok, true);
    assert.equal(r.status.backend, 'launchd');
    assert.equal(r.status.enabled, true);
    assert.ok(calls.some(c => c.startsWith('launchctl bootstrap')), '必须 bootstrap');

    const d = s.disable();
    assert.equal(d.status.enabled, false);
    assert.ok(calls.some(c => c.startsWith('launchctl disable')), 'disable 标记必须持久化');
    rmSync(home, { recursive: true, force: true });
  });
});

// ─── S5: schtasks ─────────────────────────────────────────────────────

describe('S5: schtasks', () => {
  function makeWinEnv({ installed, enabled }) {
    const repo = tmp('winrepo');
    const home = tmp('winhome');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'sync-silent.vbs'), "REPO = \"__REPO__\"\n");
    const state = { installed, enabled, battery: true };
    const calls = [];
    const xml = () => `<Task><Settings><DisallowStartIfOnBatteries>${state.battery}</DisallowStartIfOnBatteries>
      <StopIfGoingOnBatteries>${state.battery}</StopIfGoingOnBatteries><Enabled>${state.enabled}</Enabled></Settings></Task>`;
    const runFn = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'schtasks') {
        if (args.includes('/Query')) return state.installed
          ? { ok: true, stdout: xml(), stderr: '' }
          : { ok: false, stdout: '', stderr: 'ERROR: task not found' };
        if (args.includes('/Create')) { state.installed = true; state.enabled = true; return { ok: true, stdout: '', stderr: '' }; }
        if (args.includes('/ENABLE')) { state.enabled = true; return { ok: true, stdout: '', stderr: '' }; }
        if (args.includes('/DISABLE')) { state.enabled = false; return { ok: true, stdout: '', stderr: '' }; }
        if (args.includes('/TR')) return { ok: true, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell') { state.battery = false; return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unexpected ' + cmd };
    };
    const s = createScheduler({ platform: 'win32', home, repo, runFn });
    return { s, state, calls, home, repo };
  }

  it('任务存在但被禁用 → install() 必须 /ENABLE（回归：事故形态）', () => {
    const { s, state, calls } = makeWinEnv({ installed: true, enabled: false });
    const before = s.status();
    assert.equal(before.installed, true);
    assert.equal(before.enabled, false);
    const r = s.install();
    assert.equal(r.ok, true);
    assert.equal(r.status.enabled, true);
    assert.ok(calls.some(c => c.includes('/ENABLE')), '禁用任务必须被 /ENABLE');
    assert.equal(state.enabled, true);
  });

  it('任务不存在 → 创建并写 vbs；电池默认项触发 PowerShell 修正', () => {
    const { s, calls, home } = makeWinEnv({ installed: false, enabled: false });
    const r = s.install();
    assert.equal(r.ok, true);
    assert.ok(calls.some(c => c.includes('/Create')));
    assert.ok(calls.some(c => c.startsWith('powershell')), '电池项 true 时必须尝试修正');
    const vbs = readFileSync(join(home, 'AppData', 'Local', 'relic', 'sync-silent.vbs'), 'utf8');
    assert.ok(vbs.includes('__REPO__') === false, 'vbs 的 __REPO__ 占位符必须被替换');
  });
});
