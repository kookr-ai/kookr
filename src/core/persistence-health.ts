import type {
  PersistenceHealthError,
  PersistenceHealthSnapshot,
  PersistenceHealthTarget,
  PersistenceTargetHealth,
} from '../shared/contracts/persistence-health.js';

export type {
  PersistenceHealthError,
  PersistenceHealthSnapshot,
  PersistenceHealthTarget,
  PersistenceTargetHealth,
};

export interface PersistenceHealthRecorder {
  recordSuccess(target: PersistenceHealthTarget): void;
  recordFailure(target: PersistenceHealthTarget, error: unknown): void;
}

const TARGETS: PersistenceHealthTarget[] = ['task_state', 'detection_stats'];
const HARD_ERROR_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EROFS']);

function emptyTarget(target: PersistenceHealthTarget): PersistenceTargetHealth {
  return {
    target,
    totalAttempts: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

export function normalizePersistenceError(error: unknown): PersistenceHealthError {
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === 'string'
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return {
      message: error.message,
      name: error.name,
      ...(code ? { code } : {}),
      hard: code ? HARD_ERROR_CODES.has(code) : false,
    };
  }
  return {
    message: String(error),
    hard: false,
  };
}

export class PersistenceHealthTracker implements PersistenceHealthRecorder {
  private readonly targets: Record<PersistenceHealthTarget, PersistenceTargetHealth>;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.targets = {
      task_state: emptyTarget('task_state'),
      detection_stats: emptyTarget('detection_stats'),
    };
  }

  recordSuccess(target: PersistenceHealthTarget): void {
    const state = this.targets[target];
    const now = this.now().toISOString();
    state.totalAttempts += 1;
    state.consecutiveFailures = 0;
    state.lastAttemptAt = now;
    state.lastSuccessAt = now;
    state.lastError = null;
  }

  recordFailure(target: PersistenceHealthTarget, error: unknown): void {
    const state = this.targets[target];
    const now = this.now().toISOString();
    state.totalAttempts += 1;
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastAttemptAt = now;
    state.lastFailureAt = now;
    state.lastError = normalizePersistenceError(error);
  }

  snapshot(): PersistenceHealthSnapshot {
    return {
      schemaVersion: 'persistence-health.v1',
      targets: Object.fromEntries(
        TARGETS.map((target) => [
          target,
          {
            ...this.targets[target],
            lastError: this.targets[target].lastError ? { ...this.targets[target].lastError } : null,
          },
        ]),
      ) as Record<PersistenceHealthTarget, PersistenceTargetHealth>,
    };
  }
}
