/**
 * Reads the sentinel's transcript facts from a Claude Code session transcript (JSONL), for
 * RFC `rfc-supervisor-sentinel.md` §1 (issue #4239).
 *
 * Rules, each from the RFC's empirical checkpoint:
 * - **Timestamps, never file order.** The file is not chronological (a `compact_boundary` is
 *   written before the `/compact` entry), so every "latest" is the maximum `timestamp`. Equal
 *   timestamps tie-break on the larger value, so the result does not depend on line order.
 * - **Unknown, never 0.** A value with no matching entry is `UNKNOWN`.
 * - **Robust lines.** Unparseable lines (a partial last line while the agent writes), lines with
 *   no valid timestamp, and sidechain (subagent) entries are skipped. The reader never throws on
 *   content.
 *
 * Context size is `input + cache_read + cache_creation` of the latest main-chain assistant entry
 * whose usage is non-zero. Synthetic entries (an API error, an interrupted turn) carry zero usage
 * and are skipped.
 */
import { readFile } from 'node:fs/promises';
import {
  UNKNOWN,
  type Known,
  type TranscriptFacts,
  type TranscriptMarker,
} from '../../core/sentinel/types.js';

interface UsageLike {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function contextOf(usage: UsageLike | undefined): number {
  if (!usage || typeof usage !== 'object') return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join('\n');
}

const READY_RE = /^\s*HANDOFF READY\s*$/;
const LATER_RE = /^\s*HANDOFF LATER\s*$/;
const WAITING_RE = /^\s*WAITING ON OPERATOR:\s*(.*?)\s*$/;

/** Standalone marker lines in one assistant text. */
export function markersInText(text: string, atMs: number): TranscriptMarker[] {
  const out: TranscriptMarker[] = [];
  for (const line of text.split('\n')) {
    if (READY_RE.test(line)) out.push({ kind: 'HANDOFF READY', atMs });
    else if (LATER_RE.test(line)) out.push({ kind: 'HANDOFF LATER', atMs });
    else {
      const m = WAITING_RE.exec(line);
      if (m) out.push({ kind: 'WAITING ON OPERATOR', atMs, ...(m[1] ? { detail: m[1] } : {}) });
    }
  }
  return out;
}

/** Parse transcript text. Pure: no clock, no file access. */
export function parseTranscriptFacts(text: string): TranscriptFacts {
  let ctxAt = -Infinity;
  let ctx = 0;
  let turnEnd = -Infinity;
  let assistantAt = -Infinity;
  const boundaries: number[] = [];
  const markers: TranscriptMarker[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;

    if (entry.type === 'system') {
      if (entry.subtype === 'turn_duration') turnEnd = Math.max(turnEnd, at);
      else if (entry.subtype === 'compact_boundary') boundaries.push(at);
      continue;
    }
    if (entry.type !== 'assistant') continue;
    assistantAt = Math.max(assistantAt, at);
    const message = entry.message && typeof entry.message === 'object' ? entry.message as { usage?: UsageLike; content?: unknown } : undefined;
    const size = contextOf(message?.usage);
    if (size > 0 && (at > ctxAt || (at === ctxAt && size > ctx))) {
      ctxAt = at;
      ctx = size;
    }
    markers.push(...markersInText(assistantText(message?.content), at));
  }

  const known = (v: number): Known<number> => (Number.isFinite(v) ? v : UNKNOWN);
  const kindOrder = { 'HANDOFF READY': 0, 'HANDOFF LATER': 1, 'WAITING ON OPERATOR': 2 } as const;
  markers.sort((a, b) => a.atMs - b.atMs || kindOrder[a.kind] - kindOrder[b.kind] || (a.detail ?? '').localeCompare(b.detail ?? ''));
  return {
    contextTokens: Number.isFinite(ctxAt) ? ctx : UNKNOWN,
    // RFC edge case: with no `turn_duration`, the last assistant entry time stands in.
    lastTurnEndAtMs: known(Number.isFinite(turnEnd) ? turnEnd : assistantAt),
    lastAssistantAtMs: known(assistantAt),
    compactBoundariesAtMs: boundaries.sort((a, b) => a - b),
    markers,
  };
}

/** Every fact unknown: the transcript path is not known or the file cannot be read. */
export const UNKNOWN_TRANSCRIPT_FACTS: TranscriptFacts = {
  contextTokens: UNKNOWN,
  lastTurnEndAtMs: UNKNOWN,
  lastAssistantAtMs: UNKNOWN,
  compactBoundariesAtMs: UNKNOWN,
  markers: UNKNOWN,
};

export async function readTranscriptFacts(
  transcriptPath: string | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<TranscriptFacts> {
  if (!transcriptPath) return UNKNOWN_TRANSCRIPT_FACTS;
  try {
    return parseTranscriptFacts(await read(transcriptPath));
  } catch {
    return UNKNOWN_TRANSCRIPT_FACTS;
  }
}
