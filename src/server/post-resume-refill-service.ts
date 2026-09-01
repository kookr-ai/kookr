/**
 * Post-resume refill service (issue #2797).
 *
 * Edge-triggered on the paused→live transition (see
 * {@link OrchestrationPauseService.resume}). Runs at most one bounded,
 * idempotent refill pass per transition: it consumes only existing vetted,
 * ownerless leaves (never invents backlog), respects the current reserve /
 * spawn budget and every launch gate (SAFE MODE, operator pause, drain), and
 * records a first-class outcome so a capacity report can separate
 * pause-expected silence from post-resume idle capacity.
 *
 * The decision logic is the pure {@link decidePostResumeRefill}; this service
 * owns the durable per-transition idempotency latch, the actual launches
 * (through an injected launcher over injected eligible leaves), and the
 * in-memory health snapshot consumed by diagnostics.
 *
 * Production actuation is gated by {@link PostResumeRefillServiceDeps.isEnabled}
 * (env, off by default — the same convention idle-refinery uses for a new
 * autonomous auto-spawn path). When disabled, the pass still classifies the
 * post-resume posture for visibility but never launches.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { atomicWriteFile } from '../core/persistence-utils.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import {
  decidePostResumeRefill,
  postResumeRefillIdempotencyKey,
  POST_RESUME_REFILL_STATE_SCHEMA,
  type PostResumeRefillState,
  type RefillBlockedReason,
  type PostResumeRefillSkipReason,
} from '../core/post-resume-refill.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';

export const POST_RESUME_REFILL_HEALTH_SCHEMA = 'post-resume-refill.v1' as const;
/** Latest-evaluation rows only; keeps health bounded regardless of leaf count. */
export const POST_RESUME_REFILL_HEALTH_RESULT_LIMIT = 25;

export type PostResumeRefillOutcomeKind =
  | 'refilled'
  | 'intentional_idle'
  | 'refill_blocked'
  | 'skipped';

/** Actuation-gate skip reason layered on top of the pure decision's skip reasons. */
export type PostResumeRefillReason =
  | PostResumeRefillSkipReason
  | RefillBlockedReason
  | 'disabled';

/**
 * One eligible vetted, ownerless leaf the refill pass may launch. Enumerated by
 * the injected provider; the pass never invents these.
 */
export interface EligibleLeaf {
  /** Stable per-leaf idempotency token (e.g. `owner/repo#123`). */
  key: string;
  /** Audit URL recorded on launch (the issue URL). */
  url: string;
  /** Build launch opts for this leaf; `idempotencyKey` is injected per transition. */
  toLaunchOpts: (idempotencyKey: string) => LaunchOpts;
}

export interface PostResumeRefillLaunchedLeaf {
  url: string;
  taskId: string;
}

export interface PostResumeRefillResult {
  outcome: PostResumeRefillOutcomeKind;
  reason?: PostResumeRefillReason;
  transitionId: string;
  /** Issue URLs + task ids actually launched this pass (empty unless `refilled`). */
  launched: PostResumeRefillLaunchedLeaf[];
  /** Leaves the decision would have launched (recorded even when suppressed). */
  wouldLaunchCount: number;
}

export interface PostResumeRefillHealthSnapshot {
  schemaVersion: typeof POST_RESUME_REFILL_HEALTH_SCHEMA;
  state: 'not_started' | 'evaluated';
  outcome: PostResumeRefillOutcomeKind | null;
  reason: PostResumeRefillReason | null;
  transitionId: string | null;
  evaluatedAt: string | null;
  ageMs: number | null;
  wouldLaunchCount: number;
  launched: PostResumeRefillLaunchedLeaf[];
  resultLimit: typeof POST_RESUME_REFILL_HEALTH_RESULT_LIMIT;
  truncated: boolean;
}

export interface PostResumeRefillServiceDeps {
  /** Same capacity ledger as health / idle-refinery / post-recovery. */
  getCapacityLedger: () => CapacityLedger;
  /** Enumerate eligible vetted, ownerless leaves. Never invents backlog. */
  enumerateEligibleLeaves: () => readonly EligibleLeaf[];
  /** Substrate preflight (disk floor / provider admission / claim). null ⇒ clear. */
  checkSubstrate?: () => RefillBlockedReason | null;
  launcher: (opts: LaunchOpts) => Promise<LaunchResult>;
  /** Operator drain gate; defaults accepting. */
  isAccepting?: () => boolean;
  /** SAFE MODE gate; defaults enabled (not in SAFE MODE). */
  isAutomationEnabled?: () => boolean;
  /** Orchestration paused (record active); defaults not paused. */
  isPaused?: () => boolean;
  /** Actuation gate (env). Off ⇒ classify only, never launch. Defaults off. */
  isEnabled?: () => boolean;
  /** Per-source spawn budget for this pass; defaults to the free-slot floor. */
  getSpawnBudget?: () => number;
  /** Free-slot floor override. */
  minFreeSlots?: number;
  kookrDir?: string;
  /** Override durable state dir (tests). */
  stateDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

interface StoredHealth {
  state: 'not_started' | 'evaluated';
  outcome: PostResumeRefillOutcomeKind | null;
  reason: PostResumeRefillReason | null;
  transitionId: string | null;
  evaluatedAtMs: number | null;
  wouldLaunchCount: number;
  launched: PostResumeRefillLaunchedLeaf[];
  truncated: boolean;
}

export class PostResumeRefillService {
  private readonly deps: PostResumeRefillServiceDeps;
  private health: StoredHealth = {
    state: 'not_started',
    outcome: null,
    reason: null,
    transitionId: null,
    evaluatedAtMs: null,
    wouldLaunchCount: 0,
    launched: [],
    truncated: false,
  };

  constructor(deps: PostResumeRefillServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private stateDir(): string {
    if (this.deps.stateDir) return this.deps.stateDir;
    const base = this.deps.kookrDir ?? join(homedir(), '.kookr');
    return join(base, 'playbook-state', 'post-resume-refill');
  }

  private statePath(): string {
    return join(this.stateDir(), 'state.json');
  }

  private async loadState(): Promise<PostResumeRefillState | null> {
    try {
      const raw = await readFile(this.statePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PostResumeRefillState>;
      if (parsed.schemaVersion !== POST_RESUME_REFILL_STATE_SCHEMA) return null;
      return {
        schemaVersion: POST_RESUME_REFILL_STATE_SCHEMA,
        lastRefilledTransitionId:
          typeof parsed.lastRefilledTransitionId === 'string'
            ? parsed.lastRefilledTransitionId
            : undefined,
        lastRefilledAt:
          typeof parsed.lastRefilledAt === 'string' ? parsed.lastRefilledAt : undefined,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async saveState(transitionId: string): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    const state: PostResumeRefillState = {
      schemaVersion: POST_RESUME_REFILL_STATE_SCHEMA,
      lastRefilledTransitionId: transitionId,
      lastRefilledAt: nowIso,
      updatedAt: nowIso,
    };
    const path = this.statePath();
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  private record(result: PostResumeRefillResult): void {
    this.health = {
      state: 'evaluated',
      outcome: result.outcome,
      reason: result.reason ?? null,
      transitionId: result.transitionId,
      evaluatedAtMs: this.now(),
      wouldLaunchCount: result.wouldLaunchCount,
      launched: result.launched.slice(0, POST_RESUME_REFILL_HEALTH_RESULT_LIMIT),
      truncated: result.launched.length > POST_RESUME_REFILL_HEALTH_RESULT_LIMIT,
    };
  }

  /** Latest post-resume refill evaluation; ageMs computed at call time. */
  getRefillHealthSnapshot(): PostResumeRefillHealthSnapshot {
    const h = this.health;
    return {
      schemaVersion: POST_RESUME_REFILL_HEALTH_SCHEMA,
      state: h.state,
      outcome: h.outcome,
      reason: h.reason,
      transitionId: h.transitionId,
      evaluatedAt: h.evaluatedAtMs != null ? new Date(h.evaluatedAtMs).toISOString() : null,
      ageMs: h.evaluatedAtMs != null ? Math.max(0, this.now() - h.evaluatedAtMs) : null,
      wouldLaunchCount: h.wouldLaunchCount,
      launched: h.launched,
      resultLimit: POST_RESUME_REFILL_HEALTH_RESULT_LIMIT,
      truncated: h.truncated,
    };
  }

  /**
   * Run the refill pass for one paused→live transition. Idempotent: a repeated
   * call with the same `transitionId` (a replayed resume tick) returns the
   * `already_refilled_transition` skip and launches nothing.
   */
  async onResumeTransition(transitionId: string): Promise<PostResumeRefillResult> {
    const id = (transitionId ?? '').trim();
    const prior = await this.loadState();
    const ledger = this.deps.getCapacityLedger();
    const freeGeneralSlots = ledger.freeForGeneralSources ?? ledger.free;
    const leaves = this.deps.enumerateEligibleLeaves();
    const spawnBudget = this.deps.getSpawnBudget?.() ?? (this.deps.minFreeSlots ?? freeGeneralSlots);
    const substrateBlock = this.deps.checkSubstrate?.() ?? null;

    const decision = decidePostResumeRefill({
      resumed: true,
      transitionId: id,
      lastRefilledTransitionId: prior?.lastRefilledTransitionId ?? null,
      safeModeEngaged: !(this.deps.isAutomationEnabled?.() ?? true),
      paused: this.deps.isPaused?.() ?? false,
      accepting: this.deps.isAccepting?.() ?? true,
      freeGeneralSlots,
      pendingQueueDepth: ledger.pendingQueueDepth,
      eligibleLeafCount: leaves.length,
      spawnBudget,
      substrateBlock,
      ...(this.deps.minFreeSlots != null ? { minFreeSlots: this.deps.minFreeSlots } : {}),
    });

    let result: PostResumeRefillResult;
    switch (decision.action) {
      case 'skip':
        result = { outcome: 'skipped', reason: decision.reason, transitionId: id, launched: [], wouldLaunchCount: 0 };
        break;
      case 'intentional_idle':
        result = { outcome: 'intentional_idle', transitionId: id, launched: [], wouldLaunchCount: 0 };
        break;
      case 'refill_blocked':
        result = { outcome: 'refill_blocked', reason: decision.reason, transitionId: id, launched: [], wouldLaunchCount: 0 };
        break;
      case 'launch': {
        const enabled = this.deps.isEnabled?.() ?? false;
        if (!enabled) {
          // Classify for visibility, but a new autonomous auto-spawn path stays
          // off by default (idle-refinery convention). Do not latch: enabling
          // later should still let a subsequent transition refill.
          result = {
            outcome: 'skipped',
            reason: 'disabled',
            transitionId: id,
            launched: [],
            wouldLaunchCount: decision.count,
          };
          break;
        }
        result = await this.launchLeaves(id, leaves.slice(0, decision.count), decision.count);
        break;
      }
    }

    this.record(result);
    this.log(
      `[post-resume-refill] transition=${id || '(none)'} outcome=${result.outcome}`
        + (result.reason ? ` reason=${result.reason}` : '')
        + ` launched=${result.launched.length} wouldLaunch=${result.wouldLaunchCount}`,
    );
    return result;
  }

  /**
   * Launch up to `count` leaves. Latches the transition after the attempt so a
   * replayed resume tick cannot duplicate a claim or spawn. A launcher throw
   * (e.g. an issue-claim 409 / admission rejection) is a substrate contention:
   * any leaves already launched are kept (`refilled`); if none launched, the
   * pass reports `refill_blocked` / `claim_contended`.
   */
  private async launchLeaves(
    transitionId: string,
    leaves: readonly EligibleLeaf[],
    count: number,
  ): Promise<PostResumeRefillResult> {
    const launched: PostResumeRefillLaunchedLeaf[] = [];
    let blocked: RefillBlockedReason | null = null;
    for (const leaf of leaves) {
      const key = postResumeRefillIdempotencyKey(transitionId, leaf.key);
      try {
        const res = await this.deps.launcher(leaf.toLaunchOpts(key));
        launched.push({ url: leaf.url, taskId: res.task.id });
      } catch (err) {
        blocked = 'claim_contended';
        this.log(
          `[post-resume-refill] leaf launch blocked leaf=${leaf.key}: `
            + (err instanceof Error ? err.message : String(err)),
        );
        break;
      }
    }
    // Latch: the pass ran for this transition; never launch again for it.
    // Best-effort — a persistence fault must not swallow the outcome (the
    // caller still records the health snapshot and returns). A lost latch is
    // backstopped by the paused→live edge guard (a replayed resume is not an
    // edge) and the per-transition launcher idempotency key.
    try {
      await this.saveState(transitionId);
    } catch (err) {
      this.log(
        `[post-resume-refill] latch persist failed transition=${transitionId}: `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
    if (launched.length > 0) {
      return { outcome: 'refilled', transitionId, launched, wouldLaunchCount: count };
    }
    return {
      outcome: 'refill_blocked',
      reason: blocked ?? 'claim_contended',
      transitionId,
      launched: [],
      wouldLaunchCount: count,
    };
  }
}
