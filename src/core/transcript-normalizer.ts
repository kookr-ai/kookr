import type { AgentEvent } from './types.js';
import type { TranscriptMessage } from '../shared/contracts/transcript.js';

/**
 * High safety bound (below the 32 MB read cap) on bytes produced during
 * normalization. The real display/stored budget is enforced afterwards by
 * {@link capMessagesKeepingTail}, which keeps the END of the conversation.
 */
export const TRANSCRIPT_MAX_TOTAL_BYTES = 24_000_000;
/** Per-message text cap; longer text is cut and flagged. */
export const TRANSCRIPT_MAX_MESSAGE_BYTES = 20_000;

export interface NormalizeLimits {
  maxTotalBytes?: number;
  maxMessageBytes?: number;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Accumulates messages while enforcing the total and per-message byte caps. */
class Collector {
  readonly messages: TranscriptMessage[] = [];
  private total = 0;
  private stopped = false;
  constructor(private readonly maxTotal: number, private readonly maxMsg: number) {}

  get full(): boolean {
    return this.stopped;
  }

  /** Cap `text`; returns the (possibly cut) text and whether it was cut. */
  private clip(text: string): { text: string; cut: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= this.maxMsg) return { text, cut: false };
    return { text: Buffer.from(text, 'utf8').subarray(0, this.maxMsg).toString('utf8'), cut: true };
  }

  push(build: (clip: (s: string) => string, markCut: () => void) => TranscriptMessage): void {
    if (this.stopped) return;
    let cut = false;
    const msg = build(
      (s) => {
        const r = this.clip(s);
        if (r.cut) cut = true;
        return r.text;
      },
      () => { cut = true; },
    );
    const size = JSON.stringify(msg).length;
    if (this.total + size > this.maxTotal) {
      this.stopped = true;
      this.messages.push({ kind: 'truncation_marker', note: `Transcript truncated after ${this.total} bytes.` });
      return;
    }
    this.total += size;
    if (cut && msg.kind === 'tool_result') msg.truncated = true;
    this.messages.push(msg);
    if (cut && msg.kind !== 'tool_result') {
      this.messages.push({ kind: 'truncation_marker', note: `A message exceeded ${this.maxMsg} bytes and was truncated.` });
    }
  }
}

/**
 * Keep the most recent messages that fit in `maxBytes` (JSON size). When any
 * are dropped, prepend one truncation marker. The last message always survives,
 * even alone over budget (the per-message clip bounds it).
 */
export function capMessagesKeepingTail(messages: TranscriptMessage[], maxBytes: number): TranscriptMessage[] {
  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;
    if (total + size > maxBytes && start < messages.length) break;
    total += size;
    start = i;
  }
  if (start === 0) return messages;
  return [
    { kind: 'truncation_marker', note: `Earlier messages truncated (showing the most recent ${messages.length - start}).` },
    ...messages.slice(start),
  ];
}

function makeCollector(limits?: NormalizeLimits): Collector {
  return new Collector(limits?.maxTotalBytes ?? TRANSCRIPT_MAX_TOTAL_BYTES, limits?.maxMessageBytes ?? TRANSCRIPT_MAX_MESSAGE_BYTES);
}

interface VendorBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as VendorBlock).text === 'string' ? (c as VendorBlock).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Map Claude transcript JSONL lines to provider-neutral messages. Malformed
 * lines are skipped. Unlike `parseTranscriptLine` (which drops text and user
 * turns because it only feeds the event pipeline), this keeps the prose.
 */
export function normalizeVendorLines(lines: string[], limits?: NormalizeLimits): TranscriptMessage[] {
  const out = makeCollector(limits);
  const toolNames = new Map<string, string>();
  for (const line of lines) {
    if (out.full) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string; role?: string; message?: { role?: string; content?: unknown }; content?: unknown };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = entry.type ?? entry.role;
    if (type !== 'user' && type !== 'assistant') continue;
    const role: 'user' | 'assistant' = type;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === 'string') {
      if (content.trim()) out.push((clip) => ({ kind: 'text', role, text: clip(content) }));
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const raw of content as VendorBlock[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim()) {
        const text = raw.text;
        out.push((clip) => ({ kind: 'text', role, text: clip(text) }));
      } else if (raw.type === 'tool_use') {
        const name = raw.name ?? 'unknown';
        const id = (raw as { id?: string }).id;
        if (id) toolNames.set(id, name);
        const input = stringify(raw.input);
        out.push((clip) => ({ kind: 'tool_call', name, ...(input !== undefined ? { input: clip(input) } : {}) }));
      } else if (raw.type === 'tool_result') {
        const text = blockText(raw.content);
        const name = toolNames.get((raw as { tool_use_id?: string }).tool_use_id ?? '');
        out.push((clip) => ({ kind: 'tool_result', ...(name ? { name } : {}), text: clip(text) }));
      }
    }
  }
  return out.messages;
}

/** Map decoded Kookr hook events (chronological) to messages. */
export function normalizeLedgerEvents(events: AgentEvent[], limits?: NormalizeLimits): TranscriptMessage[] {
  const out = makeCollector(limits);
  for (const ev of events) {
    if (out.full) break;
    switch (ev.type) {
      case 'user_prompt':
        if (ev.prompt.trim()) out.push((clip) => ({ kind: 'text', role: 'user', text: clip(ev.prompt) }));
        break;
      case 'stop':
      case 'subagent_stop':
        if (ev.lastMessage.trim()) out.push((clip) => ({ kind: 'text', role: 'assistant', text: clip(ev.lastMessage) }));
        break;
      case 'tool_use': {
        const input = stringify(ev.toolInput);
        out.push((clip) => ({ kind: 'tool_call', name: ev.toolName, ...(input !== undefined ? { input: clip(input) } : {}) }));
        break;
      }
      case 'tool_result': {
        const text = stringify(ev.toolResponse) ?? '';
        out.push((clip) => ({ kind: 'tool_result', name: ev.toolName, text: clip(text) }));
        break;
      }
      default:
        break;
    }
  }
  return out.messages;
}
