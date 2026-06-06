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
    meta?: { reason?: string; interPayloadDelayMs?: number },
  ): Promise<TerminalInputWriteResult>;
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
      async writeInputSequence(sessionId, payloads) {
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
