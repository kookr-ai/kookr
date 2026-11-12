/**
 * Cuts a streamed answer into sentences as the text arrives, so the first sentence can
 * be turned into speech while the model is still writing the rest.
 *
 * A sentence ends at `.`, `!`, `?` or `…` (plus any closing quotes or brackets) that is
 * followed by whitespace, or at a line break. Requiring the whitespace means "3.5" is
 * never split, and a full stop at the very end of the buffer waits for the next piece
 * of text (or {@link SentenceSplitter.flush}) before it counts. A full stop after a
 * common abbreviation ("e.g.", "Dr."), a single initial ("J."), or a list number at the
 * start ("1.") does not end a sentence.
 */

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'mr', 'mrs', 'ms', 'dr', 'st', 'approx', 'cf', 'inc', 'ltd', 'no',
]);

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’']);

export class SentenceSplitter {
  private buffer = '';

  /** Add streamed text; returns the sentences it completed, in order. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const end = this.findBoundary(from);
      if (end === undefined) break;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end).replace(/^\s+/, '');
      from = 0;
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** The unfinished remainder (end of stream), or null when nothing is left. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest || null;
  }

  /** Index just after the first confirmed sentence end at or after `from`, if any. */
  private findBoundary(from: number): number | undefined {
    const text = this.buffer;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        if (text.slice(0, i).trim()) return i;
        continue;
      }
      if (!TERMINATORS.has(ch)) continue;
      let j = i + 1;
      while (j < text.length && (TERMINATORS.has(text[j]) || CLOSERS.has(text[j]))) j++;
      if (j >= text.length) return undefined; // cannot tell yet: wait for more text
      if (!/\s/.test(text[j])) { i = j - 1; continue; }
      if (ch === '.' && j === i + 1 && this.isNonTerminalPeriod(i)) continue;
      return j;
    }
    return undefined;
  }

  private isNonTerminalPeriod(periodIndex: number): boolean {
    const before = this.buffer.slice(0, periodIndex);
    const token = /[A-Za-z0-9.]+$/.exec(before)?.[0] ?? '';
    if (ABBREVIATIONS.has(token.toLowerCase())) return true;
    if (/^[A-Za-z]$/.test(token)) return true; // an initial: "J. Smith"
    if (/^\d+$/.test(token) && before.length === token.length) return true; // list number at the start
    return false;
  }
}
