#!/usr/bin/env node
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type ChildRecord,
  deliverUnit,
  readChildren,
  seedChildren,
} from './delivery-ownership-rehearsal';

// Executable rehearsal + doc-guard for issue #1571: the parent-implementer
// fallback in the parallel-issue-batch playbook.
//
// On 2026-07-26, server overload broke child spawning for batch dd1fbcec
// (spawn timeout / 500 under CPU spin; tasks created then lost/pruned before a
// session). The parent fell back to implementing units itself with in-session
// implementer subagents — an improvised path the playbook did not document.
// That fallback bypassed the batch's Phase 4 idempotency accounting: units
// were left marked "parent implementer" with `task_id: null` and NO recorded
// delivery owner, which fed the duplicate-PR incident.
//
// This module models the fix as real, testable code so the playbook prose is
// backed by a runnable protocol. It deliberately REUSES the single-writer
// delivery-ownership primitives from #1570 (`claimDelivery`/`deliverUnit`)
// rather than re-implementing them: the fallback is a bookkeeping wrapper that
// takes over delivery as the `parent` owner, not a second delivery mechanism.
//
// Invariants it enforces:
//
//   FB-1 trigger-bookkeeping  a spawn failure (timeout / 500 / task-lost) moves
//                             the unit through an auditable status trail before
//                             the parent implements it.
//   FB-2 owned-delivery       the parent takes over delivery only after claiming
//                             single-writer `delivery` ownership (owner:parent).
//   FB-3 no-orphan-delivery   NO delivered unit may have `task_id: null` AND a
//                             null `delivery` owner (the 2026-07-26 orphan state).
//   FB-4 trailed-delivery     every delivered unit carries a non-empty status
//                             transition trail.
//   FB-5 merge-sweep          fallback-delivered units (task_id: null, owned by
//                             parent) are picked up by the merge sweep by their
//                             delivery owner, not by a child task id.
//   FB-6 doc-presence         the playbook documents the fallback section:
//                             triggers, bookkeeping, transitions, merge-sweep.

export const PLAYBOOK_REL = 'plugin/playbooks/parallel-issue-batch.md';

/** One entry in a unit's status transition trail. */
export interface StatusTransition {
  status: string;
  at: string;
  note?: string;
}

/** A children.json unit record extended with the fallback bookkeeping fields. */
export interface FallbackRecord extends ChildRecord {
  /** Ordered audit trail of status transitions this unit moved through. */
  status_trail?: StatusTransition[];
  /** True once a delivery actor recorded a PR attempt for this unit. */
  delivered?: boolean;
}

/** The spawn-failure conditions that trigger the parent-implementer fallback. */
export type SpawnFailureReason = 'spawn-timeout' | 'spawn-http-500' | 'task-lost-before-session';

export const SPAWN_FAILURE_REASONS: readonly SpawnFailureReason[] = [
  'spawn-timeout',
  'spawn-http-500',
  'task-lost-before-session',
];

export interface SpawnResult {
  ok: boolean;
  taskId: string | null;
  reason?: SpawnFailureReason;
}

/**
 * Stand in for `kookr-spawn`. A successful spawn yields a task id; a failure
 * yields one of the documented trigger reasons and NO task id — which is
 * exactly the state that must never be delivered without bookkeeping.
 */
export function simulateSpawn(outcome: SpawnFailureReason | { taskId: string }): SpawnResult {
  if (typeof outcome === 'object') return { ok: true, taskId: outcome.taskId };
  return { ok: false, taskId: null, reason: outcome };
}

function childrenFile(stateDir: string): string {
  return join(stateDir, 'children.json');
}

/** Write children.json durably: temp file -> fsync -> atomic rename. */
function writeChildrenDurable(stateDir: string, records: FallbackRecord[]): void {
  const dest = childrenFile(stateDir);
  const tmp = `${dest}.tmp`;
  const body = `${JSON.stringify(records, null, 2)}\n`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
}

/**
 * Record a status transition on a unit (FB-1). Appends to the unit's
 * `status_trail` and updates `status`, then persists durably. The trail is the
 * audit evidence that a fallback-delivered unit went through bookkeeping rather
 * than being delivered out of band.
 */
export function transitionStatus(
  stateDir: string,
  unitId: string,
  to: string,
  at: string,
  note?: string,
): StatusTransition[] {
  const records = readChildren(stateDir) as FallbackRecord[];
  const rec = records.find((r) => r.unit_id === unitId);
  if (!rec) throw new Error(`no children.json record for unit ${unitId}`);
  rec.status = to;
  rec.status_trail = rec.status_trail ?? [];
  rec.status_trail.push({ status: to, at, ...(note ? { note } : {}) });
  writeChildrenDurable(stateDir, records);
  return rec.status_trail;
}

function markDelivered(stateDir: string, unitId: string, pr: string): void {
  const records = readChildren(stateDir) as FallbackRecord[];
  const rec = records.find((r) => r.unit_id === unitId);
  if (!rec) throw new Error(`no children.json record for unit ${unitId}`);
  rec.delivered = true;
  rec.pr = pr;
  writeChildrenDurable(stateDir, records);
}

export interface FallbackOutcome {
  unitId: string;
  triggeredBy: SpawnFailureReason;
  delivered: boolean;
  deliveryOwner: string | null;
  pr: string | null;
  statusTrail: StatusTransition[];
  /** Present when the parent unexpectedly could not take delivery. */
  standDownLine?: string;
}

/**
 * Run the full parent-implementer fallback for one unit, exactly as the
 * playbook prescribes:
 *
 *   1. spawn fails (timeout / 500 / task-lost)         -> status: spawn-failed
 *   2. parent decides to take over                     -> status: parent-takeover
 *   3. parent claims single-writer delivery ownership  (reuse #1570 deliverUnit)
 *   4. parent implements + delivers                    -> status: delivering
 *   5. PR recorded, ownership durable                  -> status: delivered
 *
 * `stamps` supplies deterministic ISO timestamps for each transition (index 0
 * = spawn-failed, 1 = parent-takeover, 2 = delivering/claim, 3 = delivered).
 * The last stamp is reused if fewer are supplied.
 */
export function runParentImplementerFallback(
  stateDir: string,
  unitId: string,
  failure: SpawnFailureReason,
  stamps: string[],
): FallbackOutcome {
  const at = (i: number): string => stamps[Math.min(i, stamps.length - 1)] ?? '1970-01-01T00:00:00Z';

  // 1. The spawn attempt fails — this is the whole trigger.
  const spawn = simulateSpawn(failure);
  if (spawn.ok) {
    throw new Error('runParentImplementerFallback called for a spawn that did not fail');
  }
  transitionStatus(stateDir, unitId, 'spawn-failed', at(0), `spawn failed: ${failure}`);

  // 2. Parent takes over rather than leaving the unit stranded.
  transitionStatus(stateDir, unitId, 'parent-takeover', at(1), `fallback trigger: ${failure}`);

  // 3+4. Deliver as the `parent` owner. deliverUnit (from #1570) claims
  // single-writer delivery ownership, enforces read-before-push, and records
  // exactly one PR attempt — the fallback reuses it instead of inventing a
  // second delivery path (FB-2).
  transitionStatus(stateDir, unitId, 'delivering', at(2));
  const outcome = deliverUnit(stateDir, unitId, 'parent', at(2));
  if (!outcome.delivered) {
    // Another actor already owns delivery — the parent stands down instead of
    // double-delivering. This should not happen for a spawn-failed unit, but
    // the fallback must never override the single-writer gate.
    return {
      unitId,
      triggeredBy: failure,
      delivered: false,
      deliveryOwner: null,
      pr: null,
      statusTrail: (readChildren(stateDir).find((r) => r.unit_id === unitId) as FallbackRecord)?.status_trail ?? [],
      standDownLine: outcome.standDownLine,
    };
  }

  // 5. Record the PR and close the trail.
  const pr = `https://example.invalid/pr/${unitId}`;
  markDelivered(stateDir, unitId, pr);
  const statusTrail = transitionStatus(stateDir, unitId, 'delivered', at(3));

  const rec = readChildren(stateDir).find((r) => r.unit_id === unitId) as FallbackRecord;
  return {
    unitId,
    triggeredBy: failure,
    delivered: true,
    deliveryOwner: rec.delivery?.owner ?? null,
    pr,
    statusTrail,
  };
}

/**
 * The merge sweep over the batch's children.json (FB-5). A fallback-delivered
 * unit has `task_id: null` — it was never spawned — so the sweep must match it
 * by its `delivery` owner, not by a child task id, or it silently drops the
 * unit. Marks every delivered, owned, not-yet-merged unit as merged and trails
 * the transition.
 */
export function mergeSweep(stateDir: string, at: string): FallbackRecord[] {
  const records = readChildren(stateDir) as FallbackRecord[];
  for (const rec of records) {
    if (rec.delivered && rec.delivery && !rec.merged) {
      rec.merged = true;
      rec.status = 'merged';
      rec.status_trail = rec.status_trail ?? [];
      rec.status_trail.push({ status: 'merged', at });
    }
  }
  writeChildrenDurable(stateDir, records);
  return records;
}

export interface AccountingViolation {
  unit_id: string;
  reason: string;
}

/**
 * Phase 4 idempotency accounting audit (FB-3 + FB-4). Every delivered unit
 * must:
 *   - NOT be an orphan: `task_id: null` AND `delivery == null` is forbidden —
 *     that is the exact 2026-07-26 state that produced duplicate PRs, and
 *   - carry a non-empty status transition trail.
 * Returns every violation (empty array = consistent state).
 */
export function auditFallbackAccounting(records: FallbackRecord[]): AccountingViolation[] {
  const violations: AccountingViolation[] = [];
  for (const rec of records) {
    if (!rec.delivered) continue;
    if (rec.task_id == null && rec.delivery == null) {
      violations.push({
        unit_id: rec.unit_id,
        reason: 'delivered unit has task_id: null AND no recorded delivery owner',
      });
    }
    if (!rec.status_trail || rec.status_trail.length === 0) {
      violations.push({
        unit_id: rec.unit_id,
        reason: 'delivered unit has no status transition trail',
      });
    }
  }
  return violations;
}

export interface RehearsalResult {
  outcomes: FallbackOutcome[];
  records: FallbackRecord[];
  violations: AccountingViolation[];
}

/**
 * End-to-end rehearsal (AC #1571): seed a batch of un-spawned units, drive each
 * one through the fallback (a different trigger reason per unit), run the merge
 * sweep, and audit idempotency accounting. State is asserted consistent at each
 * step by the accompanying test; this function returns the final artifacts.
 */
export function rehearseFallback(stateDir: string): RehearsalResult {
  const units = ['u-1656', 'u-1659', 'u-1660'];
  const records: FallbackRecord[] = units.map((unit_id, i) => ({
    unit_id,
    issue: 1656 + i,
    issues: [1656 + i],
    task_id: null,
    status: 'spawned',
    pr: null,
    merged: false,
    blocker: null,
    delivery: null,
    status_trail: [{ status: 'spawned', at: '2026-07-26T09:00:00Z' }],
  }));
  seedChildren(stateDir, records);

  const outcomes = units.map((unitId, i) =>
    runParentImplementerFallback(stateDir, unitId, SPAWN_FAILURE_REASONS[i % SPAWN_FAILURE_REASONS.length], [
      `2026-07-26T10:0${i}:00Z`,
      `2026-07-26T10:1${i}:00Z`,
      `2026-07-26T10:2${i}:00Z`,
      `2026-07-26T10:3${i}:00Z`,
    ]),
  );

  const swept = mergeSweep(stateDir, '2026-07-26T11:00:00Z');
  const violations = auditFallbackAccounting(swept);
  return { outcomes, records: swept, violations };
}

// ---------------------------------------------------------------------------
// Doc-guard (FB-6): the playbook prose must keep documenting the fallback.
// Modelled on scripts/delivery-ownership-rehearsal.ts — guidance rots silently,
// so CI fails the push if the fallback contract disappears from the playbook.
// ---------------------------------------------------------------------------

export const REQUIRED_FALLBACK_DOC_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'Parent-implementer fallback section heading', regex: /Parent-implementer fallback/i },
  { label: 'spawn timeout / 500 / task-lost triggers', regex: /timeout.*500|500.*timeout|lost before (its |the )?session/i },
  { label: 'status transition trail bookkeeping', regex: /status[- ]transition trail|status_trail/i },
  { label: 'parent takes over delivery as owner `parent`', regex: /`parent`/ },
  { label: 'forbid delivery outside the fallback bookkeeping', regex: /outside (this|the fallback) bookkeeping/i },
  { label: 'merge-sweep participation for task_id: null units', regex: /merge sweep/i },
];

export interface DocGuardResult {
  root: string;
  errors: { file: string; message: string }[];
}

export function validateFallbackDocs(repoRoot: string = process.cwd()): DocGuardResult {
  const errors: { file: string; message: string }[] = [];
  const file = join(repoRoot, PLAYBOOK_REL);
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return {
      root: repoRoot,
      errors: [{ file: PLAYBOOK_REL, message: 'file not found — the parent-implementer fallback must live here' }],
    };
  }
  for (const { label, regex } of REQUIRED_FALLBACK_DOC_PATTERNS) {
    if (!regex.test(content)) {
      errors.push({
        file: PLAYBOOK_REL,
        message: `missing the ${label} (expected to match ${regex}). The parent-implementer fallback contract must stay documented — see issue #1571.`,
      });
    }
  }
  return { root: repoRoot, errors };
}

// ---------------------------------------------------------------------------
// CLI. Two modes:
//   validate <repoRoot?>   -> doc-guard, exit 0/1/2
//   rehearse <stateDir>    -> run the end-to-end fallback rehearsal, exit 0/1
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  const [mode, ...rest] = argv;

  if (mode === 'rehearse') {
    const [stateDir] = rest;
    if (!stateDir) {
      console.error('usage: parent-implementer-fallback-rehearsal.ts rehearse <stateDir>');
      return 2;
    }
    const { outcomes, violations } = rehearseFallback(stateDir);
    console.log(JSON.stringify({ outcomes, violations }, null, 2));
    if (violations.length > 0) {
      console.error('parent-implementer fallback accounting violations:');
      for (const v of violations) console.error(`  ${v.unit_id}: ${v.reason}`);
      return 1;
    }
    return 0;
  }

  // Default: validate.
  const args = mode === 'validate' ? rest : argv;
  const unknownFlags = args.filter((a) => a.startsWith('--'));
  if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    return 2;
  }
  const repoRoot = args[0] ?? process.cwd();
  const { errors } = validateFallbackDocs(repoRoot);
  if (errors.length > 0) {
    console.error('parent-implementer fallback doc validation failed:');
    for (const error of errors) {
      console.error(`  ${relative(repoRoot, join(repoRoot, error.file))}: ${error.message}`);
    }
    return 1;
  }
  console.log('parent-implementer fallback doc validation passed.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
