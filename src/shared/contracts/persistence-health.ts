export type PersistenceHealthTarget = 'task_state' | 'detection_stats';

export interface PersistenceHealthError {
  message: string;
  name?: string;
  code?: string;
  hard: boolean;
}

export interface PersistenceTargetHealth {
  target: PersistenceHealthTarget;
  totalAttempts: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: PersistenceHealthError | null;
}

export interface PersistenceHealthSnapshot {
  schemaVersion: 'persistence-health.v1';
  targets: Record<PersistenceHealthTarget, PersistenceTargetHealth>;
}
