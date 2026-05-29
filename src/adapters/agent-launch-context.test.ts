import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import {
  buildAgentLaunchContext,
  deliverInitialPromptToSession,
  resolveBracketedPasteSubmit,
  isBracketedPasteModeEnabled,
  isClaudeBusyOrResponding,
  PROMPT_BRACKETED_PASTE_ENV,
  DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS,
  DEFAULT_PROMPT_SUBMIT_DELAY_MS,
  DEFAULT_PROMPT_SUBMIT_RETRIES,
  DEFAULT_PROMPT_READY_TIMEOUT_MS,
  INITIAL_PROMPT_CHUNK_BYTES,
} from './agent-launch-context.js';

const decoder = new TextDecoder();

function concatPayloads(payloads: Uint8Array[]): Uint8Array {
  const total = payloads.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of payloads) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('agent-launch-context', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injects task and API context for child-task workflows', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: child.id,
      cwd: repoDir,
      serverPort: 4801,
    });

    expect(context.env).toEqual({
      KOOKR_TASK_ID: child.id,
      KOOKR_PARENT_TASK_ID: parent.id,
      KOOKR_PORT: '4801',
      KOOKR_API_BASE_URL: 'http://127.0.0.1:4801',
      KOOKR_GIT_COMMON_DIR: join(repoDir, '.git'),
    });
    expect(context.permissionAllowlist).toEqual([
      'Bash(git *)',
      'Bash(curl *KOOKR_API_BASE_URL*api/tasks*)',
      'Bash(curl *http://127.0.0.1:4801/api/tasks*)',
      'Bash(curl *http://localhost:4801/api/tasks*)',
      `Read(//${join(repoDir, '.git').slice(1)}/**)`,
      `Write(//${join(repoDir, '.git').slice(1)}/**)`,
    ]);
  });

  test('maps linked worktrees back to the shared git common dir', async () => {
    const rootDir = makeTempDir();
    const mainGitDir = join(rootDir, 'repo', '.git');
    const worktreeDir = join(rootDir, 'repo-worktree');
    mkdirSync(join(mainGitDir, 'worktrees', 'issue-231'), { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ${join(mainGitDir, 'worktrees', 'issue-231')}\n`,
    );

    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix issue', worktreeDir);
    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: worktreeDir,
    });

    expect(context.env.KOOKR_GIT_COMMON_DIR).toBe(mainGitDir);
    expect(context.permissionAllowlist).toContain(`Write(//${mainGitDir.slice(1)}/**)`);
  });

  test('injects checkpoint dir env var and allowlist entries when provided', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Long task', '/repo');
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));
    const checkpointDir = join(makeTempDir(), 'checkpoints', 'a-1234abcd', 'feat-x');
    mkdirSync(checkpointDir, { recursive: true });

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: repoDir,
      checkpointDir,
    });

    expect(context.env).toEqual({
      KOOKR_TASK_ID: task.id,
      KOOKR_GIT_COMMON_DIR: join(repoDir, '.git'),
      TASK_CHECKPOINT_DIR: checkpointDir,
    });
    expect(context.permissionAllowlist).toEqual([
      'Bash(git *)',
      `Read(//${join(repoDir, '.git').slice(1)}/**)`,
      `Write(//${join(repoDir, '.git').slice(1)}/**)`,
      `Read(//${checkpointDir.slice(1)}/**)`,
      `Write(//${checkpointDir.slice(1)}/**)`,
      `Bash(${checkpointDir}/repro.sh*)`,
    ]);
  });

  test('omits checkpoint env when checkpointDir is not provided', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Plain task', '/repo');
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: repoDir,
    });

    expect(context.env.TASK_CHECKPOINT_DIR).toBeUndefined();
    // Guard against regression: also confirm the legacy var name is not set.
    expect(Object.keys(context.env)).not.toContain('KOOKR_CHECKPOINT_DIR');
    const checkpointAllowlistEntries = context.permissionAllowlist.filter((e) =>
      e.includes('checkpoint') || e.includes('repro.sh'),
    );
    expect(checkpointAllowlistEntries).toHaveLength(0);
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-agent-launch-'));
    tempDirs.push(dir);
    return dir;
  }
});

describe('deliverInitialPromptToSession', () => {
  test('without bracketed paste, delivers prompt and Enter in one writeSequence (legacy path)', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s1', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');

    // The function picks the delivery path purely from `options.bracketedPaste`
    // (omitted here) — it never reads the env var; only the adapter does, via
    // resolveBracketedPasteSubmit.
    await deliverInitialPromptToSession(backend, 's1', 'do the thing');

    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    // No bracketed-paste markers; body + CR delivered together.
    expect(backend.getWrittenText('s1')).toBe('do the thing\r');
  });

  test('bracketed-paste mode wraps the body and submits Enter after the closing marker', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s2', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});

    await deliverInitialPromptToSession(backend, 's2', 'submit me', {
      bracketedPaste: true,
      submitDelayMs: 120,
      sleep,
    });

    // The body is wrapped in ANSI bracketed-paste markers and delivered as
    // one block; the Enter is a separate write after the closing marker, so
    // a UI that supports bracketed paste parses it as a keystroke.
    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(120);

    const block = decoder.decode(concatPayloads(writeSeqSpy.mock.calls[0][1]));
    expect(block).toBe('\x1b[200~submit me\x1b[201~');
    // The separate write delivers exactly the Enter (CR, 0x0d) byte.
    expect(Array.from(writeSpy.mock.calls[0][1])).toEqual([0x0d]);

    // Ordering: paste block -> delay -> Enter.
    expect(writeSeqSpy.mock.invocationCallOrder[0]).toBeLessThan(
      sleep.mock.invocationCallOrder[0],
    );
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );

    // End-to-end the session receives the wrapped prompt then the CR.
    expect(backend.getWrittenText('s2')).toBe('\x1b[200~submit me\x1b[201~\r');
  });

  test('bracketed-paste mode chunks a large prompt between the markers', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s3', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const large = 'x'.repeat(200_000);
    const sleep = vi.fn(async (_ms: number) => {});

    await deliverInitialPromptToSession(backend, 's3', large, {
      bracketedPaste: true,
      submitDelayMs: 0,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(0);
    // Inspect the writeSequence payloads directly: the opening marker first,
    // the closing marker last, and the body split into multiple
    // INITIAL_PROMPT_CHUNK_BYTES chunks in between.
    const payloads = writeSeqSpy.mock.calls[0][1];
    expect(decoder.decode(payloads[0])).toBe('\x1b[200~');
    expect(decoder.decode(payloads[payloads.length - 1])).toBe('\x1b[201~');
    const bodyChunks = payloads.slice(1, -1);
    expect(bodyChunks.length).toBeGreaterThan(1);
    expect(bodyChunks.every((c) => c.length <= INITIAL_PROMPT_CHUNK_BYTES)).toBe(true);
    expect(backend.getWrittenText('s3')).toBe(`\x1b[200~${large}\x1b[201~\r`);
  });

  test('bracketed-paste mode strips paste markers embedded in the prompt body', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s4', 'claude');
    const sleep = vi.fn(async (_ms: number) => {});

    // A prompt that itself contains bracketed-paste markers must not be able
    // to prematurely close the synthetic paste — the markers are stripped.
    const hostile = 'before\x1b[201~after\x1b[200~end';
    await deliverInitialPromptToSession(backend, 's4', hostile, {
      bracketedPaste: true,
      submitDelayMs: 0,
      sleep,
    });

    expect(backend.getWrittenText('s4')).toBe('\x1b[200~beforeafterend\x1b[201~\r');
  });

  test('bracketed-paste mode uses the default submit delay when none is given', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s5', 'claude');
    const sleep = vi.fn(async (_ms: number) => {});

    await deliverInitialPromptToSession(backend, 's5', 'hi', {
      bracketedPaste: true,
      sleep,
    });

    expect(DEFAULT_PROMPT_SUBMIT_DELAY_MS).toBe(500);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(backend.getWrittenText('s5')).toBe('\x1b[200~hi\x1b[201~\r');
  });

  test('bracketed-paste mode waits for paste-mode enable, not just the painted composer', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s6', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    let sleepCalls = 0;
    const sleep = vi.fn(async (_ms: number) => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        // The composer can paint before Claude Code enables bracketed-paste
        // handling; this must not release the paste block.
        backend.emit('s6', '\x1b]0;Claude Code\x07ClaudeCode\n❯ ');
      } else if (sleepCalls === 2) {
        backend.emit('s6', '\x1b[?2004h');
      }
    });

    await deliverInitialPromptToSession(backend, 's6', 'ready submit', {
      bracketedPaste: true,
      waitForReady: true,
      readyTimeoutMs: DEFAULT_PROMPT_READY_TIMEOUT_MS,
      readyPollMs: 10,
      submitDelayMs: 0,
      sleep,
    });

    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSeqSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      sleep.mock.invocationCallOrder[1],
    );
    expect(backend.getWrittenText('s6')).toBe('\x1b[200~ready submit\x1b[201~\r');
  });

  test('bracketed-paste ready wait proceeds after timeout if paste-mode enable never appears', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-timeout', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const sleep = vi.fn(async (_ms: number) => {
      backend.emit('s-timeout', '\x1b]0;Claude Code\x07ClaudeCode\n❯ ');
    });

    await deliverInitialPromptToSession(backend, 's-timeout', 'timeout submit', {
      bracketedPaste: true,
      waitForReady: true,
      readyTimeoutMs: 25,
      readyPollMs: 10,
      submitDelayMs: 0,
      sleep,
    });

    expect(sleep).toHaveBeenCalled();
    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(backend.getWrittenText('s-timeout')).toBe('\x1b[200~timeout submit\x1b[201~\r');
  });
});

describe('resolveBracketedPasteSubmit', () => {
  test('explicit boolean wins over the env var', () => {
    expect(resolveBracketedPasteSubmit(false, { [PROMPT_BRACKETED_PASTE_ENV]: '1' })).toBe(false);
    expect(resolveBracketedPasteSubmit(true, { [PROMPT_BRACKETED_PASTE_ENV]: '0' })).toBe(true);
  });

  test('falls back to the env var, recognising every documented token', () => {
    for (const off of ['0', 'false', 'no', 'off']) {
      expect(resolveBracketedPasteSubmit(undefined, { [PROMPT_BRACKETED_PASTE_ENV]: off })).toBe(false);
    }
    for (const on of ['1', 'true', 'yes', 'on']) {
      expect(resolveBracketedPasteSubmit(undefined, { [PROMPT_BRACKETED_PASTE_ENV]: on })).toBe(true);
    }
  });

  test('normalises case and surrounding whitespace in the env value', () => {
    expect(resolveBracketedPasteSubmit(undefined, { [PROMPT_BRACKETED_PASTE_ENV]: '  FALSE  ' })).toBe(false);
    expect(resolveBracketedPasteSubmit(undefined, { [PROMPT_BRACKETED_PASTE_ENV]: 'On' })).toBe(true);
  });

  test('defaults to enabled when there is no explicit value or env var', () => {
    expect(resolveBracketedPasteSubmit(undefined, {})).toBe(true);
    // An unrecognised env value falls through to the default rather than
    // silently disabling the fix.
    expect(resolveBracketedPasteSubmit(undefined, { [PROMPT_BRACKETED_PASTE_ENV]: 'garbage' })).toBe(true);
  });
});

describe('isBracketedPasteModeEnabled', () => {
  const encoder = new TextEncoder();
  test('returns true when the DECSET sequence appears anywhere in the raw bytes', () => {
    expect(isBracketedPasteModeEnabled(encoder.encode('boot\x1b[?2004hready'))).toBe(true);
    // Sequence at end-of-buffer (after the visual composer has painted) still matches.
    expect(isBracketedPasteModeEnabled(encoder.encode('Claude Code\n❯ \x1b[?2004h'))).toBe(true);
  });
  test('returns false on a painted composer that has not yet enabled paste mode', () => {
    // This is exactly the race the new detector exists to close: visually
    // ready but paste-mode-disable would still misparse ESC[200~ as content.
    expect(isBracketedPasteModeEnabled(encoder.encode('Claude Code\n❯ '))).toBe(false);
    expect(isBracketedPasteModeEnabled(encoder.encode(''))).toBe(false);
  });
});

describe('isClaudeBusyOrResponding', () => {
  const encoder = new TextEncoder();
  test('detects the streaming-response "esc to interrupt" indicator', () => {
    expect(isClaudeBusyOrResponding(encoder.encode('Generating… esc to interrupt'))).toBe(true);
    expect(isClaudeBusyOrResponding(encoder.encode('Generating… Esc to interrupt'))).toBe(true);
    expect(isClaudeBusyOrResponding(encoder.encode('Generating… ESC to interrupt'))).toBe(true);
  });
  test('detects numbered permission-prompt options', () => {
    expect(isClaudeBusyOrResponding(encoder.encode('Allow tool?\n❯ 1. Yes\n  2. No'))).toBe(true);
    expect(isClaudeBusyOrResponding(encoder.encode('  1. Allow once\n  2. Deny'))).toBe(true);
    expect(isClaudeBusyOrResponding(encoder.encode('  1. Approve\n  2. Reject'))).toBe(true);
  });
  test('returns false for an idle composer or empty display', () => {
    // The exact state the retry loop must be willing to resend into:
    // composer painted with no busy / response indicators.
    expect(isClaudeBusyOrResponding(encoder.encode('Claude Code\n❯ '))).toBe(false);
    expect(isClaudeBusyOrResponding(encoder.encode(''))).toBe(false);
  });
  test('does not false-positive on bare numbers or the ❯ glyph', () => {
    // The permission-prompt regex is intentionally narrow (must follow a
    // line break, must match Yes/Allow/Approve/Continue) so prompts that
    // mention "1." in passing or echo the composer cursor do not trip it.
    expect(isClaudeBusyOrResponding(encoder.encode('see step 1. then step 2.'))).toBe(false);
    expect(isClaudeBusyOrResponding(encoder.encode('❯ '))).toBe(false);
  });
});

describe('deliverInitialPromptToSession with awaitSubmit', () => {
  test('sends exactly one Enter when awaitSubmit confirms on the first attempt', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-confirm', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});
    const awaitSubmit = vi.fn(async (_timeoutMs: number) => true);

    const result = await deliverInitialPromptToSession(backend, 's-confirm', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      submitRetries: 2,
      submitConfirmTimeoutMs: 1234,
      sleep,
      awaitSubmit,
    });

    // One Enter total — no retry needed when the hook ack arrives.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(writeSpy.mock.calls[0][1])).toEqual([0x0d]);
    expect(awaitSubmit).toHaveBeenCalledTimes(1);
    expect(awaitSubmit).toHaveBeenCalledWith(1234);
    expect(result).toEqual({ status: 'confirmed', confirmationAttempts: 1, enterWrites: 1 });
  });

  test('resends Enter on every timeout up to submitRetries, then stops', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-retry-all', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});
    // Three awaits expected: initial submit + two retry loops. All return
    // false so the launch falls through after exhausting submitRetries.
    const awaitSubmit = vi.fn(async (_timeoutMs: number) => false);

    const result = await deliverInitialPromptToSession(backend, 's-retry-all', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      submitRetries: 2,
      submitConfirmTimeoutMs: 50,
      sleep,
      awaitSubmit,
    });

    // 1 initial Enter + submitRetries (2) resends = 3 Enter writes total.
    expect(writeSpy).toHaveBeenCalledTimes(3);
    for (const call of writeSpy.mock.calls) {
      expect(Array.from(call[1])).toEqual([0x0d]);
    }
    // `submitRetries + 1` awaits — one per loop iteration.
    expect(awaitSubmit).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ status: 'unconfirmed', confirmationAttempts: 3, enterWrites: 3 });
  });

  test('with submitRetries=0, awaits once but never resends Enter', async () => {
    // Regression guard for the "skip the retries entirely" caller intent:
    // the helper still issues exactly one confirmation await (so a hook
    // that does arrive is observed), but writes no retry Enter.
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-no-retry', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});
    const awaitSubmit = vi.fn(async (_timeoutMs: number) => false);

    const result = await deliverInitialPromptToSession(backend, 's-no-retry', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      submitRetries: 0,
      submitConfirmTimeoutMs: 5,
      sleep,
      awaitSubmit,
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(awaitSubmit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'unconfirmed', confirmationAttempts: 1, enterWrites: 1 });
  });

  test('skips the retry Enter when the post-await display shows Claude is busy', async () => {
    // The hazard: the initial Enter actually submitted the prompt, but the
    // `UserPromptSubmit` hook is slow to round-trip. A blind retry at the
    // confirm timeout could confirm a tool-permission dialog that has
    // since appeared. When the captured display proves Claude has already
    // accepted the prompt, treat the submission as confirmed and stop.
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-busy', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});
    const awaitSubmit = vi.fn(async () => {
      // Between the initial Enter and the would-be retry, Claude starts
      // streaming — the display now carries the "esc to interrupt" marker.
      backend.emit('s-busy', ' (esc to interrupt) ');
      return false;
    });

    const result = await deliverInitialPromptToSession(backend, 's-busy', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      submitRetries: 2,
      submitConfirmTimeoutMs: 5,
      sleep,
      awaitSubmit,
    });

    // Only the initial Enter — no retry written despite the timed-out await.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // Exactly one confirmation attempt; the busy check short-circuits the loop.
    expect(awaitSubmit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'assumed-submitted', confirmationAttempts: 1, enterWrites: 1 });
  });

  test('stops resending the moment awaitSubmit returns true', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-retry-mid', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});
    // First await times out; second confirms — so we expect 2 Enter writes total.
    let calls = 0;
    const awaitSubmit = vi.fn(async (_timeoutMs: number) => {
      calls += 1;
      return calls >= 2;
    });

    const result = await deliverInitialPromptToSession(backend, 's-retry-mid', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      submitRetries: 3,
      submitConfirmTimeoutMs: 10,
      sleep,
      awaitSubmit,
    });

    // Initial Enter + 1 retry = 2 writes; the second await returns true so
    // the loop exits before a third Enter is sent.
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(awaitSubmit).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'confirmed', confirmationAttempts: 2, enterWrites: 2 });
  });

  test('without awaitSubmit, sends exactly one Enter (open-loop, prior behaviour)', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-no-await', 'claude');
    const writeSpy = vi.spyOn(backend, 'write');
    const sleep = vi.fn(async (_ms: number) => {});

    const result = await deliverInitialPromptToSession(backend, 's-no-await', 'go', {
      bracketedPaste: true,
      submitDelayMs: 0,
      sleep,
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(writeSpy.mock.calls[0][1])).toEqual([0x0d]);
    expect(result).toEqual({ status: 'open-loop', confirmationAttempts: 0, enterWrites: 1 });
  });

  test('exposes documented defaults for submit confirmation tuning', () => {
    expect(DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS).toBe(2_000);
    expect(DEFAULT_PROMPT_SUBMIT_RETRIES).toBe(2);
  });
});

describe('deliverInitialPromptToSession waitForReady covers paste-mode-enable too', () => {
  test('waitForReady resolves on the ESC[?2004h DECSET in raw bytes', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s-pasteready', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    let polls = 0;
    const sleep = vi.fn(async (_ms: number) => {
      polls += 1;
      // After the first poll, emit ONLY the DECSET (no visible composer
      // text) — proves the wait succeeds on the precise paste-mode signal.
      if (polls === 1) backend.emit('s-pasteready', '\x1b[?2004h');
    });

    await deliverInitialPromptToSession(backend, 's-pasteready', 'go', {
      bracketedPaste: true,
      waitForReady: true,
      readyTimeoutMs: DEFAULT_PROMPT_READY_TIMEOUT_MS,
      readyPollMs: 10,
      submitDelayMs: 0,
      sleep,
    });

    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    // Sanity: paste block was delivered AFTER at least one ready-poll sleep.
    expect(writeSeqSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      sleep.mock.invocationCallOrder[0],
    );
  });
});
