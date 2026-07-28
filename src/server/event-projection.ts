import type { AgentEvent } from '../core/types.js';
import type { CompletionDigest } from '../core/completion-digest.js';
import { isSecretFieldName, redactSecrets } from '../core/redact-secrets.js';

/**
 * Project an AgentEvent for client transport. Drops fields no frontend consumer
 * reads (toolResponse) and caps fields that can grow unbounded (toolInput, lastMessage).
 *
 * Server-internal consumers (anomaly-detector, completion-digest, response-assist,
 * github-reference-scanner, reflection-task) must read events from Monitor.agentEvents
 * directly, not from the projected snapshot. Method naming in
 * src/server/use-cases/get-snapshot.ts (ForClient vs Raw) documents intent at the seam.
 *
 * Agent-level fields (`description`, `completionDigest`) are projected separately via
 * {@link projectAgentFieldsForClient} — with hundreds of historical tasks those two
 * fields alone can push the WebSocket snapshot over the 8 MiB hard cap, which drops
 * the entire frame and leaves the dashboard empty (looks like "dev mode").
 *
 * See docs/rfc/rfc-snapshot-payload-slimming.md.
 */

/** Max bytes of toolInput JSON included in client-facing events. */
export const TOOL_INPUT_MAX_BYTES = 2 * 1024;

/** Max UTF-8 bytes of lastMessage included in client-facing events. */
export const LAST_MESSAGE_MAX_BYTES = 4 * 1024;

/** Max UTF-8 bytes of task prompt (`description`) in client-facing snapshots. */
export const DESCRIPTION_MAX_BYTES = 4 * 1024;

/**
 * Max UTF-8 bytes of `description` on a client-facing snapshot entry for a
 * task in terminal status (issue #1526 Phase C / C2 payload diet). Terminal
 * rows only surface the description as a hover tooltip in the Completed pane
 * (`CompletedRow` in FindingsPanel.tsx); the full prompt stays available via
 * `GET /api/tasks/:id` (the DetailPanel relaunch path already fetches it).
 * On the 2026-07 prod store, full 4 KiB descriptions across ~650 terminal
 * rows were the single largest contributor (~2.2 MB) to the ~5 MB snapshot.
 */
export const TERMINAL_DESCRIPTION_MAX_BYTES = 1024;

/** Max files listed in a client-facing completion digest. */
export const COMPLETION_DIGEST_MAX_FILES = 40;

/** Max bullets listed in a client-facing completion digest. */
export const COMPLETION_DIGEST_MAX_BULLETS = 8;

/** Max characters per bullet / testSummary / verification command. */
export const COMPLETION_DIGEST_TEXT_MAX_CHARS = 500;

/** Max verification commands listed in a client-facing completion digest. */
export const COMPLETION_DIGEST_MAX_COMMANDS = 20;

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

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'spawn_agent']);
const SUBAGENT_PROMPT_KEYS = new Set(['prompt', 'instructions']);

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

function projectWithToolInput<E extends AgentEvent & { toolName: string; toolInput?: unknown }>(event: E): E {
  const toolInput = redactToolInputSecrets(redactSubagentPromptInput(event.toolName, event.toolInput));
  if (toolInput === undefined || toolInput === null) return event;

  const serialized = JSON.stringify(toolInput);
  if (serialized.length <= TOOL_INPUT_MAX_BYTES) {
    return toolInput === event.toolInput ? event : { ...event, toolInput };
  }

  return { ...event, toolInput: truncateToolInput(toolInput, serialized.length) };
}

function redactToolInputSecrets(toolInput: unknown): unknown {
  if (typeof toolInput === 'string') return redactSecrets(toolInput);
  if (toolInput === null || typeof toolInput !== 'object') return toolInput;

  if (Array.isArray(toolInput)) {
    let redacted: unknown[] | undefined;
    toolInput.forEach((value, index) => {
      const next = redactToolInputSecrets(value);
      if (next === value && redacted === undefined) return;
      redacted ??= toolInput.slice(0, index);
      redacted.push(next);
    });
    return redacted ?? toolInput;
  }

  const obj = toolInput as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(obj)) {
    const next = isSecretFieldName(key) ? '[REDACTED]' : redactToolInputSecrets(value);
    if (next === value && redacted === undefined) continue;
    redacted ??= { ...obj };
    redacted[key] = next;
  }
  return redacted ?? toolInput;
}

function redactSubagentPromptInput(toolName: string, toolInput: unknown): unknown {
  if (!SUBAGENT_TOOL_NAMES.has(toolName)) return toolInput;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return toolInput;

  const obj = toolInput as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  for (const key of SUBAGENT_PROMPT_KEYS) {
    if (!(key in obj)) continue;
    redacted ??= { ...obj };
    delete redacted[key];
  }
  return redacted ?? toolInput;
}

/** Per-descriptor-value cap: prevents a single large descriptor (e.g. tool `prompt`)
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
  const lastMessage = redactSecrets(event.lastMessage);
  const bytes = Buffer.byteLength(lastMessage, 'utf-8');
  if (bytes <= LAST_MESSAGE_MAX_BYTES) {
    return lastMessage === event.lastMessage ? event : { ...event, lastMessage };
  }

  return { ...event, lastMessage: truncateUtf8(lastMessage, LAST_MESSAGE_MAX_BYTES, bytes) };
}

function truncateUtf8(s: string, maxBytes: number, totalBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8') + `…<${totalBytes} bytes elided>`;
}

function truncateChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

/**
 * Cap unbounded agent-level fields for the dashboard WebSocket snapshot.
 * Identity-preserving when nothing needs clipping.
 */
export function projectAgentFieldsForClient<
  T extends { description?: string; completionDigest?: CompletionDigest },
>(agent: T): T {
  const description = projectDescriptionForClient(agent.description);
  const completionDigest = agent.completionDigest
    ? projectCompletionDigestForClient(agent.completionDigest)
    : undefined;

  const descriptionChanged = description !== agent.description;
  const digestChanged = completionDigest !== agent.completionDigest;
  if (!descriptionChanged && !digestChanged) return agent;

  return {
    ...agent,
    ...(descriptionChanged ? { description } : {}),
    ...(digestChanged && completionDigest !== undefined ? { completionDigest } : {}),
  };
}

export function projectDescriptionForClient(
  description: string | undefined,
  maxBytes: number = DESCRIPTION_MAX_BYTES,
): string | undefined {
  if (description === undefined) return undefined;
  const bytes = Buffer.byteLength(description, 'utf-8');
  if (bytes <= maxBytes) return description;
  return truncateUtf8(description, maxBytes, bytes);
}

/**
 * Slim a terminal-status agent snapshot entry for client transport
 * (issue #1526 Phase C / C2 payload diet). Applies on top of
 * {@link projectAgentFieldsForClient}:
 *
 *  - `description` is bounded to {@link TERMINAL_DESCRIPTION_MAX_BYTES} — on a
 *    terminal row it only feeds the Completed-pane hover tooltip; the full
 *    prompt remains available via `GET /api/tasks/:id`.
 *  - `completionFeedback` and `launchHealthSummary` are dropped — verified to
 *    have zero frontend readers on terminal snapshot rows (the DetailPanel
 *    reads feedback state from the task detail endpoint, not the snapshot).
 *  - `completionDigest` keeps everything the dashboard renders (bullets,
 *    filesChanged, criteriaVerdict, testSummary, branch, tokenUsage) and
 *    sheds the sub-fields with zero frontend readers (`verificationCommands`,
 *    `commits`, `prUrls`) — on the 2026-07 prod store those alone were
 *    ~1.9 MB raw. Full digests stay on `GET /api/tasks/:id` and the raw
 *    snapshot surfaces.
 *
 * Identity-preserving when nothing needs clipping.
 */
export function projectTerminalAgentFieldsForClient<
  T extends {
    description?: string;
    completionFeedback?: unknown;
    launchHealthSummary?: unknown;
    completionDigest?: CompletionDigest;
  },
>(agent: T): T {
  const description = projectDescriptionForClient(agent.description, TERMINAL_DESCRIPTION_MAX_BYTES);
  const completionDigest = agent.completionDigest
    ? projectTerminalCompletionDigestForClient(agent.completionDigest)
    : undefined;
  const descriptionChanged = description !== agent.description;
  const digestChanged = completionDigest !== agent.completionDigest;
  const hasDroppableFields = agent.completionFeedback !== undefined || agent.launchHealthSummary !== undefined;
  if (!descriptionChanged && !digestChanged && !hasDroppableFields) return agent;

  const next = { ...agent };
  if (descriptionChanged && description !== undefined) next.description = description;
  if (digestChanged && completionDigest !== undefined) next.completionDigest = completionDigest;
  delete next.completionFeedback;
  delete next.launchHealthSummary;
  return next;
}

/**
 * Drop the completion-digest sub-fields no dashboard surface reads
 * (issue #1526 Phase C / C2). Identity-preserving when none are present.
 */
export function projectTerminalCompletionDigestForClient(digest: CompletionDigest): CompletionDigest {
  if (
    digest.verificationCommands === undefined
    && digest.commits === undefined
    && digest.prUrls === undefined
  ) {
    return digest;
  }
  const { verificationCommands: _vc, commits: _c, prUrls: _p, ...kept } = digest;
  return kept;
}

export function projectCompletionDigestForClient(digest: CompletionDigest): CompletionDigest {
  const bullets = digest.bullets
    .slice(0, COMPLETION_DIGEST_MAX_BULLETS)
    .map((b) => truncateChars(b, COMPLETION_DIGEST_TEXT_MAX_CHARS));
  const filesChanged = digest.filesChanged.slice(0, COMPLETION_DIGEST_MAX_FILES);
  const verificationCommands = digest.verificationCommands
    ?.slice(0, COMPLETION_DIGEST_MAX_COMMANDS)
    .map((c) => truncateChars(c, COMPLETION_DIGEST_TEXT_MAX_CHARS));
  const testSummary = digest.testSummary
    ? truncateChars(digest.testSummary, COMPLETION_DIGEST_TEXT_MAX_CHARS)
    : undefined;

  const filesClipped = filesChanged.length < digest.filesChanged.length;
  const bulletsClipped = bullets.length < digest.bullets.length
    || bullets.some((b, i) => b !== digest.bullets[i]);
  const commandsClipped = verificationCommands !== undefined
    && (
      verificationCommands.length < (digest.verificationCommands?.length ?? 0)
      || verificationCommands.some((c, i) => c !== digest.verificationCommands?.[i])
    );
  const testClipped = testSummary !== digest.testSummary;

  if (!filesClipped && !bulletsClipped && !commandsClipped && !testClipped) {
    return digest;
  }

  const next: CompletionDigest = {
    ...digest,
    bullets,
    filesChanged,
    ...(testSummary !== undefined ? { testSummary } : {}),
    ...(verificationCommands !== undefined ? { verificationCommands } : {}),
  };

  // Surface elided file volume so the UI still reflects scale when we clip.
  if (filesClipped) {
    const omitted = digest.filesChanged.length - filesChanged.length;
    next.filesChanged = [...filesChanged, `…+${omitted} more`];
  }

  return next;
}
