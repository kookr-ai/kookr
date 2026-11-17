import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyMergeTrailCommand,
  createGhMergedAtVerifier,
  evaluateMergeRequiredGate,
  extractCreatedPrNumbersFromOutput,
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

function postToolBash(command: string, stdout: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '' },
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

  test('extracts PR numbers from merge-command arguments', () => {
    expect(extractPrNumbersFromCommand('gh pr merge 99 --squash')).toEqual([99]);
    expect(extractPrNumbersFromCommand('pnpm merge 12')).toEqual([12]);
    expect(extractPrNumbersFromCommand('kookr merge 13 --repo o/r')).toEqual([13]);
    expect(extractPrNumbersFromCommand('bash scripts/kookr-merge.sh 14')).toEqual([14]);
    expect(
      extractPrNumbersFromCommand('gh pr merge https://github.com/o/r/pull/15 --squash'),
    ).toEqual([15]);
    expect(
      extractPrNumbersFromCommand('kookr merge 16 && gh pr merge 17'),
    ).toEqual([16, 17]);
  });

  // Issue #4128: a flag between the merge verb and its argument used to hide
  // the number, so the gate asked about the current branch instead.
  test('skips flags between the merge verb and its argument', () => {
    // A flag with no value before a URL or a number.
    expect(
      extractPrNumbersFromCommand('gh pr merge --squash https://github.com/o/r/pull/41'),
    ).toEqual([41]);
    expect(extractPrNumbersFromCommand('gh pr merge -s -d 42')).toEqual([42]);
    expect(extractPrNumbersFromCommand('gh pr merge --admin --squash #43')).toEqual([43]);
    // A flag with a value: the value is not the argument.
    expect(extractPrNumbersFromCommand('gh pr merge -R o/r 12')).toEqual([12]);
    expect(extractPrNumbersFromCommand('gh pr merge --repo o/r --squash 44')).toEqual([44]);
    expect(extractPrNumbersFromCommand('gh pr merge --repo=o/r 45')).toEqual([45]);
    expect(extractPrNumbersFromCommand('kookr merge --repo o/r 46')).toEqual([46]);
    expect(extractPrNumbersFromCommand('bash scripts/kookr-merge.sh --repo o/r -- 47')).toEqual([47]);
    // A value that is all digits (a SHA, a subject) is skipped as a value.
    expect(
      extractPrNumbersFromCommand('gh pr merge --match-head-commit 1234567 --squash 48'),
    ).toEqual([48]);
    expect(
      extractPrNumbersFromCommand('gh pr merge --subject "Release 42 now" --squash 49'),
    ).toEqual([49]);
    expect(extractPrNumbersFromCommand("gh pr merge -t 'fix 7' -b 8 50")).toEqual([50]);
  });

  test('reads no number when the first non-flag word is not a PR', () => {
    // Numberless merge: the gate falls back to the created PR / current branch.
    expect(extractPrNumbersFromCommand('gh pr merge --squash --delete-branch')).toEqual([]);
    // A branch name is the argument; a later number is not.
    expect(extractPrNumbersFromCommand('gh pr merge my-branch 51')).toEqual([]);
    // The argument ends at the end of the simple command.
    expect(extractPrNumbersFromCommand('gh pr merge --squash && gh pr view 52')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr merge --squash; echo 53')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr merge --squash | tee log 54')).toEqual([]);
    // A flag value cut off by the command end is not the argument either.
    expect(extractPrNumbersFromCommand('gh pr merge -R && echo 55')).toEqual([]);
    // An unclosed quote ends the command: here the flag's value is missing.
    expect(extractPrNumbersFromCommand('gh pr merge --subject "open 56')).toEqual([]);
    expect(extractPrNumbersFromCommand("gh pr merge --squash 'open 56")).toEqual([]);
    // A URL that is not a pull request, or a pull-request URL with junk after the number.
    expect(extractPrNumbersFromCommand('gh pr merge https://github.com/o/r/issues/57')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr merge https://github.com/o/r/pull/57abc')).toEqual([]);
    // `&&` with no spaces still ends the command; a longer verb is not a merge.
    expect(extractPrNumbersFromCommand('gh pr merge --squash&&echo 5')).toEqual([]);
    expect(extractPrNumbersFromCommand('kookr merge-queue 5')).toEqual([]);
  });

  test('reads the number inside a wrapper whose quote closes after the merge', () => {
    expect(extractPrNumbersFromCommand('bash -c "gh pr merge 12"')).toEqual([12]);
    expect(extractPrNumbersFromCommand('bash -lc "gh pr merge 12 --squash"')).toEqual([12]);
    expect(extractPrNumbersFromCommand("sh -c 'gh pr merge -R o/r 13'")).toEqual([13]);
    expect(
      extractPrNumbersFromCommand('ssh host "gh pr merge --squash https://github.com/o/r/pull/14"'),
    ).toEqual([14]);
    expect(extractPrNumbersFromCommand('x=`gh pr merge 15`; echo "$x"')).toEqual([15]);
    // Words before an unclosed quote still decide the argument.
    expect(extractPrNumbersFromCommand("gh pr merge 16 --subject 'unclosed")).toEqual([16]);
    // A closed inner quote inside the wrapper is one word.
    expect(
      extractPrNumbersFromCommand(`bash -c "gh pr merge --subject 'a 1' 17"`),
    ).toEqual([17]);
    expect(
      extractPrNumbersFromCommand(`sh -c 'gh pr merge --subject "fix 9" 18'`),
    ).toEqual([18]);
  });

  test('escaped quotes inside a wrapper fall back instead of reading a value word', () => {
    // The inner `\"…\"` is quoted one level deeper than this parser reads, so
    // a word of the quoted value must not be taken for the argument.
    expect(
      extractPrNumbersFromCommand('bash -c "gh pr merge --subject \\"fix 9 now\\" 12"'),
    ).toEqual([]);
    expect(
      extractPrNumbersFromCommand('ssh host "gh pr merge --body \\"closes #5 too\\" 12"'),
    ).toEqual([]);
    expect(
      extractPrNumbersFromCommand('bash -c "gh pr merge --subject \\"fix 9\\" 12"'),
    ).toEqual([]);
  });

  test('a line continuation is not a word', () => {
    expect(
      extractPrNumbersFromCommand(
        'gh pr merge --squash --delete-branch \\\n  https://github.com/o/r/pull/62',
      ),
    ).toEqual([62]);
    expect(extractPrNumbersFromCommand('gh pr merge \\\n  -R o/r \\\n  63')).toEqual([63]);
    // The shell deletes a backslash-newline, so mid-word it joins the word.
    expect(extractPrNumbersFromCommand('gh pr merge --squash 31\\\n2')).toEqual([312]);
  });

  test('redirections and their targets are not the argument', () => {
    // `2>&1` is a redirection of file descriptor 2, not PR 2.
    expect(extractPrNumbersFromCommand('gh pr merge --squash 2>&1')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr merge --squash > log 2>&1')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr merge --squash >out.txt 3')).toEqual([3]);
    // `>&2` is one redirection: its `&` does not end the command.
    expect(extractPrNumbersFromCommand('gh pr merge --squash >&2 34')).toEqual([34]);
    expect(extractPrNumbersFromCommand('gh pr merge 18 >log 2>&1')).toEqual([18]);
    expect(extractPrNumbersFromCommand('gh pr merge 19 </dev/null')).toEqual([19]);
    // A number glued to `>` or `<` is a file descriptor: the shell passes no argument.
    expect(extractPrNumbersFromCommand('gh pr merge 20>log')).toEqual([]);
  });

  test('a backslash escape inside double quotes stays inside the value', () => {
    expect(
      extractPrNumbersFromCommand('gh pr merge --subject "say \\"9\\" now" 64'),
    ).toEqual([64]);
  });

  test('a merge inside a subshell still yields its argument', () => {
    expect(extractPrNumbersFromCommand('(cd ../wt && gh pr merge --squash 58)')).toEqual([58]);
    expect(
      extractPrNumbersFromCommand('gh pr merge -R o/r --squash 59 && kookr merge --repo o/r 60'),
    ).toEqual([59, 60]);
  });

  // Issue #4126: before, every URL and every "PR #N" in any command counted
  // as a PR the task had to merge. A mention is not ownership.
  test('ignores read-only and prose mentions of other PRs', () => {
    expect(
      extractPrNumbersFromCommand('open https://github.com/kookr-ai/kookr/pull/1836 and done'),
    ).toEqual([]);
    expect(extractPrNumbersFromCommand('see PR #7 for context')).toEqual([]);
    expect(extractPrNumbersFromCommand('git commit -m "follow-up to pull request 8"')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr view 9 --json state')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr diff 9')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr list --state open')).toEqual([]);
    expect(extractPrNumbersFromCommand('gh pr create --body "see PR #9"')).toEqual([]);
  });

  test('reads the opened PR number from gh pr create output only', () => {
    expect(
      extractCreatedPrNumbersFromOutput(
        'gh pr create --fill',
        'Creating pull request\nhttps://github.com/o/r/pull/21\n',
      ),
    ).toEqual([21]);
    expect(
      extractCreatedPrNumbersFromOutput(
        'gh pr view 9 --json url',
        'https://github.com/o/r/pull/9',
      ),
    ).toEqual([]);
    expect(extractCreatedPrNumbersFromOutput('gh pr create --fill', '')).toEqual([]);
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

  /** Write raw hook lines (pre and post) as one session log. */
  function writeRawLog(session: string, lines: string[]) {
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
    writeRawLog('sess', [
      preToolBash('gh pr create --fill'),
      postToolBash('gh pr create --fill', 'https://github.com/o/r/pull/99\n'),
    ]);
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
    writeRawLog('sess', [
      preToolBash('gh pr create --fill'),
      postToolBash('gh pr create --fill', 'https://github.com/o/r/pull/55\n'),
    ]);
    const verifyMerged = async (nums: number[]) => {
      expect(nums).toEqual([55]);
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

  test('numberless create+merge still calls verifyMerged([]) for branch-scoped live check', async () => {
    writeLog('sess', ['gh pr create --fill', 'gh pr merge --squash']);
    let seen: number[] | undefined;
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      {
        verifyMerged: async (nums) => {
          seen = nums;
          // Live says still open → must reject despite trail merge intent.
          return { allMerged: false, checked: 1 };
        },
      },
    );
    expect(seen).toEqual([]);
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe(MERGE_REQUIRED_CODE);
  });

  // --- Issue #4126 acceptance criteria -----------------------------------

  /** Live verifier stub: only the PR numbers in `merged` are merged. */
  function stubVerifier(merged: number[]) {
    const calls: number[][] = [];
    const verifyMerged = async (nums: number[]) => {
      calls.push([...nums]);
      if (nums.length === 0) return { allMerged: false, checked: 1 };
      return { allMerged: nums.every((n) => merged.includes(n)), checked: nums.length };
    };
    return { calls, verifyMerged };
  }

  test('#4126 AC1: create + merge 10 + look at open PR 9 passes when 10 is merged', async () => {
    writeLog('sess', [
      'gh pr create --fill',
      'gh pr view 9',
      'gh pr diff 9',
      // What really pulled foreign numbers in before the fix:
      'echo "background: PR #9 edits the same test file"',
      'gh pr comment 9 --body "see https://github.com/o/r/pull/9"',
      'kookr merge 10 --repo o/r',
    ]);
    const { calls, verifyMerged } = stubVerifier([10]);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      { verifyMerged },
    );
    expect(calls).toEqual([[10]]);
    expect(verdict.allow).toBe(true);
    expect(verdict.evidence?.prNumbers).toEqual([10]);
  });

  test('#4126 AC2: create + merge 10 is still refused while 10 is open', async () => {
    writeLog('sess', ['gh pr create --fill', 'kookr merge 10 --repo o/r']);
    const { calls, verifyMerged } = stubVerifier([]);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      { verifyMerged },
    );
    expect(calls).toEqual([[10]]);
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe(MERGE_REQUIRED_CODE);
    expect(verdict.prNumbers).toEqual([10]);
  });

  test('#4126 AC3: create with no number falls back to the current-branch check', async () => {
    writeLog('sess', ['gh pr create --fill', 'gh pr view 9']);
    const { calls, verifyMerged } = stubVerifier([9]);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      { verifyMerged },
    );
    // Asked about the current branch ([]), never about the foreign PR 9.
    expect(calls).toEqual([[]]);
    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe(MERGE_REQUIRED_CODE);
  });

  test('post-tool lines add the created PR number without double-counting commands', async () => {
    writeRawLog('sess', [
      preToolBash('gh pr create --fill'),
      postToolBash('gh pr create --fill', 'https://github.com/o/r/pull/31\n'),
      preToolBash('gh pr merge 31 --squash'),
      postToolBash('gh pr merge 31 --squash', 'Merged https://github.com/o/r/pull/32'),
    ]);
    const trail = await resolveTaskMergeEvidence(
      { sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
    );
    expect(trail.prCreateCommands).toBe(1);
    expect(trail.prMergeCommands).toBe(1);
    expect(trail.prNumbers).toEqual([31]);
  });

  test('#4128: a merge with a flag before its URL is checked by number, not by branch', async () => {
    // No create output captured, so the merge argument is the only number.
    writeLog('sess', [
      'gh pr create --fill',
      'gh pr merge --squash https://github.com/o/r/pull/61',
    ]);
    const { calls, verifyMerged } = stubVerifier([61]);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      { verifyMerged },
    );
    expect(calls).toEqual([[61]]);
    expect(verdict.allow).toBe(true);
  });

  // #4128 item 2: Codex and OpenCode write Claude-shaped PostToolUse lines
  // (tool_name "Bash", tool_input.command, tool_response) through the same
  // hook writer, so the opened PR number is read from their output too.
  test('#4128: reads the created PR from a Codex-shaped post-tool line', async () => {
    writeRawLog('sess', [
      JSON.stringify({
        session_id: 'codex-session',
        turn_id: 'turn-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill' },
        tool_use_id: 'tu-1',
      }),
      JSON.stringify({
        session_id: 'codex-session',
        turn_id: 'turn-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill' },
        tool_response: { output: 'https://github.com/o/r/pull/62\n', exit_code: 0 },
        tool_use_id: 'tu-1',
      }),
    ]);
    const trail = await resolveTaskMergeEvidence({ sessions: [{ tmuxSession: 'sess' }] }, hooksDir);
    expect(trail.prCreateCommands).toBe(1);
    expect(trail.prNumbers).toEqual([62]);
  });

  test('#4128: reads the created PR from an OpenCode-shaped post-tool line', async () => {
    // The OpenCode plugin maps `bash` to "Bash" and logs the output as a string.
    writeRawLog('sess', [
      JSON.stringify({
        session_id: 'oc-session',
        hook_event_name: 'PreToolUse',
        cwd: '/work',
        transcript_path: '',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill', description: 'open PR' },
      }),
      JSON.stringify({
        session_id: 'oc-session',
        hook_event_name: 'PostToolUse',
        cwd: '/work',
        transcript_path: '',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill', description: 'open PR' },
        tool_response: 'https://github.com/o/r/pull/63\n',
      }),
    ]);
    const { calls, verifyMerged } = stubVerifier([63]);
    const verdict = await resolveMergeRequiredGate(
      { mergeRequired: true, sessions: [{ tmuxSession: 'sess' }] },
      hooksDir,
      { verifyMerged },
    );
    // Asked about the opened PR, not about the current branch.
    expect(calls).toEqual([[63]]);
    expect(verdict.allow).toBe(true);
  });
});

describe('createGhMergedAtVerifier', () => {
  test('with no PR numbers, asks gh about the current branch', async () => {
    const seen: string[][] = [];
    const exec = (async (_cmd: string, args: string[]) => {
      seen.push(args);
      return { stdout: JSON.stringify({ number: 3, mergedAt: null }), stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof createGhMergedAtVerifier>[0]>['exec'];
    const verify = createGhMergedAtVerifier({ exec });
    expect(await verify([])).toEqual({ allMerged: false, checked: 1 });
    expect(seen).toEqual([['pr', 'view', '--json', 'number,mergedAt']]);
  });

  test('with PR numbers, checks only those numbers', async () => {
    const seen: string[][] = [];
    const exec = (async (_cmd: string, args: string[]) => {
      seen.push(args);
      return { stdout: JSON.stringify({ mergedAt: '2026-11-17T08:11:23Z' }), stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof createGhMergedAtVerifier>[0]>['exec'];
    const verify = createGhMergedAtVerifier({ exec });
    expect(await verify([10])).toEqual({ allMerged: true, checked: 1 });
    expect(seen).toEqual([['pr', 'view', '10', '--json', 'mergedAt']]);
  });
});
