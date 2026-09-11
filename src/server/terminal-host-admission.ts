import type { TerminalHostMethod } from './terminal-host-contract.js';

// Readiness must still progress when captures or input writes fill the ordinary
// lane. Both ends reserve half of the 128 calls and two MiB for these small
// control messages; the parent's readiness scheduler uses that same call bound.
export const TERMINAL_HOST_READINESS_SLOTS = 64;
const READINESS_METHODS = new Set<TerminalHostMethod>([
  'input.registerSession', 'input.cleanupSession', 'input.dispose',
  'input.markUserPromptSubmitted', 'input.markToolStarted', 'input.markPermissionBlocked',
  'input.markStopFailure', 'input.markTurnStopped', 'input.markSessionEnded',
  'input.markPromptReady', 'input.handleEmptyEnterIntent',
]);

export function isTerminalHostReadiness(method: TerminalHostMethod): boolean {
  return READINESS_METHODS.has(method);
}

/** Shared admission accounting for queued parent calls and executing child calls. */
export class TerminalHostAdmission {
  private count = 0;
  private bytes = 0;
  private ordinaryCount = 0;
  private ordinaryBytes = 0;

  acquire(method: TerminalHostMethod, bytes: number): (() => void) | null {
    const ordinary = !isTerminalHostReadiness(method);
    if (bytes > 8 * 1024 * 1024 || this.count >= 128 || this.bytes + bytes > 16 * 1024 * 1024
      || (ordinary && (this.ordinaryCount >= 64 || this.ordinaryBytes + bytes > 14 * 1024 * 1024))) return null;
    this.count++; this.bytes += bytes;
    if (ordinary) { this.ordinaryCount++; this.ordinaryBytes += bytes; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--; this.bytes -= bytes;
      if (ordinary) { this.ordinaryCount--; this.ordinaryBytes -= bytes; }
    };
  }
}
