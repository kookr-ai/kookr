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
  isClaudeComposerReady,
  PROMPT_BRACKETED_PASTE_ENV,
  DEFAULT_PROMPT_SUBMIT_DELAY_MS,
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

  test('bracketed-paste mode can wait for Claude Code composer readiness before writing', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession('s6', 'claude');
    const writeSeqSpy = vi.spyOn(backend, 'writeSequence');
    const writeSpy = vi.spyOn(backend, 'write');
    let sleepCalls = 0;
    const sleep = vi.fn(async (_ms: number) => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        backend.emit('s6', '\x1b]0;Claude Code\x07ClaudeCode\n❯ ');
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

    expect(sleep).toHaveBeenCalledWith(10);
    expect(writeSeqSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSeqSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      sleep.mock.invocationCallOrder[0],
    );
    expect(backend.getWrittenText('s6')).toBe('\x1b[200~ready submit\x1b[201~\r');
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

describe('isClaudeComposerReady', () => {
  test('recognises Claude Code composer output with terminal controls stripped', () => {
    expect(isClaudeComposerReady('\x1b]0;Claude Code\x07\x1b[7mClaudeCode\x1b[0m\n❯ ')).toBe(true);
    expect(isClaudeComposerReady('Claude Code\n❯ ')).toBe(true);
    expect(isClaudeComposerReady('ClaudeCode without composer')).toBe(false);
  });
});
