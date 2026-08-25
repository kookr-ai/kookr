import type { Phase, PhaseStatus } from './phase-ledger.js';
import { isValidIsoTimestamp } from './iso-timestamp.js';
import { resolveAutonomousReviewIterationCap } from './autonomous-review-policy.js';

/** The first version of the machine-readable umbrella ledger. */
export const PHASE_LEDGER_SCHEMA_VERSION = 1 as const;
export const PHASE_LEDGER_FENCE = 'kookr-phase-ledger';

export type PhaseLedgerBlockedReason =
  | 'dependency-unmerged'
  | 'gate-red'
  | 'review-block'
  | 'stuck-claim'
  | 'malformed';

export interface PhaseLedgerPhase extends Phase {
  /** Explicit predecessor edge. D2 only accepts the adjacent predecessor. */
  dependsOn: readonly string[];
  /** The task that owns the phase, when the phase has been started. */
  taskId?: string;
  /** Set when the owner has reached a terminal task state. */
  ownerTerminal?: boolean;
  /** Timestamp at which the owning PR became merge-reachable. */
  mergedAt?: string;
  /** Independent post-merge review verdict for automation safety. */
  reviewVerdict?: 'pass' | 'block';
  /** Timestamp at which the independent review verdict was recorded. */
  reviewedAt?: string;
  /** Distinct task identity that produced the independent review verdict. */
  reviewerTaskId?: string;
  /** Durable count of correction/review attempts for this phase. */
  reviewAttempts?: number;
  /** Exact PR head SHA reviewed by the latest verdict. */
  reviewHeadSha?: string;
  /** Optional deliberate lower per-phase cap; omitted uses the shared default. */
  reviewIterationCap?: number;
}

export interface PhaseLedger {
  version: typeof PHASE_LEDGER_SCHEMA_VERSION;
  chainId: string;
  repo: string;
  issueNumber: number;
  phases: readonly PhaseLedgerPhase[];
  blockedReason?: PhaseLedgerBlockedReason;
  blockedSince?: string;
}

export interface PhaseResultComment {
  version: typeof PHASE_LEDGER_SCHEMA_VERSION;
  chainId: string;
  issueNumber: number;
  phaseId: string;
  prNumber?: number;
  status?: PhaseStatus;
  taskId?: string;
  ownerTerminal?: boolean;
  mergedAt?: string;
  reviewVerdict?: 'pass' | 'block';
  reviewedAt?: string;
  reviewerTaskId?: string;
  reviewAttempts?: number;
  reviewHeadSha?: string;
  reviewIterationCap?: number;
}

export class PhaseLedgerParseError extends Error {
  readonly code = 'phase-ledger-malformed';

  constructor(message: string) {
    super(message);
    this.name = 'PhaseLedgerParseError';
  }
}

const STATUSES: ReadonlySet<PhaseStatus> = new Set(['pending', 'in-flight', 'blocked', 'merged']);
const BLOCKED_REASONS: ReadonlySet<PhaseLedgerBlockedReason> = new Set([
  'dependency-unmerged',
  'gate-red',
  'review-block',
  'stuck-claim',
  'malformed',
]);

function fail(message: string): never {
  throw new PhaseLedgerParseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return isValidIsoTimestamp(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${context} contains unknown field ${JSON.stringify(key)}`);
  }
}

function parsePhase(value: unknown, index: number): PhaseLedgerPhase {
  if (!isRecord(value)) fail(`phase ${index + 1} must be an object`);
  assertOnlyKeys(
    value,
    ['id', 'prNumber', 'status', 'dependsOn', 'taskId', 'ownerTerminal', 'mergedAt', 'reviewVerdict', 'reviewedAt', 'reviewerTaskId', 'reviewAttempts', 'reviewHeadSha', 'reviewIterationCap'],
    `phase ${index + 1}`,
  );
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    fail(`phase ${index + 1} requires a non-empty id`);
  }
  if (!Array.isArray(value.dependsOn) || !value.dependsOn.every((edge) => typeof edge === 'string' && edge.length > 0)) {
    fail(`phase ${value.id} requires dependsOn as a string array`);
  }
  if (value.prNumber !== undefined && !isPositiveInteger(value.prNumber)) {
    fail(`phase ${value.id} has an invalid prNumber`);
  }
  if (value.status !== undefined && (typeof value.status !== 'string' || !STATUSES.has(value.status as PhaseStatus))) {
    fail(`phase ${value.id} has an invalid status`);
  }
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.trim() === '')) {
    fail(`phase ${value.id} has an invalid taskId`);
  }
  if (value.ownerTerminal !== undefined && typeof value.ownerTerminal !== 'boolean') {
    fail(`phase ${value.id} has an invalid ownerTerminal flag`);
  }
  if (value.mergedAt !== undefined && !isIsoDate(value.mergedAt)) {
    fail(`phase ${value.id} has an invalid mergedAt timestamp`);
  }
  if (value.reviewVerdict !== undefined && value.reviewVerdict !== 'pass' && value.reviewVerdict !== 'block') {
    fail(`phase ${value.id} has an invalid reviewVerdict`);
  }
  if (value.reviewedAt !== undefined && !isIsoDate(value.reviewedAt)) {
    fail(`phase ${value.id} has an invalid reviewedAt timestamp`);
  }
  if (value.reviewedAt !== undefined && value.reviewVerdict === undefined) {
    fail(`phase ${value.id} requires reviewVerdict when reviewedAt is present`);
  }
  if (value.reviewerTaskId !== undefined && (typeof value.reviewerTaskId !== 'string' || value.reviewerTaskId.trim() === '')) {
    fail(`phase ${value.id} has an invalid reviewerTaskId`);
  }
  if (value.reviewerTaskId !== undefined && value.reviewVerdict === undefined) {
    fail(`phase ${value.id} requires reviewVerdict when reviewerTaskId is present`);
  }
  if (value.reviewAttempts !== undefined && (!isPositiveInteger(value.reviewAttempts))) {
    fail(`phase ${value.id} has an invalid reviewAttempts`);
  }
  if (value.reviewHeadSha !== undefined && (typeof value.reviewHeadSha !== 'string' || value.reviewHeadSha.trim() === '')) {
    fail(`phase ${value.id} has an invalid reviewHeadSha`);
  }
  if (value.reviewIterationCap !== undefined) {
    if (!isPositiveInteger(value.reviewIterationCap)) fail(`phase ${value.id} has an invalid reviewIterationCap`);
    try {
      resolveAutonomousReviewIterationCap(value.reviewIterationCap);
    } catch {
      fail(`phase ${value.id} has an invalid reviewIterationCap`);
    }
  }
  return {
    id: value.id,
    dependsOn: [...value.dependsOn],
    ...(value.prNumber !== undefined ? { prNumber: value.prNumber } : {}),
    ...(value.status !== undefined ? { status: value.status as PhaseStatus } : {}),
    ...(value.taskId !== undefined ? { taskId: value.taskId } : {}),
    ...(value.ownerTerminal !== undefined ? { ownerTerminal: value.ownerTerminal } : {}),
    ...(value.mergedAt !== undefined ? { mergedAt: value.mergedAt } : {}),
    ...(value.reviewVerdict !== undefined ? { reviewVerdict: value.reviewVerdict } : {}),
    ...(value.reviewedAt !== undefined ? { reviewedAt: value.reviewedAt } : {}),
    ...(value.reviewerTaskId !== undefined ? { reviewerTaskId: value.reviewerTaskId } : {}),
    ...(value.reviewAttempts !== undefined ? { reviewAttempts: value.reviewAttempts } : {}),
    ...(value.reviewHeadSha !== undefined ? { reviewHeadSha: value.reviewHeadSha.toLowerCase() } : {}),
    ...(value.reviewIterationCap !== undefined ? { reviewIterationCap: value.reviewIterationCap } : {}),
  };
}

/** Validate a parsed ledger and return its normalized representation. */
export function validatePhaseLedger(value: unknown): PhaseLedger {
  if (!isRecord(value)) fail('ledger must be an object');
  assertOnlyKeys(value, ['version', 'chainId', 'repo', 'issueNumber', 'phases', 'blockedReason', 'blockedSince'], 'ledger');
  if (value.version !== PHASE_LEDGER_SCHEMA_VERSION) fail(`unsupported ledger version: ${String(value.version)}`);
  if (typeof value.chainId !== 'string' || value.chainId.trim() === '') fail('ledger requires a non-empty chainId');
  if (typeof value.repo !== 'string' || !/^(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo)) {
    fail('ledger requires repo in owner/repo or github.com/owner/repo form');
  }
  if (!isPositiveInteger(value.issueNumber)) fail('ledger requires a positive issueNumber');
  if (!Array.isArray(value.phases) || value.phases.length === 0) fail('ledger requires at least one phase');
  const phases = value.phases.map(parsePhase);
  const ids = new Set<string>();
  const prNumbers = new Set<number>();
  phases.forEach((phase, index) => {
    if (ids.has(phase.id)) fail(`duplicate phase id: ${phase.id}`);
    ids.add(phase.id);
    if (phase.prNumber !== undefined) {
      if (prNumbers.has(phase.prNumber)) fail(`duplicate PR number: ${phase.prNumber}`);
      prNumbers.add(phase.prNumber);
    }
    const expected = index === 0 ? [] : [phases[index - 1]!.id];
    if (phase.dependsOn.length !== expected.length || phase.dependsOn.some((id, edgeIndex) => id !== expected[edgeIndex])) {
      fail(`phase ${phase.id} must depend only on its adjacent predecessor`);
    }
  });
  if (value.blockedReason !== undefined && (typeof value.blockedReason !== 'string' || !BLOCKED_REASONS.has(value.blockedReason as PhaseLedgerBlockedReason))) {
    fail(`invalid blockedReason: ${String(value.blockedReason)}`);
  }
  if (value.blockedSince !== undefined && !isIsoDate(value.blockedSince)) fail('blockedSince must be an ISO timestamp');
  if (value.blockedSince !== undefined && value.blockedReason === undefined) fail('blockedSince requires blockedReason');
  return {
    version: PHASE_LEDGER_SCHEMA_VERSION,
    chainId: value.chainId,
    repo: value.repo,
    issueNumber: value.issueNumber,
    phases,
    ...(value.blockedReason !== undefined ? { blockedReason: value.blockedReason as PhaseLedgerBlockedReason } : {}),
    ...(value.blockedSince !== undefined ? { blockedSince: value.blockedSince } : {}),
  };
}

/** Parse the JSON payload inside one fenced `kookr-phase-ledger` block. */
export function parsePhaseLedgerBlock(block: string): PhaseLedger {
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    fail('ledger block is not valid JSON');
  }
  return validatePhaseLedger(value);
}

/** Serialize a validated ledger to its canonical fenced representation. */
export function serializePhaseLedgerBlock(ledger: PhaseLedger): string {
  const validated = validatePhaseLedger(ledger);
  return `\`\`\`${PHASE_LEDGER_FENCE}\n${JSON.stringify(validated, null, 2)}\n\`\`\``;
}

/** Locate and parse the single machine block in an umbrella issue body. */
export function parsePhaseLedgerFromIssueBody(body: string): PhaseLedger {
  const matches = [...body.matchAll(/```kookr-phase-ledger\s*\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length === 0) fail('issue body has no kookr-phase-ledger block');
  if (matches.length > 1) fail('issue body has multiple kookr-phase-ledger blocks');
  return parsePhaseLedgerBlock(matches[0]![1]!);
}

/** Replace the single machine block while preserving the surrounding prose. */
export function replacePhaseLedgerInIssueBody(body: string, ledger: PhaseLedger): string {
  const replacement = serializePhaseLedgerBlock(ledger);
  const matches = [...body.matchAll(/```kookr-phase-ledger\s*\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length > 1) fail('issue body has multiple kookr-phase-ledger blocks');
  if (matches.length === 0) return `${body.trimEnd()}\n\n${replacement}\n`;
  const match = matches[0]!;
  return `${body.slice(0, match.index)}${replacement}${body.slice(match.index! + match[0].length)}`;
}

/** Parse one append-only phase result comment. Invalid comments are ignored. */
export function parsePhaseResultComment(body: string): PhaseResultComment | null {
  const match = body.match(/<!--\s*kookr-phase-result\s+([\s\S]*?)\s*-->/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as unknown;
    if (!isRecord(value)) return null;
    assertOnlyKeys(value, ['version', 'chainId', 'issueNumber', 'phaseId', 'prNumber', 'status', 'taskId', 'ownerTerminal', 'mergedAt', 'reviewVerdict', 'reviewedAt', 'reviewerTaskId', 'reviewAttempts', 'reviewHeadSha', 'reviewIterationCap'], 'phase result');
    if (value.version !== PHASE_LEDGER_SCHEMA_VERSION || typeof value.chainId !== 'string' || !isPositiveInteger(value.issueNumber) || typeof value.phaseId !== 'string' || value.phaseId.length === 0) return null;
    if (value.prNumber !== undefined && !isPositiveInteger(value.prNumber)) return null;
    if (value.status !== undefined && (typeof value.status !== 'string' || !STATUSES.has(value.status as PhaseStatus))) return null;
    if (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.trim() === '')) return null;
    if (value.ownerTerminal !== undefined && typeof value.ownerTerminal !== 'boolean') return null;
    if (value.mergedAt !== undefined && !isIsoDate(value.mergedAt)) return null;
    if (value.reviewVerdict !== undefined && value.reviewVerdict !== 'pass' && value.reviewVerdict !== 'block') return null;
    if (value.reviewedAt !== undefined && !isIsoDate(value.reviewedAt)) return null;
    if (value.reviewedAt !== undefined && value.reviewVerdict === undefined) return null;
    if (value.reviewerTaskId !== undefined && (typeof value.reviewerTaskId !== 'string' || value.reviewerTaskId.trim() === '')) return null;
    if (value.reviewerTaskId !== undefined && value.reviewVerdict === undefined) return null;
    if (value.reviewAttempts !== undefined && !isPositiveInteger(value.reviewAttempts)) return null;
    if (value.reviewHeadSha !== undefined && (typeof value.reviewHeadSha !== 'string' || value.reviewHeadSha.trim() === '')) return null;
    if (value.reviewIterationCap !== undefined) {
      if (!isPositiveInteger(value.reviewIterationCap)) return null;
      try {
        resolveAutonomousReviewIterationCap(value.reviewIterationCap);
      } catch {
        return null;
      }
    }
    return {
      version: PHASE_LEDGER_SCHEMA_VERSION,
      chainId: value.chainId,
      issueNumber: value.issueNumber,
      phaseId: value.phaseId,
      ...(value.prNumber !== undefined ? { prNumber: value.prNumber } : {}),
      ...(value.status !== undefined ? { status: value.status as PhaseStatus } : {}),
      ...(value.taskId !== undefined ? { taskId: value.taskId } : {}),
      ...(value.ownerTerminal !== undefined ? { ownerTerminal: value.ownerTerminal } : {}),
      ...(value.mergedAt !== undefined ? { mergedAt: value.mergedAt } : {}),
      ...(value.reviewVerdict !== undefined ? { reviewVerdict: value.reviewVerdict } : {}),
      ...(value.reviewedAt !== undefined ? { reviewedAt: value.reviewedAt } : {}),
      ...(value.reviewerTaskId !== undefined ? { reviewerTaskId: value.reviewerTaskId } : {}),
      ...(value.reviewAttempts !== undefined ? { reviewAttempts: value.reviewAttempts } : {}),
      ...(value.reviewHeadSha !== undefined ? { reviewHeadSha: value.reviewHeadSha.toLowerCase() } : {}),
      ...(value.reviewIterationCap !== undefined ? { reviewIterationCap: value.reviewIterationCap } : {}),
    };
  } catch {
    return null;
  }
}

/** Apply append-only comments to a ledger; the body remains D2-owned. */
export function reconcilePhaseResultComments(
  ledger: PhaseLedger,
  comments: readonly string[],
): PhaseLedger {
  const phases = ledger.phases.map((phase) => ({ ...phase }));
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  for (const commentBody of comments) {
    const result = parsePhaseResultComment(commentBody);
    if (!result || result.chainId !== ledger.chainId || result.issueNumber !== ledger.issueNumber) continue;
    const phase = byId.get(result.phaseId);
    if (!phase) continue;
    if (result.reviewVerdict !== undefined && (result.reviewAttempts ?? 1) < (phase.reviewAttempts ?? 0)) continue;
    if (result.prNumber !== undefined) phase.prNumber = result.prNumber;
    if (result.status !== undefined) phase.status = result.status;
    if (result.taskId !== undefined) phase.taskId = result.taskId;
    if (result.ownerTerminal !== undefined) phase.ownerTerminal = result.ownerTerminal;
    if (result.mergedAt !== undefined) phase.mergedAt = result.mergedAt;
    if (result.reviewVerdict !== undefined) {
      phase.reviewVerdict = result.reviewVerdict;
      if (result.reviewHeadSha !== undefined) phase.reviewHeadSha = result.reviewHeadSha;
      else delete phase.reviewHeadSha;
    }
    if (result.reviewedAt !== undefined) phase.reviewedAt = result.reviewedAt;
    if (result.reviewerTaskId !== undefined) phase.reviewerTaskId = result.reviewerTaskId;
    if (result.reviewVerdict !== undefined) {
      // Verdict comments are append-only but the same history is reconciled on
      // every sweep. Explicit counts are authoritative only monotonically;
      // omitted legacy counts never increment on replay.
      phase.reviewAttempts = Math.max(phase.reviewAttempts ?? 0, result.reviewAttempts ?? 1);
    }
    if (result.reviewIterationCap !== undefined) phase.reviewIterationCap = result.reviewIterationCap;
  }
  return validatePhaseLedger({ ...ledger, phases });
}
