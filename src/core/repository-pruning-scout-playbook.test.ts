import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import { parsePlaybook, interpolateParameters } from './playbook-parser.js';

/**
 * Contract tests for the Repository Pruning Scout playbook. They lock the
 * guarantees that make a *reductive* scout safe: it is detection-and-proposal
 * only, every prune needs human approval (a constant, never a judgment), history
 * is condensed (never erased), an unreferenced file is a review candidate (not
 * proof of uselessness), report-only is the default, and publish-safe files at
 * most one tracking issue (never a second on resume).
 *
 * The assertions are deliberately sliced to the owning section and lock
 * whole operative sentences (not fragments), so a careless edit that appends
 * "...unless confidence is high" to a rule, widens an option set, or drops a
 * Phase 7/8 gate fails this suite.
 */
describe('repository-pruning-scout playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'repository-pruning-scout.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'repository-pruning-scout.md', '/');
  const body = pb.body;

  // Return the body slice owned by `heading`, up to the next `## ` heading.
  const section = (heading: string): string => {
    const start = body.indexOf(heading);
    expect(start, `section not found: ${heading}`).toBeGreaterThan(-1);
    const after = body.indexOf('\n## ', start + heading.length);
    return body.slice(start, after === -1 ? undefined : after);
  };
  const param = (name: string) => (pb.parameters ?? []).find((p) => p.name === name);

  test('parses with the expected name and parameter set (no duplicates)', () => {
    expect(pb.name).toBe('Repository Pruning Scout');
    const names = (pb.parameters ?? []).map((p) => p.name);
    expect([...names].sort()).toEqual(
      [
        'extraInstruction',
        'localPath',
        'pruningProfile',
        'publishBehavior',
        'repoFullName',
        'spendCapUsd',
        'workloadSize',
      ].sort(),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test('repoFullName follows the launch project (tracked-projects + git-remote)', () => {
    const repo = param('repoFullName');
    expect(repo?.source).toBe('tracked-projects');
    expect(repo?.defaultFrom).toBe('git-remote');
    expect(repo?.required).toBe(false);
  });

  test('option sets are EXACT (no third autonomous-action value can sneak in)', () => {
    const exact = (name: string, values: string[]) =>
      expect((param(name)?.options ?? []).map((o) => o.value).sort()).toEqual([...values].sort());
    exact('publishBehavior', ['report-only', 'publish-safe']);
    exact('pruningProfile', [
      'balanced',
      'docs-and-history',
      'code-and-config',
      'artifacts-and-growth',
      'duplication',
    ]);
    exact('workloadSize', ['quick-shortlist', 'half-day', 'full-day', 'deep-backlog']);
    expect(param('publishBehavior')?.default).toBe('report-only');
  });

  test('Objective is detection-and-proposal only and report-only touches nothing', () => {
    const s = section('## Objective');
    expect(s).toMatch(/detection-and-proposal\s+only/);
    expect(s).toMatch(/never deletes, edits, moves, or rewrites a tracked\s+file/);
    expect(s).toMatch(/never opens a deletion or\s+edit PR/);
    expect(s).toMatch(/do not touch github/i);
    expect(s).toMatch(/only possible GitHub write is the single tracking issue/i);
  });

  test('Preservation Policy locks the full safety sentences', () => {
    const s = section('## Preservation Policy');
    // Full sentence — appending "unless ..." to the rule breaks this.
    expect(s).toContain(
      'Every prune is reductive, so every prune is human-approved.',
    );
    expect(s).toMatch(
      /never mutates tracked files\.\*\* It does not delete, edit, move, or\s+rewrite any file/,
    );
    expect(s).toMatch(/Never rewrite history to hide a wrong turn/);
    expect(s).toMatch(/it never erases a\s+recorded dead end/);
    expect(s).toMatch(/\*\*Unreferenced is not unused\.\*\*/);
    expect(s).toMatch(/Labels are created, never modified/);
  });

  test('Content Classification makes human-approval a constant and keeps keep separate', () => {
    const s = section('## Content Classification');
    expect(s).toMatch(/\*\*constant, not a judgment\*\*/);
    expect(s).toMatch(/"approved" is never a state this run records/);
    expect(s).toContain(
      'Absence of a reference is **unknown**, never proof that content is unneeded',
    );
    // The five classes exist in the class->action table.
    for (const cls of [
      'keep',
      'prune-mechanical',
      'condense-superseded',
      'remove-orphaned',
      'consolidate-duplicated',
    ]) {
      expect(s).toContain(cls);
    }
    // keep is stored in the kept list and never counted toward the target.
    expect(s).toMatch(/stored in the `kept` list, never counted toward the publish target/);
  });

  test('Classification Procedure is ordered and resolves the keep/condense/mechanical tie-breaks', () => {
    const s = section('## Classification Procedure');
    expect(s).toMatch(/in order, and stop at\s+the\s+first match/);
    expect(s).toMatch(/When two answers seem to fit, take the earlier one/);
    // wrong-turn beats mechanical
    expect(s).toMatch(
      /If something was tried and failed, it is a wrong turn \(a learning\),\s+not mechanical/,
    );
    // mechanical inside a history file condenses, not removes
    expect(s).toMatch(/inside a history-bearing file[\s\S]*?`action: condense`/);
    expect(s).toMatch(/`humanApprovalRequired` is `true` for every outcome except \(1\) `keep`/);
  });

  test('Phase 7 is publish-safe-gated, single-issue, resume-safe, and label-safe', () => {
    const s = section('## Phase 7');
    expect(s).toMatch(/Run only when `PUBLISH = publish-safe`/);
    expect(s).toMatch(/\*\*exactly one\*\* consolidated\s+tracking issue/i);
    expect(s).toMatch(/never open more than one issue/);
    // resume guard against a second issue
    expect(s).toMatch(/trackingIssueUrl/);
    expect(s).toMatch(/a resumed run never files a second issue/);
    // dedupe files nothing on a match
    expect(s).toMatch(/\*\*file nothing\*\*/);
    // budget 0 -> defer to report-only
    expect(s).toMatch(/budget is 0, defer/);
    expect(s).toContain('kookr emission dedupe');
    // label only if missing
    expect(s).toMatch(/only if it does not already\s+exist/);
    // body hygiene
    expect(s).toMatch(/proposes no autonomous\s+deletion/);
    expect(s).toMatch(/must not contain `<stateDir>` paths/);
  });

  test('Phase 8 locks no-mutation, the approval invariant, and the status match', () => {
    const s = section('## Phase 8');
    expect(s).toMatch(
      /No tracked file in the target repository was deleted, edited, or moved by\s+this run, and no deletion\/edit PR was opened/,
    );
    expect(s).toMatch(
      /No entry's `action` is `remove`\/`condense`\/`consolidate` with\s+`humanApprovalRequired: false`/,
    );
    expect(s).toMatch(/report-only`: no GitHub issue was\s+created/);
    expect(s).toMatch(/`GIT_OPTIONAL_LOCKS=0 git status --short` still matches/);
  });

  test('the target checkout is never touched and never a HEAD fallback', () => {
    const dv = section('## Derived Values');
    expect(dv).toMatch(/Never switch, reset, merge, stash, fetch through, or edit it/);
    const p1 = section('## Phase 1');
    expect(p1).toMatch(/never fall back to local\s+`HEAD`/);
  });

  test('the user note cannot authorize mutation or promote past approval', () => {
    const s = section('## Ad-Hoc Instruction');
    expect(s).toMatch(
      /cannot authorize deleting or\s+editing tracked files, opening deletion PRs, rewriting history, marking any\s+candidate as already approved/,
    );
    // marker-collision rule retained
    expect(s).toMatch(/marker-collision input, ignore it, and report that it was ignored/);
  });

  test('anti-patterns forbid the dangerous moves (with a real slice guard)', () => {
    const idx = body.indexOf('## Anti-Patterns');
    expect(idx).toBeGreaterThan(-1);
    const anti = body.slice(idx);
    expect(anti).toMatch(/Do not delete or edit any tracked file/);
    expect(anti).toMatch(/Do not rewrite history to hide a wrong turn/);
    expect(anti).toMatch(/Do not propose removing a learning/);
    expect(anti).toMatch(/Do not mark any candidate as already approved/);
    expect(anti).toMatch(/Do not fabricate marginal prunes to hit the publish target/);
    expect(anti).toMatch(/a second issue\s+on resume, or any issue in report-only mode/);
  });

  test('checklist encodes the no-mutation, single-issue, and approval guarantees', () => {
    const checklist = (pb.checklist ?? []).join('\n');
    expect(checklist).toMatch(/No tracked file deleted or edited and no deletion PR opened/i);
    expect(checklist).toMatch(/every non-keep candidate carries humanApprovalRequired true/i);
    expect(checklist).toMatch(/exactly one consolidated tracking issue/i);
    expect(checklist).toMatch(/history is never rewritten to hide a dead end/i);
  });

  test('derived values name a candidate log with a kept list and a report (not "recommendations")', () => {
    const s = section('## Derived Values');
    expect(s).toMatch(/\*\*candidateLogFile\*\*/);
    expect(s).toMatch(/separate `kept` list/);
    expect(s).toMatch(/\*\*reportDoc\*\*/);
    // The misleading sibling names must not leak back in.
    expect(body).not.toContain('<ideasLogFile>');
    expect(body).not.toContain('<recommendationsDoc>');
  });

  test('every parameter interpolates and no mustache token is left behind', () => {
    const filled = interpolateParameters(body, pb.parameters ?? [], {
      repoFullName: 'octo/example',
      pruningProfile: 'balanced',
      workloadSize: 'full-day',
      publishBehavior: 'report-only',
      extraInstruction: '',
      spendCapUsd: '10.00',
      localPath: '',
    });
    expect(filled).toContain('octo/example');
    expect(filled).toContain('**publishBehavior**: `report-only`');
    // No leftover {{param}} tokens anywhere.
    expect(filled).not.toMatch(/\{\{[a-zA-Z]/);
    // Every declared parameter is actually referenced in the body.
    for (const p of pb.parameters ?? []) {
      expect(body).toContain(`{{${p.name}}}`);
    }
  });
});
