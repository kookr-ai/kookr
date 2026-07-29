// RFC 018 M2 (#373) — Kookr context-injection hook core.
//
// Implements the §11 consumer contract for the knowledge-base-mcp-server
// relevance gate. Before an agent turn, this logic:
//
//   - assembles a freshness-stamped `task_context` from the user prompt
//     (RFC §11);
//   - runs `kb search "<query>" --gate --task-context-file=<f> --format=json`;
//   - validates the response's `gate_verdict` against the vendored
//     relevance-gate schema artifact (`relevance-gate-schema.ts`);
//   - honors the verdict — `no-relevant-context` / `empty-index` inject
//     nothing, `injected` + `low_confidence` injects but flags every item;
//   - echoes `gate_verdict` to the debug channel (stderr).
//
// Everything here is fail-open: the gate "never blocks retrieval", and a
// hook crash must never break the agent's turn. Any error path returns an
// empty injection. The pure functions (assemble / parse / decide / format)
// carry the test weight; `runKbContextInjection` is the thin orchestrator.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseRelevanceGateVerdict,
  type RelevanceGateVerdict,
} from './relevance-gate-schema.js';

/** RFC 018 §1 — `task_context` is hard-truncated to 2000 chars server-side. */
const TASK_CONTEXT_MAX_CHARS = 2000;
/** `kb search` is given the prompt as the query; keep it bounded. */
const QUERY_MAX_CHARS = 400;

/**
 * Playbook prompts (since #1420) begin with a fixed ~215-char context-header
 * blockquote naming the playbook and its definition path. That boilerplate is
 * identical across every playbook launch, so leaving it in the query source
 * would spend more than half of `QUERY_MAX_CHARS` on non-discriminating text
 * and degrade KB relevance. Strip a leading header line so the query keys off
 * the actual task body (#1431). Matched on the stable prefix, not the full
 * wording, so header copy-edits don't silently defeat the strip.
 */
const PLAYBOOK_CONTEXT_HEADER_RE = /^> _Kookr playbook context\b[^\n]*\n+/;

/**
 * Drop a leading playbook context header from a prompt so the KB query keys off
 * the task body. Returns the prompt unchanged when no header is present, and
 * falls back to the original prompt when stripping would leave nothing to query
 * (a header-only prompt).
 */
export function stripPlaybookContextHeader(prompt: string): string {
  const stripped = prompt.replace(PLAYBOOK_CONTEXT_HEADER_RE, '');
  return stripped.trim() === '' ? prompt : stripped;
}
/** Per-snippet cap on injected content so a turn is not flooded. */
const SNIPPET_MAX_CHARS = 800;
/** `kb search --gate` runs the Stage B LLM judge — bound the per-turn wait. */
export const KB_SEARCH_TIMEOUT_MS = 20_000;

export class KbContextInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbContextInjectionError';
  }
}

// ---------------------------------------------------------------------------
// task_context assembly
// ---------------------------------------------------------------------------

/**
 * Build the `task_context` string. Stamped with the monotonic turn id so a
 * stale context is detectable (RFC §11 freshness contract) — the hook also
 * never reuses one: it is rebuilt every turn from the current prompt.
 */
export function assembleTaskContext(input: {
  prompt: string;
  turnId: number;
}): string {
  const lines: string[] = [`[kookr-turn ${input.turnId}]`];
  lines.push(`Current request: ${input.prompt.trim()}`);
  return lines.join('\n').slice(0, TASK_CONTEXT_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// turn id — monotonic per-session counter
// ---------------------------------------------------------------------------

export interface TurnIdFsDeps {
  readFileImpl: (path: string) => Promise<string>;
  writeFileImpl: (path: string, data: string) => Promise<void>;
  mkdirImpl: (path: string) => Promise<void>;
}

const realTurnIdFs: TurnIdFsDeps = {
  readFileImpl: (path) => readFile(path, 'utf-8'),
  writeFileImpl: (path, data) => writeFile(path, data, 'utf-8'),
  mkdirImpl: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

/**
 * The next turn id for a session, persisted to a per-session counter file.
 * RFC §11 requires this stamp so a stale `task_context` is detectable.
 * Strictly increasing in the normal case. Fail-soft: a corrupt counter
 * resets to 0, and if the counter cannot be persisted the returned stamp is
 * non-decreasing rather than strictly increasing — a repeated value is never
 * "older", so the §11 freshness check still holds.
 */
export async function nextTurnId(
  sessionId: string,
  stateDir: string,
  deps: TurnIdFsDeps = realTurnIdFs,
): Promise<number> {
  const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  const counterFile = join(stateDir, `${safeSession}.turn`);
  let current = 0;
  try {
    const value = Number.parseInt((await deps.readFileImpl(counterFile)).trim(), 10);
    if (Number.isInteger(value) && value >= 0) current = value;
  } catch {
    // First turn of this session, or an unreadable counter — start from 0.
  }
  const next = current + 1;
  try {
    await deps.mkdirImpl(stateDir);
    await deps.writeFileImpl(counterFile, String(next));
  } catch {
    // Counter not persistable (rare) — `next` is still derived from the last
    // readable value, so the stamp stays non-decreasing across turns.
  }
  return next;
}

// ---------------------------------------------------------------------------
// kb search response parsing + schema validation
// ---------------------------------------------------------------------------

export interface KbSearchResultItem {
  source: string;
  content: string;
}

export interface KbSearchResponse {
  results: KbSearchResultItem[];
  gateVerdict: RelevanceGateVerdict;
}

/**
 * Parse a `kb search --format=json` payload. The `gate_verdict` is validated
 * against the vendored relevance-gate schema (RFC §11 — a contract break
 * throws here and the caller fail-opens). The `results` array is parsed
 * leniently: only `gate_verdict` is a schema-locked contract.
 */
export function parseKbSearchResponse(stdout: string): KbSearchResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new KbContextInjectionError('kb search did not return JSON');
  }
  if (!isRecord(parsed)) {
    throw new KbContextInjectionError('kb search JSON payload was not an object');
  }
  const gateVerdict = parseRelevanceGateVerdict(parsed.gate_verdict);
  return { results: extractResultItems(parsed.results), gateVerdict };
}

function extractResultItems(raw: unknown): KbSearchResultItem[] {
  if (!Array.isArray(raw)) return [];
  const items: KbSearchResultItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const content = firstString(entry, ['content', 'text', 'pageContent', 'snippet', 'body']);
    if (content === null) continue;
    const source = firstString(entry, ['source', 'path', 'file', 'kb', 'id']) ?? 'knowledge base';
    items.push({ source, content: content.slice(0, SNIPPET_MAX_CHARS) });
  }
  return items;
}

// ---------------------------------------------------------------------------
// verdict policy + formatting
// ---------------------------------------------------------------------------

export interface InjectionDecision {
  /** Whether any KB context is injected into the agent's turn. */
  inject: boolean;
  items: KbSearchResultItem[];
  /** RFC §11 — propagated onto every injected item the agent sees. */
  lowConfidence: boolean;
  state: RelevanceGateVerdict['state'];
  /** RFC §11 — `empty-index` absence is surfaced to the operator, not suppressed. */
  emptyIndex: boolean;
}

/** Apply the RFC §11 verdict policy to a parsed `kb search` response. */
export function decideInjection(response: KbSearchResponse): InjectionDecision {
  const { state, low_confidence: lowConfidence } = response.gateVerdict;
  // `no-relevant-context` → inject nothing (silence). `empty-index` → inject
  // nothing, but flag the absence to the operator.
  if (state === 'no-relevant-context' || state === 'empty-index') {
    return { inject: false, items: [], lowConfidence, state, emptyIndex: state === 'empty-index' };
  }
  // `injected` (gate ran, kept a set) and `bypassed` (gate off — the gate
  // emits the full set unchanged) are handled identically: inject whatever
  // results came back.
  return {
    inject: response.results.length > 0,
    items: response.results,
    lowConfidence,
    state,
    emptyIndex: false,
  };
}

/** The agent-facing context block (stdout). Empty when nothing is injected. */
export function formatInjectedContext(decision: InjectionDecision, turnId: number): string {
  if (!decision.inject || decision.items.length === 0) return '';
  const lines: string[] = [];
  lines.push('<system-reminder>');
  lines.push(`[hook: kb-context-inject · turn ${turnId}] Relevance-gated knowledge-base context.`);
  if (decision.lowConfidence) {
    lines.push(
      'The relevance gate kept this context under a WEAK signal (low_confidence). '
      + 'Each snippet below is marked [low-confidence] — verify before relying on it.',
    );
  }
  decision.items.forEach((item, idx) => {
    const flag = decision.lowConfidence ? ' [low-confidence]' : '';
    lines.push(`--- snippet ${idx + 1} [${item.source}]${flag} ---`);
    lines.push(item.content.trim());
  });
  lines.push('</system-reminder>');
  return lines.join('\n');
}

/** The operator/debug echo (stderr). RFC §11 — by-stage drop counts + degraded. */
export function formatGateDebugEcho(verdict: RelevanceGateVerdict): string {
  const drops = { A1: 0, A2: 0, B: 0, other: 0 };
  for (const drop of verdict.dropped) {
    if (drop.stage.startsWith('A1')) drops.A1 += 1;
    else if (drop.stage.startsWith('A2')) drops.A2 += 1;
    else if (drop.stage.startsWith('B')) drops.B += 1;
    else drops.other += 1;
  }
  const degraded = verdict.judge.status === 'failed';
  return (
    `[kb-context-inject] gate_verdict: state=${verdict.state} `
    + `kept=${verdict.output_count}/${verdict.input_count} `
    + `low_confidence=${verdict.low_confidence} degraded=${degraded} `
    + `drops(A1=${drops.A1} A2=${drops.A2} B=${drops.B} other=${drops.other}) `
    + `judge=${verdict.judge.status}`
  );
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export interface KbSearchExec {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KbContextInjectionInput {
  prompt: string;
  sessionId: string;
}

export interface KbContextInjectionDeps {
  /** Runs `kb` with the given args. Injected so tests never touch the binary. */
  execKbSearch: (args: string[]) => Promise<KbSearchExec>;
  env: NodeJS.ProcessEnv;
  /** Where the per-session turn counter lives (default: ~/.kookr/kb-context-injection). */
  stateDir?: string;
}

export interface KbContextInjectionResult {
  /** Injected into the agent turn (empty = inject nothing). */
  stdout: string;
  /** Operator/debug channel — never injected into the agent. */
  stderr: string;
  turnId: number;
}

/** The default `kb` runner — `execFile`, bounded, never throws on non-zero exit. */
export function defaultExecKbSearch(args: string[]): Promise<KbSearchExec> {
  return new Promise((resolve) => {
    execFile(
      'kb',
      args,
      { timeout: KB_SEARCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const nodeError = error as NodeJS.ErrnoException | null;
        const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
  });
}

/**
 * Run the full RFC §11 context-injection flow for one agent turn. Always
 * fail-open: any error returns an empty injection so the turn proceeds.
 */
export async function runKbContextInjection(
  input: KbContextInjectionInput,
  deps: KbContextInjectionDeps,
): Promise<KbContextInjectionResult> {
  const prompt = input.prompt.trim();
  if (prompt === '') return { stdout: '', stderr: '', turnId: 0 };

  const stateDir = deps.stateDir
    ?? join(deps.env.HOME ?? tmpdir(), '.kookr', 'kb-context-injection');
  const turnId = await nextTurnId(input.sessionId, stateDir);

  let tcFile: string | null = null;
  try {
    const taskContext = assembleTaskContext({ prompt, turnId });

    tcFile = join(tmpdir(), `kookr-kb-task-context-${turnId}-${randomUUID()}.txt`);
    await writeFile(tcFile, taskContext, 'utf-8');

    // `execFile` (no shell) makes the query injection-safe. A prompt that
    // happens to start with `--` is rejected by `kb search` as an unknown
    // flag → non-zero exit → fail-open below; there is no silent flag
    // misbinding (kb-search throws on unknown `--flags`).
    const exec = await deps.execKbSearch([
      'search',
      stripPlaybookContextHeader(prompt).slice(0, QUERY_MAX_CHARS),
      '--gate',
      `--task-context-file=${tcFile}`,
      '--format=json',
    ]);

    if (exec.exitCode !== 0 || exec.stdout.trim() === '') {
      return {
        stdout: '',
        stderr: `[kb-context-inject] kb search unavailable (exit ${exec.exitCode}); injecting nothing.`,
        turnId,
      };
    }

    const response = parseKbSearchResponse(exec.stdout);
    const decision = decideInjection(response);
    const stderrLines = [formatGateDebugEcho(response.gateVerdict)];
    if (decision.emptyIndex) {
      stderrLines.push(
        '[kb-context-inject] kb index is empty — no knowledge-base content exists to inject.',
      );
    }
    return {
      stdout: formatInjectedContext(decision, turnId),
      stderr: stderrLines.join('\n'),
      turnId,
    };
  } catch (err) {
    // Fail-open — a parse/schema/IO error must not break the turn.
    return {
      stdout: '',
      stderr: `[kb-context-inject] skipped (${(err as Error).message}); injecting nothing.`,
      turnId,
    };
  } finally {
    if (tcFile !== null) {
      await rm(tcFile, { force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}
