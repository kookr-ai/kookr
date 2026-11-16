import type { AgentType } from './agent-types.js';
import type { TerminationReason } from './task-status.js';

export type CoordinatorDetectorId = 'declared_edge' | 'stale' | 'duplicate' | 'done_not_cleared';

export type CoordinatorRecommendationAction = 'nudge' | 'compare' | 'acknowledge' | 'snooze';

export interface CoordinatorDetectorOutput {
  detectorId: CoordinatorDetectorId;
  taskId: string;
  evidence: Record<string, unknown>;
}

export interface CoordinatorTaskChip {
  taskId: string;
  detectorId: CoordinatorDetectorId;
  agentType: AgentType;
  action: CoordinatorRecommendationAction;
  verb: string;
  evidenceGlyph: string;
  evidenceCount: number;
  title: string;
  peerTaskIds?: string[];
}

export interface CoordinatorFinding {
  id: string;
  kind: 'duplicate_cluster' | 'orphan_blocker';
  title: string;
  taskIds: string[];
  evidenceGlyph: string;
  evidenceCount: number;
}

export interface CoordinatorChainMember {
  taskId: string;
  label: string;
  status: string;
  relation: 'parent' | 'child' | 'blocks' | 'blocked_by';
  /**
   * Why the task was terminated, sent only when `status` is `terminated`. The
   * chain strip uses it to keep failed tasks visible and hide deliberate stops
   * (`manual`, `supervisor`) behind "Show all" (#3946).
   */
  terminationReason?: TerminationReason;
}

export interface CoordinatorChainStrip {
  members: CoordinatorChainMember[];
  priorTaskIds: string[];
  concurrencyToken: string;
}

export interface CoordinatorSnapshotState {
  outputs: CoordinatorDetectorOutput[];
  chips: CoordinatorTaskChip[];
  findings: CoordinatorFinding[];
  chains: Record<string, CoordinatorChainStrip>;
}
