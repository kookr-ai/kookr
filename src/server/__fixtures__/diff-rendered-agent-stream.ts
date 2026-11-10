/**
 * A terminal byte stream shaped like a differentially rendering agent TUI
 * (Claude Code), for attach-seed tests (issue #3564).
 *
 * The agent prints a transcript and a small interface block once. After that
 * each frame only un-parks the cursor, moves *up* to the spinner row, rewrites
 * a glyph and one digit, walks back down, and parks again. Nothing in those
 * frames repaints the screen, so a suffix of the stream cannot rebuild it.
 *
 * The stream for `n + k` frames starts with the stream for `n` frames, so a
 * test can treat the extra bytes as live output that follows a capture.
 */

const ESC = '\x1b';
const GLYPHS = ['✻', '✶', '✢', '·', '*'];
const RULE = '─'.repeat(60);

/** Enough spinner frames to push every repainting byte out of a 64 KiB tail. */
export const SPINNER_ONLY_FRAMES = 800;

export interface DiffRenderedAgentStream {
  bytes: Uint8Array;
  /** Bytes of spinner-only frames at the end of the stream. */
  spinnerBytes: number;
}

export function diffRenderedAgentStream(spinnerFrames: number): DiffRenderedAgentStream {
  const base: string[] = [
    // Modes an agent sets once at startup: bracketed paste on, cursor hidden.
    `${ESC}[?2004h${ESC}[?25l`,
  ];
  for (let line = 1; line <= 30; line++) base.push(`● transcript line ${line} of agent output\r\n`);
  base.push(
    '\r\n',
    '✻ Working… (0s · ↓ 1.2k tokens)\r\n', // spinner row: 7 above the resting row
    '\r\n',
    `${RULE}\r\n`,
    '❯ draft prompt\r\n',                  // the cursor parks on this row
    `${RULE}\r\n`,
    '  ? for shortcuts\r\n',
    '  esc to interrupt\r\n',              // leaves the cursor on the resting row
    `${ESC}[14C${ESC}[4A${ESC}[?25h`,      // park: up to the prompt row, right to its end
  );

  const frames: string[] = [];
  for (let frame = 0; frame < spinnerFrames; frame++) {
    frames.push(
      `${ESC}[?2026h${ESC}[?25l`,
      `${ESC}[14D${ESC}[4B\r`,             // un-park: back to the resting row, column 0
      `${ESC}[7A`,                         // up to the spinner row
      `${ESC}[38;2;215;119;87m${GLYPHS[frame % GLYPHS.length]}${ESC}[39m`,
      `${ESC}[14G${frame % 10}`,           // one digit of the elapsed-time counter
      '\r\r\n\r\n\r\n\r\n\r\n\r\n\r\n',    // walk back down to the resting row
      `${ESC}[14C${ESC}[4A`,               // park again
      `${ESC}[?25h${ESC}[?2026l`,
    );
  }

  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(base.join(''));
  const frameBytes = encoder.encode(frames.join(''));
  const bytes = new Uint8Array(baseBytes.length + frameBytes.length);
  bytes.set(baseBytes, 0);
  bytes.set(frameBytes, baseBytes.length);
  return { bytes, spinnerBytes: frameBytes.length };
}
