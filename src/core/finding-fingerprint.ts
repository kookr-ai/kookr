import type { Anomaly } from './types.js';
import { stableAnomalyExplanation } from './anomaly-fingerprint.js';

/**
 * Fingerprint inputs #1326 layers on top of the raw {@link Anomaly}.
 *
 * A finding belongs to a durable *task*, not to the volatile session/agent that
 * happened to surface it. Two supervision sweeps of the same waiting task run
 * under different `agentId`s (Ralph iterations, crash-relaunched sessions), so
 * the caller supplies the owning `taskId` to key the finding to that durable
 * identity. When no task is known (orphan / resolver-less tests) the fingerprint
 * falls back to `anomaly.agentId`.
 */
export interface FindingFingerprintInput {
  /** Owning task id — the durable identity a finding belongs to. Falls back to `agentId`. */
  taskId?: string | null;
  /**
   * Opaque marker of the underlying task/question state (e.g. a task revision or
   * updatedAt). When it changes the finding is superseded even if the normalized
   * question text is byte-identical — an escape hatch for "same words, different
   * situation". Omit to fingerprint purely on the question/context text.
   */
  stateVersion?: string | number | null;
}

const UNIT = '␟'; // ␟ — record separator; never appears in explanations.

/**
 * Normalize free-text question/context so that superficially-different but
 * equivalent detections collapse to the same value. Lower-cases, strips quote
 * characters, collapses runs of whitespace, and drops trailing sentence
 * punctuation. This is what stops a five-sweep snooze storm: the same unresolved
 * question re-detected with drifted quoting/whitespace still normalizes equal, so
 * it stays one logical finding instead of forking a fresh alert each sweep.
 */
export function normalizeFindingContext(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”„‟"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

/** Resolve the durable identity a finding is keyed to: the task, else the agent. */
function findingIdentity(anomaly: Anomaly, input: FindingFingerprintInput): string {
  // Treat an empty/blank taskId as "no task known" so it falls back to the agent
  // rather than collapsing every same-type finding across agents into one lineage.
  const taskId = input.taskId?.trim();
  return taskId ? taskId : anomaly.agentId;
}

/**
 * Lineage key: the identity that stays stable while a question evolves. Equal to
 * `identity + anomaly type` — deliberately excluding sub-type, question text, and
 * state version. All detections of the same anomaly kind on the same task share a
 * lineage key, so a changed question *supersedes* the existing finding (same
 * lineage, new fingerprint) rather than opening an unrelated second one.
 */
export function findingLineageKey(anomaly: Anomaly, input: FindingFingerprintInput = {}): string {
  return `${findingIdentity(anomaly, input)}${UNIT}${anomaly.type}`;
}

/**
 * Stable fingerprint of a finding: lineage key + sub-type + normalized
 * question/context + state version. Two detections with equal fingerprints are
 * the *same* logical finding (dedupe); a different fingerprint within the same
 * lineage is a material change (supersede).
 */
export function findingFingerprint(anomaly: Anomaly, input: FindingFingerprintInput = {}): string {
  const context = normalizeFindingContext(stableAnomalyExplanation(anomaly));
  const version = input.stateVersion == null ? '' : String(input.stateVersion);
  return [
    findingLineageKey(anomaly, input),
    anomaly.subType ?? '',
    context,
    version,
  ].join(UNIT);
}

/** True when two fingerprints denote the same logical finding (dedupe-equivalent). */
export function findingsAreEquivalent(a: string, b: string): boolean {
  return a === b;
}

/** True when `next` materially changes the finding relative to `previous` (supersede). */
export function isMaterialChange(previous: string, next: string): boolean {
  return previous !== next;
}
