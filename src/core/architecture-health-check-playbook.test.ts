import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Contract tests for architecture-health-check emission-budget wiring (#1607)
 * and value-density governor (#1846).
 */
describe('architecture-health-check playbook', () => {
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

  test('parses with maxIssues and value-density parameters', () => {
    expect(pb.name).toBe('Architecture Health Check');
    expect(pb.parameters.some((p) => p.name === 'maxIssues')).toBe(true);
    expect(pb.parameters.some((p) => p.name === 'maxRefactorPerWindow')).toBe(true);
    expect(pb.parameters.some((p) => p.name === 'minDriftScoreDelta')).toBe(true);
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

  test('Phase 3 gates refactor-class filing via value-density admit + decline log', () => {
    expect(phase3).toContain('kookr value-density admit');
    expect(phase3).toContain('kookr value-density decline');
    expect(phase3).toContain('kookr value-density composition');
    expect(phase3).toContain('REFACTOR_FILED');
    expect(phase3).toContain('--refactor-count');
    expect(phase3).toContain('--max-refactor');
    expect(phase3).toContain('--min-drift-delta');
    expect(phase3).toContain('--reason-code');
    expect(phase3).toContain('refactorCount');
    expect(phase3).toContain('playbook-state/value-density');
    expect(phase3).toMatch(/cosmetic|value-density decline/i);
  });

  test('routes only large dependent architecture refactors through the RFC-first playbook', () => {
    expect(pb.body).toContain('## Large-Refactor Threshold');
    const threshold = pb.body.slice(
      pb.body.indexOf('## Large-Refactor Threshold'),
      pb.body.indexOf('## Phase 3 — Create Issues'),
    );
    expect(threshold).toMatch(/behavior-preserving.*structural/i);
    expect(threshold).toMatch(/size.*large/i);
    expect(threshold).toMatch(/at least two|2\+/i);
    expect(threshold).toMatch(/ordered.*depend/i);

    expect(phase3).toContain('architecture-refactor-rfc.md');
    expect(phase3).toContain('rfc-first');
    expect(phase3).toContain('--idempotency-key');
    const route = phase3.indexOf('RFC-first routing gate');
    const plainIssue = phase3.indexOf('# ... gh issue create ...');
    expect(route).toBeGreaterThan(-1);
    expect(plainIssue).toBeGreaterThan(route);
  });

  test('preserves plain issue creation below the large-refactor threshold', () => {
    expect(phase3).toMatch(/below.*large-refactor threshold.*existing.*issue/i);
    expect(phase3).toContain('# ... gh issue create ...');
  });
});
