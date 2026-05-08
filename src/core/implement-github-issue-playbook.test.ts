import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Contract tests for the implement-github-issue playbook. The author-filter
 * gate is a security boundary, so its presence is asserted explicitly — a
 * casual edit that drops the parameter or short-circuits the check should
 * fail this suite.
 */
describe('implement-github-issue playbook', () => {
  const playbookPath = join(import.meta.dirname, '..', '..', '.kookr', 'playbooks', 'implement-github-issue.md');
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'implement-github-issue.md', '/');

  test('exposes allowOtherAuthors as a required select with safe default', () => {
    const param = pb.parameters.find((p) => p.name === 'allowOtherAuthors');
    expect(param).toBeDefined();
    expect(param!.required).toBe(true);
    expect(param!.default).toBe('false');
    expect(param!.type).toBe('select');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['false', 'true']);
  });

  test('Phase 0d enforces the author check before reading the issue body', () => {
    expect(pb.body).toMatch(/Author check/);
    expect(pb.body).toContain('CURRENT_USER');
    expect(pb.body).toContain('{{allowOtherAuthors}}');
    // The check must precede Phase 1's body read — assert relative ordering.
    const authorCheckIdx = pb.body.indexOf('Author check');
    const phase1Idx = pb.body.indexOf('Phase 1: Read the target issue');
    expect(authorCheckIdx).toBeGreaterThan(0);
    expect(phase1Idx).toBeGreaterThan(authorCheckIdx);
  });

  test('Step 0b resolves CURRENT_USER from gh', () => {
    expect(pb.body).toMatch(/CURRENT_USER=\$\(gh api user -q \.login\)/);
  });

  test('Phase 0 skips non-automatable labels before implementation', () => {
    expect(pb.body).toContain('automation-blocked');
    expect(pb.body).toContain('question');
    expect(pb.body).toMatch(/skip issues with labels.*automation-blocked.*question/i);
  });

  test('defines an automation-quarantine path for trusted non-implementable issues', () => {
    expect(pb.body).toMatch(/automation-quarantine/i);
    expect(pb.body).toContain('gh issue comment "$TARGET"');
    expect(pb.body).toContain('gh issue edit "$TARGET"');
    expect(pb.body).toContain('"permanent":true');
  });
});
