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
    const normalizedThreshold = threshold.replace(/\s+/g, ' ');
    for (const label of [
      'Repository',
      'Finding key',
      'Finding title',
      'Source reference',
      'Verified evidence and affected boundaries',
      'Ordered phase plan',
    ]) {
      expect(normalizedThreshold).toContain(label);
    }

    expect(phase3).toContain('architecture-refactor-rfc.md');
    expect(phase3).toContain('rfc-first');
    expect(phase3).toContain('--idempotency-key');
    const route = phase3.indexOf('RFC-first routing gate');
    const routePredicate = phase3.indexOf('if [ "${FINDING_ROUTE:-plain-issue}" = "rfc-first" ]; then');
    const routeContinue = phase3.indexOf('continue', routePredicate);
    const plainIssue = phase3.indexOf('# ... gh issue create ...');
    expect(route).toBeGreaterThan(-1);
    expect(routePredicate).toBeGreaterThan(route);
    expect(routeContinue).toBeGreaterThan(routePredicate);
    expect(plainIssue).toBeGreaterThan(route);
    expect(plainIssue).toBeGreaterThan(routeContinue);

    const rfcBranch = phase3.slice(routePredicate, plainIssue);
    const launchCommand = rfcBranch.slice(
      rfcBranch.indexOf('RFC_SPAWN_JSON=$(kookr spawn -C "$(pwd)"'),
      rfcBranch.indexOf('|| { echo "architecture-health-check: RFC-first launch ambiguous'),
    );
    expect(launchCommand).toContain('--prompt-file "$RFC_HANDOFF_FILE"');
    expect(launchCommand).toContain('--playbook architecture-refactor-rfc.md --playbook-scope plugin');
    expect(launchCommand).not.toContain('--criteria');
    expect(rfcBranch).toContain(
      '|| { echo "architecture-health-check: RFC-first launch ambiguous; stop and inspect idempotency state before retry"; exit 0; }',
    );

    const taskRead = rfcBranch.slice(
      rfcBranch.indexOf('if ! curl -fsS --max-time 5'),
      rfcBranch.indexOf('# Record rfcTaskId'),
    );
    expect(taskRead).toContain('/api/tasks/$RFC_TASK_ID');
    expect(taskRead).toContain('.taskId == $taskId');
    expect(taskRead).toContain('exit 0');

    const counters = rfcBranch.slice(rfcBranch.indexOf('FILED=$((FILED + 1))'));
    expect(counters).toContain('if [ "$ADMIT_REFACTOR" = "true" ]; then');
    expect(counters).toMatch(/if \[ "\$ADMIT_REFACTOR" = "true" \]; then\s+REFACTOR_FILED=\$\(\(REFACTOR_FILED \+ 1\)\)\s+fi/);
  });

  test('preserves plain issue creation below the large-refactor threshold', () => {
    expect(phase3).toMatch(/below.*large-refactor threshold.*existing.*issue/i);
    expect(phase3).toContain('# ... gh issue create ...');
    const reportOnlyGuard = phase3.indexOf('If `{{maxIssues}}` is `0`, skip this phase entirely');
    const rfcSpawn = phase3.indexOf('kookr spawn');
    expect(reportOnlyGuard).toBeGreaterThan(-1);
    expect(rfcSpawn).toBeGreaterThan(reportOnlyGuard);
  });
});
