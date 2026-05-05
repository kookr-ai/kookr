/**
 * Module-level bridge for sending keystrokes to the active terminal WebSocket.
 * TerminalPanel registers/unregisters the send function; global shortcuts call it.
 */

let sendFn: ((data: string) => void) | null = null;

/** Called by TerminalPanel when its WebSocket connects / disconnects. */
export function registerTerminalSend(fn: ((data: string) => void) | null): void {
  sendFn = fn;
}

/** Send raw data to the active terminal. Returns true if a terminal was connected. */
export function sendToTerminal(data: string): boolean {
  if (sendFn) {
    sendFn(data);
    return true;
  }
  return false;
}
