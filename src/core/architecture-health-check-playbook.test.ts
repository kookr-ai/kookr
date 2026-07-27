import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Contract tests for architecture-health-check emission-budget wiring (#1607).
 * Ensures the emitter fails closed on plan failure and gates on ALLOWED + dedupe.
 */
describe('architecture-health-check playbook emission budget', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'architecture-health-check.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'architecture-health-check.md', '/');
  const phase3 = pb.body.slice(pb.body.indexOf('## Phase 3 — Create Issues'));

  test('parses with maxIssues parameter', () => {
    expect(pb.name).toBe('Architecture Health Check');
    expect(pb.parameters.some((p) => p.name === 'maxIssues')).toBe(true);
  });

  test('Phase 3 uses emission plan fail-closed and ALLOWED gate', () => {
    expect(phase3).toContain('kookr emission plan');
    expect(phase3).toMatch(/emission plan failed|refusing to file/i);
    expect(phase3).toContain('ALLOWED');
    expect(phase3).toMatch(/FILED.*-ge.*"\$ALLOWED"|FILED=0/);
    expect(phase3).toContain('kookr emission defer');
    expect(phase3).toContain('kookr emission dedupe');
    expect(phase3).toContain('isDuplicate');
    expect(phase3).toContain('kookr emission metrics');
    expect(phase3).toContain('playbook-state/emission-metrics');
    expect(phase3).toMatch(/netBacklogDelta7d/);
  });
});
