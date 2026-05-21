export type CoordinatorDetectorId = 'stale' | 'duplicate' | 'done_not_cleared';

export interface CoordinatorDetectorOutput {
  detectorId: CoordinatorDetectorId;
  taskId: string;
  evidence: Record<string, unknown>;
}

export interface CoordinatorSnapshotState {
  outputs: CoordinatorDetectorOutput[];
}
