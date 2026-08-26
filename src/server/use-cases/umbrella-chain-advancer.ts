import { join } from 'node:path';
import { isValidIsoTimestamp } from '../../core/iso-timestamp.js';
import {
  parsePhaseLedgerFromIssueBody,
  reconcilePhaseResultComments,
  replacePhaseLedgerInIssueBody,
  serializePhaseLedgerBlock,
  type PhaseLedger,
  type PhaseLedgerPhase,
} from '../../core/phase-ledger-codec.js';
import { nextEligiblePhase } from '../../core/phase-ledger.js';
import { DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP } from '../../core/autonomous-review-policy.js';
import type { UmbrellaChainRemote, UmbrellaIssue } from '../../adapters/github-umbrella-chain-client.js';
import { withCrossProcessLock } from '../cross-process-lock.js';
import { evaluateIndependentReview, isSelfAdvancingDisabled } from '../self-advancing-authority.js';
import { UmbrellaChainClaimStore } from '../umbrella-chain-claim-store.js';

export type UmbrellaChainAdvancerMode = 'off' | 'observe' | 'spawn';

export const UMBRELLA_CHAIN_ADVANCER_INTERVAL_MS = 60_000;
export const UMBRELLA_CHAIN_ADVANCER_GRACE_MS = 5 * 60_000;
export const UMBRELLA_CHAIN_ADVANCER_STALE_MS = 60 * 60_000;

export interface UmbrellaChainAdvancerLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface UmbrellaChainSpawn {
  taskId: string;
}

export interface UmbrellaChainAdvancerDeps {
  kookrDir: string;
  repo: string;
  repoPath: string;
  remote: UmbrellaChainRemote;
  claimStore?: Pick<UmbrellaChainClaimStore, 'claim' | 'finalize' | 'release' | 'get'>;
  launch?: (options: {
    prompt: string;
    cwd: string;
    idempotencyKey: string;
    claimIssue: { number: number; repo: string };
  }) => Promise<UmbrellaChainSpawn>;
  /** Resolves the owning task's terminal state; absence is fail-closed. */
  isTaskTerminal?: (taskId: string) => boolean | Promise<boolean>;
  /** Verifies that the recorded reviewer task exists and is outside the implementer lineage. */
  isReviewTaskIndependent?: (implementerTaskId: string, reviewerTaskId: string) => boolean | Promise<boolean>;
  mode?: UmbrellaChainAdvancerMode;
  baseBranch?: string;
  intervalMs?: number;
  graceMs?: number;
  staleMs?: number;
  now?: () => Date;
  logger?: UmbrellaChainAdvancerLogger;
}

export interface UmbrellaChainHealth {
  issueNumber: number;
  repo: string;
  chainId: string;
  status: 'eligible' | 'blocked' | 'complete' | 'malformed' | 'stale';
  nextPhase: string | null;
  blockedReason?: string;
  blockedSince?: string;
  lastDecisionAt: string;
  inFlight: boolean;
  reason: string;
  reviewAudit?: 'pass' | 'block' | 'missing' | 'not-required';
}

export interface UmbrellaChainAdvancerHealth {
  schemaVersion: 'umbrella-chain-advancer.v1';
  mode: UmbrellaChainAdvancerMode;
  running: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  tickCount: number;
  staleThresholdMs: number;
  unstickProcedure: string;
  chains: readonly UmbrellaChainHealth[];
}

interface MutableChainHealth extends UmbrellaChainHealth {
  lastSeenAtMs: number;
}

const DEFAULT_UNSTICK_PROCEDURE =
  'Inspect the umbrella ledger and claim file, terminate the stale owner, then rerun the advancer; malformed ledgers require a manual body repair.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The deterministic idempotency key for an `(issue, phase)` spawn claim.
 *
 * The repository-qualified `chain:<repo>:<issue>:phase:<id>` form is the single
 * source of truth shared between the advancer's claim store and the task launch.
 * It is exported so other code that creates phase-spawn tasks (part of the #2711
 * rollout) derives the same key rather than re-encoding the format — two
 * encodings that drift would let a duplicate sweep or retry POST a second phase
 * task. `legacyPhaseClaimKey` preserves the earlier unqualified form so chains
 * claimed before the upgrade are still honored.
 */
export function phaseClaimKey(repo: string, issueNumber: number, phaseId: string): string {
  const normalizedRepo = repo.trim().toLowerCase();
  return `chain:${normalizedRepo}:${issueNumber}:phase:${phaseId}`;
}

export function legacyPhaseClaimKey(issueNumber: number, phaseId: string): string {
  return `chain:${issueNumber}:phase:${phaseId}`;
}

function reviewClaimKey(phaseKey: string, attempt: number): string {
  return `${phaseKey}:review:${attempt}`;
}

function reviewAuditBlocker(
  phases: readonly PhaseLedgerPhase[],
  currentHeadByPr: ReadonlyMap<number, string> = new Map(),
): PhaseLedgerPhase | undefined {
  return phases.find((candidate) => {
    if (candidate.prNumber === undefined) return false;
    if (candidate.mergedAt !== undefined && candidate.reviewedAt !== undefined
      && Date.parse(candidate.reviewedAt) <= Date.parse(candidate.mergedAt)) return true;
    if (candidate.taskId === undefined || candidate.reviewedAt === undefined) return true;
    const currentHeadSha = currentHeadByPr.get(candidate.prNumber);
    const decision = evaluatePhaseReview(candidate, currentHeadSha);
    return decision.decision !== 'merge-allowed';
  });
}

function evaluatePhaseReview(phase: PhaseLedgerPhase, currentHeadSha?: string) {
  if (phase.taskId === undefined || phase.reviewedAt === undefined) {
    return { decision: 'retry-review' as const, reason: 'review is missing' };
  }
  return evaluateIndependentReview({
    implementerLineage: [phase.taskId],
    reviewerTaskId: phase.reviewerTaskId,
    reviewerRan: phase.reviewerTaskId !== undefined || phase.reviewVerdict !== undefined,
    ...(phase.reviewVerdict !== undefined
      ? { verdict: phase.reviewVerdict === 'pass' ? 'PASS' as const : 'BLOCK' as const }
      : {}),
    reviewAttempts: phase.reviewAttempts ?? (phase.reviewerTaskId !== undefined || phase.reviewVerdict !== undefined ? 1 : 0),
    ...(phase.reviewIterationCap !== undefined ? { maxReviewAttempts: phase.reviewIterationCap } : {}),
    ...(phase.reviewHeadSha !== undefined ? { reviewHeadSha: phase.reviewHeadSha } : {}),
    ...(currentHeadSha !== undefined ? { currentHeadSha } : {}),
  });
}

function reviewAuditKind(phase: PhaseLedgerPhase): 'block' | 'missing' {
  if (phase.reviewVerdict === 'block') return 'block';
  return 'missing';
}

function phasePrompt(issue: UmbrellaIssue, phase: PhaseLedgerPhase, chainId: string): string {
  return [
    `Implement phase ${phase.id} of umbrella issue #${issue.number} in ${chainId}.`,
    '',
    'This is an unattended Phase-2 chain continuation. Work in a fresh worktree, run the repository gates, and open the phase PR when complete.',
    `The phase owner must emit an append-only GitHub issue comment containing this marker after the PR is created:`,
    `<!-- kookr-phase-result {"version":1,"chainId":${JSON.stringify(chainId)},"issueNumber":${issue.number},"phaseId":${JSON.stringify(phase.id)},"prNumber":<number>,"status":"in-flight","taskId":"<task-id>","ownerTerminal":false} -->`,
    'After the PR is merged, an independent reviewer task must append a second marker with reviewVerdict "pass" or "block", reviewedAt, reviewerTaskId, reviewAttempts, and reviewHeadSha equal to the exact PR head it reviewed. The reviewerTaskId must differ from the phase owner taskId. A missing, stale, or blocking verdict prevents the next phase from spawning. The default durable review cap is 10; preserve a deliberately lower configured cap.',
    '',
    'Do not edit the fenced kookr-phase-ledger body directly; the umbrella-chain advancer is its single writer.',
    '',
    issue.body,
  ].join('\n');
}

/**
 * Durable, serialized backstop for self-advancing umbrella chains.
 *
 * The service is deliberately side-effect-free in `observe` mode. `spawn`
 * is an explicit operator choice; the default is `off`, which keeps the new
 * mechanism dormant until its synthetic-canary review is complete.
 */
export class UmbrellaChainAdvancer {
  private readonly deps: UmbrellaChainAdvancerDeps;
  private readonly mode: UmbrellaChainAdvancerMode;
  private readonly baseBranch: string;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private readonly staleMs: number;
  private readonly now: () => Date;
  private readonly logger: UmbrellaChainAdvancerLogger;
  private readonly claimStore: Pick<UmbrellaChainClaimStore, 'claim' | 'finalize' | 'release' | 'get'>;
  private readonly lockPath: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlightSweep: Promise<void> | undefined;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private tickCount = 0;
  private readonly chains = new Map<number, MutableChainHealth>();

  constructor(deps: UmbrellaChainAdvancerDeps) {
    this.deps = deps;
    this.mode = deps.mode ?? 'off';
    this.baseBranch = deps.baseBranch ?? 'main';
    this.intervalMs = deps.intervalMs ?? UMBRELLA_CHAIN_ADVANCER_INTERVAL_MS;
    this.graceMs = deps.graceMs ?? UMBRELLA_CHAIN_ADVANCER_GRACE_MS;
    this.staleMs = deps.staleMs ?? UMBRELLA_CHAIN_ADVANCER_STALE_MS;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
    this.claimStore = deps.claimStore ?? new UmbrellaChainClaimStore(deps.kookrDir);
    this.lockPath = join(deps.kookrDir, 'umbrella-chain-advancer.sweep.lock');
  }

  start(): void {
    if (this.timer || this.mode === 'off') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    void this.sweep();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlightSweep;
  }

  async sweep(): Promise<void> {
    if (this.inFlightSweep) return this.inFlightSweep;
    this.inFlightSweep = this.runSweep().finally(() => {
      this.inFlightSweep = undefined;
    });
    return this.inFlightSweep;
  }

  getHealthSnapshot(nowMs = this.now().getTime()): UmbrellaChainAdvancerHealth {
    const chains = [...this.chains.values()].map(({ lastSeenAtMs, ...chain }) => ({
      ...chain,
      ...(nowMs - lastSeenAtMs > this.staleMs ? { status: 'stale' as const } : {}),
    }));
    return {
      schemaVersion: 'umbrella-chain-advancer.v1',
      mode: this.mode,
      running: this.timer !== undefined,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      tickCount: this.tickCount,
      staleThresholdMs: this.staleMs,
      unstickProcedure: DEFAULT_UNSTICK_PROCEDURE,
      chains,
    };
  }

  private async runSweep(): Promise<void> {
    try {
      const lockResult = await withCrossProcessLock(this.lockPath, async () => this.scanAll());
      if (lockResult.kind === 'busy') {
        this.emit({ ledger: 'ok', next: null, depSatisfied: false, inFlight: true, claim: 'held', decision: 'skip', reason: 'sweep-in-flight' });
        return;
      }
      this.lastTickAt = this.now().toISOString();
      this.tickCount += 1;
      this.lastTickError = null;
    } catch (error) {
      this.lastTickAt = this.now().toISOString();
      this.tickCount += 1;
      this.lastTickError = messageOf(error);
      this.logger.error?.(`[umbrella-chain-advancer] sweep failed: ${this.lastTickError}`);
      this.emit({ ledger: 'ok', next: null, depSatisfied: false, inFlight: false, claim: 'not-attempted', decision: 'skip', reason: `sweep-error:${this.lastTickError}` });
    }
  }

  private async scanAll(): Promise<void> {
    const candidates = await this.deps.remote.listOpenIssues(this.deps.repo);
    await this.deps.remote.refreshBase(this.deps.repoPath, this.baseBranch);
    let scanned = 0;
    for (const candidate of candidates) {
      const issue = await this.deps.remote.getIssue(this.deps.repo, candidate.number);
      if (!issue) continue;
      scanned += 1;
      await this.scanIssue(issue);
    }
    this.logger.info?.(`[umbrella-chain-advancer] tick-summary ${JSON.stringify({ issues: scanned })}`);
  }

  private async scanIssue(issue: UmbrellaIssue): Promise<void> {
    let ledger: PhaseLedger;
    try {
      ledger = parsePhaseLedgerFromIssueBody(issue.body);
    } catch (error) {
      this.emit({ ledger: 'malformed', next: null, depSatisfied: false, inFlight: false, claim: 'not-attempted', decision: 'skip', reason: messageOf(error) }, issue.number);
      this.recordMalformedHealth(issue.number, messageOf(error));
      return;
    }

    if (!this.repoMatches(ledger.repo) || ledger.issueNumber !== issue.number) {
      const reason = ledger.issueNumber !== issue.number
        ? `ledger-issue-mismatch:${ledger.issueNumber}`
        : `ledger-repo-mismatch:${ledger.repo}`;
      this.emit({ ledger: 'malformed', next: null, depSatisfied: false, inFlight: false, claim: 'not-attempted', decision: 'skip', reason }, issue.number);
      this.recordMalformedHealth(issue.number, reason);
      return;
    }

    const reconciled = reconcilePhaseResultComments(ledger, issue.comments.map((comment) => comment.body));
    let changed = JSON.stringify(reconciled) !== JSON.stringify(ledger);
    ledger = reconciled;

    const reachable = new Map<number, boolean>();
    const currentHeadByPr = new Map<number, string>();
    for (const phase of ledger.phases) {
      if (phase.prNumber === undefined) continue;
      const isReachable = await this.deps.remote.isPullRequestReachable(
        this.deps.repoPath,
        this.baseBranch,
        phase.prNumber,
        this.deps.repo,
      );
      if (isReachable) {
        const headSha = await this.deps.remote.getPullRequestHeadSha(this.deps.repo, phase.prNumber);
        if (headSha) currentHeadByPr.set(phase.prNumber, headSha);
        const mergedAt = await this.deps.remote.getPullRequestMergedAt(this.deps.repo, phase.prNumber);
        if (mergedAt === null || !isValidIsoTimestamp(mergedAt)) {
          reachable.set(phase.prNumber, false);
          this.logger.warn?.(`[umbrella-chain-advancer] could not verify merge time for PR #${phase.prNumber}; holding the chain`);
        } else {
          reachable.set(phase.prNumber, true);
          if (phase.status !== 'merged') {
            phase.status = 'merged';
            changed = true;
          }
          if (phase.mergedAt !== mergedAt) {
            phase.mergedAt = mergedAt;
            changed = true;
          }
        }
      } else {
        reachable.set(phase.prNumber, false);
      }
      if (phase.taskId && !phase.ownerTerminal && this.deps.isTaskTerminal) {
        if (await this.deps.isTaskTerminal(phase.taskId)) {
          phase.ownerTerminal = true;
          changed = true;
        }
      }
    }

    const result = nextEligiblePhase(ledger.phases, (prNumber) => reachable.get(prNumber) === true);
    if (ledger.blockedReason === 'gate-red' || ledger.blockedReason === 'stuck-claim') {
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(ledger, 'blocked', result.phase?.id ?? null, false, `manual-block:${ledger.blockedReason}`);
      this.emit({ ledger: 'ok', next: result.phase?.id ?? null, depSatisfied: result.outcome === 'eligible', inFlight: false, claim: 'not-attempted', decision: 'skip', reason: `manual-block:${ledger.blockedReason}` }, issue.number);
      return;
    }
    if (result.outcome === 'blocked') {
      if (ledger.blockedReason !== 'dependency-unmerged' || ledger.blockedSince === undefined) {
        ledger.blockedReason = 'dependency-unmerged';
        ledger.blockedSince ??= this.now().toISOString();
        changed = true;
      }
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(ledger, 'blocked', null, false, result.reason);
      this.emit({ ledger: 'ok', next: null, depSatisfied: false, inFlight: false, claim: 'not-needed', decision: 'skip', reason: `dependency-unmerged:${result.reason}` }, issue.number);
      return;
    }
    if (result.outcome === 'complete') {
      const reviewBlocker = await this.findReviewAuditBlocker(ledger.phases, currentHeadByPr);
      if (reviewBlocker) {
        if (await this.launchReviewCorrection(issue, ledger, reviewBlocker, currentHeadByPr)) return;
        const reviewAudit = reviewAuditKind(reviewBlocker);
        const reason = `review-audit-${reviewAudit}:${reviewBlocker.id}`;
        ledger.blockedReason = 'review-block';
        ledger.blockedSince ??= this.now().toISOString();
        await this.persistIfChanged(issue, ledger, true);
        this.recordHealth(ledger, 'blocked', null, false, reason, reviewAudit);
        this.emit({ ledger: 'ok', next: null, depSatisfied: true, inFlight: false, claim: 'not-needed', decision: 'skip', reason }, issue.number);
        return;
      }
      if (ledger.blockedReason !== undefined || ledger.blockedSince !== undefined) {
        delete ledger.blockedReason;
        delete ledger.blockedSince;
        changed = true;
      }
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(ledger, 'complete', null, false, result.reason, 'pass');
      this.emit({ ledger: 'ok', next: null, depSatisfied: true, inFlight: false, claim: 'not-needed', decision: 'skip', reason: result.reason }, issue.number);
      return;
    }

    const phase = ledger.phases.find((candidate) => candidate.id === result.phase!.id)!;
    const predecessorPhases = ledger.phases.slice(0, ledger.phases.indexOf(phase));
    const reviewBlocker = await this.findReviewAuditBlocker(predecessorPhases, currentHeadByPr);
    if (reviewBlocker) {
      if (await this.launchReviewCorrection(issue, ledger, reviewBlocker, currentHeadByPr)) return;
      const reviewAudit = reviewAuditKind(reviewBlocker);
      const reason = `review-audit-${reviewAudit}:${reviewBlocker.id}`;
      if (ledger.blockedReason !== 'review-block' || ledger.blockedSince === undefined) {
        ledger.blockedReason = 'review-block';
        ledger.blockedSince ??= this.now().toISOString();
        changed = true;
      }
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(ledger, 'blocked', phase.id, false, reason, reviewAudit);
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: false, claim: 'not-needed', decision: 'skip', reason }, issue.number);
      return;
    }
    if (ledger.blockedReason !== undefined || ledger.blockedSince !== undefined) {
      delete ledger.blockedReason;
      delete ledger.blockedSince;
      changed = true;
    }
    const preferredKey = phaseClaimKey(this.deps.repo, ledger.issueNumber, phase.id);
    const legacyKey = legacyPhaseClaimKey(ledger.issueNumber, phase.id);
    const preferredClaim = await this.claimStore.get(preferredKey);
    const legacyClaim = await this.claimStore.get(legacyKey);
    const namespaceConflict = preferredClaim !== undefined && legacyClaim !== undefined;
    // Continue through the legacy key when upgrading an in-flight chain. Its
    // claim() call remains the durable CAS and safely reclaims it when stale.
    const key = legacyClaim && !preferredClaim ? legacyKey : preferredKey;
    const existingClaim = preferredClaim ?? legacyClaim;
    const existingInFlight = existingClaim !== undefined;
    const predecessor = ledger.phases[ledger.phases.indexOf(phase) - 1];
    const withinGrace = predecessor?.mergedAt !== undefined
      && this.now().getTime() - Date.parse(predecessor.mergedAt) < this.graceMs;
    const predecessorTerminal = predecessor === undefined || predecessor.ownerTerminal === true;
    const ownerActive = Boolean(
      phase.taskId
      && !phase.ownerTerminal
      && (!this.deps.isTaskTerminal || !(await this.deps.isTaskTerminal(phase.taskId))),
    );
    const claimOwnerActive = Boolean(
      existingClaim?.taskId
      && (!this.deps.isTaskTerminal || !(await this.deps.isTaskTerminal(existingClaim.taskId))),
    );
    // Do not gate on an existing claim here: claim() is the durable CAS and
    // owns stale-claim reclamation. Calling it is what lets a crashed owner's
    // expired claim be reclaimed without ever allowing two live spawns.
    const safeToAdvance = !namespaceConflict
      && !withinGrace
      && predecessorTerminal
      && !ownerActive
      && !claimOwnerActive;

    if (!safeToAdvance || this.mode !== 'spawn' || !this.deps.launch || isSelfAdvancingDisabled()) {
      if (namespaceConflict
        && (ledger.blockedReason !== 'stuck-claim' || ledger.blockedSince === undefined)) {
        ledger.blockedReason = 'stuck-claim';
        ledger.blockedSince ??= this.now().toISOString();
        changed = true;
      }
      let reason: string;
      if (namespaceConflict) reason = 'claim-namespace-conflict';
      else if (existingInFlight) reason = 'in-flight-claim';
      else if (withinGrace) reason = 'grace-window';
      else if (!predecessorTerminal) reason = 'predecessor-owner-active';
      else if (ownerActive) reason = 'owner-active';
      else if (claimOwnerActive) reason = 'claim-owner-active';
      else if (this.mode === 'observe') reason = 'observe-only';
      else if (isSelfAdvancingDisabled()) reason = 'self-advancing-disabled';
      else reason = 'spawning-disabled';
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(
        ledger,
        namespaceConflict ? 'blocked' : 'eligible',
        phase.id,
        existingInFlight,
        reason,
        predecessorPhases.length > 0 ? 'pass' : 'not-required',
      );
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: existingInFlight, claim: existingInFlight ? 'held' : 'not-attempted', decision: 'skip', reason }, issue.number);
      return;
    }

    const claim = await this.claimStore.claim(key);
    if (claim.kind !== 'claimed') {
      const reason = claim.kind === 'busy' ? 'in-flight-claim' : `claim-failed:${claim.message}`;
      if (claim.kind === 'error') {
        ledger.blockedReason = 'stuck-claim';
        ledger.blockedSince ??= this.now().toISOString();
        await this.persistIfChanged(issue, ledger, true);
      }
      this.recordHealth(ledger, claim.kind === 'error' ? 'blocked' : 'eligible', phase.id, claim.kind === 'busy', reason, predecessorPhases.length > 0 ? 'pass' : 'not-required');
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: true, claim: claim.kind === 'busy' ? 'held' : 'failed', decision: 'skip', reason }, issue.number);
      return;
    }

    let launchedTaskId: string | undefined;
    try {
      const launched = await this.deps.launch({
        prompt: phasePrompt(issue, phase, ledger.chainId),
        cwd: this.deps.repoPath,
        idempotencyKey: key,
        claimIssue: { number: ledger.issueNumber, repo: this.deps.repo },
      });
      launchedTaskId = launched.taskId;
      phase.status = 'in-flight';
      phase.taskId = launchedTaskId;
      phase.ownerTerminal = false;
      changed = true;
      await this.claimStore.finalize(key, launchedTaskId, claim.claim.ownerToken);
      await this.persistIfChanged(issue, ledger, changed);
      this.recordHealth(ledger, 'eligible', phase.id, true, `spawned:${launchedTaskId}`, predecessorPhases.length > 0 ? 'pass' : 'not-required');
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: true, claim: 'acquired', decision: 'spawn', reason: `spawned:${launchedTaskId}` }, issue.number);
    } catch (error) {
      if (launchedTaskId === undefined) {
        try {
          await this.claimStore.release(key, claim.claim.ownerToken);
        } catch (releaseError) {
          this.logger.warn?.(`[umbrella-chain-advancer] failed to release claim ${key}: ${messageOf(releaseError)}`);
        }
        const reason = `spawn-failed:${messageOf(error)}`;
        this.recordHealth(ledger, 'blocked', phase.id, false, reason);
        this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: false, claim: 'released', decision: 'skip', reason }, issue.number);
        return;
      }
      // The task already exists. Retain the durable claim and ledger owner so a
      // finalization/lock failure cannot turn into a duplicate spawn later.
      await this.persistIfChanged(issue, ledger, true);
      const reason = `claim-finalize-failed:${messageOf(error)}`;
      this.recordHealth(ledger, 'blocked', phase.id, true, reason);
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: true, claim: 'acquired', decision: 'skip', reason }, issue.number);
    }
  }

  private async persistIfChanged(issue: UmbrellaIssue, ledger: PhaseLedger, changed: boolean): Promise<void> {
    if (!changed || this.mode !== 'spawn') return;
    try {
      const latest = await this.deps.remote.getIssue(this.deps.repo, issue.number);
      if (!latest) {
        this.logger.warn?.(`[umbrella-chain-advancer] skipped issue #${issue.number} update because it could not be refetched`);
        return;
      }
      const originalLedger = parsePhaseLedgerFromIssueBody(issue.body);
      if (JSON.stringify(parsePhaseLedgerFromIssueBody(latest.body)) !== JSON.stringify(originalLedger)) {
        this.logger.warn?.(`[umbrella-chain-advancer] skipped stale issue #${issue.number} ledger update`);
        return;
      }
      const body = replacePhaseLedgerInIssueBody(latest.body, ledger);
      if (serializePhaseLedgerBlock(parsePhaseLedgerFromIssueBody(body)) !== serializePhaseLedgerBlock(ledger)) {
        this.logger.warn?.(`[umbrella-chain-advancer] skipped non-round-tripping issue #${issue.number} ledger update`);
        return;
      }
      await this.deps.remote.updateIssueBody(this.deps.repo, issue.number, body);
    } catch (error) {
      this.logger.warn?.(`[umbrella-chain-advancer] failed to persist issue #${issue.number}: ${messageOf(error)}`);
    }
  }

  private async findReviewAuditBlocker(
    phases: readonly PhaseLedgerPhase[],
    currentHeadByPr: ReadonlyMap<number, string> = new Map(),
  ): Promise<PhaseLedgerPhase | undefined> {
    const blocker = reviewAuditBlocker(phases, currentHeadByPr);
    if (blocker) return blocker;
    for (const phase of phases) {
      if (phase.prNumber === undefined) continue;
      if (!phase.taskId || !phase.reviewerTaskId || !this.deps.isReviewTaskIndependent) return phase;
      if (!(await this.deps.isReviewTaskIndependent(phase.taskId, phase.reviewerTaskId))) return phase;
    }
    return undefined;
  }

  private async launchReviewCorrection(
    issue: UmbrellaIssue,
    ledger: PhaseLedger,
    phase: PhaseLedgerPhase,
    currentHeadByPr: ReadonlyMap<number, string>,
  ): Promise<boolean> {
    if (this.mode !== 'spawn' || !this.deps.launch || phase.reviewVerdict !== 'block' || phase.prNumber === undefined) return false;
    const decision = evaluatePhaseReview(phase, currentHeadByPr.get(phase.prNumber));
    if (decision.decision !== 'retry-review') return false;
    if (this.deps.isReviewTaskIndependent && phase.taskId && phase.reviewerTaskId
      && !(await this.deps.isReviewTaskIndependent(phase.taskId, phase.reviewerTaskId))) return false;

    const attempt = (phase.reviewAttempts ?? 1) + 1;
    const preferredKey = reviewClaimKey(
      phaseClaimKey(this.deps.repo, ledger.issueNumber, phase.id),
      attempt,
    );
    const legacyKey = reviewClaimKey(
      legacyPhaseClaimKey(ledger.issueNumber, phase.id),
      attempt,
    );
    const preferredClaim = await this.claimStore.get(preferredKey);
    const legacyClaim = await this.claimStore.get(legacyKey);
    if (preferredClaim && legacyClaim) {
      this.logger.warn?.(
        `[umbrella-chain-advancer] both current and legacy review claims exist for ${phase.id} attempt ${attempt}`,
      );
      return false;
    }
    const existingClaim = preferredClaim ?? legacyClaim;
    if (existingClaim?.taskId
      && (!this.deps.isTaskTerminal || !(await this.deps.isTaskTerminal(existingClaim.taskId)))) {
      return false;
    }
    const key = legacyClaim ? legacyKey : preferredKey;
    const claim = await this.claimStore.claim(key);
    if (claim.kind !== 'claimed') return false;
    let launchedTaskId: string | undefined;
    try {
      const launched = await this.deps.launch({
        prompt: [
          `Correct the confirmed independent-review findings for phase ${phase.id} of umbrella issue #${issue.number}.`,
          `This is autonomous correction/review attempt ${attempt}/${phase.reviewIterationCap ?? DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP}.`,
          'Inspect the blocked PR and its review findings, fix the confirmed defects in a fresh worktree, run all local gates, open the corrective PR, and arrange a fresh independent exact-head review.',
          'Append the phase-result marker with the new PR number, owner task id, reviewAttempts, and exact reviewHeadSha when the fresh review completes.',
          '',
          issue.body,
        ].join('\n'),
        cwd: this.deps.repoPath,
        idempotencyKey: key,
        claimIssue: { number: ledger.issueNumber, repo: this.deps.repo },
      });
      launchedTaskId = launched.taskId;
      phase.status = 'in-flight';
      phase.taskId = launchedTaskId;
      phase.ownerTerminal = false;
      delete phase.prNumber;
      delete phase.mergedAt;
      delete phase.reviewVerdict;
      delete phase.reviewedAt;
      delete phase.reviewerTaskId;
      delete phase.reviewHeadSha;
      phase.reviewAttempts = attempt;
      await this.claimStore.finalize(key, launchedTaskId, claim.claim.ownerToken);
      await this.persistIfChanged(issue, ledger, true);
      this.emit({ ledger: 'ok', next: phase.id, depSatisfied: true, inFlight: true, claim: 'acquired', decision: 'spawn', reason: `review-correction:${phase.id}:${attempt}` }, issue.number);
      return true;
    } catch (error) {
      if (launchedTaskId === undefined) {
        try { await this.claimStore.release(key, claim.claim.ownerToken); } catch { /* retain the original blocker */ }
      }
      this.logger.warn?.(`[umbrella-chain-advancer] review correction failed: ${messageOf(error)}`);
      return false;
    }
  }

  private recordHealth(
    ledger: PhaseLedger,
    status: UmbrellaChainHealth['status'],
    nextPhase: string | null,
    inFlight: boolean,
    reason: string,
    reviewAudit?: UmbrellaChainHealth['reviewAudit'],
  ): void {
    const now = this.now();
    this.chains.set(ledger.issueNumber, {
      issueNumber: ledger.issueNumber,
      repo: ledger.repo,
      chainId: ledger.chainId,
      status,
      nextPhase,
      ...(ledger.blockedReason ? { blockedReason: ledger.blockedReason } : {}),
      ...(ledger.blockedSince ? { blockedSince: ledger.blockedSince } : {}),
      lastDecisionAt: now.toISOString(),
      inFlight,
      reason,
      ...(reviewAudit ? { reviewAudit } : {}),
      lastSeenAtMs: now.getTime(),
    });
  }

  private recordMalformedHealth(issueNumber: number, reason: string): void {
    const now = this.now();
    this.chains.set(issueNumber, {
      issueNumber,
      repo: this.deps.repo,
      chainId: 'unknown',
      status: 'malformed',
      nextPhase: null,
      lastDecisionAt: now.toISOString(),
      inFlight: false,
      reason,
      reviewAudit: 'missing',
      lastSeenAtMs: now.getTime(),
    });
  }

  private repoMatches(ledgerRepo: string): boolean {
    const normalized = ledgerRepo.replace(/^github\.com\//, '').toLowerCase();
    return normalized === this.deps.repo.replace(/^github\.com\//, '').toLowerCase();
  }

  private emit(
    event: {
      ledger: 'ok' | 'malformed';
      next: string | null;
      depSatisfied: boolean;
      inFlight: boolean;
      claim: string;
      decision: 'spawn' | 'skip';
      reason: string;
    },
    issueNumber?: number,
  ): void {
    this.logger.info?.(`[umbrella-chain-advancer] ${JSON.stringify({
      issue: issueNumber ?? null,
      ...event,
    })}`);
  }
}

export function isUmbrellaChainAdvancerMode(value: string | undefined): value is UmbrellaChainAdvancerMode {
  return value === 'off' || value === 'observe' || value === 'spawn';
}

export function umbrellaChainAdvancerModeFromEnv(env: NodeJS.ProcessEnv = process.env): UmbrellaChainAdvancerMode {
  const value = env.KOOKR_UMBRELLA_CHAIN_ADVANCER?.trim().toLowerCase();
  return isUmbrellaChainAdvancerMode(value) ? value : 'off';
}
