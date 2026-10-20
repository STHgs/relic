// =============================================================================
// src/render/agents-md.mjs — AGENTS.md 渲染器
// =============================================================================
// 架构：骨架 + 模块索引表
//   - 骨架（固定，不随自定义区变动）：治理约束表（自律执行）、替代方案、风险分级（跨模块合并视图）、学习与适应（机制段）、助手人设（数据段头）、subagent 治理提示、给助手的话
//   - 模块索引表（极小）：workflow id + 触发条件，agent 按需 Read module.yaml
// workflow 详细步骤留在 modules/ 下不渲染进 AGENTS.md；risk_levels 是跨模块合并视图（无单一文件可指），常驻骨架
// =============================================================================

// 纯度不变量（2026-10-09 修复 habits-v2 事故）：
//   渲染器是纯函数——只吃 policies（含显式注入的 meta.habits 视图），
//   不读任何机器本地状态、不取时钟。机器本地数据的读取在管线侧（generate/pipeline）。
//   门禁守护结构（golden），易变内容进 inputSig（见 src/core/skeleton.mjs）。

/** 易变区起始标记：机器本地数据段（结构由 golden 守护，内容随本机库变化）。 */
function volatileBegin(region, view) {
  return `<!-- BEGIN RELIC-VOLATILE:${region} store=${view.digest || 'none'} date=${view.date || 'unknown'} -->`;
}

/** 易变区结束标记。 */
function volatileEnd(region) {
  return `<!-- END RELIC-VOLATILE:${region} -->`;
}

/**
 * 把一条 permission 的 patterns 格式化为表格单元。
 * @param {object} p
 * @returns {string}
 */
function formatPatternsCell(p) {
  const pats = p.patterns || [];
  if (pats.length === 0) return '*';
  return pats.map((item) => {
    const act = item.action || p.action;
    return act !== p.action ? `${item.pattern}→${act}` : item.pattern;
  }).join(', ');
}

const ACTION_ZH = { ask: '中高危——发起前显式声明', deny: '禁止——任何情况不执行', allow: '放行' };
const LEVEL_LABEL = {
  low: '🟢 低风险（直接执行，不用请示）',
  medium: '🟡 中风险（直接发起，但在输出中显式声明风险点）',
  high: '🔴 高风险（仅主助手；发起前必须显式声明理由）',
};

/**
 * 渲染 policies 为 AGENTS.md 文本。
 * @param {object} policies
 * @returns {string}
 */
export function renderAgentsMd(policies) {
  const lines = [];

  lines.push('# Agent 行为治理规则');
  lines.push('');
  lines.push('> 本文件自动生成，请勿手动修改。');
  lines.push('> 修改规则请编辑源 modules/<id>/module.yaml，然后跑 npm run generate。');
  if (policies.meta?.profile) {
    lines.push(`> Profile: ${policies.meta.profile.name} (${policies.meta.profile.id})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // 元规则（评估机制）
  if (policies.meta?.evaluation) {
    lines.push('## 元规则（评估机制）');
    lines.push('');
    lines.push(`> ${policies.meta.evaluation}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // 治理约束表（全量渲染，agent 自律执行——2026-09-15 去硬约束决策）
  const permRows = policies.permissions || [];
  lines.push('## 治理约束（自律执行）');
  lines.push('');
  lines.push('以下约束由你自律执行——运行时不再弹窗拦截。判断标准见「风险分级」。');
  lines.push('**deny 级条目任何情况下不得执行，无例外**；ask 级自行权衡，发起前在输出中显式声明风险与理由。');
  lines.push('');
  lines.push('| 工具 | 匹配模式 | 动作 | 意图 |');
  lines.push('|---|---|---|---|');
  for (const p of permRows) {
    const pats = formatPatternsCell(p);
    const actionZh = ACTION_ZH[p.action] || p.action;
    lines.push(`| ${p.tool} | \`${pats}\` | ${actionZh} | ${p.intent} |`);
  }
  lines.push('');

  // 替代方案
  const withAlts = (policies.permissions || []).filter((p) => p.alternatives && p.alternatives.length > 0);
  if (withAlts.length > 0) {
    lines.push('### 替代方案（受限操作改走什么路）');
    lines.push('');
    for (const p of withAlts) {
      lines.push(`**${p.id}**:`);
      for (const alt of p.alternatives) {
        lines.push(`- ${alt}`);
      }
      lines.push('');
    }
  }

  // 风险分级（跨模块合并视图——没有单一 module.yaml 可指，且约束每个动作的即时判断，常驻骨架）
  if (policies.risk_levels) {
    lines.push('## 风险分级（避免消极回避）');
    lines.push('');
    lines.push('**不要因为害怕审批而回避正常工作。** 按风险等级判断：');
    lines.push('');
    for (const level of ['low', 'medium', 'high']) {
      const items = policies.risk_levels[level];
      if (!items || items.length === 0) continue;
      lines.push(`### ${LEVEL_LABEL[level]}`);
      for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  // 助手人设（L1 声明层：数据段，渲染 default persona；内容自由，骨架不动）
  const personas = policies.personas || [];
  const persona = personas.find((x) => x.default === true) ?? (personas.length === 1 ? personas[0] : undefined);
  if (persona) {
    lines.push('## 助手人设');
    lines.push('');
    lines.push('> 用户声明的工作习惯（声明层）。修改：同步库 policies.yaml 的 personas 段，commit+push 后 5 分钟全域生效。');
    lines.push('');
    if (persona.identity) lines.push(`- **定位**：${persona.identity}`);
    if (persona.language) lines.push(`- **语言**：${persona.language}`);
    if (persona.tone) lines.push(`- **基调**：${persona.tone}`);
    if (persona.verbosity) lines.push(`- **详细度**：${persona.verbosity}`);
    if (persona.directives && persona.directives.length > 0) {
      lines.push('- **常驻指令**：');
      for (const d of persona.directives) lines.push(`  - ${d}`);
    }
    lines.push('');
  }

  // 学习与适应 v2（骨架：重计算下放 sync 管线——agent 只做事件触发的轻动作）
  // 易变区（volatile）：偏好表与固化申请随本机库变化 → 用标记包裹 + 溯源（store 摘要/日期）
  lines.push('## 学习与适应（v2：分层记忆）');
  lines.push('');
  lines.push('### 当前最强偏好（常驻注入）');
  lines.push('');
  const habits = policies.meta?.habits || { top: [], solidify: [] };   // 显式输入（管线注入）
  const top = habits.top || [];
  if (top.length > 0) {
    lines.push(volatileBegin('habits-top', habits));
    lines.push('| 偏好 | 依据 | 命中 |');
    lines.push('|---|---|---|');
    for (const e of top) {
      lines.push('| ' + e.observation + ' | ' + (e.evidence || '').slice(0, 60) + ' | ' + (e.hits || 1) + ' |');
    }
    lines.push(volatileEnd('habits-top'));
    lines.push('');
  }
  lines.push('### 机制（你的职责极轻——重计算由 relic sync 每 5 分钟离线完成）');
  lines.push('');
  lines.push('1. **收尾二值自省**（每轮，无工具调用）：问自己"本轮我是否因用户偏好调整了输出方式"。否 → 跳过全部记忆动作。');
  lines.push('2. **有感轮写入**（仅自省为"是"的轮次）：向 `~/.config/relic-habits/learned.yaml` 写入/更新一条——判据：对未来有用 且 ①助手人设未覆盖 ②环境推不出。字段：type（style|feedback|workflow|reference）/observation/evidence/recorded/hits/lastHit。同主题新偏好覆盖旧条目（updatedFrom 标注）。');
  lines.push('3. **顺手 hits 更新**：本轮实际运用了头部某条偏好 → 该条 hits+1、lastHit=今天。');
  lines.push('4. **全库按需检索**：会话中涉及记忆主题时可 Read 全库（上层头部已常驻注入，通常无需全读）。');
  lines.push('5. **固化照指令执行**：若下方出现「固化申请指令」——按其点名条目向用户申请（一句话确认），确认后写入同步库 personas.directives 并 commit+push，同时删除 habit 库对应条目。');
  lines.push('6. 优先级：助手人设（声明层）> 本 session 新学习 > 历史学习条目。');
  lines.push('');
  const solidify = habits.solidify || [];
  if (solidify.length > 0) {
    lines.push(volatileBegin('habits-solidify', habits));
    lines.push('### ⭐ 固化申请指令（relic sync 检测——本轮收尾执行）');
    lines.push('');
    for (const e of solidify) {
      lines.push('- 向用户申请固化：「' + e.observation + '」（已命中 ' + e.hits + ' 次，建议措辞："我注意到你多轮都' + e.observation + '，要固化为全域规则吗？"）用户确认 → 写入 personas.directives + 删除本条；拒绝 → 保留库中继续观察。');
    }
    lines.push(volatileEnd('habits-solidify'));
    lines.push('');
  }

  // 模块索引表（workflow 详细步骤留在 modules/ 下，按需 Read——方向 2）
  // 路径 = meta.runtimeRoot（本机 clone 根）+ workflowSources 溯源；缺省时退化为 Glob 提示。
  if (policies.workflows && policies.workflows.length > 0) {
    lines.push('## 自定义流程索引');
    lines.push('');
    lines.push('> 以下流程的详细步骤存储在每行「文件路径」指向的 yaml 文件中（绝对路径）。');
    lines.push('> 命中触发条件时，先用 Read 工具读取对应 module.yaml（入口流程读 policies.yaml）获取完整步骤，再执行。');
    lines.push('');
    lines.push('| 流程 | 优先级 | 触发条件 | 文件路径 |');
    lines.push('|---|---|---|---|');
    const root = policies.meta?.runtimeRoot;
    const sources = policies.meta?.workflowSources || {};
    for (const w of policies.workflows) {
      const priorityTag = (w.priority && w.priority !== 'normal') ? w.priority : 'normal';
      const trigger = w.applies_when ? w.applies_when.substring(0, 50) : '—';
      const src = sources[w.id];
      let modulePath;
      if (root && src === 'manifest') modulePath = `${root}/policies.yaml`;
      else if (root && src) modulePath = `${root}/modules/${src}/module.yaml`;
      else modulePath = `modules/?/${w.id}（无 runtimeRoot，用 Glob: modules/*/${w.id} 定位）`;
      lines.push(`| ${w.id} | ${priorityTag} | ${trigger} | ${modulePath} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  // 对 subagent 的治理提示（架构修订 D 节）
  // OpenCode V2 把 AGENTS.md 注入所有 agent——subagent 直接读到本节，
  // 不需主 agent 转达。subagent 的 runtime permission 可能不含 bash 模式规则
  //（平台代码只做工具级 deny），靠本节软约束 + V2 默认 ask 兜底。
  lines.push('## 对 subagent 的治理提示');
  lines.push('');
  lines.push('你是 subagent（explore/oracle/librarian/metis/momus 等）。你的 runtime permission 可能不包含上表中的 bash 模式级规则——但请**同样遵守**本表的 bash 约束：');
  lines.push('');
  lines.push('- **不跑破坏性命令**：`rm -rf`、`dd if=* of=/dev/*`、`mkfs*`、`fdisk*` 一律不执行');
  lines.push('- **不碰 Windows 挂载盘**：`/mnt/c/*`、`/mnt/d/*`、`/mnt/e/*` 的写/删/改/移动一律不做');
  lines.push('- **不格式化磁盘**：`mount`/`umount`/`losetup` 一律不碰');
  lines.push('- **不删治理文件**：`~/.config/opencode/*` 的删除/移动一律不做');
  lines.push('- **遇 ask 弹窗时**：若你触发了需确认的操作，基于本表判断该操作是否属于上述禁止项——属于则不执行，不属于则让用户确认');
  lines.push('');
  lines.push('你的 permission 由平台代码硬编码（通常 deny write/edit/task），bash 模式规则靠你自律。这是软约束，不是 runtime 强制——但违反可能导致用户数据损失。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 给助手的话');
  lines.push('');
  lines.push('0. **注入哨兵**——每次对话输出前，第一句原样输出以下红色标记（diff 代码块的删除行在 UI 中渲染为红色）。`MMDD-HHMMSS` 换成输出时刻的时间戳（2位月2位日-2位时2位分2位秒，每轮现取，不得照抄本文件里的示例值）——时间戳证明标记是本 session 实时打出的，不是复读旧文本：');
  lines.push('````');
  lines.push('```diff');
  lines.push('- RELIC IS RUNNING @ MMDD-HHMMSS');
  lines.push('```');
  lines.push('````');
  lines.push('这是 AGENTS.md 注入成功的判读标志：用户靠这句确认治理已加载。若你读到本条但输出时漏了这句，说明你没遵守本文件——自我检查。');
  lines.push('1. **约束靠自律**——deny 级无例外不执行；ask 级自行判断并在输出中声明，优先走替代方案。');
  lines.push('2. **中风险操作不用回避**——直接发起（webfetch、工作区外路径等），但在输出中显式标注风险与理由。');
  lines.push('3. **低风险直接做**——装公开库、改项目文件、跑测试，不用请示。');
  lines.push('4. **改规则不改这里**——这里只读。要改规则编辑 `modules/<id>/module.yaml` 然后跑 `npm run generate`。');
  lines.push('5. **流程先读后行**——命中「自定义流程索引」任一行的触发条件时，必须先用 Read 工具读取该行「文件路径」指向的 yaml 正文，再按步骤执行；正文未读不得执行。');

  return lines.join('\n');
}
