/**
 * Task-relation inference engine (issue #600).
 *
 * Takes durable evidence — task records, kookr-spawn output, playbook state,
 * prompt text — and returns `TaskRelationInput[]` candidates suitable for
 * upserting via the existing `POST /api/task-relations` endpoint (issue #599).
 *
 * The engine is pure: it never reads from disk and never mutates `parentTaskId`.
 * IO and the actual HTTP write live in `bin/kookr-infer-relations.js`. Splitting
 * extraction from inference keeps the heuristics deterministically testable.
 *
 * Confidence thresholds (issue #600 acceptance: "Confidence thresholds are
 * explicit and documented near the code"):
 *   - {@link CONFIDENCE_EXTRACTED} — children.json line, kookr-spawn output
 *     with a known parent, state.md prior-parent header. Above the
 *     high-confidence gate but deliberately below
 *     `DETERMINISTIC_RELATION_CONFIDENCE` (which is reserved for Kookr's own
 *     authoritative writes — see #599).
 *   - {@link CONFIDENCE_PROMPT_STRUCTURED} — prompt names a unique run-key,
 *     prior parent task id, or shared state directory.
 *   - {@link LLM_CONFIDENCE_CAP} — hard cap for LLM-only verdicts. Issue body:
 *     "Never create a high-confidence edge from LLM-only evidence."
 *   - {@link AMBIGUITY_FLOOR} — candidates below this only appear in the
 *     `ambiguous` report, never as inferred edges.
 */

import {
  DETERMINISTIC_RELATION_CONFIDENCE,
  HIGH_CONFIDENCE_RELATION_THRESHOLD,
  taskRelationKey,
  type TaskRelation,
  type TaskRelationEvidence,
  type TaskRelationInput,
  type TaskRelationType,
} from '../shared/contracts/task-relations.js';
import type { LlmClient } from './llm-types.js';

export { HIGH_CONFIDENCE_RELATION_THRESHOLD } from '../shared/contracts/task-relations.js';

/** Authoritative writes (Kookr writing its own state) use
 *  {@link DETERMINISTIC_RELATION_CONFIDENCE} = 1.0. Inference is one step
 *  removed — even children.json and `kookr-spawn` output have small chances
 *  of staleness or operator hand-editing — so the inference engine writes
 *  at 0.95 to keep the on-record "1.0 means Kookr wrote this directly"
 *  contract that #599 established. Still well above the high-confidence
 *  gate so `--apply` will write these without lowering --apply-threshold. */
export const CONFIDENCE_EXTRACTED = 0.95;
export const CONFIDENCE_PROMPT_STRUCTURED = 0.85;
export const LLM_CONFIDENCE_CAP = 0.6;
export const AMBIGUITY_FLOOR = 0.4;

// Sanity guard: every documented threshold above the high-confidence gate must
// actually be above it, and the LLM cap must stay below it. If a future edit
// shifts these by mistake the assertion fails at module load.
if (CONFIDENCE_EXTRACTED < HIGH_CONFIDENCE_RELATION_THRESHOLD
  || CONFIDENCE_PROMPT_STRUCTURED < HIGH_CONFIDENCE_RELATION_THRESHOLD
  || LLM_CONFIDENCE_CAP >= HIGH_CONFIDENCE_RELATION_THRESHOLD
  || CONFIDENCE_EXTRACTED >= DETERMINISTIC_RELATION_CONFIDENCE) {
  throw new Error('task-relation-inference: confidence ladder violates contract invariants');
}

// ---------------------------------------------------------------------------
// Input shapes the engine consumes. The CLI extracts these from disk.
// ---------------------------------------------------------------------------

export interface InferenceTask {
  id: string;
  /** ISO-8601 string or Date. Used for time-proximity heuristics only. */
  createdAt: string | Date;
  /** Raw execution prompt (`Task.prompt`). */
  prompt?: string;
  /** User-authored prompt (`Task.userPrompt`). */
  userPrompt?: string;
  /** Deterministic parent set on API create; #599 has already written the
   *  matching `spawned_by` edge for these tasks so we count them as already
   *  linked and skip prompt heuristics on them. */
  parentTaskId?: string;
}

export interface SpawnEvent {
  /** Newly-created child task id, parsed from `task_id=<uuid>`. */
  taskId: string;
  /** Parent task id, when a known mapping (hook log → owner task, or
   *  `--parent-task-id <uuid>` flag on the spawn command) is available. */
  parentTaskId?: string;
  /** ISO-8601 capture time. */
  observedAt: string;
  filePath?: string;
  rawSnippet?: string;
}

export interface PlaybookChildEntry {
  task_id?: string;
  issue?: number | string;
}

export interface PlaybookChildrenSource {
  /** Run key — parallel-issue-batch uses the parent batch task uuid as run key. */
  runKey: string;
  /** Parent batch task id pulled from state.md, if known. */
  parentTaskId?: string;
  filePath: string;
  observedAt: string;
  entries: PlaybookChildEntry[];
}

export interface PlaybookStateRef {
  /** UUID-shaped task ids referenced anywhere in state.md / checkpoint text. */
  referencedTaskIds: string[];
  /** Parent batch task id pulled from "Parent task: <uuid>". */
  parentTaskId?: string;
  /** Prior parent task id pulled from "Prior parent task: <uuid>". */
  priorParentTaskId?: string;
  runKey?: string;
  filePath: string;
  observedAt: string;
}

export interface InferenceInput {
  tasks: InferenceTask[];
  /** Existing relation records from the store. Used to skip idempotent re-emits. */
  existingRelations: TaskRelation[];
  spawnEvents: SpawnEvent[];
  playbookChildren: PlaybookChildrenSource[];
  playbookStates: PlaybookStateRef[];
}

export interface InferenceOptions {
  /** LLM client for ambiguous text classification. If null/omitted, the
   *  fallback is skipped and ambiguous pairs are reported as such. */
  llmClient?: LlmClient | null;
  /** Floor for accepting a relation candidate at all. Default {@link AMBIGUITY_FLOOR}. */
  ambiguityFloor?: number;
}

export interface InferenceMetrics {
  totalTasks: number;
  alreadyLinked: number;
  inferred: number;
  ambiguous: number;
}

export interface AmbiguousCandidate {
  sourceTaskId: string;
  targetTaskId: string;
  reason: string;
  evidence: TaskRelationEvidence[];
}

export interface InferenceResult {
  /** Deduped candidates with confidence ≥ ambiguity floor. Candidates that
   *  match an existing relation are kept so the caller can refresh evidence,
   *  but they do NOT count toward `metrics.inferred`. */
  inferred: TaskRelationInput[];
  /** Pairs the engine looked at but could not confidently classify. */
  ambiguous: AmbiguousCandidate[];
  metrics: InferenceMetrics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SPAWNED_BY_PHRASE_RE = /Kookr child (?:task )?spawned by/i;
const RUN_KEY_RE = /run[- ]?key[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const PRIOR_TASK_RE = /(?:previous task[- ]?id|prior parent task|previous parent task)[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const PARENT_STATE_PATH_RE = /parent state(?: dir)?[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

interface PromptHints {
  spawnedByText: boolean;
  /** UUIDs that the prompt presents as the parent run / batch (e.g.
   *  "Run key: <uuid>", "parent state dir <uuid>"). Resolved to a
   *  `spawned_by` edge when the uuid matches a known task. */
  runKeyTokens: string[];
  /** UUIDs that the prompt presents as a *prior* task in a chain (e.g.
   *  "Previous task id: <uuid>", "Prior parent task: <uuid>"). Resolved
   *  to a `successor_of` edge. */
  priorParentTokens: string[];
  ambiguousChildText: boolean;
}

function extractPromptHints(prompt: string): PromptHints {
  const spawnedByText = SPAWNED_BY_PHRASE_RE.test(prompt);
  const runKeyTokens: string[] = [];
  for (const m of prompt.matchAll(RUN_KEY_RE)) runKeyTokens.push(m[1].toLowerCase());
  // "parent state dir <uuid>" identifies the parent batch, not a *prior*
  // batch — it goes into runKeyTokens so the rule engine resolves it as
  // `spawned_by`. Mis-routing this into priorParentTokens emits a
  // `successor_of` edge at structured confidence (well above the
  // high-confidence gate), which was previously confirmed-correct by
  // tests; we deliberately split the buckets so the type of the edge
  // matches the semantic of the prompt phrase.
  for (const m of prompt.matchAll(PARENT_STATE_PATH_RE)) runKeyTokens.push(m[1].toLowerCase());
  const priorParentTokens: string[] = [];
  for (const m of prompt.matchAll(PRIOR_TASK_RE)) priorParentTokens.push(m[1].toLowerCase());
  return {
    spawnedByText,
    runKeyTokens,
    priorParentTokens,
    ambiguousChildText: spawnedByText
      && runKeyTokens.length === 0
      && priorParentTokens.length === 0,
  };
}

interface CandidateAccumulator {
  byKey: Map<string, TaskRelationInput>;
}

function pushCandidate(acc: CandidateAccumulator, input: TaskRelationInput): void {
  if (!input.sourceTaskId || !input.targetTaskId) return;
  if (input.sourceTaskId === input.targetTaskId) return;
  const key = taskRelationKey(input.sourceTaskId, input.targetTaskId, input.type);
  const existing = acc.byKey.get(key);
  if (!existing) {
    acc.byKey.set(key, {
      ...input,
      evidence: input.evidence ? input.evidence.map((e) => ({ ...e })) : [],
    });
    return;
  }
  // Strongest confidence wins; evidence merged by snippet|path dedup.
  if (input.confidence > existing.confidence) {
    existing.confidence = input.confidence;
    existing.source = input.source;
  }
  if (input.evidence && input.evidence.length > 0) {
    const evidenceKey = (e: TaskRelationEvidence): string =>
      JSON.stringify([e.snippet ?? null, e.path ?? null]);
    existing.evidence = existing.evidence ?? [];
    const seen = new Set(existing.evidence.map(evidenceKey));
    for (const ev of input.evidence) {
      const k = evidenceKey(ev);
      if (seen.has(k)) continue;
      seen.add(k);
      existing.evidence.push({ ...ev });
    }
  }
}

function toIso(d: string | Date): string {
  return typeof d === 'string' ? d : d.toISOString();
}

function pickClosestPriorTask(child: InferenceTask, tasks: InferenceTask[]): InferenceTask | null {
  const childMs = new Date(child.createdAt).getTime();
  if (!Number.isFinite(childMs)) return null;
  let best: InferenceTask | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const t of tasks) {
    if (t.id === child.id) continue;
    const tMs = new Date(t.createdAt).getTime();
    if (!Number.isFinite(tMs) || tMs > childMs) continue;
    const delta = childMs - tMs;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = t;
    }
  }
  return best;
}

interface LlmVerdict {
  type: TaskRelationType | 'unrelated';
  confidence: number;
  rationale: string;
}

const LLM_SYSTEM_PROMPT = 'You classify the relation between two Kookr tasks based on their prompts. '
  + 'Respond with JSON of the form '
  + '{"type":"spawned_by"|"successor_of"|"same_chain"|"depends_on"|"unrelated","confidence":<0..1>,"rationale":""}. '
  + 'Only emit a non-"unrelated" verdict when the prompts share an obvious chain or parent reference.';

async function classifyWithLlm(
  client: LlmClient,
  child: InferenceTask,
  parent: InferenceTask,
): Promise<LlmVerdict | null> {
  const userMessage = JSON.stringify({
    parent: { id: parent.id, promptHead: (parent.prompt ?? '').slice(0, 800) },
    child: { id: child.id, promptHead: (child.prompt ?? '').slice(0, 800) },
  });
  let response: string | null;
  try {
    response = await client.complete({
      maxTokens: 256,
      system: LLM_SYSTEM_PROMPT,
      userMessage,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'task_relation_verdict',
          schema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['spawned_by', 'successor_of', 'same_chain', 'depends_on', 'unrelated'],
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              rationale: { type: 'string' },
            },
            required: ['type', 'confidence', 'rationale'],
            additionalProperties: false,
          },
        },
      },
      timeoutMs: 15_000,
    });
  } catch {
    return null;
  }
  if (!response) return null;
  try {
    const parsed = JSON.parse(response) as Partial<LlmVerdict>;
    if (parsed.type !== 'spawned_by'
      && parsed.type !== 'successor_of'
      && parsed.type !== 'same_chain'
      && parsed.type !== 'depends_on'
      && parsed.type !== 'unrelated') {
      return null;
    }
    const conf = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return {
      type: parsed.type,
      confidence: conf,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch {
    return null;
  }
}

async function applyPromptRules(
  tasks: InferenceTask[],
  taskById: Map<string, InferenceTask>,
  acc: CandidateAccumulator,
  ambiguous: AmbiguousCandidate[],
  options: InferenceOptions,
): Promise<void> {
  for (const child of tasks) {
    if (child.parentTaskId !== undefined) continue;
    const prompt = `${child.prompt ?? ''}\n${child.userPrompt ?? ''}`;
    if (prompt.trim().length === 0) continue;
    const hints = extractPromptHints(prompt);

    // R4/R5: prompt names a previous run-key or prior parent task id that
    // resolves to a known task. "prior parent" → successor_of; bare "run key"
    // → spawned_by (matches the parallel-issue-batch convention where the
    // run key IS the parent batch task uuid).
    let resolved = false;
    const handled = new Set<string>();
    for (const tok of hints.priorParentTokens) {
      if (handled.has(tok)) continue;
      handled.add(tok);
      const parent = taskById.get(tok);
      if (!parent || parent.id === child.id) continue;
      pushCandidate(acc, {
        sourceTaskId: child.id,
        targetTaskId: parent.id,
        type: 'successor_of',
        confidence: CONFIDENCE_PROMPT_STRUCTURED,
        source: 'transcript',
        evidence: [{
          snippet: `prompt references previous task id ${tok}`,
          observedAt: toIso(child.createdAt),
        }],
      });
      resolved = true;
    }
    for (const tok of hints.runKeyTokens) {
      if (handled.has(tok)) continue;
      handled.add(tok);
      const parent = taskById.get(tok);
      if (!parent || parent.id === child.id) continue;
      pushCandidate(acc, {
        sourceTaskId: child.id,
        targetTaskId: parent.id,
        type: 'spawned_by',
        confidence: CONFIDENCE_PROMPT_STRUCTURED,
        source: 'transcript',
        evidence: [{
          snippet: `prompt references run-key ${tok}`,
          observedAt: toIso(child.createdAt),
        }],
      });
      resolved = true;
    }
    if (resolved) continue;

    // R6: ambiguous "Kookr child task spawned by …" with no uuid hint.
    // Try LLM fallback against the closest prior task by createdAt.
    if (!hints.ambiguousChildText) continue;
    const candidateParent = pickClosestPriorTask(child, tasks);
    if (!candidateParent) continue;
    const baseEvidence: TaskRelationEvidence[] = [{
      snippet: 'prompt contains "Kookr child task spawned by" without an explicit parent id',
      observedAt: toIso(child.createdAt),
    }];

    if (options.llmClient) {
      const verdict = await classifyWithLlm(options.llmClient, child, candidateParent);
      if (verdict && verdict.type !== 'unrelated') {
        // Hard cap: LLM-only evidence never trips the high-confidence gate.
        const capped = Math.min(verdict.confidence, LLM_CONFIDENCE_CAP);
        pushCandidate(acc, {
          sourceTaskId: child.id,
          targetTaskId: candidateParent.id,
          type: verdict.type,
          confidence: capped,
          source: 'llm-inference',
          evidence: [
            ...baseEvidence,
            {
              snippet: `LLM verdict: ${verdict.type} (raw conf ${verdict.confidence.toFixed(2)})`
                + (verdict.rationale ? ` — ${verdict.rationale}` : ''),
              observedAt: new Date().toISOString(),
            },
          ],
        });
        continue;
      }
    }
    ambiguous.push({
      sourceTaskId: child.id,
      targetTaskId: candidateParent.id,
      reason: options.llmClient
        ? 'LLM returned unrelated/null for "spawned by" prompt without uuid'
        : '"spawned by" prompt without uuid; LLM fallback disabled',
      evidence: baseEvidence,
    });
  }
}

/**
 * Infer task relations from the supplied evidence bundle.
 *
 * Idempotency: candidates whose (source, target, type) key already exists in
 * `existingRelations` are still emitted (so a re-run can refresh evidence) but
 * they do NOT count toward `metrics.inferred` — running the engine repeatedly
 * against the same store will report `inferred: 0` after the first pass.
 */
export async function inferRelations(
  input: InferenceInput,
  options: InferenceOptions = {},
): Promise<InferenceResult> {
  const acc: CandidateAccumulator = { byKey: new Map() };
  const ambiguous: AmbiguousCandidate[] = [];
  const taskById = new Map<string, InferenceTask>();
  for (const t of input.tasks) taskById.set(t.id, t);
  const existingKeys = new Set<string>();
  for (const rel of input.existingRelations) {
    if (rel.lifecycle === 'rejected') continue;
    existingKeys.add(taskRelationKey(rel.sourceTaskId, rel.targetTaskId, rel.type));
  }

  // R1: kookr-spawn task_id= output with a known parent.
  for (const ev of input.spawnEvents) {
    if (!ev.parentTaskId || ev.parentTaskId === ev.taskId) continue;
    pushCandidate(acc, {
      sourceTaskId: ev.taskId,
      targetTaskId: ev.parentTaskId,
      type: 'spawned_by',
      confidence: CONFIDENCE_EXTRACTED,
      source: 'kookr-spawn',
      evidence: [{
        snippet: ev.rawSnippet ?? `kookr-spawn task_id=${ev.taskId}`,
        ...(ev.filePath ? { path: ev.filePath } : {}),
        observedAt: ev.observedAt,
      }],
    });
  }

  // R2: children.json entries map child task ids to a parent run, and the
  // siblings inside a single children.json all share the same chain.
  for (const src of input.playbookChildren) {
    const parentId = src.parentTaskId;
    const siblings: string[] = [];
    for (const entry of src.entries) {
      const childId = entry.task_id?.trim();
      if (!childId) continue;
      siblings.push(childId);
      if (parentId) {
        pushCandidate(acc, {
          sourceTaskId: childId,
          targetTaskId: parentId,
          type: 'spawned_by',
          confidence: CONFIDENCE_EXTRACTED,
          source: 'playbook-state',
          evidence: [{
            snippet: `children.json entry${entry.issue !== undefined ? ` for issue #${entry.issue}` : ''}: task_id=${childId}`,
            path: src.filePath,
            observedAt: src.observedAt,
          }],
        });
      }
    }
    // Sibling co-membership: every pair of children in the same children.json
    // is `same_chain`. Quadratic but bounded by the per-batch fan-out
    // (single-digit in practice); we do NOT emit cross-state.md cliques
    // because state.md files can list dozens of historical task ids.
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        pushCandidate(acc, {
          sourceTaskId: siblings[i],
          targetTaskId: siblings[j],
          type: 'same_chain',
          confidence: CONFIDENCE_PROMPT_STRUCTURED,
          source: 'playbook-state',
          evidence: [{
            snippet: `siblings in children.json${src.runKey ? ` (run ${src.runKey})` : ''}`,
            path: src.filePath,
            observedAt: src.observedAt,
          }],
        });
      }
    }
  }

  // R3: state.md "Prior parent task: <uuid>" → successor_of between parents.
  // We deliberately do NOT scrape every UUID in state.md for co-membership —
  // state.md files in long-running playbooks accumulate task ids from
  // many prior waves and produce O(N²) noise. Sibling membership is recorded
  // via R2 (children.json) instead, where the listing is authoritative.
  for (const ref of input.playbookStates) {
    if (ref.parentTaskId
      && ref.priorParentTaskId
      && ref.parentTaskId !== ref.priorParentTaskId) {
      pushCandidate(acc, {
        sourceTaskId: ref.parentTaskId,
        targetTaskId: ref.priorParentTaskId,
        type: 'successor_of',
        confidence: CONFIDENCE_EXTRACTED,
        source: 'playbook-state',
        evidence: [{
          snippet: `state.md: Prior parent task: ${ref.priorParentTaskId}`,
          path: ref.filePath,
          observedAt: ref.observedAt,
        }],
      });
    }
  }

  await applyPromptRules(input.tasks, taskById, acc, ambiguous, options);

  const floor = options.ambiguityFloor ?? AMBIGUITY_FLOOR;
  const inferredOut: TaskRelationInput[] = [];
  let newCount = 0;
  for (const cand of acc.byKey.values()) {
    if (cand.confidence < floor) {
      ambiguous.push({
        sourceTaskId: cand.sourceTaskId,
        targetTaskId: cand.targetTaskId,
        reason: `confidence ${cand.confidence.toFixed(2)} below ambiguity floor ${floor.toFixed(2)}`,
        evidence: cand.evidence ?? [],
      });
      continue;
    }
    inferredOut.push(cand);
    const key = taskRelationKey(cand.sourceTaskId, cand.targetTaskId, cand.type);
    if (!existingKeys.has(key)) newCount += 1;
  }

  const alreadyLinked = input.tasks.reduce(
    (n, t) => n + (t.parentTaskId !== undefined ? 1 : 0),
    0,
  );

  return {
    inferred: inferredOut,
    ambiguous,
    metrics: {
      totalTasks: input.tasks.length,
      alreadyLinked,
      inferred: newCount,
      ambiguous: ambiguous.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers shared with the CLI. Kept here (not in `bin/`) so the
// regex contracts have tests next to the inference rules they feed.
// ---------------------------------------------------------------------------

const KOOKR_SPAWN_TASK_ID_RE = /task_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PARENT_TASK_HEADER_RE = /^\s*Parent task:\s*`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?/im;
const PRIOR_PARENT_HEADER_RE = /^\s*Prior parent task:\s*`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?/im;
const RUN_KEY_HEADER_RE = /^\s*Run key:\s*`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?/im;

/** Extracts the first `task_id=<uuid>` token from a `kookr-spawn` PostToolUse
 *  response line. Returns null when no uuid is present. */
export function parseKookrSpawnTaskId(text: string): string | null {
  const m = KOOKR_SPAWN_TASK_ID_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Parse a children.json buffer into validated entries. Non-array or malformed
 *  bodies return an empty array — children.json is operator-authored and we
 *  tolerate stale/partial shapes. */
export function parseChildrenJson(raw: string): PlaybookChildEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PlaybookChildEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const entry: PlaybookChildEntry = {};
    if (typeof obj.task_id === 'string') entry.task_id = obj.task_id;
    if (typeof obj.issue === 'number' || typeof obj.issue === 'string') {
      entry.issue = obj.issue as number | string;
    }
    if (entry.task_id || entry.issue !== undefined) out.push(entry);
  }
  return out;
}

/** Parse playbook state.md text to pull out the parent batch task id, the
 *  prior parent (for successor edges), the run key, and every UUID-shaped
 *  task reference. */
export function parseStateMd(text: string): {
  parentTaskId?: string;
  priorParentTaskId?: string;
  runKey?: string;
  referencedTaskIds: string[];
} {
  const parentMatch = PARENT_TASK_HEADER_RE.exec(text);
  const priorMatch = PRIOR_PARENT_HEADER_RE.exec(text);
  const runKeyMatch = RUN_KEY_HEADER_RE.exec(text);
  const seen = new Set<string>();
  for (const m of text.matchAll(UUID_RE)) seen.add(m[0].toLowerCase());
  return {
    ...(parentMatch ? { parentTaskId: parentMatch[1].toLowerCase() } : {}),
    ...(priorMatch ? { priorParentTaskId: priorMatch[1].toLowerCase() } : {}),
    ...(runKeyMatch ? { runKey: runKeyMatch[1].toLowerCase() } : {}),
    referencedTaskIds: Array.from(seen),
  };
}
