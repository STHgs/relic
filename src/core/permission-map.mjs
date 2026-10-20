// =============================================================================
// src/core/permission-map.mjs — 共享辅助：把权限规则映射成平台读的形态
// =============================================================================
// 抽出前身 generate.mjs 第 117-127 行（omo）和 164-173 行（opencode）的重复逻辑，
// 消除"同一段映射写两遍"的漂移风险。
//
// 输入：单条 permission 规则（schema v2 形状：patterns 为对象数组 [{pattern, action?}]）
// 输出：{ [tool]: action } 或 { [tool]: { [pattern]: action } }
//   - 无 patterns（或空数组）：{ [tool]: rule.action }     单值
//   - 有 patterns：{ [tool]: { [pattern]: patternAction } }  pattern 级 action 覆盖 rule 级
//
// 前身 generate.mjs:121 `const act = item.action || p.action` 即此覆盖语义。
// =============================================================================

/**
 * 把一条 permission 规则的 patterns/tool/action 映射为平台读的 map 项。
 * @param {object} rule  单条 permission（schema v2 形状）
 * @returns {{ [tool: string]: string | Record<string, string> }}
 *   key = rule.tool；value = action（无 patterns）或 { pattern: action }（有 patterns）
 */
export function buildPermissionMap(rule) {
  const pats = rule.patterns || [];
  if (pats.length === 0) {
    return { [rule.tool]: rule.action };
  }
  const map = {};
  for (const item of pats) {
    const act = item.action || rule.action;
    map[item.pattern] = act;
  }
  return { [rule.tool]: map };
}

/**
 * 给定一组 permission，按 applies_to 角色筛选适用的规则子集。
 * （只读辅助，预留给适配器复用；T8 omo/opencode 会用到）
 * @param {object[]} permissions
 * @param {('primary'|'deep'|'subagent'|'all')[]} appliesTo  该 agent 拥有的角色
 * @returns {object[]} 只保留 applies_to 命中的规则
 */
export function filterByRole(permissions, appliesTo) {
  const has = (p) => p.applies_to?.includes('all') || p.applies_to?.some((r) => appliesTo.includes(r));
  return permissions.filter(has);
}
