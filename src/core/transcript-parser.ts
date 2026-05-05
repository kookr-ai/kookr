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
    content?: ContentBlock[];
  };
  content?: ContentBlock[];
}

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
  if (!contentBlocks || contentBlocks.length === 0) {
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
