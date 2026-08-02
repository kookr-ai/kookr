#!/usr/bin/env node
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Executable rehearsal + doc-guard for issue #1570: single-writer delivery
// ownership in children.json before a parent (or any second actor) takes over
// delivery of a work unit.
//
// Batch task dd1fbcec (2026-07-26) shipped the same three units twice: the
// parent's fast-track merge sweep delivered u-1656/u-1659/u-1660, then a second
// in-session actor re-ran `gh pr create` on the same branches minutes later.
// `children.json` recorded the units as "parent implementer" with
// `task_id: null` — there was no durable record of who owns delivery for a
// unit, so nothing forced the second actor to stand down. #1230's task-scoped
// auto-claim would not have helped: both actors belonged to the same task.
//
// Convergence (issue #1904): delivery ownership is now decided **solely by the
// issue-claim lease** (#1711) — the single dedup source. The server holds that
// lease as an in-memory synchronous CAS keyed by (repo, issue), durably projected
// onto Task.issueClaim and rebuilt on restart. The playbook no longer maintains a
// separate `<unit_id>.delivery.lock` file; the `delivery` field is a **thin shim**
// mirroring the lease holder for audit + the same-task read-before-push check.
// This rehearsal models that single-writer lease locally with an O_EXCL claim
// file (the cross-process atomic primitive available to a test), which stands in
// for the server's in-memory lease CAS: exactly one actor wins, everyone else
// stands down — the property the lease guarantees in production.
//
// This module models the protocol as real, testable code so the playbook prose is
// backed by a runnable contract instead of hand-waving. The invariants it
// enforces (see the PR body) are:
//
//   INV-1 single-writer   at most one actor may own delivery for a unit; a
//                         concurrent claim resolves to exactly one winner.
//   INV-2 read-before-push a non-owner that re-reads children.json immediately
//                         before push/PR stands down with an explicit log line
//                         and opens no PR.
//   INV-3 write-ordering   the delivery ownership record lands durably in
//                         children.json BEFORE any `git push` / `gh pr create`
//                         for the unit.
//   INV-4 completeness     every delivered unit carries a non-null delivery
//                         owner + timestamp.
//   INV-5 doc-presence     the playbook documents the field, the
//                         read-before-push rule, and the write ordering.

export const PLAYBOOK_REL = 'plugin/playbooks/parallel-issue-batch.md';

/** A durable single-writer delivery-ownership record on a children.json unit. */
export interface Delivery {
  /** `parent` or the child task id that owns delivery of this unit. */
  owner: string;
  /** ISO-8601 timestamp when ownership was claimed. */
  at: string;
}

/** The children.json per-unit record (subset relevant to delivery ownership). */
export interface ChildRecord {
  unit_id: string;
  issue?: number;
  issues?: number[];
  task_id: string | null;
  status?: string;
  pr?: string | null;
  merged?: boolean;
  blocker?: string | null;
  /** Single-writer delivery owner; null until an actor claims delivery. */
  delivery?: Delivery | null;
}

/** The exact stand-down line a non-owner must emit (AC-2). */
export function standDownLog(owner: string, at: string): string {
  return `delivery owned by ${owner} since ${at}; standing down`;
}

function childrenFile(stateDir: string): string {
  return join(stateDir, 'children.json');
}

// Local stand-in for the issue-claim lease's single-writer gate (#1711/#1904).
// The server does this atomically in memory; a cross-process test needs a file
// primitive, so we model the lease as an O_EXCL claim file. It is NOT the removed
// `<unit_id>.delivery.lock` — it is a test-only rendering of the lease CAS.
export function leaseFile(stateDir: string, unitId: string): string {
  return join(stateDir, `${unitId}.claim.lease`);
}

/**
 * Model a server restart across a batch (AC #1904 restart-dedup). Mirrors the
 * server's boot sequence: the in-memory lease CAS is lost, then the durable
 * claim projection is rebuilt from tasks. Concretely:
 *
 *   1. drop every in-memory lease (delete the `*.claim.lease` files); and
 *   2. replay the durable `delivery` projection out of children.json to
 *      re-establish the lease — but ONLY for owners in `liveOwners`. A terminated
 *      owner's claim auto-released on death (`dead_reclaim`), so `rebuildFromTasks`
 *      ignores it and its lease stays free.
 *
 * The durable children.json record is what survives the restart, so a re-run by
 * any other actor stands down against the rebuilt lease — no duplicate PR. If the
 * owner terminated, the lease is free and the parent may reclaim it cleanly
 * (the residual restart dedup is then the pre-`gh pr create` duplicate-guard,
 * #1569, which is a live-GitHub check outside this local model).
 */
export function simulateRestart(stateDir: string, liveOwners: string[]): void {
  for (const entry of readdirSync(stateDir)) {
    if (entry.endsWith('.claim.lease')) unlinkSync(join(stateDir, entry));
  }
  for (const rec of readChildren(stateDir)) {
    const delivery = rec.delivery ?? null;
    if (!delivery || !liveOwners.includes(delivery.owner)) continue;
    const fd = openSync(leaseFile(stateDir, rec.unit_id), 'wx');
    try {
      writeSync(fd, `${JSON.stringify(delivery)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function readChildren(stateDir: string): ChildRecord[] {
  const raw = readFileSync(childrenFile(stateDir), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('children.json must be a JSON array');
  return parsed as ChildRecord[];
}

/** Write children.json durably: temp file -> fsync -> atomic rename. */
function writeChildrenDurable(stateDir: string, records: ChildRecord[]): void {
  const dest = childrenFile(stateDir);
  const tmp = `${dest}.tmp`;
  const body = `${JSON.stringify(records, null, 2)}\n`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd); // INV-3: bytes hit disk before the record becomes visible.
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest); // atomic replace; readers see all-or-nothing.
}

export interface ClaimResult {
  won: boolean;
  delivery: Delivery;
}

/**
 * Attempt to claim the issue-claim lease for `unitId` on behalf of `actor`, then
 * record delivery ownership as the thin `delivery` shim over it.
 *
 * The single-writer gate is modelled with an O_EXCL claim file
 * (`openSync(path, 'wx')`): the kernel lets exactly one caller create it, so
 * exactly one actor can ever win a unit (INV-1) — the local rendering of the
 * server's in-memory lease CAS (#1711/#1904). The winner then records `delivery`
 * on the unit in children.json durably. The loser reads the winner's identity out
 * of the lease file and returns `won: false` so the caller can stand down.
 *
 * Restart is modelled by `simulateRestart`, which mirrors the server's
 * `rebuildFromTasks`: the in-memory CAS (the lease file) is lost, then the
 * durable `delivery` projection is replayed to re-establish the lease — but only
 * for **non-terminal** owners, because a terminated owner's claim auto-releases
 * (`dead_reclaim`). That is what dedups a re-run across a restart boundary.
 */
export function claimDelivery(
  stateDir: string,
  unitId: string,
  actor: string,
  nowIso: string,
): ClaimResult {
  const lock = leaseFile(stateDir, unitId);
  let fd: number;
  try {
    fd = openSync(lock, 'wx'); // atomic create-if-absent — the single-writer gate.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lock already held. Idempotent re-entry: if WE already own it, that is a
      // win (an actor may re-run the claim before its own push). Anyone else
      // owning it is a genuine loss and must stand down.
      const held = readLockIdentity(lock);
      return { won: held.owner === actor, delivery: held };
    }
    throw err;
  }

  const delivery: Delivery = { owner: actor, at: nowIso };
  try {
    // Stamp the winner's identity into the lock atomically-enough that a racing
    // loser can read who won. fsync so a crash can't leave an anonymous lock.
    writeSync(fd, `${JSON.stringify(delivery)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // INV-3: persist ownership on the unit BEFORE the caller may push/PR.
  const records = readChildren(stateDir);
  const rec = records.find((r) => r.unit_id === unitId);
  if (!rec) throw new Error(`no children.json record for unit ${unitId}`);
  rec.delivery = delivery;
  writeChildrenDurable(stateDir, records);

  return { won: true, delivery };
}

/** Read the winner's {owner, at} out of a held lock file, tolerating the tiny
 * window between O_EXCL create and the identity write. */
function readLockIdentity(lock: string): Delivery {
  for (let attempt = 0; attempt < 50; attempt++) {
    let raw = '';
    try {
      raw = readFileSync(lock, 'utf8').trim();
    } catch {
      raw = '';
    }
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as Delivery;
        if (parsed && typeof parsed.owner === 'string' && typeof parsed.at === 'string') {
          return parsed;
        }
      } catch {
        // fall through to retry
      }
    }
    // Busy-wait a hair; the winner writes identity microseconds after create.
    const until = Date.now() + 1;
    while (Date.now() < until) {
      /* spin */
    }
  }
  // Lock is held but identity never materialized — still a loss, unknown owner.
  return { owner: 'unknown', at: 'unknown' };
}

/**
 * Confirm on-disk ownership immediately before push/PR (INV-2 + INV-3).
 *
 * Re-reads children.json fresh — never trusts an in-memory claim — and throws
 * if `actor` does not own the unit's delivery record. Callers invoke this as
 * the last gate before `git push` / `gh pr create`; if it throws, no PR is
 * opened. This is the executable form of the read-before-push rule.
 */
export function assertOwnershipBeforePush(stateDir: string, unitId: string, actor: string): Delivery {
  const rec = readChildren(stateDir).find((r) => r.unit_id === unitId);
  const delivery = rec?.delivery ?? null;
  if (!delivery || delivery.owner !== actor) {
    throw new Error(
      delivery
        ? standDownLog(delivery.owner, delivery.at)
        : `no delivery owner recorded for unit ${unitId}; standing down`,
    );
  }
  return delivery;
}

export interface DeliverOutcome {
  actor: string;
  unitId: string;
  delivered: boolean;
  /** Present when the actor stood down. */
  standDownLine?: string;
}

/**
 * Full delivery protocol one actor runs for one unit. Returns whether it
 * delivered (recorded a PR attempt) or stood down. Never throws for a normal
 * loss — a stand-down is an expected outcome, not an error.
 *
 * Ordering, exactly as the playbook prescribes:
 *   1. claim delivery (single-writer gate)
 *   2. read-before-push: re-read children.json and confirm ownership
 *   3. only then record the PR attempt
 */
export function deliverUnit(
  stateDir: string,
  unitId: string,
  actor: string,
  nowIso: string,
): DeliverOutcome {
  const claim = claimDelivery(stateDir, unitId, actor, nowIso);
  if (!claim.won) {
    const line = standDownLog(claim.delivery.owner, claim.delivery.at);
    appendLine(join(stateDir, 'delivery.log'), `[${actor}] ${line}`);
    return { actor, unitId, delivered: false, standDownLine: line };
  }

  // Read-before-push gate: throws (and thus opens no PR) if we somehow lost
  // ownership between the claim and here. For the winner this passes.
  try {
    assertOwnershipBeforePush(stateDir, unitId, actor);
  } catch (err) {
    const line = (err as Error).message;
    appendLine(join(stateDir, 'delivery.log'), `[${actor}] ${line}`);
    return { actor, unitId, delivered: false, standDownLine: line };
  }

  // Delivery: stand in for `git push` / `gh pr create`. One line == one PR
  // attempt, so the test can assert exactly one attempt per unit.
  appendLine(join(stateDir, 'pr-attempts.log'), `[${actor}] gh pr create ${unitId}`);
  appendLine(join(stateDir, 'delivery.log'), `[${actor}] delivered ${unitId} (owner)`);
  return { actor, unitId, delivered: true };
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Doc-guard (INV-5): the playbook prose must keep documenting the contract.
// Modelled on scripts/validate-rerun-bound.ts — guidance text silently rots,
// so CI fails the push if the delivery-ownership contract disappears from the
// playbook.
// ---------------------------------------------------------------------------

export const REQUIRED_DOC_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: '`delivery` field name', regex: /`delivery`/ },
  { label: 'delivery owner values (parent / task id)', regex: /owner/i },
  { label: 'read-before-push rule', regex: /read[- ]before[- ]push/i },
  { label: 'stand-down log line', regex: /standing down/i },
  { label: 'write-ordering before push/PR', regex: /before any .*(git push|gh pr create|push)/i },
];

export interface DocGuardResult {
  root: string;
  errors: { file: string; message: string }[];
}

export function validateDeliveryDocs(repoRoot: string = process.cwd()): DocGuardResult {
  const errors: { file: string; message: string }[] = [];
  const file = join(repoRoot, PLAYBOOK_REL);
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return {
      root: repoRoot,
      errors: [{ file: PLAYBOOK_REL, message: 'file not found — the delivery-ownership contract must live here' }],
    };
  }
  for (const { label, regex } of REQUIRED_DOC_PATTERNS) {
    if (!regex.test(content)) {
      errors.push({
        file: PLAYBOOK_REL,
        message: `missing the ${label} (expected to match ${regex}). The single-writer delivery-ownership contract must stay documented — see issue #1570.`,
      });
    }
  }
  return { root: repoRoot, errors };
}

// ---------------------------------------------------------------------------
// CLI. Two modes:
//   validate <repoRoot?>                    -> doc-guard, exit 0/1/2
//   deliver  <stateDir> <unitId> <actor> <nowIso>  -> run one actor, exit 0/1
// The `deliver` mode lets a test spawn two real, concurrent OS processes that
// race for the same unit (the two-scripted-actors rehearsal in AC-2).
// ---------------------------------------------------------------------------

function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
}

export function seedChildren(stateDir: string, records: ChildRecord[]): void {
  ensureStateDir(stateDir);
  writeFileSync(childrenFile(stateDir), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function main(argv: string[]): number {
  const [mode, ...rest] = argv;

  if (mode === 'deliver') {
    const [stateDir, unitId, actor, nowIso] = rest;
    if (!stateDir || !unitId || !actor || !nowIso) {
      console.error('usage: delivery-ownership-rehearsal.ts deliver <stateDir> <unitId> <actor> <nowIso>');
      return 2;
    }
    const outcome = deliverUnit(stateDir, unitId, actor, nowIso);
    console.log(JSON.stringify(outcome));
    return outcome.delivered ? 0 : 1;
  }

  // Default: validate.
  const args = mode === 'validate' ? rest : argv;
  const unknownFlags = args.filter((a) => a.startsWith('--'));
  if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    return 2;
  }
  const repoRoot = args[0] ?? process.cwd();
  const { errors } = validateDeliveryDocs(repoRoot);
  if (errors.length > 0) {
    console.error('delivery-ownership doc validation failed:');
    for (const error of errors) {
      console.error(`  ${relative(repoRoot, join(repoRoot, error.file))}: ${error.message}`);
    }
    return 1;
  }
  console.log('delivery-ownership doc validation passed.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
