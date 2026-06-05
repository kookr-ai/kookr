import { randomUUID } from 'node:crypto';
import type { SessionId, TerminalBackend } from '../adapters/terminal-backend.js';
import type {
  TerminalInputWriterPort,
  TerminalInputWriteResult,
} from '../core/ports/terminal-input-writer-port.js';
import type {
  EmptyEnterDecision,
  EmptyEnterIntentRequest,
  PromptStatus,
} from '../shared/terminal-input-contract.js';

interface TerminalInputState {
  sessionId: string;
  inputStateEpoch: string;
  readinessVersion: number;
  prompt: PromptStatus;
  pendingWrites: number;
  queue: Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TerminalInputCoordinator implements TerminalInputWriterPort {
  private readonly states = new Map<SessionId, TerminalInputState>();

  constructor(
    private readonly backend: Pick<TerminalBackend, 'write' | 'writeSequence' | 'isAlive'>,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  registerSession(sessionId: SessionId): void {
    if (this.states.has(sessionId)) return;
    this.states.set(sessionId, {
      sessionId,
      inputStateEpoch: randomUUID(),
      readinessVersion: 0,
      prompt: { kind: 'unknown' },
      pendingWrites: 0,
      queue: Promise.resolve(),
    });
  }

  cleanupSession(sessionId: SessionId): void {
    this.states.delete(sessionId);
  }

  getSnapshot(sessionId: SessionId): {
    sessionId: string;
    inputStateEpoch: string;
    readinessVersion: number;
    prompt: PromptStatus;
  } | null {
    const state = this.states.get(sessionId);
    if (!state) return null;
    return {
      sessionId,
      inputStateEpoch: state.inputStateEpoch,
      readinessVersion: state.readinessVersion,
      prompt: state.prompt,
    };
  }

  async writeInput(
    sessionId: string,
    bytes: Uint8Array,
    _meta?: { reason?: string },
  ): Promise<TerminalInputWriteResult> {
    this.getOrRegisterState(sessionId);
    return this.withSessionQueue(sessionId, async (state) => {
      const readinessVersion = this.acceptWrite(state);
      try {
        await this.backend.write(sessionId, bytes);
      } finally {
        state.pendingWrites -= 1;
      }
      return { sessionId, readinessVersion };
    });
  }

  async writeInputSequence(
    sessionId: string,
    payloads: Uint8Array[],
    meta?: { reason?: string; interPayloadDelayMs?: number },
  ): Promise<TerminalInputWriteResult> {
    this.getOrRegisterState(sessionId);
    if (payloads.length === 0) {
      const state = this.getOrRegisterState(sessionId);
      return { sessionId, readinessVersion: state.readinessVersion };
    }
    return this.withSessionQueue(sessionId, async (state) => {
      const readinessVersion = this.acceptWrite(state);
      try {
        const delayMs = meta?.interPayloadDelayMs ?? 0;
        if (delayMs > 0 && payloads.length > 1) {
          await this.backend.write(sessionId, payloads[0]!);
          for (const payload of payloads.slice(1)) {
            await this.sleepFn(delayMs);
            await this.backend.write(sessionId, payload);
          }
        } else {
          await this.backend.writeSequence(sessionId, payloads);
        }
      } finally {
        state.pendingWrites -= 1;
      }
      return { sessionId, readinessVersion };
    });
  }

  markUserPromptSubmitted(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'unknown' });
  }

  markToolStarted(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'blocked', reason: 'running' });
  }

  markPermissionBlocked(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'blocked', reason: 'permission' });
  }

  markStopFailure(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'unknown' });
  }

  markTurnStopped(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'unknown' });
  }

  markSessionEnded(sessionId: string): Promise<void> {
    return this.invalidate(sessionId, { kind: 'blocked', reason: 'terminated' });
  }

  async markPromptReady(
    sessionId: string,
    observed: { observedEpoch: string; observedReadinessVersion: number },
  ): Promise<boolean> {
    const observedWhileWritePending = (this.states.get(sessionId)?.pendingWrites ?? 0) > 0;
    return this.withSessionQueue(sessionId, async (state) => {
      if (observedWhileWritePending) return false;
      if (state.inputStateEpoch !== observed.observedEpoch) return false;
      if (state.readinessVersion !== observed.observedReadinessVersion) return false;
      if (state.pendingWrites > 0) return false;
      if (state.prompt.kind === 'blocked') return false;
      state.prompt = { kind: 'ready', readinessVersion: state.readinessVersion };
      return true;
    });
  }

  async handleEmptyEnterIntent(request: EmptyEnterIntentRequest): Promise<EmptyEnterDecision> {
    return this.withSessionQueue(request.sessionId, async (state) => {
      if (state.inputStateEpoch !== request.inputStateEpoch) {
        return { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'stale-epoch' };
      }
      if (state.readinessVersion !== request.observedReadinessVersion) {
        return { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'stale-readiness-version' };
      }
      if (state.prompt.kind === 'blocked') {
        return { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'blocked' };
      }
      if (state.prompt.kind !== 'ready' || state.prompt.readinessVersion !== request.observedReadinessVersion) {
        return { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'not-ready' };
      }
      if (!(await this.backend.isAlive(request.sessionId))) {
        return { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'session-gone' };
      }
      return {
        kind: 'valid-empty-enter',
        intentId: request.intentId,
        taskId: request.taskId,
        sessionId: request.sessionId,
        inputStateEpoch: state.inputStateEpoch,
        decisionReadinessVersion: state.readinessVersion,
      };
    }, {
      missing: { kind: 'rejected', intentId: request.intentId, sessionId: request.sessionId, reason: 'session-gone' },
    });
  }

  private acceptWrite(state: TerminalInputState): number {
    state.readinessVersion += 1;
    state.prompt = { kind: 'unknown' };
    state.pendingWrites += 1;
    return state.readinessVersion;
  }

  private invalidate(sessionId: string, prompt: PromptStatus): Promise<void> {
    return this.withSessionQueue(sessionId, async (state) => {
      state.readinessVersion += 1;
      state.prompt = prompt;
    }, { missing: undefined });
  }

  private getOrRegisterState(sessionId: string): TerminalInputState {
    let state = this.states.get(sessionId);
    if (!state) {
      this.registerSession(sessionId);
      state = this.states.get(sessionId)!;
    }
    return state;
  }

  private async withSessionQueue<T>(
    sessionId: string,
    fn: (state: TerminalInputState) => Promise<T> | T,
    options?: { missing?: T },
  ): Promise<T> {
    const state = this.states.get(sessionId);
    if (!state) {
      if (Object.prototype.hasOwnProperty.call(options ?? {}, 'missing')) return options!.missing as T;
      throw new Error(`terminal input state missing for ${sessionId}`);
    }
    const run = state.queue.then(() => fn(state));
    state.queue = run.catch(() => undefined);
    return run;
  }
}
