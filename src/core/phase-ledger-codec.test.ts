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
