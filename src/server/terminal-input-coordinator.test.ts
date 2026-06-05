import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../adapters/codex-cli-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { LocalDtachBackend } from '../adapters/local-dtach-backend.js';
import { TaskStore } from '../core/tasks.js';
import { TerminalInputCoordinator } from './terminal-input-coordinator.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENTER_BYTES = Uint8Array.of(0x0d);
const CANARY_AGENT = fileURLToPath(new URL('./__fixtures__/terminal-submit-canary-agent.mjs', import.meta.url));

function resolveDtachBinary(): string | null {
  const vendored = join(process.cwd(), 'vendor', 'dtach', 'dtach');
  if (existsSync(vendored)) return vendored;
  try {
    execFileSync('dtach', ['--help'], { stdio: 'pipe' });
    return 'dtach';
  } catch {
    return null;
  }
}

const DTACH = resolveDtachBinary();
const skipIfNoDtach = DTACH ? it : it.skip;

async function waitForOutput(
  backend: LocalDtachBackend,
  sessionId: string,
  needle: string,
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = decoder.decode(await backend.captureBytes(sessionId, 4096));
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in terminal output:\n${text}`);
}

describe('TerminalInputCoordinator', () => {
  async function setup(sessionId = 's1') {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: sessionId, command: 'agent', args: [] });
    const coordinator = new TerminalInputCoordinator(backend);
    coordinator.registerSession(sessionId);
    return { backend, coordinator, sessionId };
  }

  it('increments readinessVersion and clears prompt readiness before accepted writes', async () => {
    const { coordinator, sessionId } = await setup();
    const initial = coordinator.getSnapshot(sessionId)!;
    expect(initial.readinessVersion).toBe(0);

    const readyAccepted = await coordinator.markPromptReady(sessionId, {
      observedEpoch: initial.inputStateEpoch,
      observedReadinessVersion: initial.readinessVersion,
    });
    expect(readyAccepted).toBe(true);

    const result = await coordinator.writeInput(sessionId, encoder.encode('x'), { reason: 'test' });
    const snapshot = coordinator.getSnapshot(sessionId)!;
    expect(result.readinessVersion).toBe(1);
    expect(snapshot.readinessVersion).toBe(1);
    expect(snapshot.prompt.kind).toBe('unknown');
  });

  it('accepts prompt-ready only for the current epoch and readiness version', async () => {
    const { coordinator, sessionId } = await setup();
    const snapshot = coordinator.getSnapshot(sessionId)!;

    await coordinator.writeInput(sessionId, encoder.encode('draft'));

    await expect(coordinator.markPromptReady(sessionId, {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toBe(false);
    expect(coordinator.getSnapshot(sessionId)!.prompt.kind).toBe('unknown');
  });

  it('rejects stale, blocked, unknown, and missing empty-enter intents without writing Enter', async () => {
    const { backend, coordinator, sessionId } = await setup();
    const initial = coordinator.getSnapshot(sessionId)!;
    const base = {
      type: 'emptyEnterIntent' as const,
      intentId: 'intent-1',
      taskId: 'task-1',
      sessionId,
      selectionVersion: 1,
      inputStateEpoch: initial.inputStateEpoch,
      observedReadinessVersion: initial.readinessVersion,
    };

    await expect(coordinator.handleEmptyEnterIntent(base)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'not-ready',
    });

    await coordinator.markPermissionBlocked(sessionId);
    const blocked = coordinator.getSnapshot(sessionId)!;
    await expect(coordinator.handleEmptyEnterIntent({
      ...base,
      inputStateEpoch: blocked.inputStateEpoch,
      observedReadinessVersion: blocked.readinessVersion,
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'blocked' });

    coordinator.cleanupSession(sessionId);
    await expect(coordinator.handleEmptyEnterIntent(base)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'session-gone',
    });
    expect(backend.getWrittenText(sessionId)).not.toContain('\r');
  });

  it('approves valid empty-enter intents but never forwards Enter', async () => {
    const { backend, coordinator, sessionId } = await setup();
    const snapshot = coordinator.getSnapshot(sessionId)!;
    await coordinator.markPromptReady(sessionId, {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    });

    await expect(coordinator.handleEmptyEnterIntent({
      type: 'emptyEnterIntent',
      intentId: 'intent-1',
      taskId: 'task-1',
      sessionId,
      selectionVersion: 1,
      inputStateEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toMatchObject({
      kind: 'valid-empty-enter',
      decisionReadinessVersion: snapshot.readinessVersion,
    });
    expect(backend.getWrittenText(sessionId)).not.toContain('\r');
  });

  it('rejects prompt-ready marks while a write is in-flight', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    const coordinator = new TerminalInputCoordinator(backend);
    coordinator.registerSession('s1');
    const writeSpy = vi.spyOn(backend, 'write').mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );

    const write = coordinator.writeInput('s1', encoder.encode('x'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = coordinator.getSnapshot('s1')!;
    expect(snapshot.readinessVersion).toBe(1);
    await expect(coordinator.markPromptReady('s1', {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    })).resolves.toBe(false);
    await write;
    writeSpy.mockRestore();
  });

  it('delays sequence payloads while keeping the session write in-flight', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    let releaseDelay!: () => void;
    const sleepFn = vi.fn(() => new Promise<void>((resolve) => {
      releaseDelay = resolve;
    }));
    const coordinator = new TerminalInputCoordinator(backend, sleepFn);
    coordinator.registerSession('s1');

    const writeSequenceSpy = vi.spyOn(backend, 'writeSequence');
    const writePromise = coordinator.writeInputSequence(
      's1',
      [encoder.encode('reply'), Uint8Array.of(0x0d)],
      { reason: 'test-submit', interPayloadDelayMs: 500 },
    );

    await vi.waitFor(() => {
      expect(backend.getWrittenText('s1')).toBe('reply');
      expect(sleepFn).toHaveBeenCalledWith(500);
    });

    const snapshot = coordinator.getSnapshot('s1')!;
    const readyMark = coordinator.markPromptReady('s1', {
      observedEpoch: snapshot.inputStateEpoch,
      observedReadinessVersion: snapshot.readinessVersion,
    });
    let readyResolved = false;
    readyMark.then(() => {
      readyResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readyResolved).toBe(false);
    expect(writeSequenceSpy).not.toHaveBeenCalled();

    releaseDelay();
    await writePromise;
    await expect(readyMark).resolves.toBe(false);

    expect(backend.getWrittenText('s1')).toBe('reply\r');
    expect(backend.getWrittenBytes('s1').map((bytes) => Array.from(bytes))).toEqual([
      Array.from(encoder.encode('reply')),
      [0x0d],
    ]);
  });
});

describe('TerminalInputCoordinator with real dtach-backed terminal', () => {
  let tmpDir = '';
  let backend: LocalDtachBackend | null = null;

  beforeAll(() => {
    if (!DTACH) {
      console.warn(
        '[terminal-input-coordinator.test] dtach not found at vendor/dtach/dtach and not on PATH; real terminal submit canary is skipped.',
      );
    }
  });

  async function disposeBackend() {
    if (backend) {
      for (const sessionId of await backend.listSessions()) {
        await backend.killSession(sessionId).catch(() => undefined);
      }
      backend.close();
      backend = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  }

  afterEach(async () => {
    await disposeBackend();
  });

  async function createCanary(sessionId: string) {
    await disposeBackend();
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-submit-canary-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'submit-canary',
      dtachBinary: DTACH!,
      ringFlushIntervalMs: 10,
    });
    await backend.createSession({
      id: sessionId,
      command: process.execPath,
      args: [CANARY_AGENT],
      env: { KOOKR_CANARY_SUBMIT_READY_MS: '250' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const coordinator = new TerminalInputCoordinator(backend);
    coordinator.registerSession(sessionId);
    return coordinator;
  }

  skipIfNoDtach('delayed prompt submit fixes the real terminal early-Enter failure mode', async () => {
    let coordinator = await createCanary('no-delay');
    await coordinator.writeInputSequence(
      'no-delay',
      [encoder.encode('reply-no-delay'), ENTER_BYTES],
      { reason: 'regression-control' },
    );
    const early = await waitForOutput(backend!, 'no-delay', 'IGNORED_EARLY_ENTER:reply-no-delay');
    expect(early).not.toContain('SUBMITTED:reply-no-delay');

    await backend!.killSession('no-delay');
    coordinator.cleanupSession('no-delay');

    coordinator = await createCanary('delayed');
    await coordinator.writeInputSequence(
      'delayed',
      [encoder.encode('reply-delayed'), ENTER_BYTES],
      { reason: 'regression-fixed-path', interPayloadDelayMs: 500 },
    );
    const submitted = await waitForOutput(backend!, 'delayed', 'SUBMITTED:reply-delayed');
    expect(submitted).not.toContain('IGNORED_EARLY_ENTER:reply-delayed');
  }, 10_000);

  for (const [agentType, createAdapter] of [
    ['claude-code', (coordinator: TerminalInputCoordinator) => (
      new ClaudeCodeAdapter(backend!, new TaskStore(), { terminalInputWriter: coordinator })
    )],
    ['codex-cli', (coordinator: TerminalInputCoordinator) => (
      new CodexCliAdapter(backend!, new TaskStore(), { trustWorkspace: false, terminalInputWriter: coordinator })
    )],
  ] as const) {
    skipIfNoDtach(`delays ${agentType} adapter sendInput through the real terminal backend`, async () => {
      const sessionId = `${agentType}-adapter`.replace(/[^a-z0-9-]/g, '-');
      const coordinator = await createCanary(sessionId);
      const adapter = createAdapter(coordinator);

      await adapter.sendInput(sessionId, `reply-via-${agentType}`);

      const submitted = await waitForOutput(backend!, sessionId, `SUBMITTED:reply-via-${agentType}`);
      expect(submitted).not.toContain(`IGNORED_EARLY_ENTER:reply-via-${agentType}`);
    }, 10_000);
  }
});
