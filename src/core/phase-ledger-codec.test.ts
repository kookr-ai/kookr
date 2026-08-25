import { describe, expect, test } from 'vitest';
import {
  PhaseLedgerParseError,
  parsePhaseLedgerFromIssueBody,
  parsePhaseResultComment,
  reconcilePhaseResultComments,
  replacePhaseLedgerInIssueBody,
  serializePhaseLedgerBlock,
  type PhaseLedger,
} from './phase-ledger-codec.js';

const ledger: PhaseLedger = {
  version: 1,
  chainId: 'chain:kookr-ai/kookr:2711',
  repo: 'kookr-ai/kookr',
  issueNumber: 2711,
  phases: [
    { id: 'P1', dependsOn: [], prNumber: 2716, status: 'merged' },
    { id: 'P2', dependsOn: ['P1'], status: 'pending' },
  ],
};

describe('phase ledger codec', () => {
  test('round-trips the fenced ledger and preserves surrounding issue prose', () => {
    const body = `# Chain\n\n${serializePhaseLedgerBlock(ledger)}\n\n## Notes\n`;
    const parsed = parsePhaseLedgerFromIssueBody(body);
    expect(parsed).toEqual(ledger);

    const updated = replacePhaseLedgerInIssueBody(body, {
      ...ledger,
      phases: [ledger.phases[0]!, { ...ledger.phases[1]!, status: 'in-flight', taskId: 'task-2' }],
    });
    expect(updated).toContain('# Chain');
    expect(updated).toContain('## Notes');
    expect(parsePhaseLedgerFromIssueBody(updated).phases[1]).toMatchObject({ status: 'in-flight', taskId: 'task-2' });
  });

  test('rejects malformed, duplicate, and cyclic/non-adjacent ledgers', () => {
    expect(() => parsePhaseLedgerFromIssueBody('no machine block')).toThrow(PhaseLedgerParseError);
    expect(() => parsePhaseLedgerFromIssueBody('```kookr-phase-ledger\n{"version":1}\n```')).toThrow(/chainId/);
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({ ...ledger, phases: [{ id: 'P1', dependsOn: [] }, { id: 'P1', dependsOn: ['P1'] }] })}\n\`\`\``,
    )).toThrow(/duplicate phase id/);
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({ ...ledger, phases: [{ id: 'P1', dependsOn: [] }, { id: 'P2', dependsOn: [] }] })}\n\`\`\``,
    )).toThrow(/adjacent predecessor/);
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({ ...ledger, phases: [{ id: 'P1', dependsOn: ['P1'] }, { id: 'P2', dependsOn: ['P1'] }] })}\n\`\`\``,
    )).toThrow(/adjacent predecessor/);
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({ ...ledger, phases: [{ id: 'P1', dependsOn: [], prNumber: 2716 }, { id: 'P2', dependsOn: ['P1'], prNumber: 2716 }] })}\n\`\`\``,
    )).toThrow(/duplicate PR number/);
  });

  test('round-trip validation rejects unknown fields instead of guessing', () => {
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({ ...ledger, unexpected: true })}\n\`\`\``,
    )).toThrow(/unknown field/);
  });

  test('reconciles only matching append-only phase-result comments', () => {
    const comments = [
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', prNumber: 2720, status: 'in-flight', taskId: 'task-2', reviewVerdict: 'pass', reviewedAt: '2026-08-23T10:00:00.000Z', reviewerTaskId: 'review-2' })} -->`,
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: 'other', issueNumber: 2711, phaseId: 'P2', prNumber: 999 })} -->`,
      'ordinary comment',
    ];
    const reconciled = reconcilePhaseResultComments(ledger, comments);
    expect(reconciled.phases[1]).toMatchObject({
      prNumber: 2720,
      status: 'in-flight',
      taskId: 'task-2',
      reviewVerdict: 'pass',
      reviewedAt: '2026-08-23T10:00:00.000Z',
      reviewerTaskId: 'review-2',
    });
    expect(reconciled.phases[0]).toEqual(ledger.phases[0]);
  });

  test('persists review attempts and exact reviewed head across reconciliation', () => {
    const comments = [
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', reviewVerdict: 'block', reviewedAt: '2026-08-23T10:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'OLD' })} -->`,
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', reviewVerdict: 'pass', reviewedAt: '2026-08-23T11:00:00.000Z', reviewerTaskId: 'review-2', reviewAttempts: 2, reviewHeadSha: 'NEW' })} -->`,
    ];
    const phase = reconcilePhaseResultComments(ledger, comments).phases[1]!;
    expect(phase).toMatchObject({
      reviewAttempts: 2,
      reviewHeadSha: 'new',
      reviewVerdict: 'pass',
    });
  });

  test('reconciliation is idempotent and an unbound latest verdict clears the old head', () => {
    const comments = [
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', reviewVerdict: 'pass', reviewedAt: '2026-08-23T10:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'OLD' })} -->`,
      `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', reviewVerdict: 'pass', reviewedAt: '2026-08-23T11:00:00.000Z', reviewerTaskId: 'review-2' })} -->`,
    ];
    const once = reconcilePhaseResultComments(ledger, comments);
    const twice = reconcilePhaseResultComments(once, comments);
    expect(once.phases[1]).toMatchObject({ reviewAttempts: 1, reviewVerdict: 'pass' });
    expect(once.phases[1]?.reviewHeadSha).toBeUndefined();
    expect(twice).toEqual(once);
  });

  test('does not replay an older BLOCK after a correction attempt is durable', () => {
    const corrected = { ...ledger, phases: [ledger.phases[0]!, {
      ...ledger.phases[1]!,
      reviewAttempts: 2,
      taskId: 'correction-task',
    }] } satisfies PhaseLedger;
    const oldBlock = `<!-- kookr-phase-result ${JSON.stringify({ version: 1, chainId: ledger.chainId, issueNumber: 2711, phaseId: 'P2', prNumber: 2720, reviewVerdict: 'block', reviewedAt: '2026-08-23T10:00:00.000Z', reviewerTaskId: 'review-1', reviewAttempts: 1, reviewHeadSha: 'OLD' })} -->`;
    expect(reconcilePhaseResultComments(corrected, [oldBlock])).toEqual(corrected);
  });

  test('rejects a per-phase cap above the canonical maximum', () => {
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({
        ...ledger,
        phases: [{ ...ledger.phases[0], reviewIterationCap: 21 }, ledger.phases[1]],
      })}\n\`\`\``,
    )).toThrow(/reviewIterationCap/);
  });

  test('rejects a non-positive durable review cap', () => {
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({
        ...ledger,
        phases: [{ ...ledger.phases[0], reviewIterationCap: 0 }, ledger.phases[1]],
      })}\n\`\`\``,
    )).toThrow(/reviewIterationCap/);
  });

  test('parses invalid result comments as non-events', () => {
    expect(parsePhaseResultComment('ordinary comment')).toBeNull();
    expect(parsePhaseResultComment('<!-- kookr-phase-result {"version":1} -->')).toBeNull();
    expect(parsePhaseResultComment(`<!-- kookr-phase-result ${JSON.stringify({
      version: 1,
      chainId: ledger.chainId,
      issueNumber: ledger.issueNumber,
      phaseId: 'P2',
      taskId: '',
    })} -->`)).toBeNull();
    expect(parsePhaseResultComment(`<!-- kookr-phase-result ${JSON.stringify({
      version: 1,
      chainId: ledger.chainId,
      issueNumber: ledger.issueNumber,
      phaseId: 'P2',
      reviewVerdict: 'pass',
      reviewedAt: '2026-02-30T00:00:00.000Z',
      reviewerTaskId: 'review-2',
    })} -->`)).toBeNull();
  });

  test('rejects impossible ledger timestamps', () => {
    expect(() => parsePhaseLedgerFromIssueBody(
      `\`\`\`kookr-phase-ledger\n${JSON.stringify({
        ...ledger,
        phases: [{ ...ledger.phases[0], mergedAt: '2026-02-30T00:00:00.000Z' }, ledger.phases[1]],
      })}\n\`\`\``,
    )).toThrow(/invalid mergedAt timestamp/);
  });
});
