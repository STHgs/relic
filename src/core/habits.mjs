// =============================================================================
// src/core/habits.mjs — habit 学习库 v2（重计算下放 sync 管线）
// =============================================================================
// 架构（2026-09-30 用户拍板，Q1-Q5+Q7-Q8）：
//   agent 侧（对话内，事件触发，极轻）：
//     - 收尾二值自省："本轮我调整了输出方式吗"（无工具调用）
//     - 有感轮：写入原始条目 {type, observation, evidence, recorded}
//     - 顺手 hits 更新（本轮用到了哪条它自己知道）
//   relic 侧（sync 时离线，每 5 分钟，零对话成本）：
//     - 衰减排序：score = hits × 0.7^(距 lastHit 周数)
//     - 末位淘汰：容量 30 满 → score 最低者出局（无留痕，Q6 砍除）
//     - 头部提取：前 3 条烘进 AGENTS.md（常驻注入）
//     - 固化候选检测：hits≥3 且排序前 2 且存活≥7 天 → 渲染固化提示
//   矛盾消解（Q7）：写入时若与现有条目语义冲突 → 新覆盖旧（updated-from）
//   两层注入（Q8）：常驻头部 3 条 + 按需 Read 全库（Letta core/archival）
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { userHome } from './exec.mjs';
import { posix } from 'path';

const pj = posix.join;

export const HABITS_DIR = () => pj(userHome(), '.config', 'relic-habits');
export const HABITS_FILE = () => pj(HABITS_DIR(), 'learned.yaml');

// ─── 常量（用户拍板参数） ───────────────────────────────────────────────

export const CAPACITY = 30;        // Q2: 库容量上限
export const INJECT_TOP = 3;       // Q3: 常驻注入头部条数
export const SOLIDIFY_MIN_HITS = 3;   // Q4: 固化门槛——绝对热度
export const SOLIDIFY_TOP_RANK = 2;   // Q4: 固化门槛——相对位置
export const SOLIDIFY_MIN_AGE_DAYS = 7; // Q4: 固化门槛——存活期
const DECAY_PER_WEEK = 0.7;        // 衰减系数（每过一周 score 乘 0.7）

// ─── 库读写（YAML 手写序列化——零依赖，与 learned.yaml 现有格式兼容） ────

/**
 * 读 habit 库。不存在/损坏返回 { entries: [] }（v1 首次部署预创建保证存在）。
 * @returns {{entries: object[]}}
 */
export function readHabits() {
  try {
    const raw = readFileSync(HABITS_FILE(), 'utf8');
    return parseHabitsYaml(raw);
  } catch {
    return { entries: [] };
  }
}

/**
 * 写库（原子写——先序列化后整体替换）。
 * @param {{entries: object[]}} data
 */
export function writeHabits(data) {
  mkdirSync(HABITS_DIR(), { recursive: true });
  writeFileSync(HABITS_FILE(), serializeHabitsYaml(data));
}

// ─── v1→v2 迁移：补 hits/lastHit 字段 ──────────────────────────────────

/**
 * 迁移旧库条目：无 hits 的补 hits:1, lastHit:recorded。
 * 幂等——已是 v2 格式的条目原样保留。
 * @param {object[]} entries
 * @returns {object[]} v2 格式条目
 */
export function migrateEntries(entries) {
  return entries.map((e) => ({
    type: e.type || 'style',
    observation: e.observation || '',
    evidence: e.evidence || '',
    recorded: e.recorded || new Date().toISOString().slice(0, 10),
    hits: typeof e.hits === 'number' ? e.hits : 1,
    lastHit: e.lastHit || e.recorded || new Date().toISOString().slice(0, 10),
    ...(e.updatedFrom ? { updatedFrom: e.updatedFrom } : {}),
  }));
}

// ─── 衰减排序（sync 管线核心计算） ─────────────────────────────────────

function daysBetween(a, b) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.max(0, (db - da) / 86400000);
}

/**
 * 计算单条衰减分。
 * @param {object} entry
 * @param {string} [now] ISO 日期（缺省今天）
 * @returns {number} score = hits × 0.7^(距 lastHit 周数)
 */
export function decayScore(entry, now = new Date().toISOString().slice(0, 10)) {
  const weeks = daysBetween(entry.lastHit || entry.recorded, now) / 7;
  return (entry.hits || 1) * Math.pow(DECAY_PER_WEEK, weeks);
}

/**
 * 全库排序（衰减分降序）。不修改原数组。
 * @param {object[]} entries
 * @returns {object[]} 排序后副本
 */
export function sortByDecay(entries, now) {
  return [...entries].sort((a, b) => decayScore(b, now) - decayScore(a, now));
}

// ─── 末位淘汰（容量管理，无留痕——Q6 砍除） ────────────────────────────

/**
 * 容量超限时淘汰末位。返回淘汰后的条目数组。
 * @param {object[]} entries
 * @returns {{kept: object[], evicted: object[]}}
 */
export function evictOverflow(entries) {
  if (entries.length <= CAPACITY) return { kept: entries, evicted: [] };
  const sorted = sortByDecay(entries);
  const kept = sorted.slice(0, CAPACITY);
  const evicted = sorted.slice(CAPACITY);
  return { kept, evicted };
}

// ─── 固化候选检测（三门槛：热度+位置+存活期） ───────────────────────────

/**
 * 检测够格申请固化的条目。
 * 门槛（Q4）：hits≥3 且 衰减排序前 2 且 recorded 距今≥7 天。
 * @param {object[]} entries
 * @param {string} [now]
 * @returns {object[]} 固化候选（最多 SOLIDIFY_TOP_RANK 条）
 */
export function detectSolidifyCandidates(entries, now = new Date().toISOString().slice(0, 10)) {
  const sorted = sortByDecay(entries, now);
  return sorted
    .slice(0, SOLIDIFY_TOP_RANK)
    .filter((e) =>
      (e.hits || 0) >= SOLIDIFY_MIN_HITS &&
      daysBetween(e.recorded, now) >= SOLIDIFY_MIN_AGE_DAYS
    );
}

// ─── 头部提取（常驻注入） ───────────────────────────────────────────────

/**
 * 提取头部 N 条（渲染进 AGENTS.md 的常驻注入）。
 * @param {object[]} entries
 * @param {number} [n=INJECT_TOP]
 * @returns {object[]}
 */
export function topEntries(entries, n = INJECT_TOP, now) {
  return sortByDecay(entries, now).slice(0, n);
}

// ─── 渲染视图（注入产物的显式输入——渲染器纯度不变量） ──────────────────
// 事故背景（2026-10-09）：habits-v2 曾让渲染器直接读本机库 → golden 基线随本机
// 状态漂移，门禁在别的机器必然失败（CI 红 / sync 卡死）。修复=读取在管线侧，
// 渲染器只吃视图；易变视图进确定性输入签名（见 src/core/skeleton.mjs）。

/**
 * 本机库文件内容摘要（易变区溯源展示；不存在/损坏 → 'none'）。
 * @returns {string} 8 位 hex
 */
export function habitsStoreDigest() {
  try {
    return createHash('sha256').update(readFileSync(HABITS_FILE(), 'utf8')).digest('hex').slice(0, 8);
  } catch {
    return 'none';
  }
}

/**
 * 渲染日期解析：显式传参 > SOURCE_DATE_EPOCH（可复现构建惯例，[规范](https://reproducible-builds.org/specs/source-date-epoch/)）> 今天。
 * @param {string} [explicit]
 * @returns {string} YYYY-MM-DD
 */
export function resolveRenderDate(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const sde = process.env.SOURCE_DATE_EPOCH;
  if (sde && /^\d+$/.test(sde)) {
    const d = new Date(Number(sde) * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * 构建渲染视图（纯函数）：本机库 → 渲染器唯一需要的结构。
 * @param {object[]} entries
 * @param {string} [now] YYYY-MM-DD（显式=可测可复现；缺省走 resolveRenderDate）
 * @param {string} [digest] 库摘要（仅溯源展示）
 * @returns {{date:string, digest:string, top:object[], solidify:object[]}}
 */
export function buildHabitsView(entries, now = resolveRenderDate(), digest = 'none') {
  const pick = (e) => ({ observation: e.observation || '', evidence: e.evidence || '', hits: e.hits || 1 });
  return {
    date: now,
    digest,
    top: topEntries(entries, INJECT_TOP, now).map(pick),
    solidify: detectSolidifyCandidates(entries, now).map(pick),
  };
}

/**
 * 读本机库并构建视图（管线侧调用：generate CLI / pipeline；渲染器不调用）。
 * @param {{now?:string}} [opts]
 * @returns {{date:string, digest:string, top:object[], solidify:object[]}}
 */
export function loadHabitsView(opts = {}) {
  return buildHabitsView(readHabits().entries, opts.now ?? resolveRenderDate(), habitsStoreDigest());
}

// ─── 矛盾消解（Q7：新覆盖旧） ──────────────────────────────────────────

/**
 * 简易语义近似：观察文本的 token 重叠率 ≥ 阈值视为同主题冲突。
 * （纯提示词架构无嵌入模型——用词面重叠做保守近似，宁漏判不误杀）
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function similarText(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/\s+/).filter((w) => w.length > 1));
  const tb = new Set(String(b).toLowerCase().split(/\s+/).filter((w) => w.length > 1));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.min(ta.size, tb.size) >= 0.5;
}

/**
 * 写入新条目（含矛盾消解 + 容量淘汰）。
 * 冲突：与现有条目观察文本相似 → 新条目覆盖旧条目（updatedFrom 标注旧观察）。
 * @param {{entries: object[]}} data
 * @param {object} newEntry {type, observation, evidence}
 * @returns {{entries: object[], replaced: object|null, evicted: object[]}}
 */
export function addEntry(data, newEntry) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = {
    type: newEntry.type || 'style',
    observation: newEntry.observation || '',
    evidence: newEntry.evidence || '',
    recorded: today,
    hits: 1,
    lastHit: today,
  };

  let entries = [...(data.entries || [])];
  let replaced = null;

  // 矛盾消解：找同主题旧条目
  const idx = entries.findIndex((e) => similarText(e.observation, entry.observation));
  if (idx !== -1) {
    replaced = entries[idx];
    entry.updatedFrom = replaced.observation;
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  // 容量淘汰
  const { kept, evicted } = evictOverflow(entries);
  return { entries: kept, replaced, evicted };
}

// ─── 预创建（部署管线调用——治"不存在报错"Q5） ──────────────────────────

/**
 * 部署时预创建空库（带格式注释头）。幂等——已存在不覆盖。
 * @returns {boolean} 是否实际创建
 */
export function ensureHabitsStore() {
  if (existsSync(HABITS_FILE())) return false;
  writeHabits({ entries: [] });
  return true;
}

// ─── YAML 手写序列化/解析（v2 schema，零依赖） ─────────────────────────

function serializeHabitsYaml(data) {
  const lines = [
    '# relic 学习库 v2（L3）——本机 agent 自主维护，不入 git，上限 30 条',
    '# 优先级：助手人设（声明层）> 本 session 新学习 > 本文件历史条目',
    '# 字段：hits=命中次数 lastHit=最近命中（衰减排序依据）updatedFrom=矛盾覆盖溯源',
    'entries:',
  ];
  for (const e of data.entries || []) {
    lines.push(`  - type: ${e.type || 'style'}`);
    lines.push(`    observation: ${e.observation}`);
    lines.push(`    evidence: ${e.evidence || ''}`);
    lines.push(`    recorded: ${e.recorded}`);
    lines.push(`    hits: ${e.hits || 1}`);
    lines.push(`    lastHit: ${e.lastHit || e.recorded}`);
    if (e.updatedFrom) lines.push(`    updatedFrom: ${e.updatedFrom}`);
  }
  if ((data.entries || []).length === 0) lines.push('  []');
  return lines.join('\n') + '\n';
}

function parseHabitsYaml(raw) {
  const entries = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'entries:') continue;
    if (trimmed === '[]' || trimmed === '') continue;
    if (trimmed.startsWith('- type:')) {
      if (cur) entries.push(cur);
      cur = { type: trimmed.slice(7).trim() };
    } else if (cur) {
      const m = trimmed.match(/^(\w+):\s*(.*)$/);
      if (m) cur[m[1]] = m[2];
      // 数值字段
      if (m && (m[1] === 'hits')) cur[m[1]] = parseInt(m[2], 10) || 1;
    }
  }
  if (cur) entries.push(cur);
  return { entries };
}
