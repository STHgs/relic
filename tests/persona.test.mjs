// =============================================================================
// tests/persona.test.mjs — 工作习惯系统（L1 人设渲染 + L3 机制骨架）测试
// =============================================================================
// P1: default persona 渲染全部声明字段
// P2: 无 personas → 人设段缺席；机制段仍在（骨架无条件）
// P3: 机制骨架关键指令存在（learned.yaml 路径/上限/优先级/晋升触发/落盘判据）
// P4: 门禁交互——persona 属数据行，改 persona 不改变骨架 hash；机制段行属骨架
// =============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderAgentsMd } from '../src/render/agents-md.mjs';
import { createValidator } from '../src/core/validator.mjs';
import { extractSkeletonLines } from '../src/core/skeleton.mjs';

const golden = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden-skeleton.md'), 'utf8');
const sk = extractSkeletonLines(golden).lines;
const base = { meta: { version: 2, description: 't' }, permissions: [], workflows: [], risk_levels: { low: [], medium: [], high: [] } };
const persona = {
  id: 'default', name: '主人设', default: true,
  identity: '简洁直接的工程搭档', language: 'zh-CN',
  tone: '技术准确优先', verbosity: 'compact',
  directives: ['先结论后依据', '不用表情符号'],
};

describe('P1: default persona renders all declared fields', () => {
  const md = renderAgentsMd({ ...base, personas: [persona, { id: 'other', name: '备选' }] });
  it('renders section header + note pointing at sync repo', () => {
    assert.match(md, /## 助手人设/);
    assert.match(md, /同步库 policies\.yaml 的 personas 段/);
  });
  it('renders identity/language/tone/verbosity/directives', () => {
    assert.match(md, /定位.*简洁直接的工程搭档/);
    assert.match(md, /语言.*zh-CN/);
    assert.match(md, /基调.*技术准确优先/);
    assert.match(md, /详细度.*compact/);
    assert.match(md, /先结论后依据/);
  });
  it('non-default persona content NOT rendered', () => {
    assert.ok(!md.includes('备选'));
  });
  it('persona passes schema v2', () => {
    const v = createValidator()({ ...base, personas: [persona] });
    assert.equal(v.ok, true, (v.errors || []).join('; '));
  });
});

describe('P2: empty personas → section absent, mechanism remains', () => {
  const md = renderAgentsMd(base);
  it('no persona section when personas empty', () => {
    assert.ok(!md.includes('## 助手人设'));
  });
  it('mechanism section is unconditional skeleton', () => {
    assert.match(md, /## 学习与适应（v2：分层记忆）/);
  });
});

describe('P3: mechanism skeleton directives (v2)', () => {
  const md = renderAgentsMd(base);
  it('names the learned store path', () => assert.match(md, /~\/\.config\/relic-habits\/learned\.yaml/));
  it('binary self-check directive present', () => assert.match(md, /收尾二值自省/));
  it('event-driven write gate skips declared/derivable', () => assert.match(md, /助手人设未覆盖 ②环境推不出/));
  it('hits update directive', () => assert.match(md, /hits\+1/));
  it('on-demand full store read', () => assert.match(md, /按需检索|Read 全库/));
  it('solidify follows rendered instruction', () => assert.match(md, /固化照指令执行/));
  it('states priority order', () => assert.match(md, /助手人设（声明层）> 本 session 新学习 > 历史学习条目/));
  it('entry typing', () => assert.match(md, /style\|feedback\|workflow\|reference/));
  it('top table is conditional on an explicit view (machine data never implicit)', () => {
    // 2026-10-09 修复：渲染器不再读本机库——无视图则无表；有视图才有表（见 P5）
    assert.ok(!md.includes('| 偏好 | 依据 | 命中 |'));
  });
});

describe('P5: volatile habits view is an explicit input (2026-10-09 purity fix)', () => {
  const bare = renderAgentsMd(base);
  const view = {
    date: '2026-10-09', digest: 'abcd1234',
    top: [{ observation: '偏好甲', evidence: '依据甲', hits: 2 }],
    solidify: [{ observation: '偏好甲', evidence: '依据甲', hits: 3 }],
  };
  const withView = renderAgentsMd({ ...base, meta: { version: 2, description: 't', habits: view } });
  it('renders table + solidify section from the injected view', () => {
    assert.match(withView, /\| 偏好甲 \| 依据甲 \| 2 \|/);
    assert.match(withView, /已命中 3 次/);
  });
  it('wraps volatile regions with provenance markers (store digest + date)', () => {
    assert.match(withView, /<!-- BEGIN RELIC-VOLATILE:habits-top store=abcd1234 date=2026-10-09 -->/);
    assert.match(withView, /<!-- END RELIC-VOLATILE:habits-top -->/);
    assert.match(withView, /<!-- BEGIN RELIC-VOLATILE:habits-solidify store=abcd1234 date=2026-10-09 -->/);
    assert.match(withView, /<!-- END RELIC-VOLATILE:habits-solidify -->/);
    assert.ok(!bare.includes('RELIC-VOLATILE'), 'no view → no volatile region at all');
  });
  it('mechanism skeleton is identical with and without a view', () => {
    assert.ok(withView.includes('## 学习与适应（v2：分层记忆）'));
    assert.ok(withView.includes('**收尾二值自省**'));
    assert.ok(bare.includes('**收尾二值自省**'));
  });
  it('volatile markers are content, not skeleton (golden locks structure only)', () => {
    assert.ok(!sk.some((l) => l.startsWith('<!-- BEGIN RELIC-VOLATILE')), 'BEGIN marker carries volatile provenance → not skeleton');
    assert.ok(sk.some((l) => l.startsWith('<!-- END RELIC-VOLATILE:habits-top -->')), 'END marker is stable structure → skeleton-locked');
  });
});

describe('P4: gate interaction — persona is data, mechanism is skeleton', () => {
  it('persona content lines are data; only conditional section header is skeleton-locked', () => {
    assert.ok(sk.includes('## 助手人设'), 'conditional header locked in golden');
    assert.ok(!sk.some((l) => l.includes(persona.tone)), 'persona tone text must not be skeleton');
    assert.ok(!sk.some((l) => persona.directives.some((d) => l.includes(d))), 'directives must not be skeleton');
  });
  it('mechanism lines are locked in golden (skeleton set)', () => {
    assert.ok(sk.some((l) => l.includes('学习与适应')));
    assert.ok(sk.some((l) => l.includes('relic-habits/learned.yaml')));
  });
});
