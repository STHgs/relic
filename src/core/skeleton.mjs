// =============================================================================
// src/core/skeleton.mjs — 静态骨架门禁（计划 v6：骨架等价检查）
// =============================================================================
// 原则（用户拍板 2026-09-14）：
//   1. 骨架是静态的：骨架 = 渲染器的唯一函数，与用户内容（modules/policies）无关
//   2. 用户区提交触碰骨架 = 违法
//   3. 骨架变更唯一合法路径：renderer + golden 基准同一提交更新（系统级变更）
//
// 机制：
//   - 探针策略（schema 合法、每个数据槽位放 PROBE_MARK 项）→ render → golden 基准
//   - skeletonLines = golden 行 − 探针行 − 结构噪声行（空行/分隔线/表分隔行）
//   - 断言 A（等价）：render(探针) == golden（字节级）——拦"改 renderer 不 bump golden"
//   - 断言 B（确定性守卫 v2）：渲染是**全部输入**（内容commit+golden+渲染器+本机视图）的纯函数；
//     同输入必同输出，输入变即合法重录（v1 的"骨架行不变性"因条件段误报已被实战证伪）
// =============================================================================

import { createHash } from 'crypto';

/** 探针标记：出现在任何数据行中；golden 抽取时被过滤。 */
export const PROBE_MARK = '«skeleton-probe»';

/**
 * 构造探针最小策略：激活渲染器全部骨架分支（含条件段：风险分级/替代方案/索引表/Profile 头）。
 * @returns {object} schema v2 合法的 policies 对象
 */
export function buildProbePolicies() {
  return {
    meta: {
      version: 2,
      description: 'skeleton probe policies (golden render source)',
      evaluation: PROBE_MARK,
      profile: { id: 'probe', name: 'Probe' },
      // habits 视图槽位必须由探针撑满（条件段：偏好表 + ⭐ 固化申请）——否则这些结构
      // 永不进 golden（habits-v2 事故的同类盲区）。取值用 PROBE_MARK：标记行含探针标记
      // → 不进入骨架行集（易变区内容本来就不该被锁，只锁结构）。
      habits: {
        date: PROBE_MARK,
        digest: PROBE_MARK,
        top: [{ observation: PROBE_MARK, evidence: PROBE_MARK, hits: 1 }],
        solidify: [{ observation: PROBE_MARK, evidence: PROBE_MARK, hits: 3 }],
      },
    },
    permissions: [{
      id: 'probe-perm',
      intent: `${PROBE_MARK} probe permission intent`,
      applies_to: ['all'],
      enforcement: 'runtime',
      tool: 'bash',
      action: 'ask',
      patterns: [{ pattern: 'probecmd *', action: 'ask' }],
      alternatives: [PROBE_MARK],
    }],
    workflows: [{
      id: 'probe-wf',
      intent: `${PROBE_MARK} probe workflow`,
      applies_when: PROBE_MARK,
      priority: 'normal',
      steps: [PROBE_MARK],
    }],
    risk_levels: { low: [PROBE_MARK], medium: [PROBE_MARK], high: [PROBE_MARK] },
    personas: [{
      id: 'probe-persona',
      name: PROBE_MARK,
      default: true,
      identity: PROBE_MARK,
      language: PROBE_MARK,
      tone: PROBE_MARK,
      verbosity: 'compact',
      directives: [PROBE_MARK],
    }],
    modules: [],
    profiles: [],
  };
}

/** 结构噪声行：空行、水平分隔线、markdown 表分隔行（多表重复，无法唯一归属骨架）。 */
function isStructuralNoise(line) {
  const t = line.trim();
  // '````' 是哨兵外层围栏对（开/闭各一次，纯标点，与 '---' 同类）
  return t === '' || t === '---' || t === '````' || /^\|(?:-+\|)+$/.test(t);
}

/**
 * 从 golden 文本抽取骨架行集（保序、去探针、去结构噪声）。
 * @param {string} goldenText
 * @returns {{lines: string[], unique: boolean}}
 */
export function extractSkeletonLines(goldenText) {
  const lines = goldenText.split('\n')
    .filter((l) => !l.includes(PROBE_MARK) && !isStructuralNoise(l));
  const seen = new Set();
  let unique = true;
  for (const l of lines) {
    if (seen.has(l)) unique = false;
    seen.add(l);
  }
  return { lines, unique };
}

/**
 * 从任意 render 产出中取出骨架行序列（按 skeletonLines 集合过滤，保序）。
 * @param {string} renderText
 * @param {string[]} skeletonLines golden 抽取出的骨架行集
 * @returns {string[]}
 */
export function skeletonLinesOf(renderText, skeletonLines) {
  const set = new Set(skeletonLines);
  return renderText.split('\n').filter((l) => set.has(l));
}

/** sha256(lines.join('\n')) */
export function hashLines(lines) {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * 断言 A：探针渲染与 golden 字节等价。
 * @returns {{ok:boolean, reason?:string}}
 */
export function assertGolden(probeRender, goldenText) {
  if (probeRender === goldenText) return { ok: true };
  return { ok: false, reason: 'skeleton drift: render(probe) !== golden (renderer changed without golden bump — illegal system change)' };
}

/**
 * 断言 B（v2，确定性守卫）：渲染必须是输入的纯函数。
 * inputSig = hash(内容commit + golden全文 + 渲染器源码 + habits视图)；outputSha = hash(渲染产物)。
 * 输入必须**闭合到全部渲染输入**——机器本地视图（meta.habits）也是渲染输入：漏登记它，
 * 库一改或跨天排序变化就会被误判为"同输入不同输出"（habits-v2 事故的第二层缺陷）。
 * 规则：inputSig 与账本一致而 outputSha 不一致 → 违法（同输入不同输出=非确定性/篡改）；
 * 输入变了 → 重新记录（合法性由断言 A + golden 同提交仪式守护）。
 * v1 教训：v1 比对"匹配骨架行序列"，条件渲染段（人设激活）造成合法序列变化 → 误报。
 * @param {object} p
 * @param {string} p.contentCommit  内容库当前 commit
 * @param {string} p.goldenText     当前 golden 全文
 * @param {string} p.rendererText   当前渲染器源码全文
 * @param {string} p.outputText     当前完整渲染产物
 * @param {object|null} [p.habitsView] 本机习惯视图（渲染输入之一；null=无本机视图）
 * @param {string|null} p.prevInputSig  账本记录的 inputSig（null=首次放行）
 * @param {string|null} p.prevOutputSha 账本记录的 outputSha
 */
export function computeDeterminismState({ contentCommit, goldenText, rendererText, outputText, habitsView = null }) {
  const inputSig = hashLines([
    contentCommit,
    hashLines([goldenText]),
    hashLines([rendererText]),
    hashLines([JSON.stringify(habitsView ?? null)]),
  ]);
  return { inputSig, outputSha: hashLines([outputText]) };
}

/**
 * @returns {{ok:boolean, reason?:string, inputSig:string, outputSha:string, changed:boolean}}
 */
export function checkDeterminism(p) {
  const { inputSig, outputSha } = computeDeterminismState(p);
  if (p.prevInputSig == null || p.prevInputSig !== inputSig) {
    return { ok: true, inputSig, outputSha, changed: true };
  }
  if (p.prevOutputSha !== outputSha) {
    return { ok: false, inputSig, outputSha, changed: false, reason: 'same inputs produced different output (non-deterministic render or tampering) — illegal' };
  }
  return { ok: true, inputSig, outputSha, changed: false };
}
