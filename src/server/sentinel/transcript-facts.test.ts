import { describe, expect, it } from 'vitest';
import { UNKNOWN } from '../../core/sentinel/types.js';
import { markersInText, parseTranscriptFacts, readTranscriptFacts, UNKNOWN_TRANSCRIPT_FACTS } from './transcript-facts.js';

const t = (hhmmss: string): string => `2026-11-21T${hhmmss}.000Z`;
const ms = (hhmmss: string): number => Date.parse(t(hhmmss));

function assistant(at: string, usage: Record<string, number> | null, text = 'ok', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: t(at),
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) },
    ...extra,
  });
}
const user = (at: string, text: string): string => JSON.stringify({ type: 'user', timestamp: t(at), message: { role: 'user', content: text } });
const turnDuration = (at: string): string => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: t(at), durationMs: 1000 });
const boundary = (at: string): string => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: t(at), compactMetadata: { trigger: 'manual', preTokens: 300000, postTokens: 20000 } });
const usage = (input: number, read: number, create: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: 50 });

/** Deterministic shuffle (mulberry32), so a failure reproduces. */
function shuffled<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('parseTranscriptFacts', () => {
  it('reads context size, last turn end, last assistant time and boundaries', () => {
    const facts = parseTranscriptFacts([
      user('10:00:00', 'hi'),
      assistant('10:00:05', usage(2, 100_000, 5_000)),
      turnDuration('10:00:06'),
      boundary('10:30:00'),
      assistant('10:31:00', usage(1, 20_000, 3_000)),
      turnDuration('10:31:02'),
    ].join('\n'));
    expect(facts).toEqual({
      contextTokens: 23_001,
      lastTurnEndAtMs: ms('10:31:02'),
      lastAssistantAtMs: ms('10:31:00'),
      compactBoundariesAtMs: [ms('10:30:00')],
      markers: [],
    });
  });

  it('non-chronological lines: the latest by timestamp wins, not the last line', () => {
    // A compact_boundary is written before the /compact entry; a late-flushed older line comes last.
    const facts = parseTranscriptFacts([
      assistant('11:00:00', usage(1, 400_000, 0)),
      boundary('11:05:10'),
      user('11:05:00', '/compact'),
      assistant('11:06:00', usage(1, 30_000, 0)),
      assistant('10:59:00', usage(1, 390_000, 0)), // older, but last in the file
      turnDuration('11:06:01'),
      turnDuration('10:59:01'),
    ].join('\n'));
    expect(facts.contextTokens).toBe(30_001);
    expect(facts.lastAssistantAtMs).toBe(ms('11:06:00'));
    expect(facts.lastTurnEndAtMs).toBe(ms('11:06:01'));
  });

  it('skips zero-usage assistant entries for the context size, but they still count as assistant time', () => {
    const facts = parseTranscriptFacts([
      assistant('12:00:00', usage(1, 250_000, 0)),
      assistant('12:01:00', usage(0, 0, 0), 'API Error'),
      assistant('12:02:00', null, 'interrupted'),
    ].join('\n'));
    expect(facts.contextTokens).toBe(250_001);
    expect(facts.lastAssistantAtMs).toBe(ms('12:02:00'));
  });

  it('a partial last line (the agent is mid-write) is skipped, never thrown on', () => {
    const full = assistant('13:00:00', usage(1, 100_000, 0));
    const partial = assistant('13:05:00', usage(1, 900_000, 0)).slice(0, 60);
    const facts = parseTranscriptFacts(`${full}\n${partial}`);
    expect(facts.contextTokens).toBe(100_001);
    expect(facts.lastAssistantAtMs).toBe(ms('13:00:00'));
  });

  it('missing values read as unknown, never 0', () => {
    const facts = parseTranscriptFacts([user('09:00:00', 'hello'), 'not json', '{"type":"assistant"}', '[1,2]'].join('\n'));
    expect(facts.contextTokens).toBe(UNKNOWN);
    expect(facts.lastTurnEndAtMs).toBe(UNKNOWN);
    expect(facts.lastAssistantAtMs).toBe(UNKNOWN);
    expect(facts.compactBoundariesAtMs).toEqual([]);
  });

  it('without turn_duration, the last assistant entry time stands in for the turn end', () => {
    const facts = parseTranscriptFacts(assistant('09:10:00', usage(1, 1, 1)));
    expect(facts.lastTurnEndAtMs).toBe(ms('09:10:00'));
  });

  it('ignores sidechain (subagent) entries and entries with an invalid timestamp', () => {
    const facts = parseTranscriptFacts([
      assistant('14:00:00', usage(1, 200_000, 0)),
      assistant('14:10:00', usage(1, 5_000, 0), 'sub', { isSidechain: true }),
      JSON.stringify({ type: 'assistant', timestamp: 'garbage', message: { usage: usage(1, 9, 9) } }),
    ].join('\n'));
    expect(facts.contextTokens).toBe(200_001);
    expect(facts.lastAssistantAtMs).toBe(ms('14:00:00'));
  });

  it('a boundary before the send stays visible with its own time, so the guard can tell it from a confirming one', () => {
    const facts = parseTranscriptFacts([boundary('15:00:00'), assistant('15:10:00', usage(1, 310_000, 0)), boundary('15:20:30')].join('\n'));
    expect(facts.compactBoundariesAtMs).toEqual([ms('15:00:00'), ms('15:20:30')]);
  });

  it('finds standalone marker lines in assistant text only', () => {
    const facts = parseTranscriptFacts([
      user('16:00:00', 'answer with a line containing only HANDOFF READY'),
      assistant('16:01:00', usage(1, 1, 1), 'Done.\nHANDOFF READY\n'),
      assistant('16:02:00', usage(1, 1, 1), 'I will write HANDOFF READY later'),
      assistant('16:03:00', usage(1, 1, 1), 'WAITING ON OPERATOR: approve the merge of #12'),
    ].join('\n'));
    expect(facts.markers).toEqual([
      { kind: 'HANDOFF READY', atMs: ms('16:01:00') },
      { kind: 'WAITING ON OPERATOR', atMs: ms('16:03:00'), detail: 'approve the merge of #12' },
    ]);
  });

  it('equal latest timestamps tie-break on the larger size, in either line order', () => {
    const a = assistant('17:00:00', usage(1, 60_000, 0));
    const b = assistant('17:00:00', usage(1, 61_000, 0));
    expect(parseTranscriptFacts(`${a}\n${b}`).contextTokens).toBe(61_001);
    expect(parseTranscriptFacts(`${b}\n${a}`).contextTokens).toBe(61_001);
  });

  it('property: shuffling the lines never changes the facts', () => {
    const lines = [
      user('08:00:00', 'go'),
      assistant('08:00:10', usage(1, 50_000, 1_000), 'HANDOFF LATER'),
      turnDuration('08:00:11'),
      assistant('08:20:00', usage(1, 60_000, 0)),
      assistant('08:20:00', usage(1, 61_000, 0)), // same timestamp: tie-break on the larger size
      boundary('08:25:00'),
      assistant('08:26:00', usage(0, 0, 0)),
      turnDuration('08:26:01'),
      assistant('08:30:00', usage(1, 20_000, 0), 'HANDOFF READY\nWAITING ON OPERATOR: x'),
      boundary('08:10:00'),
      '{"partial":',
    ];
    const expected = parseTranscriptFacts(lines.join('\n'));
    expect(expected.contextTokens).toBe(20_001);
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(parseTranscriptFacts(shuffled(lines, seed).join('\n'))).toEqual(expected);
    }
  });
});

describe('markersInText', () => {
  it('accepts surrounding whitespace but not extra words on the line', () => {
    expect(markersInText('  HANDOFF READY  ', 1)).toEqual([{ kind: 'HANDOFF READY', atMs: 1 }]);
    expect(markersInText('HANDOFF READY now', 1)).toEqual([]);
    expect(markersInText('WAITING ON OPERATOR:', 1)).toEqual([{ kind: 'WAITING ON OPERATOR', atMs: 1 }]);
  });
});

describe('readTranscriptFacts', () => {
  it('an unknown path or an unreadable file gives all-unknown facts', async () => {
    expect(await readTranscriptFacts(undefined)).toEqual(UNKNOWN_TRANSCRIPT_FACTS);
    expect(await readTranscriptFacts('/x', async () => { throw new Error('ENOENT'); })).toEqual(UNKNOWN_TRANSCRIPT_FACTS);
  });

  it('reads through the injected reader', async () => {
    const facts = await readTranscriptFacts('/x', async () => assistant('07:00:00', usage(1, 2, 3)));
    expect(facts.contextTokens).toBe(6);
  });
});
