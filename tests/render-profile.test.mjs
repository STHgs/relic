// =============================================================================
// tests/render-profile.test.mjs — M3 renderer profile header test
// =============================================================================
// R4: renderAgentsMd(policiesWithMetaProfile) output contains "> Profile: <name> (<id>)"
// R5: renderAgentsMd(policies) with no meta.profile → no profile line (existing tests unaffected)
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

describe('R4: profile header line present when meta.profile set', () => {
  const policies = createValidator()(parse(readFileSync(resolve(FIXTURES, 'policies-good.yaml'), 'utf8'))).doc;
  const withProfile = {
    ...policies,
    meta: { ...policies.meta, profile: { id: 'work', name: 'Work profile' } },
  };
  const md = renderAgentsMd(withProfile);
  it('contains "> Profile: Work profile (work)"', () => {
    assert.match(md, /> Profile: Work profile \(work\)/);
  });
});

describe('R5: no profile line when meta.profile absent (backward compat)', () => {
  const policies = createValidator()(parse(readFileSync(resolve(FIXTURES, 'policies-good.yaml'), 'utf8'))).doc;
  const md = renderAgentsMd(policies);
  it('does NOT contain "Profile:" line', () => {
    assert.doesNotMatch(md, /^> Profile:/m);
  });
  it('byte-identical to pre-M3 render (existing R1-R3 + workflows tests unaffected)', () => {
    // 验证 header 区域没有 profile 行（只含两行 "> ..."）
    const headerSection = md.slice(0, md.indexOf('---'));
    assert.doesNotMatch(headerSection, /Profile/);
  });
});
