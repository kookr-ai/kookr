import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyMergeTrailCommand,
  evaluateMergeRequiredGate,
  evidenceFromTrail,
  extractPrNumbersFromCommand,
  isMergeRequiredGateEnabled,
  MERGE_REQUIRED_CODE,
  MERGE_REQUIRED_GATE_ENV,
  PR_BLOCKER_MARKER,
  promptDeclaresMergeAuthority,
  resolveTaskMergeEvidence,
  resolveMergeRequiredGate,
  taskHasMergeAuthority,
  emptyMergeTrailEvidence,
} from './merge-required.js';

function preToolBash(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

function preToolGrok(command: string): string {
  return JSON.stringify({
    hookEventName: 'pre_tool_use',
    toolName: 'run_terminal_command',
    toolInput: { command, description: 'test' },
  });
}

const MERGE_CONTRACT_PROMPT = `
**TERMINAL-STATE CONTRACT (mergeAfterImplementation=true):** when \`true\`,
an open PR is NOT a terminal state — you hold merge authority. Your unit is
complete ONLY when the PR is **merged** (\`mergedAt\` non-null).
`;

describe('promptDeclaresMergeAuthority / taskHasMergeAuthority', () => {
  test('detects TERMINAL-STATE CONTRACT with mergeAfterImplementation=true', () => {
    expect(promptDeclaresMergeAuthority(MERGE_CONTRACT_PROMPT)).toBe(true);
  });

  test('ignores mergeAfterImplementation=false contract', () => {
    const prompt =
      'TERMINAL-STATE CONTRACT (mergeAfterImplementation=false): open PR is terminal.';
    expect(promptDeclaresMergeAuthority(prompt)).toBe(false);
  });

  test('ignores ordinary prompts without merge authority', () => {
    expect(promptDeclaresMergeAuthority('Ship a PR; the PR is the review gate.')).toBe(false);
    expect(promptDeclaresMergeAuthority('')).toBe(false);
  });

  test('explicit mergeRequired / terminalState flags win', () => {
    expect(taskHasMergeAuthority({ mergeRequired: true, prompt: 'plain' })).toBe(true);
    expect(taskHasMergeAuthority({ terminalState: 'merged-pr', prompt: 'plain' })).toBe(true);
    expect(
      taskHasMergeAuthority({ metadata: { mergeRequired: true }, prompt: 'plain' }),
    ).toBe(true);
    expect(
      taskHasMergeAuthority({ metadata: { terminalState: 'merged-pr' }, prompt: 'plain' }),
    ).toBe(true);
  });

  test('playbookParameterValues mergeAfterImplementation=true', () => {
    expect(
      taskHasMergeAuthority({
        prompt: 'plain',
        playbookParameterValues: { mergeAfterImplementation: 'true' },
      }),
    ).toBe(true);
    expect(
      taskHasMergeAuthority({
        prompt: 'plain',
        playbookParameterValues: { mergeAfterImplementation: 'false' },
      }),
    ).toBe(false);
  });

  test('reads authority from userPrompt when prompt is stripped', () => {
    expect(
      taskHasMergeAuthority({
        prompt: 'launcher wrapper',
        userPrompt: MERGE_CONTRACT_PROMPT,
      }),
    ).toBe(true);
  });
});

describe('classifyMergeTrailCommand / extractPrNumbersFromCommand', () => {
  test('classifies create / merge / blocker', () => {
    expect(classifyMergeTrailCommand('gh pr create --title x')).toBe('pr-create');
    expect(classifyMergeTrailCommand('gh pr merge 42 --squash')).toBe('pr-merge');
    expect(classifyMergeTrailCommand('pnpm merge 42')).toBe('pr-merge');
    expect(classifyMergeTrailCommand('bash scripts/kookr-merge.sh 42')).toBe('pr-merge');
    expect(
      classifyMergeTrailCommand(`printf '${PR_BLOCKER_MARKER} CI red\\n'`),
    ).toBe('pr-blocker');
    expect(classifyMergeTrailCommand('ls -la')).toBe('none');
  });

  test('blocker wins over create in the same command', () => {
    expect(
      classifyMergeTrailCommand(
        `gh pr create; printf '${PR_BLOCKER_MARKER} stuck'\\n`,
      ),
    ).toBe('pr-blocker');
  });

  test('extracts PR numbers from URLs and gh/pnpm merge args', () => {
    expect(
      extractPrNumbersFromCommand(
        'open https://github.com/kookr-ai/kookr/pull/1836 and done',
      ),
    ).toEqual([1836]);
    expect(extractPrNumbersFromCommand('gh pr merge 99 --squash')).toEqual([99]);
    expect(extractPrNumbersFromCommand('pnpm merge 12')).toEqual([12]);
    expect(extractPrNumbersFromCommand('see PR #7 for context')).toEqual([7]);
  });
});

describe('evaluateMergeRequiredGate', () => {
  test('allows when merge authority is not set', () => {
    const v = evaluateMergeRequiredGate({
      mergeAuthority: false,
      evidence: { prOpened: true, mergedVerified: false, blockerRecorded: false },
    });
    expect(v.allow).toBe(true);
    expect(v.code).toBeUndefined();
  });

  test('allows when authority set but no PR opened', () => {
    const v = evaluateMergeRequiredGate({
      mergeAuthority: true,
      evidence: { prOpened: false, mergedVerified: false, blockerRecorded: false },
    });
    expect(v.allow).toBe(true);
  });

  test('rejects when PR opened, unmerged, unblocked', () => {
    const v = evaluateMergeRequiredGate({
      mergeAuthority: true,
      evidence: {
        prOpened: true,
        mergedVerified: false,
        blockerRecorded: false,
        prNumbers: [42],
      },
    });
    expect(v.allow).toBe(false);
    expect(v.code).toBe(MERGE_REQUIRED_CODE);
    expect(v.hint).toContain(PR_BLOCKER_MARKER);
    expect(v.prNumbers).toEqual([42]);
  });

  test('allows when merge is verified', () => {
    const v = evaluateMergeRequiredGate({
      mergeAuthority: true,
      evidence: { prOpened: true, mergedVerified: true, blockerRecorded: false },
    });
    expect(v.allow).toBe(true);
  });

  test('allows when PR-BLOCKER is recorded', () => {
    const v = evaluateMergeRequiredGate({
      mergeAuthority: true,
      evidence: { prOpened: true, mergedVerified: false, blockerRecorded: true },
    });
    expect(v.allow).toBe(true);
    expect(v.reason).toMatch(/PR-BLOCKER/i);
  });

  test('fail-open when disabled', () => {
    const v = evaluateMergeRequiredGate({
      enabled: false,
      mergeAuthority: true,
      evidence: { prOpened: true, mergedVerified: false, blockerRecorded: false },
    });
    expect(v.allow).toBe(true);
  });
});

describe('evidenceFromTrail', () => {
  test('maps create-without-merge to unsatisfied', () => {
    const trail = {
      ...emptyMergeTrailEvidence(),
      prCreateCommands: 1,
      prNumbers: [5],
    };
    const e = evidenceFromTrail(trail);
    expect(e.prOpened).toBe(true);
    expect(e.mergedVerified).toBe(false);
    expect(e.blockerRecorded).toBe(false);
  });

  test('PR number alone without create does not count as prOpened', () => {
    const e = evidenceFromTrail({
      ...emptyMergeTrailEvidence(),
      prNumbers: [5],
    });
    expect(e.prOpened).toBe(false);
  });

  test('trail merge satisfies only when live check is absent', () => {
    expect(
      evidenceFromTrail({
        ...emptyMergeTrailEvidence(),
        prCreateCommands: 1,
        prMergeCommands: 1,
        prNumbers: [5],
      }).mergedVerified,
    ).toBe(true);
  });

  test('live truth wins over trail merge command (failed merge attempt)', () => {
    expect(
      evidenceFromTrail(
        {
          ...emptyMergeTrailEvidence(),
          prCreateCommands: 1,
          prMergeCommands: 1,
          prNumbers: [5],
        },
        { allMerged: false, checked: 1 },
      ).mergedVerified,
    ).toBe(false);
    expect(
      evidenceFromTrail(
        { ...emptyMergeTrailEvidence(), prCreateCommands: 1, prNumbers: [5] },
        { allMerged: true, checked: 1 },
      ).mergedVerified,
    ).toBe(true);
  });
});

describe('isMergeRequiredGateEnabled', () => {
  const previous = process.env[MERGE_REQUIRED_GATE_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[MERGE_REQUIRED_GATE_ENV];
    else process.env[MERGE_REQUIRED_GATE_ENV] = previous;
  });

  test('defaults to enabled; off values disable', () => {
    delete process.env[MERGE_REQUIRED_GATE_ENV];
    expect(isMergeRequiredGateEnabled()).toBe(true);
    expect(isMergeRequiredGateEnabled({ [MERGE_REQUIRED_GATE_ENV]: '0' })).toBe(false);
    expect(isMergeRequiredGateEnabled({ [MERGE_REQUIRED_GATE_ENV]: 'false' })).toBe(false);
    expect(isMergeRequiredGateEnabled({ [MERGE_REQUIRED_GATE_ENV]: 'OFF' })).toBe(false);
    expect(isMergeRequiredGateEnabled({ [MERGE_REQUIRED_GATE_ENV]: 'no' })).toBe(false);
    expect(isMergeRequiredGateEnabled({ [MERGE_REQUIRED_GATE_ENV]: '1' })).toBe(true);
  });
});

describe('resolveTaskMergeEvidence / resolveMergeRequiredGate', () => {
  let hooksDir: string;

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kookr-merge-req-'));
    hooksDir = join(root, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLog(session: string, commands: string[], shape: 'claude' | 'grok' = 'claude') {
    const lines = commands.map((c) =>
      shape === 'claude' ? preToolBash(c) : preToolGrok(c),
    );
    writeFileSync(join(hooksDir, `${session}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }

  test('scans create + merge across sessions', async () => {
    writeLog('s1', ['gh pr create --title "x"']);
    writeLog('s2', ['gh pr merge 10 --squash --delete-branch']);
    const trail = await resolveTaskMergeEvidence(
      { sessions: [{ tmuxSession: 's1' }, { tmuxSession: 's2' }] },
      hooksDir,
    );
    expect(trail.prCreateCommands).toBe(1);
    expect(trail.prMergeCommands).toBe(1);
    expect(trail.prNumbers).toContain(10);
  });

  test('rejects completion path for merge-authority task with open unmerged PR', async () => {
    writeLog('sess', ['gh pr create --fill', 'echo https://github.com/o/r/pull/99']);
    const verdict = await resolveMergeRequiredGate(
      {
        prompt: MERGE_CONTRACT_PROMPT,
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
    );
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe(MERGE_REQUIRED_CODE);
    expect(verdict.prNumbers).toContain(99);
  });

  test('allows after merge command in trail', async () => {
    writeLog('sess', [
      'gh pr create --fill',
      'gh pr merge 99 --squash',
    ]);
    const verdict = await resolveMergeRequiredGate(
      {
        prompt: MERGE_CONTRACT_PROMPT,
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
    );
    expect(verdict.allow).toBe(true);
  });

  test('allows after PR-BLOCKER marker (Grok-shaped hooks)', async () => {
    writeLog(
      'sess',
      [
        'gh pr create --fill',
        `printf '${PR_BLOCKER_MARKER} executed-red on unit tests\\n'`,
      ],
      'grok',
    );
    const verdict = await resolveMergeRequiredGate(
      {
        mergeRequired: true,
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
    );
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toMatch(/PR-BLOCKER/i);
  });

  test('allows ordinary tasks without merge authority even with open PR', async () => {
    writeLog('sess', ['gh pr create --fill']);
    const verdict = await resolveMergeRequiredGate(
      {
        prompt: 'Open a PR; the PR is the review gate.',
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
    );
    expect(verdict.allow).toBe(true);
  });

  test('live verifyMerged can satisfy without a merge command', async () => {
    writeLog('sess', ['gh pr create --fill', 'echo PR #55 ready']);
    const verifyMerged = async (nums: number[]) => {
      expect(nums).toContain(55);
      return { allMerged: true, checked: nums.length };
    };
    const verdict = await resolveMergeRequiredGate(
      {
        mergeRequired: true,
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
      { verifyMerged },
    );
    expect(verdict.allow).toBe(true);
  });

  test('live allMerged=false rejects even when trail has merge command', async () => {
    writeLog('sess', ['gh pr create --fill', 'gh pr merge 55 --squash']);
    const verdict = await resolveMergeRequiredGate(
      {
        mergeRequired: true,
        sessions: [{ tmuxSession: 'sess' }],
      },
      hooksDir,
      { verifyMerged: async () => ({ allMerged: false, checked: 1 }) },
    );
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe(MERGE_REQUIRED_CODE);
  });

  test('fail-open when hooksDir is undefined', async () => {
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      undefined,
    );
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toMatch(/hooks directory/i);
  });

  test('verifyMerged throw falls back to trail (merge command allows)', async () => {
    writeLog('sess', ['gh pr create --fill', 'gh pr merge 7 --squash']);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      {
        verifyMerged: async () => {
          throw new Error('gh unavailable');
        },
      },
    );
    expect(verdict.allow).toBe(true);
  });
});
