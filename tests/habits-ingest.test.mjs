// =============================================================================
// tests/habits-ingest.test.mjs — 习惯提案合并（habits v3）单元测试
// =============================================================================
// 覆盖：校验/解析（半行、坏行）、扫描（深度、跳过、上限）、合并（新增/覆盖/
//   命中/批次去重/限流/拒绝/容量）、幂等（重复运行）、dry-run、偏移推进、
//   待合并计数、vacuum。全部在隔离 HOME 下跑，不碰真实 ~/.config。
// =============================================================================
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRecord, parseProposalBuffer, readSources, writeSources,
  discoverProposalFiles, mergeHabitProposals, countPendingProposals,
  vacuumProposals, ingestPaths, DEFAULT_TEACH_CAP, PROPOSAL_REL,
} from '../src/core/habits-ingest.mjs';
import { readHabits, writeHabits, HABITS_FILE, CAPACITY } from '../src/core/habits.mjs';

let prevHome; let prevProfile; let home;

before(() => {
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
  delete process.env.USERPROFILE;
  home = mkdtempSync(join(tmpdir(), 'relic-ingest-'));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = prevHome;
  if (prevProfile !== undefined) process.env.USERPROFILE = prevProfile;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  // 每例重置库与状态（v0.0.4：库在 <home>/.relic/habits）
  rmSync(join(home, '.relic'), { recursive: true, force: true });
  rmSync(join(home, '.config'), { recursive: true, force: true });
});

const lineOf = (obj) => JSON.stringify(obj) + '\n';
const teach = (obs, over = {}) => ({ event: 'teach', type: 'feedback', observation: obs, evidence: '用户要求', ...over });

/** 建一个工作区并写入提案行 */
function workspace(name, lines) {
  const ws = join(home, 'projects', name);
  mkdirSync(join(ws, '.relic'), { recursive: true });
  writeFileSync(join(ws, PROPOSAL_REL), lines.join(''));
  return ws;
}

describe('V1: validateRecord', () => {
  it('合法 teach', () => {
    assert.equal(validateRecord(teach('先给结论再给依据')).ok, true);
  });
  it('缺 evidence 拒绝', () => {
    const r = validateRecord({ event: 'teach', type: 'style', observation: '有效的观察文本' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /evidence/);
  });
  it('type 非法拒绝', () => {
    assert.equal(validateRecord(teach('有效的观察文本', { type: 'wrong' })).ok, false);
  });
  it('observation 过短/过长拒绝', () => {
    assert.equal(validateRecord(teach('短')).ok, false);
    assert.equal(validateRecord(teach('长'.repeat(201))).ok, false);
  });
  it('hit 合法与 target 过短', () => {
    assert.equal(validateRecord({ event: 'hit', target: '先给结论' }).ok, true);
    assert.equal(validateRecord({ event: 'hit', target: 'ab' }).ok, false);
  });
  it('未知 event 拒绝', () => {
    assert.equal(validateRecord({ event: 'nope' }).ok, false);
  });
});

describe('V2: parseProposalBuffer（半行/坏行）', () => {
  it('两条完整行 + 半行 → 只消费两条', () => {
    const text = lineOf(teach('观察一到四')) + lineOf(teach('观察二到四')) + '{"event":"tea';
    const buf = Buffer.from(text, 'utf8');
    const r = parseProposalBuffer(buf);
    assert.equal(r.records.length, 2);
    const consumed = Buffer.byteLength(lineOf(teach('观察一到四')) + lineOf(teach('观察二到四')), 'utf8');
    assert.equal(r.nextOffset, consumed);
  });
  it('坏 JSON 进 rejects 并带 endOffset', () => {
    const r = parseProposalBuffer(Buffer.from('{not json}\n', 'utf8'));
    assert.equal(r.records.length, 0);
    assert.equal(r.rejects.length, 1);
    assert.equal(r.rejects[0].endOffset, Buffer.byteLength('{not json}\n'));
  });
  it('从 offset 续读只返回新增行', () => {
    const first = lineOf(teach('观察一到四'));
    const text = first + lineOf(teach('观察二到四'));
    const off = Buffer.byteLength(first, 'utf8');
    const r = parseProposalBuffer(Buffer.from(text, 'utf8'), off);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].obj.observation, '观察二到四');
  });
});

describe('V3: 扫描根与文件发现', () => {
  it('缺省探测存在的常见根', () => {
    mkdirSync(join(home, 'projects'), { recursive: true });
    const s = readSources();
    assert.equal(s.origin, 'default');
    assert.ok(s.roots.some((r) => r.endsWith('projects')));
  });
  it('writeSources 落盘后可读回', () => {
    const ws = join(home, 'w1');
    writeSources([ws]);
    const s = readSources();
    assert.equal(s.origin, 'file');
    assert.deepEqual(s.roots, [ws.replace(/\\/g, '/') === ws ? ws : s.roots[0]]);
  });
  it('损坏的 sources.json 回退默认', () => {
    const p = ingestPaths();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.sources, '{broken');
    assert.equal(readSources().origin, 'corrupt');
  });
  it('发现嵌套提案文件，跳过 node_modules，遵守深度', () => {
    const a = workspace('a', []);
    const deep = join(home, 'projects', 'b', 'x', 'y', 'z');
    mkdirSync(join(deep, '.relic'), { recursive: true });
    writeFileSync(join(deep, PROPOSAL_REL), '');
    const nm = join(home, 'projects', 'c', 'node_modules', 'p');
    mkdirSync(join(nm, '.relic'), { recursive: true });
    writeFileSync(join(nm, PROPOSAL_REL), '');
    const { files } = discoverProposalFiles({ roots: [join(home, 'projects')], maxDepth: 3, maxFilesPerRun: 50, maxBytesPerFile: 1e6 });
    const paths = files.map((f) => f.path);
    assert.ok(paths.some((p) => p.includes(join('a', PROPOSAL_REL))));
    assert.ok(!paths.some((p) => p.includes('node_modules')));
    assert.ok(!paths.some((p) => p.includes(join('x', 'y', 'z'))), '深度 3 之外的 v 不应被发现');
    assert.equal(files.find((f) => f.path.includes(join('a', PROPOSAL_REL))).workspace, a);
  });
});

describe('V4: 合并语义', () => {
  it('新增条目带来源与合并时刻', () => {
    const ws = workspace('ws1', [lineOf(teach('遇到网络故障先停下并申请代理'))]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')], today: '2026-11-02' });
    assert.equal(r.applied, 1);
    const e = readHabits().entries;
    assert.equal(e.length, 1);
    assert.equal(e[0].observation, '遇到网络故障先停下并申请代理');
    assert.equal(e[0].source, `workspace:${ws}`);
    assert.ok(e[0].mergedAt);
    assert.equal(e[0].hits, 1);
  });

  it('重复运行不重复合并（偏移推进）', () => {
    workspace('ws1', [lineOf(teach('解决问题优先选最简路径'))]);
    mergeHabitProposals({ roots: [join(home, 'projects')] });
    const r2 = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r2.applied, 0);
    assert.equal(readHabits().entries.length, 1);
  });

  it('同批次重复投递只生效一次', () => {
    workspace('ws1', [lineOf(teach('观察文本重复投递测试')), lineOf(teach('观察文本重复投递测试'))]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r.applied, 1);
    assert.equal(readHabits().entries.length, 1);
  });

  it('hit 命中 +1 并更新 lastHit；未命中记拒绝', () => {
    writeHabits({ entries: [{ type: 'style', observation: '先给结论再给依据', evidence: 'e', recorded: '2026-11-01', hits: 1, lastHit: '2026-11-01' }] });
    workspace('ws1', [
      lineOf({ event: 'hit', target: '先给结论再给依据' }),
      lineOf({ event: 'hit', target: '完全不存在的一条偏好' }),
    ]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')], today: '2026-11-02' });
    assert.equal(r.hits, 1);
    assert.equal(r.rejected.length, 1);
    const e = readHabits().entries[0];
    assert.equal(e.hits, 2);
    assert.equal(e.lastHit, '2026-11-02');
  });

  it('同主题新条目覆盖旧条目（updatedFrom）', () => {
    writeHabits({ entries: [{ type: 'style', observation: '遇到网络故障先停下并申请代理', evidence: 'e', recorded: '2026-10-21', hits: 2, lastHit: '2026-10-21' }] });
    workspace('ws1', [lineOf(teach('遇到网络故障时先停下并向用户申请代理', { recorded: '2026-11-02' }))]);
    mergeHabitProposals({ roots: [join(home, 'projects')] });
    const e = readHabits().entries;
    assert.equal(e.length, 1);
    assert.match(e[0].updatedFrom, /网络故障/);
  });

  it('每轮 teach 限流，剩余留待下一轮', () => {
    const many = Array.from({ length: DEFAULT_TEACH_CAP + 2 }, (_, i) => lineOf(teach(`第 ${i} 条观察文本内容`)));
    workspace('ws1', many);
    const r1 = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r1.applied, DEFAULT_TEACH_CAP);
    assert.ok(r1.files.some((f) => f.deferred), '应记录限流留待');
    const r2 = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r2.applied, 2);
  });

  it('非法行被拒绝且不阻塞后续行', () => {
    workspace('ws1', ['{bad}\n', lineOf(teach('合法的一条观察文本'))]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r.rejected.length, 1);
    assert.equal(r.applied, 1);
  });

  it('dry-run 不写库、不推进偏移', () => {
    workspace('ws1', [lineOf(teach('dry-run 不应落库的观察'))]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')], dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.applied, 1);
    assert.equal(existsSync(HABITS_FILE()), false);
    assert.equal(existsSync(ingestPaths().state), false, '状态文件不应被创建');
  });

  it('容量上限触发末位淘汰', () => {
    const entries = Array.from({ length: CAPACITY }, (_, i) => ({
      type: 'style', observation: `历史条目 ${i} 文本`, evidence: 'e',
      recorded: '2026-01-01', hits: 1, lastHit: '2026-01-01',
    }));
    writeHabits({ entries });
    workspace('ws1', [lineOf(teach('新学到的一条偏好内容'))]);
    const r = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r.evicted, 1);
    assert.equal(readHabits().entries.length, CAPACITY);
  });

  it('文件被截断后偏移归零重读', () => {
    const ws = workspace('ws1', [lineOf(teach('第一轮写入的观察文本'))]);
    mergeHabitProposals({ roots: [join(home, 'projects')] });
    // 模拟 vacuum/截断：文件清空后写入新内容
    writeFileSync(join(ws, PROPOSAL_REL), '');
    writeFileSync(join(ws, PROPOSAL_REL), lineOf(teach('截断之后的新观察文本')));
    const r = mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(r.applied, 1);
    assert.ok(readHabits().entries.some((e) => e.observation === '截断之后的新观察文本'));
  });
});

describe('V5: 待合并计数与 vacuum', () => {
  it('countPendingProposals 统计未合并行', () => {
    workspace('ws1', [lineOf(teach('待合并计数测试观察'))]);
    assert.equal(countPendingProposals({ roots: [join(home, 'projects')] }).total, 1);
    mergeHabitProposals({ roots: [join(home, 'projects')] });
    assert.equal(countPendingProposals({ roots: [join(home, 'projects')] }).total, 0);
  });

  it('vacuum 清空已合并前缀并重置偏移', () => {
    const ws = workspace('ws1', [lineOf(teach('vacuum 前缀清理测试'))]);
    mergeHabitProposals({ roots: [join(home, 'projects')] });
    const r = vacuumProposals({ roots: [join(home, 'projects')] });
    assert.equal(r.vacuumed.length, 1);
    assert.equal(readFileSync(join(ws, PROPOSAL_REL), 'utf8'), '');
    assert.equal(countPendingProposals({ roots: [join(home, 'projects')] }).total, 0);
  });
});
