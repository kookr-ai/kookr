/** Counts CR/LF separators for the approximate unread-output badge, not visual rows. */
export function createTerminalLineCounter() {
  let previousWasCR = false;
  return {
    count(bytes: Uint8Array): number {
      let lines = 0;
      for (const byte of bytes) {
        if (byte === 13 || (byte === 10 && !previousWasCR)) lines++;
        previousWasCR = byte === 13;
      }
      return lines;
    },
    reset() { previousWasCR = false; },
  };
}
