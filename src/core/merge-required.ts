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
 * Detection reuses {@link extractShellCommandFromHookLine} / hook-log scanning
 * from `lesson-decision.ts`.
 */

import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
  extractShellCommandFromHookLine,
  hookLogPath,
  type HookLogScanOptions,
  type TaskSessionLike,
} from './lesson-decision.js';

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
const PR_NUMBER_EXPLICIT_RE = /\b(?:PR|pull request)\s*#?(\d+)\b/gi;

/**
 * Classify one shell command for merge-gate evidence.
 * Order: blocker > merge > create > none (strongest signal first).
 */
export function classifyMergeTrailCommand(command: string): MergeTrailSignal {
  if (command.includes(PR_BLOCKER_MARKER)) return 'pr-blocker';
  // Merge wrappers used by autonomous delivery on kookr-ai/kookr and forks.
  if (/\bgh\s+pr\s+merge\b/i.test(command)) return 'pr-merge';
  if (/\bpnpm\s+merge\b/i.test(command)) return 'pr-merge';
  if (/\bkookr-merge\.sh\b/i.test(command)) return 'pr-merge';
  if (/\bgh\s+pr\s+create\b/i.test(command)) return 'pr-create';
  return 'none';
}

/** Extract PR numbers referenced in a shell command (URL or "PR #N"). */
export function extractPrNumbersFromCommand(command: string): number[] {
  const nums = new Set<number>();
  for (const match of command.matchAll(PR_URL_RE)) {
    const n = parseInt(match[1]!, 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  for (const match of command.matchAll(PR_NUMBER_EXPLICIT_RE)) {
    const n = parseInt(match[1]!, 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  // `gh pr merge 123` / `pnpm merge 123` / `gh pr create` with no number yet.
  const ghMerge = command.match(/\bgh\s+pr\s+merge\s+(\d+)\b/i);
  if (ghMerge) {
    const n = parseInt(ghMerge[1]!, 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  const pnpmMerge = command.match(/\bpnpm\s+merge\s+(\d+)\b/i);
  if (pnpmMerge) {
    const n = parseInt(pnpmMerge[1]!, 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return [...nums];
}

export interface MergeTrailEvidence {
  prCreateCommands: number;
  prMergeCommands: number;
  prBlockerCommands: number;
  /** PR numbers observed in shell commands (create/merge/view/URL). */
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
      const cmd = extractShellCommandFromHookLine(evt);
      if (cmd === null) continue;

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
