import { InputSubmitAbortedError } from './agent-interaction-port.js';
export interface TerminalInputWriteResult {
  sessionId: string;
  readinessVersion: number;
}

export interface TerminalInputWriterPort {
  writeInput(
    sessionId: string,
    bytes: Uint8Array,
    meta?: { reason?: string },
  ): Promise<TerminalInputWriteResult>;

  writeInputSequence(
    sessionId: string,
    payloads: Uint8Array[],
    meta?: TerminalInputSequenceMeta,
  ): Promise<TerminalInputWriteResult>;
}

export interface TerminalInputSequenceMeta {
  reason?: string;
  interPayloadDelayMs?: number;
  /**
   * Checked inside the session's write queue immediately before the final
   * payload (the submit Enter). Returning `false` aborts the sequence with
   * `InputSubmitAbortedError` and leaves the final payload unwritten (issue
   * #3513: never press Enter on a choice dialog that appeared mid-sequence).
   */
  beforeFinalPayload?: () => boolean | Promise<boolean>;
}

export function asTerminalInputWriterPort(value: unknown): TerminalInputWriterPort {
  const candidate = value as Partial<TerminalInputWriterPort>;
  if (
    typeof candidate.writeInput === 'function'
    && typeof candidate.writeInputSequence === 'function'
  ) {
    return candidate as TerminalInputWriterPort;
  }
  const legacy = value as {
    write?: (sessionId: string, bytes: Uint8Array) => Promise<void>;
    writeSequence?: (sessionId: string, payloads: Uint8Array[]) => Promise<void>;
  };
  if (typeof legacy.write === 'function' && typeof legacy.writeSequence === 'function') {
    return {
      async writeInput(sessionId, bytes) {
        await legacy.write!(sessionId, bytes);
        return { sessionId, readinessVersion: 0 };
      },
      async writeInputSequence(sessionId, payloads, meta) {
        // Legacy writers cannot pause inside the sequence; check up front.
        if (meta?.beforeFinalPayload && !(await meta.beforeFinalPayload())) {
          throw new InputSubmitAbortedError(sessionId);
        }
        // Legacy backends can preserve sequence atomicity via writeSequence,
        // but cannot hold that mutex while inserting a delay. Production
        // delayed submits use TerminalInputCoordinator instead.
        await legacy.writeSequence!(sessionId, payloads);
        return { sessionId, readinessVersion: 0 };
      },
    };
  }
  throw new Error('TerminalInputWriterPort is required for PTY input writes');
}
