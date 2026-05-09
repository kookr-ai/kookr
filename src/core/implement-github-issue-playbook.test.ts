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
  const claudeMdPath = join(import.meta.dirname, '..', '..', 'CLAUDE.md');
  const claudeMd = readFileSync(claudeMdPath, 'utf-8');

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

  test('documents required and skipped KB lookup policy separately from memory writes', () => {
    expect(claudeMd).toContain('## KB-First Task Policy');
    expect(claudeMd).toContain('Run `kb search "<2-line gist of the task>"` before designing or implementing');
    expect(claudeMd).toContain('Non-trivial research, architecture, RFC, issue-synthesis, or requirements work');
    expect(claudeMd).toContain('Machine-specific operations, production/deployment work, Kookr runtime behavior');
    expect(claudeMd).toContain('You may skip the KB lookup for purely mechanical edits');
    expect(claudeMd).toContain('KB lookup skipped: <reason>');

    const kbPolicyIdx = claudeMd.indexOf('## KB-First Task Policy');
    const persistenceIdx = claudeMd.indexOf('## Persistence Mechanism Picker');
    expect(kbPolicyIdx).toBeGreaterThan(0);
    expect(persistenceIdx).toBeGreaterThan(kbPolicyIdx);
  });

  test('prompts GitHub issue agents to report KB hits, misses, and stale warnings', () => {
    expect(pb.body).toContain('Phase 2.5: Apply KB-First Task Policy');
    expect(pb.body).toContain('kb search "<2-line gist of the issue and intended work>"');
    expect(pb.body).toContain('KB hits: ...');
    expect(pb.body).toContain('KB miss: ...');
    expect(pb.body).toContain('KB stale warning: ...');
    expect(pb.body).toContain('This lookup policy is separate from memory-write governance');
  });
});
