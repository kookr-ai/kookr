import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Contract tests for the parallel-issue-batch playbook's headless report-and-exit
 * behavior (issue #1714). A scheduled/parent-spawned batch has nobody to answer
 * an interactive prompt, so calling `AskUserQuestion` on an empty backlog strands
 * the task in `needs_input` for its whole lifetime while it holds a maxActiveTasks
 * slot (2026-07-30 incidents: batches 305a603d and 5c6ddf5c each ~8h). These
 * assertions pin the load-bearing wording so an edit that drops the headless gate,
 * the report-and-exit protocol, or the machine-readable outcome record fails CI
 * instead of quietly regressing to the stranding behavior.
 */
describe('parallel-issue-batch playbook: headless report-and-exit (#1714)', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'parallel-issue-batch.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'parallel-issue-batch.md', '/');

  test('parses with a name and description', () => {
    expect(pb.name).toBe('Parallel Issue Batch');
    expect(pb.description.length).toBeGreaterThan(0);
  });

  test('detects headless mode from the injected launch-provenance signals', () => {
    // The env vars the adapter injects (issue #1583/#1714) are the source of the
    // headless decision; the playbook must branch on them, not guess.
    expect(pb.body).toContain('KOOKR_LAUNCH_PROVENANCE');
    expect(pb.body).toContain('KOOKR_PARENT_TASK_ID');
    expect(pb.body).toContain('KOOKR_UNATTENDED');
    // schedule and parent provenance are both headless.
    expect(pb.body).toMatch(/schedule\|parent/);
  });

  test('forbids AskUserQuestion in headless runs regardless of onAmbiguity', () => {
    // The headline invariant: the `ask` default must be overridden when headless.
    expect(pb.body).toMatch(/forbidden regardless of `?\{\{onAmbiguity\}\}`?/i);
    expect(pb.body).toMatch(/never call `?AskUserQuestion`?/i);
    // Interactive runs keep the prompt — the fix must not disable it wholesale.
    expect(pb.body).toMatch(/Interactive.*`?\{\{onAmbiguity\}\}`? applies unchanged/i);
  });

  test('routes an empty backlog through report-and-exit, terminating completed not needs_input', () => {
    expect(pb.body).toContain('Report-and-exit protocol');
    expect(pb.body).toMatch(/`?completed`?, never `?needs_input`?/i);
    // The terminal marker for a drained backlog is a no-op completion, not BLOCKED.
    expect(pb.body).toContain('NO-ELIGIBLE-WORK');
  });

  test('cites the motivating stranding incidents so the regression stays visible', () => {
    expect(pb.body).toContain('305a603d');
    expect(pb.body).toContain('5c6ddf5c');
  });

  test('emits a machine-readable blocked-empty outcome record for the refill trigger', () => {
    expect(pb.body).toContain('$OUTCOME_FILE');
    expect(pb.body).toContain('outcome.json');
    expect(pb.body).toContain('blocked-empty');
    expect(pb.body).toContain('schemaVersion');
    // The report itemizes every open issue with its disqualifier (batch 74022030
    // did this correctly), not just a bare count.
    expect(pb.body).toContain('disqualified');
    expect(pb.body).toContain('74022030');
  });

  test('lists the headless report-and-exit contract in the checklist', () => {
    const checklistText = pb.checklist.join('\n');
    expect(checklistText).toMatch(/Headless runs.*never called AskUserQuestion/i);
    expect(checklistText).toContain('blocked-empty');
  });

  test('keeps onAmbiguity offering the interactive ask default', () => {
    const param = pb.parameters.find((p) => p.name === 'onAmbiguity');
    expect(param).toBeDefined();
    expect(param!.default).toBe('ask');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['ask', 'auto-safe-subset', 'auto-stop']);
  });
});
