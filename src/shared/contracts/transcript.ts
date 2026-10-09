/**
 * Contract for `GET /api/tasks/:id/transcript` — a read-only, provider-neutral
 * view of a task's conversation. The frontend switches on `kind` / presence of
 * `unavailable`, never on the agent provider.
 */

export type TranscriptMessage =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool_call'; name: string; input?: string }
  | { kind: 'tool_result'; name?: string; text: string; truncated?: boolean }
  | { kind: 'truncation_marker'; note: string };

export type TranscriptUnavailableReason =
  | 'vendor_never_persisted'
  | 'aged_out'
  | 'unsupported_provider'
  | 'not_found';

export type TranscriptSource = 'vendor' | 'ledger' | 'stored';

export interface TranscriptAvailableResponse {
  taskId: string;
  sessionId?: string;
  source: TranscriptSource;
  messages: TranscriptMessage[];
}

export interface TranscriptUnavailableResponse {
  taskId: string;
  sessionId?: string;
  unavailable: { reason: TranscriptUnavailableReason };
}

export type TranscriptResponse = TranscriptAvailableResponse | TranscriptUnavailableResponse;
