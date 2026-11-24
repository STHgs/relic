// =============================================================================
// src/core/habits-ingest.mjs — 习惯提案合并（habits v3：agent 只写工作区）
// =============================================================================
// 设计不变量（2026-11-02 用户拍板）：
//   I1 agent 只在【当前工作区】的 .relic/habits-proposals.jsonl 追加提案行，
//      不再写 ~/.config/relic-habits（沙箱常态下工作区外写必被拒）。
//   I2 引擎（未沙箱，sync 每 5 分钟）只【读】提案、只【写】HABITS_DIR，
//      不修改用户项目里的任何文件（续读偏移记在 HABITS_DIR/ingest-state.json）。
//   I3 渲染器仍纯函数：合并发生在管线侧，视图注入方式不变。
//   I4 学习语义不变：衰减/容量 30/头部 3 条/固化三门槛照旧（复用 habits.mjs）。
//   I5 限流防投毒：每轮 ≤5 条 teach、≤20 条 hit；evidence 必填；拒绝项记审计。
//
// 提案行（JSONL，每行一个对象）：
//   {"event":"teach","type":"feedback","observation":"…","evidence":"…","recorded":"YYYY-MM-DD"}
//   {"event":"hit","target":"<已有条目的观察文本片段>"}
//
// 幂等：偏移量与库内容分两步写；崩溃后重放由批次内去重（内容哈希）兜住。
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { posix } from 'path';
import { createHash } from 'crypto';
import { HABITS_DIR, readHabits, writeHabits, addEntry, registerHit, evictOverflow } from './habits.mjs';
import { userHome } from './exec.mjs';

const pj = posix.join;

// ─── 常量（用户拍板默认值） ─────────────────────────────────────────────

export const PROPOSAL_REL = pj('.relic', 'habits-proposals.jsonl');
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_TEACH_CAP = 5;
export const DEFAULT_HIT_CAP = 20;
export const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.venv', 'venv', 'target', '__pycache__']);
export const DEFAULT_ROOTS = ['AIworkspace', 'projects', 'code', 'dev', 'src', 'workspace'];
export const TYPES = new Set(['style', 'feedback', 'workflow', 'reference']);

/** 提案/状态/审计文件路径（全部在 HABITS_DIR 下，机器级、不入内容库）。 */
export function ingestPaths(dir = HABITS_DIR()) {
  return {
    dir,
    sources: pj(dir, 'sources.json'),
    state: pj(dir, 'ingest-state.json'),
    audit: pj(dir, 'audit.log'),
  };
}

// ─── 扫描根注册表（机器级；缺省探测常见目录） ───────────────────────────

/**
 * 读扫描根配置。文件缺失 → 探测常见根（只取存在的）；损坏 → 同样回退。
 * @param {string} [root] HABITS_DIR 覆盖（测试用）
 * @param {{existsSync?:Function, readFileSync?:Function, home?:string}} [io]
 * @returns {{roots:string[], maxDepth:number, maxFilesPerRun:number, maxBytesPerFile:number, origin:'file'|'default'|'corrupt'}}
 */
export function readSources(root = HABITS_DIR(), io = {}) {
  const fsx = { existsSync, readFileSync, ...io };
  const home = io.home || userHome();
  const paths = ingestPaths(root);
  const defaults = DEFAULT_ROOTS.map((r) => pj(home, r)).filter((p) => fsx.existsSync(p));
  const base = { roots: defaults, maxDepth: DEFAULT_MAX_DEPTH, maxFilesPerRun: DEFAULT_MAX_FILES, maxBytesPerFile: DEFAULT_MAX_BYTES, origin: 'default' };
  if (!fsx.existsSync(paths.sources)) return base;
  try {
    const doc = JSON.parse(fsx.readFileSync(paths.sources, 'utf8'));
    const roots = Array.isArray(doc.roots)
      ? doc.roots.filter((r) => typeof r === 'string' && r.length > 0).map((r) => resolve(r))
      : [];
    return {
      roots,
      maxDepth: Number.isInteger(doc.maxDepth) ? doc.maxDepth : DEFAULT_MAX_DEPTH,
      maxFilesPerRun: Number.isInteger(doc.maxFilesPerRun) ? doc.maxFilesPerRun : DEFAULT_MAX_FILES,
      maxBytesPerFile: Number.isInteger(doc.maxBytesPerFile) ? doc.maxBytesPerFile : DEFAULT_MAX_BYTES,
      origin: 'file',
    };
  } catch {
    return { ...base, origin: 'corrupt' };
  }
}

/**
 * 写扫描根配置（机器级；`--add-root` / 控制台用）。
 * @param {string[]} roots
 * @param {string} [root]
 * @returns {string[]} 规范化后的绝对路径
 */
export function writeSources(roots, root = HABITS_DIR()) {
  mkdirSync(root, { recursive: true });
  const abs = [...new Set(roots.map((r) => resolve(r)))];
  writeFileSync(ingestPaths(root).sources, JSON.stringify({
    version: 1,
    roots: abs,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxFilesPerRun: DEFAULT_MAX_FILES,
    maxBytesPerFile: DEFAULT_MAX_BYTES,
  }, null, 2) + '\n');
  return abs;
}

// ─── 发现提案文件 ───────────────────────────────────────────────────────

/**
 * 在扫描根下查找 <workspace>/.relic/habits-proposals.jsonl（深度受限、跳过噪声目录）。
 * @param {{roots:string[], maxDepth?:number, maxFilesPerRun?:number, maxBytesPerFile?:number}} sources
 * @param {{readdirSync?:Function, statSync?:Function, existsSync?:Function}} [io]
 * @returns {{files:{path:string, workspace:string}[], skipped:{path:string, reason:string}[]}}
 */
export function discoverProposalFiles(sources, io = {}) {
  const fsx = { readdirSync, statSync, existsSync, ...io };
  const files = [];
  const skipped = [];
  const maxDepth = sources.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = sources.maxFilesPerRun ?? DEFAULT_MAX_FILES;

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let names;
    try { names = fsx.readdirSync(dir); } catch { return; }
    if (names.includes('.relic')) {
      const cand = join(dir, PROPOSAL_REL);
      if (fsx.existsSync(cand)) {
        let st = null;
        try { st = fsx.statSync(cand); } catch { st = null; }
        if (st && st.isFile()) {
          if (files.length >= limit) skipped.push({ path: cand, reason: `超过每轮文件上限（${limit}）` });
          else if (st.size > (sources.maxBytesPerFile ?? DEFAULT_MAX_BYTES)) skipped.push({ path: cand, reason: '超过单文件字节上限' });
          else files.push({ path: cand, workspace: dir });
        }
      }
    }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const child = join(dir, name);
      let st = null;
      try { st = fsx.statSync(child); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(child, depth + 1);
    }
  };

  for (const r of sources.roots || []) {
    let st = null;
    try { st = fsx.statSync(r); } catch { st = null; }
    if (!st || !st.isDirectory()) { skipped.push({ path: r, reason: '扫描根不存在' }); continue; }
    walk(r, 0);
  }
  return { files, skipped };
}

// ─── 解析与校验（按字节偏移续读，半行留待下次） ─────────────────────────

/**
 * 从 offset 起解析提案。只消费完整行（以 \n 结尾）；结尾半行不合并。
 * 每条 record/reject 带 endOffset（该行结束处的绝对字节偏移），供偏移推进。
 * @param {Buffer|string} buf 文件内容
 * @param {number} [offset] 字节偏移
 * @returns {{records:{line:number, obj:object, endOffset:number}[], rejects:{line:number, reason:string, raw:string, endOffset:number}[], nextOffset:number}}
 */
export function parseProposalBuffer(buf, offset = 0) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  const start = offset > b.length || offset < 0 ? 0 : offset;
  const text = b.subarray(start).toString('utf8');
  const cut = text.lastIndexOf('\n');
  const complete = cut === -1 ? '' : text.slice(0, cut + 1);
  const nextOffset = start + Buffer.byteLength(complete, 'utf8');

  const records = [];
  const rejects = [];
  let cursor = start;
  let lineNo = 0;
  for (const raw of complete.split('\n')) {
    if (raw === '' && cursor >= nextOffset) break;
    const endOffset = cursor + Buffer.byteLength(raw, 'utf8') + 1;  // +1 = '\n'
    cursor = endOffset;
    lineNo += 1;
    if (raw.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(raw); } catch {
      rejects.push({ line: lineNo, reason: 'JSON 解析失败', raw: raw.slice(0, 120), endOffset });
      continue;
    }
    const v = validateRecord(obj);
    if (!v.ok) { rejects.push({ line: lineNo, reason: v.reason, raw: raw.slice(0, 120), endOffset }); continue; }
    records.push({ line: lineNo, obj, endOffset });
  }
  return { records, rejects, nextOffset };
}

/**
 * 校验一条提案。
 * @param {any} obj
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: '不是对象' };
  if (obj.event === 'teach') {
    if (!TYPES.has(obj.type)) return { ok: false, reason: 'type 非法（style|feedback|workflow|reference）' };
    const obs = String(obj.observation ?? '').trim();
    if (obs.length < 4 || obs.length > 200) return { ok: false, reason: 'observation 长度须 4–200' };
    if (/[\r\n]/.test(obs)) return { ok: false, reason: 'observation 不得含换行' };
    const evid = String(obj.evidence ?? '').trim();
    if (evid.length < 1 || evid.length > 200) return { ok: false, reason: 'evidence 必填且 ≤200' };
    if (obj.recorded !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(obj.recorded))) return { ok: false, reason: 'recorded 须 YYYY-MM-DD' };
    return { ok: true };
  }
  if (obj.event === 'hit') {
    const target = String(obj.target ?? '').trim();
    if (target.length < 4 || target.length > 200) return { ok: false, reason: 'target 长度须 4–200' };
    return { ok: true };
  }
  return { ok: false, reason: 'event 非法（teach|hit）' };
}

// ─── 状态文件（续读偏移）与审计 ─────────────────────────────────────────

const PREFIX_BYTES = 64;
const prefixHash = (buf) => createHash('sha256').update(buf.subarray(0, Math.min(PREFIX_BYTES, buf.length))).digest('hex').slice(0, 16);

/**
 * 解析安全偏移：文件被截断/替换（前缀哈希变化或变短）时归零重读。
 * @param {Buffer} buf
 * @param {{offset?:number, prefixHash?:string}|undefined} stateEntry
 * @returns {{offset:number, prefixHash:string}}
 */
export function resolveOffset(buf, stateEntry) {
  const ph = prefixHash(buf);
  const prev = stateEntry?.offset ?? 0;
  if (prev <= 0) return { offset: 0, prefixHash: ph };
  if (prev > buf.length) return { offset: 0, prefixHash: ph };
  if (stateEntry?.prefixHash && stateEntry.prefixHash !== ph) return { offset: 0, prefixHash: ph };
  return { offset: prev, prefixHash: ph };
}


export function readIngestState(root = HABITS_DIR(), io = {}) {
  const fsx = { existsSync, readFileSync, ...io };
  const paths = ingestPaths(root);
  if (!fsx.existsSync(paths.state)) return { version: 1, files: {} };
  try {
    const doc = JSON.parse(fsx.readFileSync(paths.state, 'utf8'));
    if (!doc || typeof doc !== 'object' || typeof doc.files !== 'object' || doc.files === null) return { version: 1, files: {} };
    return { version: 1, files: doc.files };
  } catch {
    return { version: 1, files: {} };
  }
}

export function writeIngestState(state, root = HABITS_DIR()) {
  mkdirSync(root, { recursive: true });
  writeFileSync(ingestPaths(root).state, JSON.stringify({ version: 1, files: state.files || {} }, null, 2) + '\n');
}

function appendAudit(entry, root = HABITS_DIR()) {
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(ingestPaths(root).audit, JSON.stringify(entry) + '\n');
  } catch { /* 审计失败不阻塞合并 */ }
}

// ─── 待合并行数（控制台/status 用，只读） ───────────────────────────────

/**
 * 统计各文件尚未合并的提案行数（完整行计数）。不写任何文件。
 * @param {{root?:string, roots?:string[], io?:object}} [opts]
 * @returns {{files:{path:string, workspace:string, pending:number}[], total:number, roots:string[], skipped:object[]}}
 */
export function countPendingProposals(opts = {}) {
  const io = opts.io || {};
  const fsx = { existsSync, readFileSync, ...io };
  const base = readSources(opts.root, io);
  const sources = opts.roots ? { ...base, roots: opts.roots.map((r) => resolve(r)) } : base;
  const { files, skipped } = discoverProposalFiles(sources, io);
  const state = readIngestState(opts.root, io);
  const out = [];
  let total = 0;
  for (const f of files) {
    let buf;
    try { buf = fsx.readFileSync(f.path); } catch { continue; }
    const start = resolveOffset(buf, state.files?.[f.path]).offset;
    const text = buf.subarray(start).toString('utf8');
    const cut = text.lastIndexOf('\n');
    const complete = cut === -1 ? '' : text.slice(0, cut + 1);
    const pending = complete.split('\n').filter((l) => l.trim() !== '').length;
    total += pending;
    out.push({ path: f.path, workspace: f.workspace, pending });
  }
  return { files: out, total, roots: sources.roots, skipped };
}

// ─── 合并主流程 ─────────────────────────────────────────────────────────

/**
 * 执行一次提案合并。
 * @param {object} [opts]
 * @param {string} [opts.root] HABITS_DIR 覆盖（测试用）
 * @param {boolean} [opts.dryRun] 只计算不写库/不推进偏移
 * @param {string[]} [opts.roots] 临时覆盖扫描根
 * @param {string} [opts.today] YYYY-MM-DD（决定性测试用）
 * @param {number} [opts.teachCap]
 * @param {number} [opts.hitCap]
 * @param {object} [opts.io] fs 注入（测试用）
 * @param {boolean} [opts.audit] 默认 true；dry-run 恒不写
 * @returns {{ok:boolean, dryRun:boolean, roots:string[], scanned:number, applied:number, hits:number,
 *            rejected:{path:string, line:number, reason:string}[], evicted:number,
 *            files:{path:string, records:number, applied:number, hits:number, nextOffset:number}[],
 *            skipped:{path:string, reason:string}[]}}
 */
export function mergeHabitProposals(opts = {}) {
  const root = opts.root || HABITS_DIR();
  const io = opts.io || {};
  const fsx = { existsSync, readFileSync, ...io };
  const dryRun = opts.dryRun === true;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const mergedAt = new Date().toISOString();
  const teachCap = Number.isInteger(opts.teachCap) ? opts.teachCap : DEFAULT_TEACH_CAP;
  const hitCap = Number.isInteger(opts.hitCap) ? opts.hitCap : DEFAULT_HIT_CAP;

  const base = readSources(root, io);
  const sources = opts.roots ? { ...base, roots: opts.roots.map((r) => resolve(r)) } : base;
  const { files, skipped } = discoverProposalFiles(sources, io);
  const state = readIngestState(root, io);

  let entries = readHabits().entries;
  const rejected = [];
  const seenBatch = new Set();
  const perFile = [];
  let applied = 0;
  let hitsApplied = 0;
  let evicted = 0;

  for (const f of files) {
    let buf;
    try { buf = fsx.readFileSync(f.path); } catch { skipped.push({ path: f.path, reason: '读取失败' }); continue; }
    const resolved = resolveOffset(buf, state.files?.[f.path]);
    const prevOffset = resolved.offset;
    const offset = resolved.offset;
    const parsed = parseProposalBuffer(buf, offset);
    let lastConsumed = offset;
    let fileApplied = 0;
    let fileHits = 0;
    let deferred = false;

    // 拒绝项永久消费（记审计并通过其字节）
    for (const r of parsed.rejects) {
      rejected.push({ path: f.path, line: r.line, reason: r.reason });
      lastConsumed = r.endOffset;
    }

    // 按顺序消费；遇限流则停在本行之前（后续行留到下一轮，保持顺序）
    for (const r of parsed.records) {
      const obj = r.obj;
      const norm = String(obj.event === 'hit' ? obj.target : obj.observation ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const key = createHash('sha256').update(`${obj.event}|${obj.type || ''}|${norm}`).digest('hex');
      if (seenBatch.has(key)) { lastConsumed = r.endOffset; continue; }  // 批次内重复只算一次
      seenBatch.add(key);

      if (obj.event === 'teach') {
        if (applied >= teachCap) { deferred = true; break; }
        const res = addEntry({ entries }, {
          type: obj.type,
          observation: String(obj.observation).trim(),
          evidence: String(obj.evidence).trim(),
          recorded: obj.recorded,
        }, { source: `workspace:${f.workspace}`, mergedAt, today });
        entries = res.entries;
        applied += 1;
        evicted += (res.evicted || []).length;   // addEntry 内部已做容量淘汰
        fileApplied += 1;
        lastConsumed = r.endOffset;
      } else {
        if (hitsApplied >= hitCap) { deferred = true; break; }
        const res = registerHit(entries, String(obj.target).trim(), today);
        if (!res.matched) {
          rejected.push({ path: f.path, line: r.line, reason: 'hit 未匹配到条目' });
        } else {
          entries = res.entries;
          hitsApplied += 1;
          fileHits += 1;
        }
        lastConsumed = r.endOffset;
      }
    }

    const nextOffset = lastConsumed;
    perFile.push({ path: f.path, records: parsed.records.length, applied: fileApplied, hits: fileHits, nextOffset, deferred });
    if (!dryRun) {
      state.files[f.path] = { offset: nextOffset, prefixHash: resolved.prefixHash, lastMergedAt: mergedAt };
    }
  }

  let finalEntries = entries;
  if (!dryRun) {
    const r = evictOverflow(finalEntries);
    finalEntries = r.kept;
    evicted += r.evicted.length;
    writeHabits({ entries: finalEntries });
    writeIngestState(state, root);
    if (opts.audit !== false) {
      appendAudit({
        ts: mergedAt,
        roots: sources.roots,
        scanned: files.length,
        applied,
        hits: hitsApplied,
        rejected: rejected.length,
        evicted,
      }, root);
    }
  }

  return {
    ok: true,
    dryRun,
    roots: sources.roots,
    scanned: files.length,
    applied,
    hits: hitsApplied,
    rejected,
    evicted,
    files: perFile,
    skipped,
  };
}

// ─── 维护：清空已合并前缀（用户显式执行） ───────────────────────────────

/**
 * 把已合并的前缀从提案文件中移除（`--vacuum`）。会截断文件，
 * 与并发写入存在冲突风险 → 仅建议在无 agent 会话时手动执行。
 * @param {{root?:string, roots?:string[], io?:object}} [opts]
 * @returns {{vacuumed:{path:string, removedBytes:number}[], skipped:object[]}}
 */
export function vacuumProposals(opts = {}) {
  const root = opts.root || HABITS_DIR();
  const io = opts.io || {};
  const fsx = { existsSync, readFileSync, writeFileSync, ...io };
  const base = readSources(root, io);
  const sources = opts.roots ? { ...base, roots: opts.roots.map((r) => resolve(r)) } : base;
  const { files, skipped } = discoverProposalFiles(sources, io);
  const state = readIngestState(root, io);
  const vacuumed = [];
  for (const f of files) {
    let buf;
    try { buf = fsx.readFileSync(f.path); } catch { skipped.push({ path: f.path, reason: '读取失败' }); continue; }
    const offset = Math.min(state.files?.[f.path]?.offset ?? 0, buf.length);
    if (offset <= 0) continue;
    fsx.writeFileSync(f.path, buf.subarray(offset));
    state.files[f.path] = { offset: 0, lastMergedAt: new Date().toISOString() };
    vacuumed.push({ path: f.path, removedBytes: offset });
  }
  if (vacuumed.length > 0) writeIngestState(state, root);
  return { vacuumed, skipped };
}
