import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import type { AgentEvent } from './types.js';

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
}

export interface LastAssistantMessageResult {
  excerpt: string;
  truncated: boolean;
  readAtOffset: number;
}

interface RawTranscriptEntry {
  type?: string;
  role?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  cost_usd?: number;
  model?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
  content?: ContentBlock[] | string;
}

const DEFAULT_LAST_ASSISTANT_MAX_BYTES = 256 * 1024;
const DEFAULT_LAST_ASSISTANT_MAX_CHARS = 1_000;

/**
 * Parse a single JSONL line from a Claude Code transcript into an AgentEvent.
 * Returns null for non-actionable entries (user messages, system messages, text-only assistant).
 */
export function parseTranscriptLine(line: string): AgentEvent | null {
  let entry: RawTranscriptEntry;
  try {
    entry = JSON.parse(line) as RawTranscriptEntry;
  } catch {
    return null;
  }

  const sessionId = entry.session_id ?? '';
  const eventType = entry.type ?? entry.role;

  // Result events map to stop
  if (eventType === 'result') {
    return {
      type: 'stop',
      sessionId,
      lastMessage: entry.result ?? '',
    };
  }

  // Only process assistant messages with content
  if (eventType !== 'assistant') {
    return null;
  }

  // Content can be in message.content (new format) or content (legacy)
  const contentBlocks = entry.message?.content ?? entry.content;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    return null;
  }

  // Find the first actionable content block
  for (const block of contentBlocks) {
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        sessionId,
        toolName: block.name ?? 'unknown',
        toolInput: block.input,
      };
    }

    if (block.type === 'tool_result') {
      // Extract text from tool_result content
      const responseText = block.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      return {
        type: 'tool_result',
        sessionId,
        toolName: 'unknown', // tool_result doesn't carry the tool name
        toolResponse: responseText ?? block.text,
      };
    }
  }

  // Text-only assistant message — not in our AgentEvent union
  return null;
}

/**
 * Parse multiple JSONL lines, skipping malformed and non-actionable entries.
 */
export function parseTranscriptLines(lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseTranscriptLine(trimmed);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Read the tail of a transcript JSONL file and return the last assistant text
 * message. This is intentionally tail-only so finding enrichment never parses
 * large transcripts on the hot path.
 */
export function lastAssistantMessage(
  transcriptPath: string,
  options: { maxBytes?: number; maxChars?: number } = {},
): LastAssistantMessageResult | null {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_LAST_ASSISTANT_MAX_BYTES);
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_LAST_ASSISTANT_MAX_CHARS);

  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const stat = fstatSync(fd);
    if (stat.size === 0) return null;

    const readStart = Math.max(0, stat.size - maxBytes);
    const byteLength = stat.size - readStart;
    const buffer = Buffer.allocUnsafe(byteLength);
    const bytesRead = readSync(fd, buffer, 0, byteLength, readStart);
    const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

    let lineEnd = chunk.length;
    for (let i = chunk.length - 1; i >= -1; i--) {
      if (i >= 0 && chunk[i] !== 0x0a) continue;
      const lineStart = i + 1;
      const rawEnd = lineEnd;
      lineEnd = i;
      if (rawEnd <= lineStart) continue;
      if (readStart > 0 && lineStart === 0) continue;

      const lineBuffer = chunk[rawEnd - 1] === 0x0d
        ? chunk.subarray(lineStart, rawEnd - 1)
        : chunk.subarray(lineStart, rawEnd);
      const text = lineBuffer.toString('utf8').trim();
      if (!text) continue;

      const message = extractAssistantText(text);
      if (!message) continue;

      const truncated = message.length > maxChars;
      return {
        excerpt: truncated ? message.slice(0, maxChars) : message,
        truncated,
        readAtOffset: readStart + lineStart,
      };
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }

  return null;
}

function extractAssistantText(line: string): string | null {
  let entry: RawTranscriptEntry;
  try {
    entry = JSON.parse(line) as RawTranscriptEntry;
  } catch {
    return null;
  }

  const eventType = entry.type ?? entry.role ?? entry.message?.role;
  if (eventType === 'result') return cleanAssistantText(entry.result ?? '');
  if (eventType !== 'assistant' && entry.message?.role !== 'assistant') return null;

  const content = entry.message?.content ?? entry.content;
  if (typeof content === 'string') return cleanAssistantText(content);
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return cleanAssistantText(text);
}

function cleanAssistantText(text: string): string | null {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  return cleaned.length > 0 ? cleaned : null;
}
