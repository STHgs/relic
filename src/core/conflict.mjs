// =============================================================================
// src/core/conflict.mjs — 重复/冲突检测（3 层，从前身 detect-conflict.mjs 端口）
// =============================================================================
// 三层检测（与前身语义一致）：
//   Layer 1: id 冲突（硬拒绝）—— id 相同直接返回 idConflict
//   Layer 2: 功能重复/冲突（permission）—— 同 tool 才比；bash 比 patterns 重叠
//   Layer 3: steps 重叠（workflow）—— 关键词 Jaccard 相似度
//
// 与前身的差异（relic 重写）：
//   - patterns 直接读对象形式 {pattern, action?}（schema v2 已保证；前身兼容 string/object 两态，relic 简化）
//   - 输出结构保留 idConflict/duplicates/conflicts/warnings，便于 T9 inject 消费
//   - 不带 CLI 入口（前身 229-243 行那段 CLI 调试代码 relic 不需要，调试走测试）
// =============================================================================

// ─── 工具：glob pattern 重叠检测（端口自前身 patternsOverlap，语义不变）─────
function patternsOverlap(p1, p2) {
  if (p1 === p2) return true;
  const toRegex = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  try {
    const r1 = toRegex(p1);
    const r2 = toRegex(p2);
    const p2Literal = p2.replace(/\*/g, 'X').trim();
    const p1Literal = p1.replace(/\*/g, 'X').trim();
    if (r1.test(p2Literal)) return true;
    if (r2.test(p1Literal)) return true;
    const prefix1 = p1.split('*')[0];
    const prefix2 = p2.split('*')[0];
    const suffix1 = p1.split('*').pop();
    const suffix2 = p2.split('*').pop();
    if (prefix1 && prefix2 && (prefix1.startsWith(prefix2) || prefix2.startsWith(prefix1))) {
      if (suffix1 === suffix2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function findPatternOverlap(newPats, existPats) {
  const overlap = [];
  for (const np of newPats || []) {
    for (const ep of existPats || []) {
      if (patternsOverlap(np.pattern, ep.pattern)) {
        overlap.push({ newPattern: np.pattern, existingPattern: ep.pattern });
      }
    }
  }
  return overlap;
}

// ─── Layer 1+2: permission 冲突检测 ────────────────────────────────────
export function detectPermissionConflict(newRule, existingPermissions) {
  const result = { idConflict: null, duplicates: [], conflicts: [], warnings: [] };

  // Layer 1: id 冲突
  const idClash = existingPermissions.find((p) => p.id === newRule.id);
  if (idClash) {
    result.idConflict = {
      existingRule: idClash,
      suggestion: `已存在 id 为 "${newRule.id}" 的规则。请改用新 id，或编辑现有规则，或取消。`,
    };
    return result;
  }

  // Layer 2: 功能重复 / 冲突（仅同 tool 才可能重复）
  for (const existing of existingPermissions) {
    if (existing.tool !== newRule.tool) continue;

    if (newRule.tool !== 'bash') {
      // 非 bash 工具：tool 相同即视为可能重复
      if (existing.action === newRule.action) {
        result.duplicates.push({
          existingRule: existing,
          overlapPatterns: [],
          sameAction: true,
          suggestion: `现有规则 "${existing.id}" 管同一个工具 ${newRule.tool} 且 action 相同（${newRule.action}），可能重复。`,
        });
      } else {
        result.conflicts.push({
          existingRule: existing,
          overlapPatterns: [],
          existingAction: existing.action,
          newAction: newRule.action,
          suggestion: `现有规则 "${existing.id}" 管同一个工具但 action 不同（现有 ${existing.action}，新建 ${newRule.action}），可能冲突。`,
        });
      }
      continue;
    }

    // bash 工具：检查 patterns 重叠
    const overlap = findPatternOverlap(newRule.patterns, existing.patterns);
    if (overlap.length === 0) continue;

    if (existing.action === newRule.action) {
      result.duplicates.push({
        existingRule: existing,
        overlapPatterns: overlap,
        sameAction: true,
        suggestion: `现有规则 "${existing.id}" 的 patterns 与新规则重叠（${overlap.map((o) => o.newPattern).join(', ')}），action 相同（${newRule.action}），可考虑合并。`,
      });
    } else {
      const priority = { deny: 3, ask: 2, allow: 1 };
      const winner = priority[existing.action] >= priority[newRule.action] ? 'existing' : 'new';
      result.conflicts.push({
        existingRule: existing,
        overlapPatterns: overlap,
        existingAction: existing.action,
        newAction: newRule.action,
        winner,
        suggestion: `现有规则 "${existing.id}" 是 ${existing.action}，新规则是 ${newRule.action}，patterns 重叠。按优先级 deny>ask>allow，${winner === 'existing' ? '现有规则优先，新规则不会生效' : '新规则将覆盖现有规则'}。`,
      });
    }
  }

  if (newRule.enforcement === 'advisory' && newRule.action === 'deny') {
    result.warnings.push('advisory + deny 组合效果弱：advisory 不强制，deny 只是建议。建议改用 runtime + deny。');
  }
  return result;
}

// ─── Layer 1+3: workflow 冲突检测 ──────────────────────────────────────
function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export function detectWorkflowConflict(newWorkflow, existingWorkflows) {
  const result = { idConflict: null, duplicates: [], conflicts: [], warnings: [] };

  const idClash = existingWorkflows.find((w) => w.id === newWorkflow.id);
  if (idClash) {
    result.idConflict = {
      existingWorkflow: idClash,
      suggestion: `已存在 id 为 "${newWorkflow.id}" 的工作流。请改用新 id，或编辑现有，或取消。`,
    };
    return result;
  }

  const newStepsTokens = (newWorkflow.steps || []).map(tokenize);
  const newAllTokens = new Set();
  for (const s of newStepsTokens) for (const t of s) newAllTokens.add(t);

  for (const existing of existingWorkflows) {
    const existStepsTokens = (existing.steps || []).map(tokenize);
    const existAllTokens = new Set();
    for (const s of existStepsTokens) for (const t of s) existAllTokens.add(t);

    const sim = jaccardSimilarity(newAllTokens, existAllTokens);

    if (sim > 0.5) {
      const overlapSteps = [];
      for (let i = 0; i < newStepsTokens.length; i++) {
        for (let j = 0; j < existStepsTokens.length; j++) {
          const stepSim = jaccardSimilarity(newStepsTokens[i], existStepsTokens[j]);
          if (stepSim > 0.4) {
            overlapSteps.push({
              newStep: newWorkflow.steps[i],
              existingStep: existing.steps[j],
              similarity: stepSim,
            });
          }
        }
      }
      result.duplicates.push({
        existingWorkflow: existing,
        similarity: sim,
        overlapSteps,
        suggestion: `现有工作流 "${existing.id}" 的步骤与新工作流重叠度 ${(sim * 100).toFixed(0)}%，可考虑合并。`,
      });
    } else if (sim > 0.25) {
      result.warnings.push(`现有工作流 "${existing.id}" 与新工作流有一定相似度（${(sim * 100).toFixed(0)}%），建议确认是否独立。`);
    }
  }

  return result;
}

// ─── 跨模块冲突扫描（方向 3）：all-pairs 复用 layer 原语 ────────────────
/**
 * All-pairs conflict sweep across merged permissions + workflows.
 * Reuses detectPermissionConflict/detectWorkflowConflict layer primitives.
 * @param {object[]} permissions  merged permissions across modules
 * @param {object[]} workflows    merged workflows across modules
 * @returns {{ok:boolean, idClashes:object[], permissionConflicts:object[], workflowConflicts:object[], warnings:string[]}}
 *   ok=false iff any idClash (duplicate id across modules = hard error).
 *   permissionConflicts/workflowConflicts = non-blocking duplicates/overlap (warnings).
 */
export function detectCrossModuleConflicts(permissions, workflows) {
  const idClashes = [];
  const permissionConflicts = [];
  const workflowConflicts = [];
  const warnings = [];

  // Permissions: all-pairs
  for (let i = 0; i < permissions.length; i++) {
    for (let j = i + 1; j < permissions.length; j++) {
      const a = permissions[i];
      const b = permissions[j];
      // id clash (hard)
      if (a.id === b.id) {
        idClashes.push({ id: a.id, first: a, second: b });
        continue;
      }
      // use existing layer-2 logic (pattern overlap / tool dup): treat b as "new" vs [a]
      const r = detectPermissionConflict(b, [a]);
      if (r.duplicates.length > 0) {
        for (const d of r.duplicates) permissionConflicts.push(d);
      }
      if (r.conflicts.length > 0) {
        for (const c of r.conflicts) permissionConflicts.push(c);
      }
    }
  }

  // Workflows: all-pairs (Jaccard)
  for (let i = 0; i < workflows.length; i++) {
    for (let j = i + 1; j < workflows.length; j++) {
      const a = workflows[i];
      const b = workflows[j];
      if (a.id === b.id) {
        idClashes.push({ id: a.id, first: a, second: b });
        continue;
      }
      const r = detectWorkflowConflict(b, [a]);
      if (r.duplicates.length > 0) {
        for (const d of r.duplicates) workflowConflicts.push(d);
      }
      if (r.warnings.length > 0) {
        for (const w of r.warnings) warnings.push(w);
      }
    }
  }

  return {
    ok: idClashes.length === 0,
    idClashes,
    permissionConflicts,
    workflowConflicts,
    warnings,
  };
}
