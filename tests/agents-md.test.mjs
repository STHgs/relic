// =============================================================================
// tests/agents-md.test.mjs — AGENTS.md 渲染器测试（骨架化架构）
// =============================================================================
// R1: 骨架 — 治理约束表含每条权限一行（全量渲染，自律执行）
// R2: 骨架 — 替代方案段
// R3: 骨架 — subagent 治理提示段
// R4: 骨架 — 给助手的话含哨兵指令（第 0 条）
// R5: 模块索引表 — 列出所有 workflow id + 触发条件 + 文件路径
// R6: 不渲染 — workflow 详细步骤不在 AGENTS.md 中（留在 module.yaml）
// R7: 骨架 — 风险分级（跨模块合并视图）常驻渲染
// R8: 索引绝对路径 — meta.runtimeRoot + workflowSources → module.yaml / policies.yaml
// R9: 规则 5 — 流程先读后行
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parse } from 'yaml';
import { createValidator } from '../src/core/validator.mjs';
import { renderAgentsMd } from '../src/render/agents-md.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const goodYaml = readFileSync(resolve(FIXTURES, 'policies-good.yaml'), 'utf8');
const policies = createValidator()(parse(goodYaml)).doc;
const md = renderAgentsMd(policies);

describe('R1: 治理约束 table contains one row per permission (self-compliance)', () => {
  it('contains the section header', () => {
    assert.match(md, /## 治理约束（自律执行）/);
  });
  it('contains a row for sudo-ask with tool=patterns=action=intent', () => {
    const runtime = policies.permissions;  // 全量渲染（enforcement 语义已退役）
    for (const p of runtime) {
      const row = new RegExp(`\\| ${p.tool} \\|.*\\|.*\\| ${p.intent} \\|`);
      assert.match(md, row, `missing row for permission ${p.id}`);
    }
  });
});

describe('R2: 替代方案 section', () => {
  it('contains alternatives header', () => {
    assert.match(md, /### 替代方案/);
  });
});

describe('R3: 对 subagent 的治理提示 section', () => {
  it('contains the section header', () => {
    assert.match(md, /## 对 subagent 的治理提示/);
  });
  it('directly addresses subagents', () => {
    assert.match(md, /你是 subagent/);
  });
  it('lists bash constraint rules for subagents', () => {
    assert.match(md, /不跑破坏性命令/);
    assert.match(md, /不碰 Windows 挂载盘/);
    assert.match(md, /不格式化磁盘/);
    assert.match(md, /不删治理文件/);
  });
  it('explains soft-constraint nature', () => {
    assert.match(md, /软约束/);
  });
});

describe('R4: 注入哨兵（RELIC IS RUNNING）', () => {
  it('contains the sentinel rule in 给助手的话 section', () => {
    assert.match(md, /## 给助手的话/);
    assert.match(md, /RELIC IS RUNNING/);
  });
  it('is rule number 0 (highest priority, first read)', () => {
    assert.match(md, /0\. \*\*注入哨兵\*\*/);
  });
  it('states the purpose: AGENTS.md injection verification', () => {
    assert.match(md, /AGENTS\.md 注入成功/);
  });
  it('instructs red rendering via diff fenced block', () => {
    assert.match(md, /```diff\n- RELIC IS RUNNING @ MMDD-HHMMSS\n```/);
    assert.match(md, /渲染为红色/);
  });
  it('requires per-turn fresh timestamp, not a hardcoded one', () => {
    assert.match(md, /每轮现取/);
    assert.match(md, /不得照抄本文件里的示例值/);
  });
});

describe('R5: 模块索引表 lists all workflows', () => {
  it('contains the index section header', () => {
    assert.match(md, /## 自定义流程索引/);
  });
  it('contains a table with workflow id, priority, trigger, path columns', () => {
    assert.match(md, /\| 流程 \| 优先级 \| 触发条件 \| 文件路径 \|/);
  });
  it('instructs agent to Read module.yaml for details', () => {
    assert.match(md, /Read 工具读取/);
    assert.match(md, /module\.yaml/);
  });
});

describe('R6: workflow detailed steps NOT rendered (stays in module.yaml)', () => {
  it('does NOT contain numbered workflow steps in AGENTS.md', () => {
    assert.doesNotMatch(md, /## 标准流程/);
    assert.doesNotMatch(md, /### pdf-read/);
    assert.doesNotMatch(md, /1\. Use look_at for summary first/);
  });
});

describe('R7: risk_levels rendered in skeleton (cross-module merged view)', () => {
  it('contains the risk section header and philosophy line', () => {
    assert.match(md, /## 风险分级（避免消极回避）/);
    assert.match(md, /不要因为害怕审批而回避正常工作/);
  });
  it('renders one labelled level per non-empty risk level with all items', () => {
    const labels = { low: /🟢 低风险/, medium: /🟡 中风险/, high: /🔴 高风险/ };
    for (const [level, re] of Object.entries(labels)) {
      const items = policies.risk_levels[level] || [];
      if (items.length > 0) {
        assert.match(md, re, `missing label for non-empty level ${level}`);
        for (const item of items) assert.ok(md.includes(`- ${item}`), `missing risk item: ${item}`);
      }
    }
  });
});

describe('R8: index uses absolute runtime paths (meta.runtimeRoot + workflowSources)', () => {
  const inlineId = policies.workflows[0].id;
  const synthId = 'plan-then-build';
  const p2 = {
    ...policies,
    workflows: [
      policies.workflows[0],
      { id: synthId, intent: 'synthetic module workflow for path assertions', steps: ['x'] },
    ],
    meta: {
      ...policies.meta,
      runtimeRoot: '/repo',
      workflowSources: { [inlineId]: 'manifest', [synthId]: 'build-hygiene' },
    },
  };
  const md2 = renderAgentsMd(p2);
  it('inline entry workflow points at policies.yaml', () => {
    assert.match(md2, new RegExp(`\\| ${inlineId} \\|.*\\| /repo/policies\\.yaml \\|`));
  });
  it('module workflow points at absolute module.yaml', () => {
    assert.match(md2, /\/repo\/modules\/build-hygiene\/module\.yaml/);
  });
  it('without runtimeRoot falls back to Glob hint', () => {
    assert.match(md, /Glob: modules\/\*/);
  });
});

describe('R9: rule 5 read-before-execute', () => {
  it('contains rule 5 with mandatory Read-before-run semantics', () => {
    assert.match(md, /5\. \*\*流程先读后行\*\*/);
    assert.match(md, /正文未读不得执行/);
  });
});
