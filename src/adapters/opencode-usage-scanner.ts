/**
 * opencode usage/cost scanner (RFC rfc-opencode-agent-integration §8).
 *
 * opencode persists everything to a per-session sqlite DB at
 * `<XDG_DATA_HOME>/opencode/opencode.db`. A managed launch composes an isolated
 * session dir whose `data/` is that XDG_DATA_HOME (see
 * `opencode-home-composer.ts`), so the DB is private to the session and can be
 * summed wholesale. Each assistant row in `message` carries a JSON `data` blob:
 *
 *   {"role":"assistant","modelID":"...","providerID":"...","cost":0.0011,
 *    "tokens":{"total":7339,"input":5545,"output":2,"reasoning":0,
 *              "cache":{"write":0,"read":1792}},
 *    "time":{"created":...,"completed":...}}
 *
 * Token semantics (observed, opencode 1.19.5): `input` EXCLUDES cache tokens
 * (`total = input + output + reasoning + cache.read + cache.write`) and
 * `output` EXCLUDES reasoning, so reasoning is an additive bucket (like Codex,
 * unlike Grok). `cost` is USD as computed by opencode and is used verbatim.
 *
 * The scanner never throws: every failure is a typed result so teardown can
 * stay best-effort. The DB is opened read-only; a locked/WAL DB is tolerated
 * with a short busy timeout and reported as `unreadable`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '../core/types.js';

/** DB path inside a composed session dir (`<sessionDir>/data` is XDG_DATA_HOME). */
export function openCodeDbPathFor(sessionDir: string): string {
  return join(sessionDir, 'data', 'opencode', 'opencode.db');
}

/** DB path under an XDG_DATA_HOME root (the per-task persistent data dir). */
export function openCodeDbPathForDataHome(dataHome: string): string {
  return join(dataHome, 'opencode', 'opencode.db');
}

/** Usage summed across every assistant message in one session DB. */
export interface OpenCodeSessionUsage {
  /** Prompt tokens EXCLUDING cache read/write (opencode's `tokens.input`). */
  inputTokens: number;
  /** Output tokens EXCLUDING reasoning. */
  outputTokens: number;
  /** Cache-read tokens. */
  cachedReadTokens: number;
  /** Cache-write tokens. */
  cacheWriteTokens: number;
  /** Reasoning tokens (additive to output). */
  reasoningTokens: number;
  /** USD cost as computed by opencode, summed. */
  costUsd: number;
  /** `providerID/modelID` of the model with the most total tokens, or null. */
  model: string | null;
  /** Number of assistant messages (model requests) aggregated. */
  requestCount: number;
  /** Earliest `time.created` (epoch ms) across aggregated messages. */
  firstTimestamp: number | null;
  /** Latest `time.completed` (fallback `time.created`) across aggregated messages. */
  lastTimestamp: number | null;
}

export type OpenCodeUsageResult =
  | { kind: 'ok'; usage: OpenCodeSessionUsage }
  /** DB file absent, or present but holds no assistant usage yet. */
  | { kind: 'no-data' }
  /** DB lacks the expected `message` table/columns (opencode version drift). */
  | { kind: 'unsupported-schema'; reason: string }
  /** Open/read failed (locked, corrupt, addon missing). */
  | { kind: 'unreadable'; reason: string };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface MessageRow {
  data: string;
}

/** Read and sum usage from the opencode DB at `dbPath`. Never throws. */
export async function readOpenCodeDbUsage(dbPath: string): Promise<OpenCodeUsageResult> {
  if (!existsSync(dbPath)) return { kind: 'no-data' };
  let db: import('better-sqlite3').Database | undefined;
  try {
    const { default: Database } = await import('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 500 });

    const columns = db.prepare("SELECT name FROM pragma_table_info('message')").all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has('data') || !names.has('session_id')) {
      return { kind: 'unsupported-schema', reason: 'message table missing or lacks data/session_id columns' };
    }

    const rows = db
      .prepare("SELECT data FROM message WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant'")
      .all() as MessageRow[];

    const totals: OpenCodeSessionUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      model: null,
      requestCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
    };
    const modelTotals = new Map<string, number>();

    for (const row of rows) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = (msg.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      // Skip in-flight messages that have no usage recorded yet.
      if (typeof msg.tokens !== 'object' || msg.tokens === null) continue;

      const input = num(tokens.input);
      const output = num(tokens.output);
      const reasoning = num(tokens.reasoning);
      const read = num(cache.read);
      const write = num(cache.write);
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.reasoningTokens += reasoning;
      totals.cachedReadTokens += read;
      totals.cacheWriteTokens += write;
      totals.costUsd += num(msg.cost);
      totals.requestCount += 1;

      const time = (msg.time ?? {}) as Record<string, unknown>;
      const created = optNum(time.created);
      const end = optNum(time.completed) ?? created;
      if (created !== null && (totals.firstTimestamp === null || created < totals.firstTimestamp)) {
        totals.firstTimestamp = created;
      }
      if (end !== null && (totals.lastTimestamp === null || end > totals.lastTimestamp)) {
        totals.lastTimestamp = end;
      }

      if (typeof msg.modelID === 'string' && msg.modelID) {
        const key = typeof msg.providerID === 'string' && msg.providerID ? `${msg.providerID}/${msg.modelID}` : msg.modelID;
        modelTotals.set(key, (modelTotals.get(key) ?? 0) + input + output + reasoning + read + write);
      }
    }

    if (totals.requestCount === 0) return { kind: 'no-data' };
    let best: string | null = null;
    let bestTotal = -1;
    for (const [model, total] of modelTotals) {
      if (total > bestTotal) {
        best = model;
        bestTotal = total;
      }
    }
    totals.model = best;
    return { kind: 'ok', usage: totals };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A DB without a `message` table at all surfaces from pragma as empty
    // columns (handled above); anything reaching here is an access failure.
    return { kind: 'unreadable', reason };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Convenience: scan the DB inside a composed session dir. */
export function readOpenCodeSessionUsage(sessionDir: string): Promise<OpenCodeUsageResult> {
  return readOpenCodeDbUsage(openCodeDbPathFor(sessionDir));
}

/** Convenience: scan the DB under an XDG_DATA_HOME root. */
export function readOpenCodeDataHomeUsage(dataHome: string): Promise<OpenCodeUsageResult> {
  return readOpenCodeDbUsage(openCodeDbPathForDataHome(dataHome));
}

/**
 * Map to the shared {@link TokenUsage} contract: `outputTokens` carries
 * output + reasoning (matching the Codex conversion); `costUsd` is opencode's
 * own figure. `provider` stays unset (the union is openai/anthropic only and
 * opencode fronts arbitrary providers).
 */
export function mapOpenCodeUsageToTokenUsage(usage: OpenCodeSessionUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens + usage.reasoningTokens,
    cacheReadTokens: usage.cachedReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    ...(usage.model ? { model: usage.model } : {}),
  };
}
