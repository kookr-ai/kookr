/**
 * Compact self-continuation envelope (issue #1327).
 *
 * A self-continuation task chain (see the `self-continuation-task` skill) has
 * task N spawn task N+1 at the end of its run. Historically the successor prompt
 * carried a full narrative handoff — repository policy, prior PR details, issue
 * scans, CI behaviour, verification commands, continuation history — re-embedded
 * verbatim in every child. That prose is pure input-context cost: it repeats
 * across a whole chain and drifts out of date the moment the source of truth
 * moves.
 *
 * This module replaces that prose with a bounded, versioned **continuation
 * envelope**: only the *stable* parameters (goal, authorization toggles) plus a
 * durable **cursor** (repo, selector, parent refs, next-unit pointer, source
 * revision). The invariant safety rules live once in the shared skill/playbook,
 * not copied into each successor. At successor start the agent re-derives the
 * *current* GitHub/task state from durable sources via {@link
 * resolveContinuationState}, so a stale cursor self-heals instead of carrying a
 * wrong narrative forward.
 *
 * The module is pure and synchronous except for {@link resolveContinuationState},
 * whose only I/O is an injected {@link StateResolver}. That keeps GitHub / task
 * access at the call site and the selection/recovery logic fully unit-testable.
 */

/** Envelope schema version. Bump when the shape changes incompatibly. */
export const CONTINUATION_ENVELOPE_VERSION = 1;

/** How many remaining unit ids the rendered prompt lists before summarising. */
export const REMAINING_UNITS_RENDER_CAP = 20;

/**
 * Lifecycle status of a candidate unit as seen in durable state at successor
 * start. Only `eligible` units are workable; the rest explain why the cursor may
 * be stale.
 */
export type ContinuationUnitStatus = 'eligible' | 'in-flight' | 'blocked' | 'done';

/** A single candidate unit (issue, queue row, migration step) from durable state. */
export interface ContinuationUnit {
  /** Stable id, e.g. an issue number `#1327` or a queue key. */
  id: string;
  status: ContinuationUnitStatus;
}

/**
 * The durable cursor: everything needed to re-derive the next unit without any
 * prior-task transcript. This is the only part of the envelope that advances
 * between iterations.
 */
export interface ContinuationCursor {
  /** Source-of-truth repository, `owner/name`. */
  repo: string;
  /** Stable selection rule (e.g. a `gh issue list` query) to re-derive units. */
  selector: string;
  /**
   * The unit the predecessor intended the successor to pick up. Advisory only:
   * the successor revalidates it against durable state and recovers if it is no
   * longer eligible.
   */
  nextUnit?: string;
  /** Remaining eligible unit ids as snapshotted at predecessor handoff. */
  remainingUnits?: string[];
  /** Opaque revision of the source of truth (git SHA, checksum, ETag, cursor). */
  sourceRevision?: string;
  /** Mechanical per-unit attempt cap, checked before starting work. */
  attemptCap?: number;
}

/** Durable references to the parent task / PR / issue, for tracing the chain. */
export interface ParentRefs {
  taskId?: string;
  prUrl?: string;
  issue?: string;
}

/**
 * Delivery / authorization toggles that MUST survive continuation exactly. These
 * are copied verbatim into every successor (never re-derived, never defaulted)
 * so a chain cannot silently gain or lose an authorization mid-run. Kept as a
 * plain boolean record so bespoke toggles carry through without a schema change.
 */
export type AuthorizationToggles = Readonly<Record<string, boolean>>;

/** The full versioned continuation envelope handed to a successor task. */
export interface ContinuationEnvelope {
  version: number;
  /** Overall batch goal — stable across the whole chain. */
  goal: string;
  cursor: ContinuationCursor;
  parent: ParentRefs;
  authorization: AuthorizationToggles;
}

/** Snapshot of current durable state, produced by an injected {@link StateResolver}. */
export interface DurableStateSnapshot {
  /** Candidate units in selector order (the resolver decides ordering). */
  units: ContinuationUnit[];
  /**
   * Whether the envelope's parent refs still resolve (task exists, PR/issue
   * reachable). `false` signals missing parent state; omit/`true` when there are
   * no parent refs to check or they all resolved.
   */
  parentResolved?: boolean;
  /** Fresh source revision, if the resolver can supply one. */
  sourceRevision?: string;
}

/**
 * Resolves current durable state for an envelope at successor start. The only
 * I/O boundary in this module — inject a GitHub/task-store-backed implementation
 * at the call site; pass a fixture in tests.
 */
export type StateResolver = (
  envelope: ContinuationEnvelope,
) => DurableStateSnapshot | Promise<DurableStateSnapshot>;

/** Outcome of resolving an envelope against current durable state. */
export interface ResolvedContinuation {
  /** The unit the successor should actually work, or `null` if none remain. */
  selectedUnit: string | null;
  /** Eligible unit ids after revalidation, in resolver order. */
  remainingUnits: string[];
  /**
   * True when the envelope's `nextUnit` pointer was no longer eligible and the
   * selection was recovered from the fresh source of truth.
   */
  cursorWasStale: boolean;
  /**
   * True when the envelope carried parent refs but durable state could not
   * confirm them (`parentResolved === false`). The successor may still proceed —
   * it just cannot trace back to the parent.
   */
  parentMissing: boolean;
  /** Fresh source revision, if the resolver supplied one. */
  sourceRevision?: string;
  /** Human-readable diagnostics for logging / tracing. */
  notes: string[];
}

/** True if the envelope references a parent at all. */
function hasParentRef(parent: ParentRefs): boolean {
  return Boolean(parent.taskId || parent.prUrl || parent.issue);
}

/**
 * Validate and normalise a raw envelope read from durable state (JSON, a prompt
 * front-matter block, an API payload). Throws on a missing/unknown version or a
 * malformed cursor so a corrupt handoff fails loudly instead of silently
 * selecting the wrong unit.
 */
export function parseContinuationEnvelope(raw: unknown): ContinuationEnvelope {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('continuation envelope must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CONTINUATION_ENVELOPE_VERSION) {
    throw new Error(
      `unsupported continuation envelope version ${String(obj.version)} (expected ${CONTINUATION_ENVELOPE_VERSION})`,
    );
  }
  if (typeof obj.goal !== 'string' || obj.goal.trim() === '') {
    throw new Error('continuation envelope requires a non-empty goal');
  }
  const cursorRaw = obj.cursor;
  if (typeof cursorRaw !== 'object' || cursorRaw === null) {
    throw new Error('continuation envelope requires a cursor object');
  }
  const cursorObj = cursorRaw as Record<string, unknown>;
  if (typeof cursorObj.repo !== 'string' || cursorObj.repo.trim() === '') {
    throw new Error('continuation cursor requires a repo');
  }
  if (typeof cursorObj.selector !== 'string' || cursorObj.selector.trim() === '') {
    throw new Error('continuation cursor requires a selector');
  }

  const cursor: ContinuationCursor = {
    repo: cursorObj.repo,
    selector: cursorObj.selector,
  };
  if (typeof cursorObj.nextUnit === 'string') cursor.nextUnit = cursorObj.nextUnit;
  if (Array.isArray(cursorObj.remainingUnits)) {
    cursor.remainingUnits = cursorObj.remainingUnits.filter((u): u is string => typeof u === 'string');
  }
  if (typeof cursorObj.sourceRevision === 'string') cursor.sourceRevision = cursorObj.sourceRevision;
  if (typeof cursorObj.attemptCap === 'number' && Number.isFinite(cursorObj.attemptCap)) {
    cursor.attemptCap = cursorObj.attemptCap;
  }

  const parent: ParentRefs = {};
  const parentRaw = (obj.parent ?? {}) as Record<string, unknown>;
  if (typeof parentRaw.taskId === 'string') parent.taskId = parentRaw.taskId;
  if (typeof parentRaw.prUrl === 'string') parent.prUrl = parentRaw.prUrl;
  if (typeof parentRaw.issue === 'string') parent.issue = parentRaw.issue;

  const authorization: Record<string, boolean> = {};
  const authRaw = (obj.authorization ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(authRaw)) {
    if (typeof value === 'boolean') authorization[key] = value;
  }

  return {
    version: CONTINUATION_ENVELOPE_VERSION,
    goal: obj.goal,
    cursor,
    parent,
    authorization,
  };
}

/**
 * Resolve an envelope against current durable state at successor start.
 *
 * Selection order:
 *   1. If `cursor.nextUnit` is still eligible → work it (cursor fresh).
 *   2. If `cursor.nextUnit` was set but is no longer eligible (done, in-flight,
 *      blocked, or vanished) → recover: work the first eligible unit and flag
 *      the cursor stale.
 *   3. If no `nextUnit` was set → work the first eligible unit.
 *   4. If nothing is eligible → `selectedUnit` is `null` (chain end).
 */
export async function resolveContinuationState(
  envelope: ContinuationEnvelope,
  resolver: StateResolver,
): Promise<ResolvedContinuation> {
  const snapshot = await resolver(envelope);
  const notes: string[] = [];

  const eligible = snapshot.units.filter((u) => u.status === 'eligible').map((u) => u.id);
  const pointer = envelope.cursor.nextUnit;

  let selectedUnit: string | null;
  let cursorWasStale = false;

  if (pointer && eligible.includes(pointer)) {
    selectedUnit = pointer;
  } else if (pointer) {
    cursorWasStale = true;
    selectedUnit = eligible[0] ?? null;
    const priorStatus = snapshot.units.find((u) => u.id === pointer)?.status ?? 'absent';
    notes.push(
      selectedUnit === null
        ? `cursor unit ${pointer} is ${priorStatus} and no eligible unit remains — chain complete`
        : `cursor unit ${pointer} is ${priorStatus}; recovered to ${selectedUnit} from fresh source of truth`,
    );
  } else {
    selectedUnit = eligible[0] ?? null;
    if (selectedUnit === null) notes.push('no eligible unit remains — chain complete');
  }

  const parentMissing = hasParentRef(envelope.parent) && snapshot.parentResolved === false;
  if (parentMissing) {
    notes.push('parent task/PR/issue no longer resolves from durable state; proceeding without parent trace');
  }

  const resolved: ResolvedContinuation = {
    selectedUnit,
    remainingUnits: eligible,
    cursorWasStale,
    parentMissing,
    notes,
  };
  if (snapshot.sourceRevision !== undefined) resolved.sourceRevision = snapshot.sourceRevision;
  return resolved;
}

/**
 * Build the successor envelope for the *next* iteration from the current
 * envelope and a freshly-resolved state (taken *after* the current unit was
 * completed, so `resolved.selectedUnit` is the next unit to work).
 *
 * Authorization toggles are copied **verbatim** — never re-derived — so delivery
 * and safety toggles survive continuation exactly. `parent` may be overridden to
 * point at the task doing the spawning; otherwise the current parent is carried.
 */
export function advanceEnvelope(
  current: ContinuationEnvelope,
  resolved: ResolvedContinuation,
  parent?: ParentRefs,
): ContinuationEnvelope {
  const cursor: ContinuationCursor = {
    repo: current.cursor.repo,
    selector: current.cursor.selector,
  };
  if (resolved.selectedUnit !== null) cursor.nextUnit = resolved.selectedUnit;
  cursor.remainingUnits = [...resolved.remainingUnits];
  if (resolved.sourceRevision !== undefined) cursor.sourceRevision = resolved.sourceRevision;
  if (current.cursor.attemptCap !== undefined) cursor.attemptCap = current.cursor.attemptCap;

  return {
    version: CONTINUATION_ENVELOPE_VERSION,
    goal: current.goal,
    cursor,
    parent: parent ? { ...parent } : { ...current.parent },
    // Exact carry-over: authorization is a durable grant, not a derived value.
    authorization: { ...current.authorization },
  };
}

/**
 * Deterministic dedup key for an envelope's cursor. Kookr collapses task
 * launches whose prompt content matches an already-known task; this key is the
 * content-distinct signal that keeps successive iterations from being
 * deduplicated into one task.
 *
 * The key folds in every cursor dimension — repo, selector, `nextUnit`, source
 * revision, and remaining units — so it changes when *any* of them moves, not
 * only when `nextUnit` does. A changed `nextUnit` always changes the key; a
 * moved `sourceRevision`/`remainingUnits` with the same `nextUnit` also changes
 * it (e.g. a retried unit after the source of truth shifted). The unit-level
 * "don't rework the same unit" guarantee is the skill's `attemptCap`, not this
 * key; this key only guarantees two content-identical cursors never spawn twice.
 */
export function continuationCursorKey(envelope: ContinuationEnvelope): string {
  const c = envelope.cursor;
  return [
    `v${envelope.version}`,
    `repo=${c.repo}`,
    `sel=${c.selector}`,
    `next=${c.nextUnit ?? ''}`,
    `rev=${c.sourceRevision ?? ''}`,
    `rem=${(c.remainingUnits ?? []).join(',')}`,
  ].join('|');
}

/**
 * True when two envelopes would spawn content-distinct tasks. A predecessor MUST
 * NOT spawn a successor for which this returns `false`: an identical cursor means
 * the source of truth did not advance and the launch would be deduplicated.
 */
export function areContinuationsDistinct(a: ContinuationEnvelope, b: ContinuationEnvelope): boolean {
  return continuationCursorKey(a) !== continuationCursorKey(b);
}

/**
 * Render the compact successor prompt. Bounded by construction: the remaining
 * units list is capped and the invariant safety rules are *referenced*, not
 * inlined. This is the replacement for the verbose narrative handoff.
 */
export function renderContinuationPrompt(envelope: ContinuationEnvelope): string {
  const c = envelope.cursor;
  const lines: string[] = [];

  lines.push(`You are continuing a sequential Kookr task chain (continuation envelope v${envelope.version}).`);
  lines.push('');
  lines.push(`Goal: ${envelope.goal}`);
  lines.push('');
  lines.push('Follow the self-continuation-task skill for all invariant rules');
  lines.push('(fresh worktree, one unit only, durable-state selection, record-before-spawn,');
  lines.push('completion signal, end-of-chain sweep). Do not re-derive them here.');
  lines.push('');
  lines.push('Cursor:');
  lines.push(`- repo: ${c.repo}`);
  lines.push(`- selector: ${c.selector}`);
  if (c.nextUnit) lines.push(`- next unit: ${c.nextUnit}`);
  if (c.remainingUnits && c.remainingUnits.length > 0) {
    const shown = c.remainingUnits.slice(0, REMAINING_UNITS_RENDER_CAP);
    const extra = c.remainingUnits.length - shown.length;
    lines.push(`- remaining eligible: ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  }
  if (c.sourceRevision) lines.push(`- source revision: ${c.sourceRevision}`);
  if (c.attemptCap !== undefined) lines.push(`- attempt cap: ${c.attemptCap}`);

  const parentBits: string[] = [];
  if (envelope.parent.taskId) parentBits.push(`task ${envelope.parent.taskId}`);
  if (envelope.parent.prUrl) parentBits.push(`PR ${envelope.parent.prUrl}`);
  if (envelope.parent.issue) parentBits.push(`issue ${envelope.parent.issue}`);
  if (parentBits.length > 0) {
    lines.push('');
    lines.push(`Parent: ${parentBits.join(', ')}`);
  }

  const authKeys = Object.keys(envelope.authorization).sort();
  if (authKeys.length > 0) {
    lines.push('');
    lines.push('Authorization (preserve exactly in any successor):');
    for (const key of authKeys) lines.push(`- ${key}: ${envelope.authorization[key]}`);
  }

  lines.push('');
  lines.push('Revalidate the cursor against durable state before acting; if the next unit is');
  lines.push('no longer eligible, recover the next eligible unit from the selector.');

  return lines.join('\n') + '\n';
}
