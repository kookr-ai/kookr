import type { AgentEvent } from '../core/types.js';

/**
 * Project an AgentEvent for client transport. Drops fields no frontend consumer
 * reads (toolResponse) and caps fields that can grow unbounded (toolInput, lastMessage).
 *
 * Server-internal consumers (anomaly-detector, completion-digest, response-assist,
 * github-reference-scanner, reflection-task) must read events from Monitor.agentEvents
 * directly, not from the projected snapshot. Method naming in
 * src/server/use-cases/get-snapshot.ts (ForClient vs Raw) documents intent at the seam.
 *
 * See docs/rfc/rfc-snapshot-payload-slimming.md.
 */

/** Max bytes of toolInput JSON included in client-facing events. */
export const TOOL_INPUT_MAX_BYTES = 2 * 1024;

/** Max UTF-8 bytes of lastMessage included in client-facing events. */
export const LAST_MESSAGE_MAX_BYTES = 4 * 1024;

/**
 * Keys on toolInput consumed by core/activity-summary.ts for label/category.
 * Keep in sync with the `'<key>' in toolInput` narrowings in activity-summary.ts;
 * each narrowing there has a cross-reference comment pointing here.
 *
 * `file_path` is ALSO load-bearing for the activity panel diff-click walk
 * (src/frontend/components/ActivityPanel.tsx — see the EnrichedEntry mapping).
 * Removing it from this array silently breaks the diff pane's click target
 * resolution. An invariant test in event-projection.test.ts asserts that
 * `file_path` stays in the array.
 */
export const DESCRIPTOR_KEYS = ['file_path', 'command', 'pattern', 'url', 'prompt'] as const;

export function projectEventForClient(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'tool_result': {
      const { toolResponse: _toolResponse, ...rest } = event;
      return rest;
    }
    case 'tool_use':
    case 'tool_error':
    case 'permission_request':
      return projectWithToolInput(event);
    case 'subagent_stop':
    case 'stop':
    case 'stop_failure':
      return projectWithLastMessage(event);
    default:
      return event;
  }
}

function projectWithToolInput<E extends AgentEvent & { toolInput?: unknown }>(event: E): E {
  const { toolInput } = event;
  if (toolInput === undefined || toolInput === null) return event;

  const serialized = JSON.stringify(toolInput);
  if (serialized.length <= TOOL_INPUT_MAX_BYTES) return event;

  return { ...event, toolInput: truncateToolInput(toolInput, serialized.length) };
}

/** Per-descriptor-value cap: prevents a single large descriptor (e.g. Agent `prompt`)
 *  from bypassing TOOL_INPUT_MAX_BYTES. Sized so that even every descriptor at its
 *  cap still fits within the overall budget. */
const DESCRIPTOR_VALUE_MAX_BYTES = 256;

/** Prefix preserved for non-object / non-array `toolInput` (primitives). */
const PRIMITIVE_PREFIX_CHARS = 200;

function truncateToolInput(toolInput: unknown, originalBytes: number): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  if (toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const obj = toolInput as Record<string, unknown>;
    for (const key of DESCRIPTOR_KEYS) {
      if (!(key in obj)) continue;
      const value = obj[key];
      if (typeof value === 'string' && value.length > DESCRIPTOR_VALUE_MAX_BYTES) {
        preserved[key] = value.slice(0, DESCRIPTOR_VALUE_MAX_BYTES) + '…';
      } else {
        preserved[key] = value;
      }
    }
  } else {
    // Primitive or array — no descriptors to preserve. Keep a short prefix as signal.
    preserved._preview = String(toolInput).slice(0, PRIMITIVE_PREFIX_CHARS);
  }
  preserved._truncated = `<${originalBytes} bytes elided>`;
  return preserved;
}

function projectWithLastMessage<E extends AgentEvent & { lastMessage: string }>(event: E): E {
  const { lastMessage } = event;
  const bytes = Buffer.byteLength(lastMessage, 'utf-8');
  if (bytes <= LAST_MESSAGE_MAX_BYTES) return event;

  return { ...event, lastMessage: truncateUtf8(lastMessage, LAST_MESSAGE_MAX_BYTES, bytes) };
}

function truncateUtf8(s: string, maxBytes: number, totalBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8') + `…<${totalBytes} bytes elided>`;
}
