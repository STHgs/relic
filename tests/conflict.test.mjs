// =============================================================================
// tests/conflict.test.mjs — T5 3-layer 冲突检测测试
// =============================================================================
// C1: idClash → hard-block（idConflict 非空，后续层不再跑）
// C2: 两 bash 规则 patterns 重叠 → duplicates/conflicts 非空
// C3: 两 workflow Jaccard ≥0.6 → warnings/duplicates 非空（非阻塞）
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPermissionConflict, detectWorkflowConflict } from '../src/core/conflict.mjs';

describe('C1: idClash hard-blocks (Layer 1)', () => {
  const existing = [{ id: 'sudo-ask', tool: 'bash', action: 'ask', patterns: [{ pattern: 'sudo *' }] }];
  const newRule = { id: 'sudo-ask', tool: 'bash', action: 'deny', patterns: [{ pattern: 'sudo *' }] };
  const r = detectPermissionConflict(newRule, existing);
  it('sets idConflict', () => assert.ok(r.idConflict, JSON.stringify(r)));
  it('does not run Layer 2 (duplicates/conflicts empty)', () => {
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.conflicts.length, 0);
  });
});

describe('C2: bash patterns overlap (Layer 2)', () => {
  const existing = [{
    id: 'protect-c-drive',
    tool: 'bash',
    action: 'deny',
    patterns: [{ pattern: 'rm * /mnt/c/*' }],
  }];

  it('overlapping patterns with same action → duplicates', () => {
    const newRule = {
      id: 'protect-c-users',
      tool: 'bash',
      action: 'deny',
      patterns: [{ pattern: 'rm * /mnt/c/Users/*' }],
    };
    const r = detectPermissionConflict(newRule, existing);
    assert.ok(r.duplicates.length > 0, 'duplicates should be non-empty');
    assert.equal(r.conflicts.length, 0);
  });

  it('overlapping patterns with different action → conflicts (with winner)', () => {
    const newRule = {
      id: 'allow-c-drive',
      tool: 'bash',
      action: 'allow',
      patterns: [{ pattern: 'rm * /mnt/c/*' }],
    };
    const r = detectPermissionConflict(newRule, existing);
    assert.ok(r.conflicts.length > 0, 'conflicts should be non-empty');
    assert.ok(r.conflicts[0].winner, 'winner set (deny>allow → existing wins)');
    assert.equal(r.conflicts[0].winner, 'existing');
  });

  it('non-overlapping bash patterns → no duplicates/conflicts', () => {
    const newRule = {
      id: 'unrelated',
      tool: 'bash',
      action: 'ask',
      patterns: [{ pattern: 'docker *' }],
    };
    const r = detectPermissionConflict(newRule, existing);
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.conflicts.length, 0);
  });
});

describe('C3: workflow Jaccard similarity (Layer 3)', () => {
  const existing = [{
    id: 'pdf-read',
    intent: 'Read PDFs in paged chunks',
    steps: [
      'Use look_at for summary first',
      'Use read with offset and limit for detail pages',
      'Use multimodal-looker for tables and diagrams',
    ],
  }];

  it('high similarity → duplicates non-empty (non-blocking)', () => {
    const newWf = {
      id: 'pdf-read-v2',
      intent: 'Read PDFs in paged chunks',
      steps: [
        'Use look_at for summary first',
        'Use read with offset and limit for detail pages',
        'Use multimodal-looker for tables and diagrams',
      ],
    };
    const r = detectWorkflowConflict(newWf, existing);
    assert.ok(r.duplicates.length > 0, 'duplicates should be non-empty');
    assert.ok(r.duplicates[0].similarity >= 0.6, `similarity ${r.duplicates[0].similarity}`);
  });

  it('low similarity → no duplicates', () => {
    const newWf = {
      id: 'unrelated-flow',
      intent: 'Do something completely different',
      steps: ['Run npm install', 'Start the server', 'Check the logs'],
    };
    const r = detectWorkflowConflict(newWf, existing);
    assert.equal(r.duplicates.length, 0);
  });

  it('workflow id clash → hard-block', () => {
    const newWf = { id: 'pdf-read', intent: 'x', steps: ['a'] };
    const r = detectWorkflowConflict(newWf, existing);
    assert.ok(r.idConflict);
  });
});
