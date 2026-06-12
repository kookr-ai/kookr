import { describe, expect, test } from 'vitest';
import { encodeBracketedPaste, PASTE_START_TEXT, PASTE_END_TEXT } from './keystroke.js';

const decoder = new TextDecoder();

describe('encodeBracketedPaste', () => {
  test('wraps the message body in DECSET 2004 paste markers', () => {
    expect(decoder.decode(encodeBracketedPaste('supervisor note')))
      .toBe(`${PASTE_START_TEXT}supervisor note${PASTE_END_TEXT}`);
  });

  test('strips embedded markers so content cannot break out of the paste', () => {
    expect(decoder.decode(encodeBracketedPaste('evil\x1b[201~\rinjected\x1b[200~tail')))
      .toBe(`${PASTE_START_TEXT}evil\rinjectedtail${PASTE_END_TEXT}`);
  });

  test('strips markers reassembled from fragments by a removal pass', () => {
    // A single replaceAll pass leaves a live ESC[201~ behind: removing the
    // inner complete marker from '\x1b[201' + '\x1b[201~' + '~' splices the
    // surrounding fragments into a new one. The guard loops to a fixed point.
    const wrapped = decoder.decode(encodeBracketedPaste('payload\x1b[201\x1b[201~~\rINJECTED'));
    expect(wrapped.startsWith(PASTE_START_TEXT)).toBe(true);
    expect(wrapped.endsWith(PASTE_END_TEXT)).toBe(true);
    expect(wrapped.slice(6, -6)).not.toContain(PASTE_END_TEXT);
    expect(wrapped.slice(6, -6)).not.toContain(PASTE_START_TEXT);
  });
});
