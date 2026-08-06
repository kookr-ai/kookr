import { describe, expect, test } from 'vitest';
import {
  FAA_MITIGATION_KEYWORDS,
  FAA_MITIGATION_PATH_FRAGMENTS,
  citesClassifiedCause,
  evaluateFaaMitigationGate,
} from './check-faa-mitigation-gate.js';

describe('citesClassifiedCause', () => {
  test('true when any classified cause token appears (case-insensitive)', () => {
    expect(citesClassifiedCause('Root-Cause: ack_sweep_backlog')).toBe(true);
    expect(citesClassifiedCause('targets AUTO_CLOSE_DISABLED tasks')).toBe(true);
    expect(citesClassifiedCause('manual_review_gate is by design')).toBe(true);
    expect(citesClassifiedCause('normal awaiting_poll latency')).toBe(true);
  });

  test('false when no cause token appears', () => {
    expect(citesClassifiedCause('fix reclaim reaper for stuck tasks')).toBe(false);
  });
});

describe('evaluateFaaMitigationGate', () => {
  test('out of scope when no FAA file and no FAA keyword', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/server/routes/task-routes.ts', 'README.md'],
      citationText: 'feat: unrelated change',
    });
    expect(result).toEqual({ inScope: false });
  });

  test('in scope via file path, satisfied when a cause is cited', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/completion/completion-ready-cleanup.ts'],
      citationText: 'fix(faa): drain ack_sweep_backlog faster',
    });
    expect(result).toEqual({ inScope: true, satisfied: true, reason: 'cause_cited' });
  });

  test('in scope via a specific FAA/hung-suspect fragment', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/server/hung-suspect-ttl-sweep.ts'],
      citationText: 'chore: tweak reclaim counters',
    });
    expect(result).toEqual({
      inScope: true,
      satisfied: false,
      matchedFiles: ['src/server/hung-suspect-ttl-sweep.ts'],
      matchedKeyword: null,
    });
  });

  test('unrelated reclaim/reaper surfaces are NOT in scope (no blanket reclaim/reaper match)', () => {
    // These contain "reclaim"/"reaper" but are worktree/session/dtach cleanup,
    // not FAA mitigations — the narrowed fragments must not false-positive.
    for (const path of [
      'src/server/scheduled-worktree-reclaim-runner.ts',
      'src/server/use-cases/scheduled-worktree-reclaim.ts',
      'src/server/session-reaper.ts',
      'src/adapters/dtach-attach-reaper.ts',
    ]) {
      const result = evaluateFaaMitigationGate({ changedFiles: [path], citationText: 'chore: cleanup' });
      expect(result, path).toEqual({ inScope: false });
    }
  });

  test('in scope via keyword even when no obvious file matched', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/server/some-service.ts'],
      citationText: 'feat: page Discord on high finishedAwaitingAck residual',
    });
    expect(result).toEqual({
      inScope: true,
      satisfied: false,
      matchedFiles: [],
      matchedKeyword: 'finishedAwaitingAck',
    });
  });

  test('in scope but unsatisfied when no cause and no bypass', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/hung-task-reaper.ts'],
      citationText: 'fix: another reaper tweak',
    });
    expect(result).toEqual({
      inScope: true,
      satisfied: false,
      matchedFiles: ['src/core/hung-task-reaper.ts'],
      matchedKeyword: null,
    });
  });

  test('a deliberate bypass marker on its own line with a reason satisfies the gate', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/capacity-ledger.ts'],
      citationText: 'refactor: rename field\n\n[faa-gate-bypass: pure rename, no behavior change]',
    });
    expect(result).toEqual({ inScope: true, satisfied: true, reason: 'bypass' });
  });

  test('a real reason that happens to mention a <token> still satisfies the gate', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/capacity-ledger.ts'],
      citationText: '[faa-gate-bypass: renames the <legacy> field, no behavior change]',
    });
    expect(result).toEqual({ inScope: true, satisfied: true, reason: 'bypass' });
  });

  test('bypass markers without a SUBSTANTIVE reason do NOT satisfy the gate', () => {
    for (const citationText of [
      '[faa-gate-bypass:]', // empty
      '[faa-gate-bypass: ]', // whitespace only
      '[faa-gate-bypass: -]', // punctuation only
      '[faa-gate-bypass:]]', // punctuation-ish leftover bracket, empty reason
      '[faa-gate-bypass: <why>]', // the copy-paste placeholder
      '[faa-gate-bypass: (<why>)]', // placeholder wrapped in punctuation
      '[faa-gate-bypass: <reason here>]', // placeholder-only, multi-word
    ]) {
      const result = evaluateFaaMitigationGate({
        changedFiles: ['src/core/capacity-ledger.ts'],
        citationText,
      });
      expect(result, citationText).toMatchObject({ inScope: true, satisfied: false });
    }
  });

  test('a mid-sentence prose mention of the bypass syntax does NOT trip the gate', () => {
    // Documenting the gate ("add a reasoned [faa-gate-bypass: <why>]") must not
    // count as an actual bypass — the marker is only honored at line start.
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/capacity-ledger.ts'],
      citationText: 'feat: tweak sweep. Genuinely not a mitigation? Add a reasoned [faa-gate-bypass: <why>].',
    });
    expect(result).toMatchObject({ inScope: true, satisfied: false });
  });

  test('every declared path fragment puts a change in scope (incl. case-insensitivity)', () => {
    for (const fragment of FAA_MITIGATION_PATH_FRAGMENTS) {
      const path = `src/core/${fragment.toUpperCase()}-x.ts`; // uppercased to exercise the case-insensitive match
      const result = evaluateFaaMitigationGate({ changedFiles: [path], citationText: 'chore: no cause cited' });
      expect(result.inScope, `fragment ${fragment}`).toBe(true);
    }
  });

  test('every declared keyword variant puts a change in scope', () => {
    for (const re of FAA_MITIGATION_KEYWORDS) {
      // Build a citation string that matches this specific keyword regex.
      const sample = re.source.includes('finishedawaitingack')
        ? 'finishedAwaitingAck'
        : re.source.includes('finished-awaiting-ack')
          ? 'finished-awaiting-ack'
          : 'FAA';
      const result = evaluateFaaMitigationGate({
        changedFiles: ['src/server/unrelated.ts'],
        citationText: `feat: something about ${sample} residual`,
      });
      expect(result.inScope, `keyword ${re.source}`).toBe(true);
    }
  });

  test('cause cited in the PR body portion of the citation text is honored', () => {
    const result = evaluateFaaMitigationGate({
      changedFiles: ['src/core/completion/completion-ready-sweep.ts'],
      citationText: 'fix: speed up sweep\n\nThis targets the dominant auto_close_disabled cause from /api/health.',
    });
    expect(result).toEqual({ inScope: true, satisfied: true, reason: 'cause_cited' });
  });
});
