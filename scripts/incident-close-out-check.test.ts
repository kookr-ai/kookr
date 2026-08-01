import { describe, expect, test } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXIT_CODES,
  classifyFromEvidence,
  exitCodeFor,
  type EvidenceFile,
} from './incident-close-out-check.js';
import { classifyIncidentCloseOut, verifyDeploySha } from '../src/core/incident-close-out.js';

describe('incident-close-out-check exit codes', () => {
  test('maps classification states to exit codes', () => {
    const base = {
      issueState: 'open' as const,
      labels: ['incident'],
      nowMs: Date.parse('2026-08-01T12:00:00.000Z'),
    };

    expect(
      exitCodeFor(
        classifyIncidentCloseOut({
          ...base,
          hasMergedFixPr: true,
          fixMergedAt: '2026-08-01T11:50:00.000Z',
        }),
      ),
    ).toBe(EXIT_CODES.unverified);

    expect(
      exitCodeFor(
        classifyIncidentCloseOut({
          ...base,
          hasMergedFixPr: true,
          fixMergedAt: '2026-08-01T10:00:00.000Z',
        }),
      ),
    ).toBe(EXIT_CODES.stale);

    expect(
      exitCodeFor(
        classifyIncidentCloseOut({
          ...base,
          hasMergedFixPr: true,
          verification: verifyDeploySha({
            servingSha: 'old',
            targetSha: 'new',
            servingIncludesTarget: false,
          }),
        }),
      ),
    ).toBe(EXIT_CODES.reEscalated);

    expect(
      exitCodeFor(
        classifyIncidentCloseOut({
          ...base,
          hasMergedFixPr: true,
          verification: verifyDeploySha({
            servingSha: 'abcdef01',
            targetSha: 'abcdef01',
          }),
        }),
      ),
    ).toBe(EXIT_CODES.ok);
  });
});

describe('classifyFromEvidence', () => {
  test('converged deploy-sha from health body produces close receipt', async () => {
    const evidence: EvidenceFile = {
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      fixMergedAt: '2026-07-31T16:58:00.000Z',
      issueNumber: 1810,
      fixPrNumbers: [1851],
      healthBody: { status: 'ok', sha: 'bf39be2deadbeef', build: { commitHash: 'bf39be2deadbeef' } },
      targetSha: 'bf39be2',
      servingIncludesTarget: true,
    };
    const result = await classifyFromEvidence(evidence);
    expect(result.classification.state).toBe('verified-converged');
    expect(result.classification.mayClose).toBe(true);
    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(result.receipt).toContain('#1810');
    expect(result.receipt).toContain('#1851');
    expect(result.receipt).toContain('deploy-sha:converged');
  });

  test('stale unverified without health probe', async () => {
    const evidence: EvidenceFile = {
      issueState: 'open',
      labels: ['p0'],
      hasMergedFixPr: true,
      fixMergedAt: '2026-07-01T00:00:00.000Z',
      unverifiedAlertMinutes: 30,
    };
    const result = await classifyFromEvidence(evidence);
    expect(result.classification.state).toBe('fix-merged-unverified');
    expect(result.classification.staleUnverified).toBe(true);
    expect(result.exitCode).toBe(EXIT_CODES.stale);
    expect(result.receipt).toBe(null);
  });

  test('reads evidence file shape via JSON round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ico-'));
    const path = join(dir, 'evidence.json');
    const evidence: EvidenceFile = {
      issueState: 'open',
      labels: ['bug'],
      hasMergedFixPr: true,
    };
    writeFileSync(path, JSON.stringify(evidence));
    const loaded = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (await import('node:fs')).readFileSync(path, 'utf-8'),
    ) as EvidenceFile;
    const result = await classifyFromEvidence(loaded);
    expect(result.classification.state).toBe('not-incident');
    expect(result.exitCode).toBe(EXIT_CODES.ok);
  });
});
