/**
 * Merge-required completion-ready gate (issue #1836).
 *
 * Stranded-PR incident enabler: pre-authorized tasks that open a PR but never
 * merge can still raise `completion_ready` (and `--auto-close-on-signal` retires
 * them as completed). Prompt-side persuasion is not enough — an agent that
 * drops instructions still exits successfully.
 *
 * This gate mirrors the #1538 lesson-decision pattern:
 *  1. Opt-in: only tasks with merge authority (explicit flag, playbook param,
 *     or TERMINAL-STATE CONTRACT header in the prompt) are gated.
 *  2. When authority is set and the hook trail shows a PR was opened whose
 *     merge is unverified, `completion_ready` is refused with HTTP 409 /
 *     `merge_required` — unless a `PR-BLOCKER:` marker is in the trail.
 *  3. Tasks without an explicit mergeAfterImplementation=true / mergeRequired
 *     stamp are unaffected. The pre-authorized preamble may still tell the
 *     agent to merge operator-owned PRs; this gate only enforces
 *     playbook/contract opt-in so OSS playbooks are not forced to merge
 *     upstream.
 *
 * Detection reuses {@link extractShellHookLine} / hook-log scanning
 * from `lesson-decision.ts`.
 */

import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
  extractShellHookLine,
  hookLogPath,
  type HookLogScanOptions,
  type TaskSessionLike,
} from './lesson-decision.js';
import { isPrMergeCommand } from './pr-merge-command.js';

const execFileAsync = promisify(execFile);

/** Machine-readable 409 body code when completion-ready is refused. */
export const MERGE_REQUIRED_CODE = 'merge_required' as const;

/**
 * Explicit blocker marker agents print when they cannot merge
 * (`printf 'PR-BLOCKER: …'`). Presence in the hook trail satisfies the gate.
 */
export const PR_BLOCKER_MARKER = 'PR-BLOCKER:';

/** Env escape hatch for hermetic tests / emergency ops. Values: `0`/`false`/`off`/`no`. */
export const MERGE_REQUIRED_GATE_ENV = 'KOOKR_MERGE_REQUIRED_GATE';

export const MERGE_REQUIRED_HINT =
  'Merge authority was granted for this task. Merge the open PR '
  + '(`gh pr view <n> --json mergedAt` must be non-null) or record a blocker '
  + `with: printf '${PR_BLOCKER_MARKER} %s\\n' '<reason>', then re-signal.`;

// --- Merge-authority detection (opt-in) ------------------------------------

/**
 * Minimal task shape for merge-authority detection. Explicit fields are the
 * preferred spawner path; prompt/param detection covers child tasks that only
 * carry the TERMINAL-STATE CONTRACT text.
 */
export interface TaskLikeForMergeRequired {
  prompt?: string;
  userPrompt?: string;
  /**
   * Explicit opt-in set by spawners (e.g. parallel-issue-batch with
   * `terminalState: "merged-pr"` / `mergeRequired: true`).
   */
  mergeRequired?: boolean;
  /** Alternate explicit stamp: terminal delivery state is a merged PR. */
  terminalState?: string;
  playbookParameterValues?: Record<string, string>;
  /**
   * Loose metadata bag — only `mergeRequired` / `terminalState` are read when
   * present. Typed loosely so real {@link Task} metadata (which has other
   * fields and no index signature) remains assignable without widening Task.
   */
  metadata?: object & {
    mergeRequired?: boolean;
    terminalState?: string;
  };
  sessions?: TaskSessionLike[];
}

/**
 * True when the task was launched under a "merged PR is the terminal state"
 * policy. Opt-in only — ordinary open-PR review-gate tasks return false.
 */
export function taskHasMergeAuthority(task: TaskLikeForMergeRequired): boolean {
  if (task.mergeRequired === true) return true;
  if (task.terminalState === 'merged-pr') return true;
  if (task.metadata?.mergeRequired === true) return true;
  if (task.metadata?.terminalState === 'merged-pr') return true;

  const param = task.playbookParameterValues?.mergeAfterImplementation;
  if (param === 'true' || param === '1') return true;

  const text = `${task.prompt ?? ''}\n${task.userPrompt ?? ''}`;
  return promptDeclaresMergeAuthority(text);
}

/**
 * Detect merge authority from prompt text.
 *
 * Matches the parallel-issue-batch / implement-github-issue
 * `TERMINAL-STATE CONTRACT (mergeAfterImplementation=true)` header and common
 * resolved forms after template substitution.
 */
export function promptDeclaresMergeAuthority(prompt: string): boolean {
  if (!prompt) return false;

  // Canonical header after substitution:
  //   TERMINAL-STATE CONTRACT (mergeAfterImplementation=true):
  if (
    /TERMINAL-STATE\s+CONTRACT\s*\(\s*mergeAfterImplementation\s*=\s*true\s*\)/i.test(
      prompt,
    )
  ) {
    return true;
  }

  // Explicit "you hold merge authority" near a true merge policy.
  if (
    /mergeAfterImplementation\s*[:=]\s*true\b/i.test(prompt)
    && /merge authority|must continue through the merge|mergedAt/i.test(prompt)
  ) {
    return true;
  }

  return false;
}

// --- Hook-trail classification ---------------------------------------------

export type MergeTrailSignal =
  | 'pr-create'
  | 'pr-merge'
  | 'pr-blocker'
  | 'none';

const PR_URL_RE =
  /https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/(?:-\/)?(?:pull|merge_requests)\/(\d+)/gi;

/**
 * A merge command's verb: `gh pr merge`, `pnpm merge`, `kookr merge`,
 * `kookr-merge.sh`. Its first non-flag word names the PR it merges.
 */
const MERGE_VERB_RE =
  /\b(?:gh\s+pr\s+merge|pnpm\s+merge|kookr\s+merge|kookr-merge\.sh)(?=\s|$)/gi;

/**
 * Merge-command flags that take their value as the next word: the
 * `gh pr merge` flags listed by `gh help pr merge`, plus `--repo` of the
 * merge wrappers. Any other flag is read as taking no value, and a
 * `--flag=value` word is one word.
 */
const MERGE_VALUE_FLAGS = new Set([
  '-A', '--author-email',
  '-b', '--body',
  '-F', '--body-file',
  '--match-head-commit',
  '-R', '--repo',
  '-t', '--subject',
]);

const BARE_PR_ARG_RE = /^#?(\d+)$/;
const PR_URL_ARG_RE =
  /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/(?:-\/)?(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/i;

/** Characters that end a simple command: the argument never comes after one. */
const COMMAND_END_CHARS = new Set(['\n', ';', '&', '|', ')', '`']);

/**
 * Split shell text into words, honouring quotes and backslashes, up to the end
 * of the simple command (`;`, `&`, `|`, `)`, a backtick or a newline).
 *
 * - A quote that never closes also ends the command, keeping the words read so
 *   far. The merge is then usually the last thing inside a wrapper whose own
 *   quote closes after it: `bash -c "gh pr merge 12"`, `ssh host '…'`. If a
 *   backslash escape came first, the inner text was quoted one level deeper
 *   (`\"fix 9\"`) and its words cannot be read at this level: no words then.
 * - A backslash-newline is deleted, as the shell does: a line continuation.
 * - A redirection (`>log`, `2>&1`, `<in`) is dropped with its target, and a
 *   number glued to it is a file descriptor, not an argument: in
 *   `gh pr merge --squash 2>&1` the shell passes no `2` to the command.
 */
function wordsUntilCommandEnd(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let dropNextWord = false;
  let sawEscape = false;
  const endWord = (): void => {
    if (inWord && !dropNextWord) words.push(word);
    if (inWord) dropNextWord = false;
    word = '';
    inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (COMMAND_END_CHARS.has(c)) break;
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    if (c === '\\' && text[i + 1] === '\n') {
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      while (i + 1 < text.length && /[<>&]/.test(text[i + 1]!)) i++;
      dropNextWord = true;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) {
        if (sawEscape) return [];
        break;
      }
      inWord = true;
      word += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let quoted = '';
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        quoted += text[j];
      }
      if (j >= text.length) {
        if (sawEscape) return [];
        break;
      }
      inWord = true;
      word += quoted;
      i = j;
    } else if (c === '\\') {
      sawEscape = true;
      inWord = true;
      if (i + 1 < text.length) word += text[++i];
    } else {
      inWord = true;
      word += c;
    }
  }
  endWord();
  return words;
}

/**
 * The first non-flag word after a merge verb (issue #4128), skipping the value
 * of each flag in {@link MERGE_VALUE_FLAGS}. So `gh pr merge --squash <url>`
 * and `gh pr merge -R o/r 12` read the URL and 12, never `o/r`. A `--` is a
 * valueless flag here, so the word after it is the argument.
 */
function mergeCommandArgument(afterVerb: string): string | undefined {
  const words = wordsUntilCommandEnd(afterVerb);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.length > 1 && w.startsWith('-')) {
      if (MERGE_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;

/**
 * Classify one shell command for merge-gate evidence.
 * Order: blocker > merge > create > none (strongest signal first).
 */
export function classifyMergeTrailCommand(command: string): MergeTrailSignal {
  if (command.includes(PR_BLOCKER_MARKER)) return 'pr-blocker';
  if (isPrMergeCommand(command)) return 'pr-merge';
  if (GH_PR_CREATE_RE.test(command)) return 'pr-create';
  return 'none';
}

function addPositive(nums: Set<number>, raw: string | undefined): void {
  if (raw === undefined) return;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) nums.add(n);
}

/**
 * PR numbers this command merges (issue #4126): the argument of
 * `gh pr merge <n|url>` / `pnpm merge <n>` / `kookr merge <n>` /
 * `kookr-merge.sh <n>`, with flags before it skipped (issue #4128).
 *
 * Any other mention is ignored — a URL in a comment, "PR #N" in a commit
 * message or `echo`, `gh pr view <n>` / `gh pr diff <n>` / `gh pr list`. Those
 * PRs belong to someone else, so the gate must not demand that they be merged.
 * When the argument is missing or is not a number or PR URL (a branch name),
 * no number is returned and the gate falls back to the created PR or the
 * current branch: better than a wrong PR.
 */
export function extractPrNumbersFromCommand(command: string): number[] {
  const nums = new Set<number>();
  for (const verb of command.matchAll(MERGE_VERB_RE)) {
    const arg = mergeCommandArgument(command.slice(verb.index + verb[0].length));
    if (arg === undefined) continue;
    addPositive(nums, (BARE_PR_ARG_RE.exec(arg) ?? PR_URL_ARG_RE.exec(arg))?.[1]);
  }
  return [...nums];
}

/**
 * PR numbers a `gh pr create` command opened, read from its output (gh prints
 * the new PR's URL). Returns [] for any other command, and never reads the
 * create command's own text: a `--body` citing another PR is not this task's PR.
 */
export function extractCreatedPrNumbersFromOutput(
  command: string,
  output: string,
): number[] {
  if (!GH_PR_CREATE_RE.test(command) || !output) return [];
  const nums = new Set<number>();
  for (const match of output.matchAll(PR_URL_RE)) addPositive(nums, match[1]);
  return [...nums];
}

export interface MergeTrailEvidence {
  prCreateCommands: number;
  prMergeCommands: number;
  prBlockerCommands: number;
  /**
   * PR numbers this task opened or merged: `gh pr create` output URLs and
   * merge-command arguments. Read-only mentions are excluded (issue #4126).
   */
  prNumbers: number[];
  /** True when any session log existed on disk. */
  hasLogs: boolean;
  sessionsScanned: number;
  missingLogs: number;
}

export function emptyMergeTrailEvidence(): MergeTrailEvidence {
  return {
    prCreateCommands: 0,
    prMergeCommands: 0,
    prBlockerCommands: 0,
    prNumbers: [],
    hasLogs: false,
    sessionsScanned: 0,
    missingLogs: 0,
  };
}

/**
 * Scan one hook JSONL for merge-gate signals. Reuses dual agent schema
 * extraction (Claude snake_case + Grok camelCase) via lesson-decision.
 */
export async function scanHookLogForMergeEvidence(
  path: string,
  opts: HookLogScanOptions = {},
): Promise<Omit<MergeTrailEvidence, 'sessionsScanned' | 'missingLogs'>> {
  opts.signal?.throwIfAborted();
  if (!existsSync(path)) {
    return {
      prCreateCommands: 0,
      prMergeCommands: 0,
      prBlockerCommands: 0,
      prNumbers: [],
      hasLogs: false,
    };
  }

  let prCreateCommands = 0;
  let prMergeCommands = 0;
  let prBlockerCommands = 0;
  const prNumbers = new Set<number>();

  const stream = createReadStream(path, { encoding: 'utf8', signal: opts.signal });
  const rl = createInterface({ input: stream });
  try {
    for await (const line of rl) {
      opts.signal?.throwIfAborted();
      if (!line) continue;
      let evt: {
        hook_event_name?: unknown;
        hookEventName?: unknown;
        tool_name?: unknown;
        toolName?: unknown;
        tool_input?: unknown;
        toolInput?: unknown;
      };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        continue;
      }
      const shell = extractShellHookLine(evt);
      if (shell === null) continue;
      if (shell.phase === 'post') {
        // Post lines only contribute the URL `gh pr create` printed; every
        // count below comes from pre lines so nothing is counted twice.
        for (const n of extractCreatedPrNumbersFromOutput(shell.command, shell.output)) {
          prNumbers.add(n);
        }
        continue;
      }
      const cmd = shell.command;

      for (const n of extractPrNumbersFromCommand(cmd)) prNumbers.add(n);

      switch (classifyMergeTrailCommand(cmd)) {
        case 'pr-blocker':
          prBlockerCommands++;
          break;
        case 'pr-merge':
          prMergeCommands++;
          break;
        case 'pr-create':
          prCreateCommands++;
          break;
        case 'none':
          break;
      }

      // Early exit only on blocker (decisive allow that needs no further scan).
      // Do NOT stop on the first merge command — later lines may carry the PR
      // number/URL needed for live mergedAt verification.
      if (prBlockerCommands > 0) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    prCreateCommands,
    prMergeCommands,
    prBlockerCommands,
    prNumbers: [...prNumbers],
    hasLogs: true,
  };
}

/** Aggregate merge-trail evidence across every session of a task. */
export async function resolveTaskMergeEvidence(
  task: TaskLikeForMergeRequired,
  hooksDir: string,
  opts: HookLogScanOptions = {},
): Promise<MergeTrailEvidence> {
  let prCreateCommands = 0;
  let prMergeCommands = 0;
  let prBlockerCommands = 0;
  const prNumbers = new Set<number>();
  let sessionsScanned = 0;
  let missingLogs = 0;
  let hasLogs = false;

  for (const session of task.sessions ?? []) {
    opts.signal?.throwIfAborted();
    const name = session.tmuxSession?.trim();
    if (!name) continue;
    sessionsScanned++;
    const path = hookLogPath(hooksDir, name);
    if (!path) {
      missingLogs++;
      continue;
    }
    const stats = await scanHookLogForMergeEvidence(path, opts);
    if (!stats.hasLogs) {
      missingLogs++;
      continue;
    }
    hasLogs = true;
    prCreateCommands += stats.prCreateCommands;
    prMergeCommands += stats.prMergeCommands;
    prBlockerCommands += stats.prBlockerCommands;
    for (const n of stats.prNumbers) prNumbers.add(n);
    // Blocker is a decisive allow — remaining sessions cannot revote it down.
    // Keep scanning after merge so later sessions can contribute PR numbers
    // for live verification.
    if (prBlockerCommands > 0) break;
  }

  return {
    prCreateCommands,
    prMergeCommands,
    prBlockerCommands,
    prNumbers: [...prNumbers],
    hasLogs,
    sessionsScanned,
    missingLogs,
  };
}

// --- Pure gate -------------------------------------------------------------

export interface MergeRequiredGateInput {
  /** When false, the gate is bypassed (env kill-switch or test seam). */
  enabled?: boolean;
  /** Whether this task was launched with merge authority. */
  mergeAuthority: boolean;
  /**
   * Hook-trail / live evidence. When mergeAuthority is false this is ignored.
   * Callers typically pass the result of {@link resolveTaskMergeEvidence} plus
   * an optional live `mergedVerified` override from `gh pr view`.
   */
  evidence: {
    /** Agent opened a PR (`gh pr create` and/or PR URL/number in trail). */
    prOpened: boolean;
    /** Merge verified: merge command in trail, or live mergedAt non-null. */
    mergedVerified: boolean;
    /** `PR-BLOCKER:` marker observed in the trail. */
    blockerRecorded: boolean;
    /** Optional list of PR numbers for the 409 body / diagnostics. */
    prNumbers?: number[];
  };
}

export interface MergeRequiredGateVerdict {
  allow: boolean;
  code?: typeof MERGE_REQUIRED_CODE;
  reason: string;
  hint?: string;
  prNumbers?: number[];
}

/**
 * Derive the booleans the pure gate needs from trail evidence + optional
 * live-verification results.
 *
 * - `prOpened`: `gh pr create` in the trail (not merely a PR number mention —
 *   `gh pr view` / "PR #N" alone do not count as opened by this task).
 * - `mergedVerified`: when a live check ran (`checked > 0`), live truth wins
 *   (`allMerged`). Otherwise fall back to a trail merge command as best-effort
 *   hermetic evidence (PreToolUse intent — live `mergedAt` is preferred).
 * - `blockerRecorded`: any `PR-BLOCKER:` marker.
 */
export function evidenceFromTrail(
  trail: MergeTrailEvidence,
  liveMerged?: { allMerged: boolean; checked: number },
): MergeRequiredGateInput['evidence'] {
  const prOpened = trail.prCreateCommands > 0;
  const trailMerged = trail.prMergeCommands > 0;
  // Prefer live truth when available so a failed `gh pr merge` attempt cannot
  // green-light completion-ready while the PR is still open.
  const mergedVerified =
    liveMerged != null && liveMerged.checked > 0
      ? liveMerged.allMerged
      : trailMerged;
  return {
    prOpened,
    mergedVerified,
    blockerRecorded: trail.prBlockerCommands > 0,
    // Prefer numbers from trail; when only create was logged, numbers may be empty.
    prNumbers: trail.prNumbers,
  };
}

/**
 * Default live verifier: `gh pr view <n> --json mergedAt` for each PR number.
 * When `prNumbers` is empty, falls back to branch-scoped
 * `gh pr view --json number,mergedAt` (current branch in `cwd`) so numberless
 * `gh pr create --fill` / `gh pr merge --squash` trails still get live truth.
 *
 * A non-null `mergedAt` means merged. On gh failure / timeout the PR is left
 * unchecked (caller falls back to trail evidence only when `checked === 0`).
 *
 * Bound latency: default 4s per probe.
 */
export function createGhMergedAtVerifier(opts: {
  /** Working directory for `gh` (repo context). */
  cwd?: string;
  /** Per-PR timeout in ms (default 4000). */
  timeoutMs?: number;
  /** Optional override for tests. */
  exec?: typeof execFileAsync;
} = {}): (prNumbers: number[]) => Promise<{ allMerged: boolean; checked: number }> {
  const run = opts.exec ?? execFileAsync;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  return async (prNumbers: number[]) => {
    let checked = 0;
    let allMerged = true;
    const numbers = prNumbers.filter((n) => Number.isInteger(n) && n > 0);

    if (numbers.length === 0) {
      // Branch-scoped view: covers numberless create/merge on the task cwd.
      try {
        const { stdout } = await run(
          'gh',
          ['pr', 'view', '--json', 'number,mergedAt'],
          {
            cwd: opts.cwd,
            timeout: timeoutMs,
            encoding: 'utf8',
            maxBuffer: 64 * 1024,
          },
        );
        const parsed = JSON.parse(String(stdout)) as { mergedAt?: string | null };
        checked = 1;
        allMerged = parsed.mergedAt != null && parsed.mergedAt !== '';
      } catch {
        // leave checked=0
      }
      return { allMerged, checked };
    }

    for (const n of numbers) {
      try {
        const { stdout } = await run(
          'gh',
          ['pr', 'view', String(n), '--json', 'mergedAt'],
          {
            cwd: opts.cwd,
            timeout: timeoutMs,
            encoding: 'utf8',
            maxBuffer: 64 * 1024,
          },
        );
        const parsed = JSON.parse(String(stdout)) as { mergedAt?: string | null };
        checked++;
        if (parsed.mergedAt == null || parsed.mergedAt === '') {
          allMerged = false;
        }
      } catch {
        // Leave this PR unchecked; do not flip allMerged on transport errors.
      }
    }
    if (checked === 0) return { allMerged: false, checked: 0 };
    return { allMerged, checked };
  };
}

/**
 * Pure gate. Fail-open when disabled or when the task has no merge authority.
 * Fail-closed when authority is set, a PR was opened, merge is unverified, and
 * no blocker was recorded.
 */
export function evaluateMergeRequiredGate(
  input: MergeRequiredGateInput,
): MergeRequiredGateVerdict {
  if (input.enabled === false) {
    return { allow: true, reason: 'Merge-required gate disabled.' };
  }
  if (!input.mergeAuthority) {
    return {
      allow: true,
      reason: 'Task has no merge authority — merge-required gate not applicable.',
    };
  }
  if (input.evidence.blockerRecorded) {
    return {
      allow: true,
      reason: 'PR-BLOCKER marker observed in hook trail; merge obligation waived.',
      prNumbers: input.evidence.prNumbers,
    };
  }
  if (!input.evidence.prOpened) {
    // No PR was opened — this gate only covers the "opened but unmerged"
    // stranded-PR case. Incomplete work without a PR is out of scope.
    return {
      allow: true,
      reason: 'Merge authority set but no PR open evidence in trail; gate not triggered.',
    };
  }
  if (input.evidence.mergedVerified) {
    return {
      allow: true,
      reason: 'Opened PR merge verified (trail merge command or live mergedAt).',
      prNumbers: input.evidence.prNumbers,
    };
  }
  return {
    allow: false,
    code: MERGE_REQUIRED_CODE,
    reason:
      'Merge authority was granted and a PR was opened, but merge is unverified '
      + 'and no PR-BLOCKER was recorded.',
    hint: MERGE_REQUIRED_HINT,
    prNumbers: input.evidence.prNumbers,
  };
}

/** Whether the env kill-switch disables the gate. Default: enabled. */
export function isMergeRequiredGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[MERGE_REQUIRED_GATE_ENV];
  if (raw === undefined || raw === '') return true;
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === '0'
    || normalized === 'false'
    || normalized === 'off'
    || normalized === 'no'
  );
}

/**
 * Env kill-switch for live `gh pr view --json mergedAt` probes.
 * Default: enabled outside Vitest; disabled when `VITEST` is set so hermetic
 * unit/route tests do not shell out. Set `KOOKR_MERGE_REQUIRED_LIVE_VERIFY=0`
 * to force trail-only verification in production emergencies.
 */
export const MERGE_REQUIRED_LIVE_VERIFY_ENV = 'KOOKR_MERGE_REQUIRED_LIVE_VERIFY';

export function shouldUseLiveMergeVerify(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[MERGE_REQUIRED_LIVE_VERIFY_ENV];
  if (raw !== undefined && raw !== '') {
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === '0'
      || normalized === 'false'
      || normalized === 'off'
      || normalized === 'no'
    ) {
      return false;
    }
    if (
      normalized === '1'
      || normalized === 'true'
      || normalized === 'on'
      || normalized === 'yes'
    ) {
      return true;
    }
  }
  // Hermetic test runners must not depend on network/`gh`.
  if (env.VITEST != null && env.VITEST !== '') return false;
  return true;
}

/**
 * High-level resolve: detect authority + scan trail + evaluate.
 * Used by the HTTP signal route and the outbox drain.
 */
export async function resolveMergeRequiredGate(
  task: TaskLikeForMergeRequired,
  hooksDir: string | undefined,
  opts: HookLogScanOptions & {
    enabled?: boolean;
    /**
     * Optional live check: given PR numbers from the trail, return whether
     * every one has non-null `mergedAt`. When omitted, trail merge commands
     * are the only merge verification path (hermetic-safe).
     */
    verifyMerged?: (prNumbers: number[]) => Promise<{ allMerged: boolean; checked: number }>;
  } = {},
): Promise<MergeRequiredGateVerdict & { evidence?: MergeRequiredGateInput['evidence'] }> {
  const enabled = opts.enabled ?? isMergeRequiredGateEnabled();
  if (enabled === false) {
    return { allow: true, reason: 'Merge-required gate disabled.' };
  }

  const mergeAuthority = taskHasMergeAuthority(task);
  if (!mergeAuthority) {
    return {
      allow: true,
      reason: 'Task has no merge authority — merge-required gate not applicable.',
    };
  }

  // Without a hooks dir we cannot see trail evidence. Fail-open: the gate is
  // opt-in and needs evidence; a misconfigured server must not brick all
  // completion-ready signals for merge-authority tasks.
  if (!hooksDir) {
    return {
      allow: true,
      reason: 'No hooks directory configured; merge-required gate fail-open.',
    };
  }

  const trail = await resolveTaskMergeEvidence(task, hooksDir, { signal: opts.signal });
  let live: { allMerged: boolean; checked: number } | undefined;
  // Prefer live truth whenever a PR was opened (or a merge was attempted) and
  // there is no blocker — even with no PR numbers yet (branch-scoped gh view)
  // and even when the trail already shows a merge command (intent ≠ success).
  const needsLive =
    opts.verifyMerged
    && trail.prBlockerCommands === 0
    && (trail.prCreateCommands > 0 || trail.prMergeCommands > 0 || trail.prNumbers.length > 0);
  if (needsLive && opts.verifyMerged) {
    try {
      live = await opts.verifyMerged(trail.prNumbers);
    } catch {
      // Live check failures fall back to trail-only evidence.
      live = undefined;
    }
  }

  const evidence = evidenceFromTrail(trail, live);
  const verdict = evaluateMergeRequiredGate({
    enabled: true,
    mergeAuthority: true,
    evidence,
  });
  return { ...verdict, evidence };
}
