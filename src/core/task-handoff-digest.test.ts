import { describe, test, expect } from 'vitest';
import { buildTaskHandoffDigest } from './task-handoff-digest.js';
import type { AgentState } from '../shared/contracts/agent-state.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';

const NOW = new Date('2026-06-21T10:00:00.000Z');

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    events: [],
    anomaly: null,
    ...overrides,
  };
}

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    agentId: 'agent-1',
    type: 'stale_agent',
    severity: 'warning',
    explanation: 'Agent has been idle.',
    detectedAt: NOW,
    ...overrides,
  };
}

describe('buildTaskHandoffDigest', () => {
  test('renders a header, status, and next action even for a bare agent', () => {
    const md = buildTaskHandoffDigest(agent({ taskName: 'My task' }), { now: NOW });
    expect(md).toContain('# Task handoff: My task');
    expect(md).toContain('_Generated 2026-06-21T10:00:00.000Z_');
    expect(md).toContain('## Status');
    expect(md).toContain('## Next action');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('falls back to taskId then agentId for the title', () => {
    expect(buildTaskHandoffDigest(agent({ taskId: 't-9' }), { now: NOW })).toContain('# Task handoff: t-9');
    expect(buildTaskHandoffDigest(agent(), { now: NOW })).toContain('# Task handoff: agent-1');
  });

  test('includes prompt/criteria and completion digest sections', () => {
    const md = buildTaskHandoffDigest(
      agent({
        taskName: 'Ship feature',
        description: 'Implement X and add tests.',
        taskStatus: 'completed',
        completionDigest: {
          bullets: ['Changed 2 files: a.ts, b.ts', 'Made 1 commit'],
          filesChanged: ['a.ts', 'b.ts'],
          testSummary: 'Tests: 12 passed',
          prUrls: ['https://github.com/kookr-ai/kookr/pull/42'],
          branch: 'feat/x',
          commits: ['abc1234'],
          verificationCommands: ['pnpm test', 'pnpm type-check'],
        },
      }),
      { now: NOW },
    );
    expect(md).toContain('## Prompt / criteria\nImplement X and add tests.');
    expect(md).toContain('## Completion digest');
    expect(md).toContain('- Changed 2 files: a.ts, b.ts');
    expect(md).toContain('- Files changed: a.ts, b.ts');
    expect(md).toContain('- Tests: 12 passed');
    expect(md).toContain('## GitHub references');
    expect(md).toContain('- PR: https://github.com/kookr-ai/kookr/pull/42');
    expect(md).toContain('- Branch: `feat/x`');
    expect(md).toContain('- Commit: `abc1234`');
    expect(md).toContain('## Verification commands');
    expect(md).toContain('pnpm type-check');
  });

  test('renders the latest finding when an anomaly is present', () => {
    const md = buildTaskHandoffDigest(
      agent({ anomaly: anomaly({ type: 'repeated_error', severity: 'critical', explanation: 'Build failed.' }) }),
      { now: NOW },
    );
    expect(md).toContain('## Latest finding');
    expect(md).toContain('- repeated_error (critical)');
    expect(md).toContain('Build failed.');
  });

  test('uses top-level git branch/commit when no completion digest is present', () => {
    const md = buildTaskHandoffDigest(
      agent({ gitBranch: 'chain/issue-1042', gitCommit: 'deadbeef' }),
      { now: NOW },
    );
    expect(md).toContain('## GitHub references');
    expect(md).toContain('- Branch: `chain/issue-1042`');
    expect(md).toContain('- Commit: `deadbeef`');
  });

  test('a warning-severity finding is shown but the task stays in progress', () => {
    const md = buildTaskHandoffDigest(
      agent({ taskStatus: 'inProgress', anomaly: anomaly({ severity: 'warning' }) }),
      { now: NOW },
    );
    expect(md).toContain('## Latest finding');
    expect(md).toContain('- Disposition: in progress');
    expect(md).toContain('Resume or continue monitoring');
  });

  describe('next action', () => {
    test('asks to answer when the agent is waiting on a question', () => {
      const md = buildTaskHandoffDigest(
        agent({ anomaly: anomaly({ subType: 'ask_user_question', explanation: 'Which option?' }) }),
        { now: NOW },
      );
      expect(md).toContain('Answer the agent');
      expect(md).toContain('blocked — needs attention');
    });

    test('asks to investigate on a critical finding', () => {
      const md = buildTaskHandoffDigest(
        agent({ anomaly: anomaly({ severity: 'critical' }) }),
        { now: NOW },
      );
      expect(md).toContain('Investigate the finding');
    });

    test('suggests reviewing the PR for completed work', () => {
      const md = buildTaskHandoffDigest(
        agent({ taskStatus: 'completed', completionDigest: { bullets: ['done'], filesChanged: [], prUrls: ['https://github.com/o/r/pull/1'] } }),
        { now: NOW },
      );
      expect(md).toContain('Review the linked pull request');
    });

    test('suggests reviewing changes when completed without a PR', () => {
      const md = buildTaskHandoffDigest(agent({ taskStatus: 'completed' }), { now: NOW });
      expect(md).toContain('Review the completed changes');
    });

    test('suggests resuming for in-progress work', () => {
      const md = buildTaskHandoffDigest(agent({ taskStatus: 'inProgress' }), { now: NOW });
      expect(md).toContain('Resume or continue monitoring');
    });
  });

  describe('redaction and caps', () => {
    test('redacts secrets in free text and verification commands', () => {
      const md = buildTaskHandoffDigest(
        agent({
          description: 'token=ghp_0123456789abcdefghij export OPENAI=sk-abcdefghijklmnop1234',
          completionDigest: {
            bullets: [],
            filesChanged: [],
            verificationCommands: ['curl -H "authorization: Bearer sk-abcdefghijklmnop1234" https://x'],
          },
        }),
        { now: NOW },
      );
      expect(md).not.toContain('ghp_0123456789abcdefghij');
      expect(md).not.toContain('sk-abcdefghijklmnop1234');
      // Both the prompt and the verification command must be redacted independently.
      const promptSection = md.split('## Prompt / criteria')[1].split('##')[0];
      const verificationSection = md.split('## Verification commands')[1];
      expect(promptSection).toContain('[REDACTED]');
      expect(verificationSection).toContain('[REDACTED]');
      expect(verificationSection).not.toContain('sk-abcdefghijklmnop1234');
    });

    test('caps individual snippets', () => {
      const md = buildTaskHandoffDigest(
        agent({ description: 'x'.repeat(5000) }),
        { now: NOW, maxSnippetLength: 50 },
      );
      expect(md).toContain('… [truncated]');
      // The padded prompt body must not exceed the cap + truncation suffix.
      const promptLine = md.split('## Prompt / criteria\n')[1].split('\n')[0];
      expect(promptLine.length).toBeLessThanOrEqual(50 + '… [truncated]'.length);
    });

    test('caps the total rendered packet', () => {
      const md = buildTaskHandoffDigest(
        agent({ taskName: 'T', description: 'y'.repeat(20000) }),
        { now: NOW, maxSnippetLength: 100000, maxTotalLength: 500 },
      );
      expect(md.length).toBeLessThanOrEqual(500);
      expect(md).toContain('handoff truncated to size cap');
    });
  });
});
