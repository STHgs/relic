// =============================================================================
// tests/habits-unit.test.mjs — 习惯库 v2 单元测试（2026-10-09 补）
// =============================================================================
// 背景：habits-v2（748e81b）引入 263 行新逻辑（衰减排序/末位淘汰/三门槛固化/
//   矛盾覆盖/YAML 往返/视图投影），当时零单测覆盖——事故得以随推送直出。
// 覆盖：纯计算函数（可注入 now=确定性）+ 库读写（隔离 HOME）+ 渲染视图投影。
// =============================================================================
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPACITY, INJECT_TOP, SOLIDIFY_MIN_HITS,
  decayScore, sortByDecay, evictOverflow, detectSolidifyCandidates, topEntries,
  addEntry, migrateEntries,
  readHabits, writeHabits, ensureHabitsStore, habitsStoreDigest,
  resolveRenderDate, buildHabitsView, loadHabitsView,
  HABITS_FILE,
} from '../src/core/habits.mjs';

const TODAY = '2026-10-09';
const daysAgo = (n) => new Date(new Date(TODAY + 'T00:00:00Z').getTime() - n * 86400000).toISOString().slice(0, 10);
const entry = (over = {}) => ({ type: 'style', observation: 'obs', evidence: 'ev', recorded: TODAY, hits: 1, lastHit: TODAY, ...over });

// ─── 隔离 HOME（库读写路径经 userHome()=USERPROFILE||HOME||homedir） ────────
let prevHome; let prevProfile; let home;
before(() => {
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
  delete process.env.USERPROFILE;
  home = mkdtempSync(join(tmpdir(), 'relic-habits-'));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = prevHome;
  if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('U1: decay scoring (hits × 0.7^weeks)', () => {
  it('same-day hit scores exactly hits', () => {
    assert.equal(decayScore(entry({ hits: 4, lastHit: TODAY }), TODAY), 4);
  });
  it('one week old decays by factor 0.7', () => {
    assert.ok(Math.abs(decayScore(entry({ hits: 4, lastHit: daysAgo(7) }), TODAY) - 4 * 0.7) < 1e-9);
  });
  it('missing hits defaults to 1; unparseable dates degrade to same-day', () => {
    assert.equal(decayScore({ observation: 'x' }, TODAY), 1);
    assert.equal(decayScore(entry({ hits: 3, lastHit: 'not-a-date' }), TODAY), 3);
  });
  it('sortByDecay puts fresher/hotter first and does not mutate input', () => {
    const stale = entry({ observation: 'stale', hits: 10, lastHit: daysAgo(90) });
    const fresh = entry({ observation: 'fresh', hits: 1, lastHit: TODAY });
    const input = [stale, fresh];
    const sorted = sortByDecay(input, TODAY);
    assert.deepEqual(sorted.map((e) => e.observation), ['fresh', 'stale']);
    assert.equal(input[0].observation, 'stale', 'input order must be preserved');
  });
});

describe('U2: capacity eviction (lowest decay score leaves)', () => {
  it('no overflow → identity, nothing evicted', () => {
    const r = evictOverflow([entry(), entry()]);
    assert.equal(r.kept.length, 2);
    assert.deepEqual(r.evicted, []);
  });
  it('overflow → keeps CAPACITY, evicts the coldest', () => {
    const many = Array.from({ length: CAPACITY + 2 }, (_, i) => entry({ observation: `o${i}`, hits: i + 1, lastHit: TODAY }));
    const r = evictOverflow(many);
    assert.equal(r.kept.length, CAPACITY);
    assert.deepEqual(r.evicted.map((e) => e.hits).sort((a, b) => a - b), [1, 2]);
  });
});

describe('U3: solidify gate (hits ≥ 3 ∧ top-2 ∧ age ≥ 7d)', () => {
  it('qualifies when all three hold', () => {
    const hot = entry({ observation: 'hot', hits: SOLIDIFY_MIN_HITS, recorded: daysAgo(30), lastHit: TODAY });
    assert.deepEqual(detectSolidifyCandidates([hot], TODAY).map((e) => e.observation), ['hot']);
  });
  it('rejects too-new, too-cold and out-of-top-2 entries', () => {
    const tooNew = entry({ observation: 'new', hits: 5, recorded: daysAgo(2), lastHit: TODAY });
    const tooCold = entry({ observation: 'cold', hits: 2, recorded: daysAgo(30), lastHit: TODAY });
    assert.deepEqual(detectSolidifyCandidates([tooNew], TODAY), []);
    assert.deepEqual(detectSolidifyCandidates([tooCold], TODAY), []);
    const a = entry({ observation: 'a', hits: 9, recorded: daysAgo(30), lastHit: TODAY });
    const b = entry({ observation: 'b', hits: 8, recorded: daysAgo(30), lastHit: TODAY });
    const c = entry({ observation: 'c', hits: 7, recorded: daysAgo(30), lastHit: TODAY });   // rank 3 → out
    assert.deepEqual(detectSolidifyCandidates([a, b, c], TODAY).map((e) => e.observation), ['a', 'b']);
  });
});

describe('U4: top-N projection', () => {
  it('defaults to INJECT_TOP and honours explicit now', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ observation: `o${i}`, hits: i + 1, lastHit: TODAY }));
    assert.equal(topEntries(entries, undefined, TODAY).length, INJECT_TOP);
    assert.equal(topEntries(entries, undefined, TODAY)[0].observation, 'o4');
  });
});

describe('U5: addEntry (conflict overwrite + capacity)', () => {
  it('appends a fresh entry with hits=1', () => {
    const r = addEntry({ entries: [] }, { type: 'style', observation: 'use tables', evidence: 'e' });
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].hits, 1);
    assert.equal(r.replaced, null);
  });
  it('similar observation replaces the old entry and records updatedFrom', () => {
    const old = entry({ observation: 'use tables for comparison', hits: 7 });
    const r = addEntry({ entries: [old] }, { observation: 'use tables for comparison always' });
    assert.equal(r.entries.length, 1, 'conflicting entry must not duplicate');
    assert.equal(r.replaced.observation, 'use tables for comparison');
    assert.equal(r.entries[0].updatedFrom, 'use tables for comparison');
    assert.equal(r.entries[0].hits, 1, 'new entry starts its own hit count');
  });
  it('evicts through addEntry when the store is at capacity', () => {
    const full = Array.from({ length: CAPACITY }, (_, i) => entry({ observation: `bulk-${i}`, hits: i + 1, lastHit: TODAY }));
    const r = addEntry({ entries: full }, { observation: 'brand new preference' });
    assert.equal(r.entries.length, CAPACITY);
    assert.equal(r.evicted.length, 1);
  });
});

describe('U6: v1→v2 migration', () => {
  it('backfills hits/lastHit and preserves updatedFrom', () => {
    const v1 = [{ type: 'feedback', observation: 'o', evidence: 'e', recorded: '2026-01-01' }];
    const [m] = migrateEntries(v1);
    assert.equal(m.hits, 1);
    assert.equal(m.lastHit, '2026-01-01');
    const [m2] = migrateEntries([{ ...v1[0], hits: 4, lastHit: '2026-02-02', updatedFrom: 'old' }]);
    assert.equal(m2.hits, 4);
    assert.equal(m2.lastHit, '2026-02-02');
    assert.equal(m2.updatedFrom, 'old');
  });
});

describe('U7: store read/write round-trip (isolated HOME)', () => {
  it('writes and reads back fields; empty store round-trips', () => {
    const entries = [
      entry({ observation: '偏好甲', evidence: '依据甲', hits: 5, lastHit: TODAY, updatedFrom: '偏好甲旧' }),
      entry({ observation: '偏好乙', evidence: '', hits: 2, recorded: '2026-09-01', lastHit: '2026-09-01' }),
    ];
    writeHabits({ entries });
    const back = readHabits().entries;
    assert.equal(back.length, 2);
    assert.equal(back[0].observation, '偏好甲');
    assert.equal(back[0].evidence, '依据甲');
    assert.equal(back[0].hits, 5);
    assert.equal(back[0].lastHit, TODAY);
    assert.equal(back[0].updatedFrom, '偏好甲旧');
    assert.equal(back[1].hits, 2);
    writeHabits({ entries: [] });
    assert.deepEqual(readHabits(), { entries: [] });
  });
  it('ensureHabitsStore is idempotent', () => {
    writeHabits({ entries: [] });
    assert.equal(ensureHabitsStore(), false);
    rmSync(HABITS_FILE(), { force: true });
    assert.equal(ensureHabitsStore(), true);
    assert.equal(ensureHabitsStore(), false);
  });
  it('store digest: none when absent, 8-hex and content-sensitive otherwise', () => {
    rmSync(HABITS_FILE(), { force: true });
    assert.equal(habitsStoreDigest(), 'none');
    writeHabits({ entries: [entry({ observation: 'a' })] });
    const d1 = habitsStoreDigest();
    assert.match(d1, /^[0-9a-f]{8}$/);
    writeHabits({ entries: [entry({ observation: 'b' })] });
    assert.notEqual(habitsStoreDigest(), d1);
  });
});

describe('U8: render date resolution (SOURCE_DATE_EPOCH)', () => {
  const prev = process.env.SOURCE_DATE_EPOCH;
  after(() => { if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = prev; });
  it('explicit argument wins', () => {
    assert.equal(resolveRenderDate('2001-02-03'), '2001-02-03');
  });
  it('SOURCE_DATE_EPOCH is honoured (reproducible replay)', () => {
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    assert.equal(resolveRenderDate(), '2023-11-14');
  });
  it('invalid SOURCE_DATE_EPOCH falls back to today', () => {
    process.env.SOURCE_DATE_EPOCH = 'not-a-number';
    assert.match(resolveRenderDate(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('U9: render view projection (renderer input)', () => {
  it('buildHabitsView is deterministic and projects only renderer fields', () => {
    const entries = [entry({ observation: 'o1', evidence: 'e1', hits: 3, updatedFrom: 'x', type: 'feedback' })];
    const v = buildHabitsView(entries, TODAY, 'deadbeef');
    assert.deepEqual(v, { date: TODAY, digest: 'deadbeef', top: [{ observation: 'o1', evidence: 'e1', hits: 3 }], solidify: [] });
    assert.deepEqual(buildHabitsView(entries, TODAY, 'deadbeef'), v, 'same input → same view');
  });
  it('loadHabitsView reads the store, carries its digest and honours SOURCE_DATE_EPOCH', () => {
    const prev = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = '1700000000';
      writeHabits({ entries: [entry({ observation: '偏好甲', hits: 4, lastHit: TODAY })] });
      const v = loadHabitsView();
      assert.equal(v.date, '2023-11-14');
      assert.equal(v.digest, habitsStoreDigest());
      assert.equal(v.top[0].observation, '偏好甲');
    } finally {
      if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = prev;
    }
  });
});
