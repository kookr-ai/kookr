import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentType } from '../../shared/contracts/agent-types.js';
import type { CoordinatorDetectorId } from '../../shared/contracts/coordinator.js';

export interface CoordinatorSuppressionEntry {
  key: string;
  detectorId: CoordinatorDetectorId;
  agentType: AgentType;
  taskId?: string;
  suppressedUntil: string;
  dismissalCount: number;
  lastDismissedAt: string;
}

interface CoordinatorSuppressionFile {
  version: 'coordinator-suppressions.v1';
  suppressions: CoordinatorSuppressionEntry[];
}

export interface CoordinatorSuppressionReader {
  isSuppressed(detectorId: CoordinatorDetectorId, agentType: AgentType, now?: Date, taskId?: string): boolean;
}

export interface CoordinatorSuppressionRegistry extends CoordinatorSuppressionReader {
  suppress(detectorId: CoordinatorDetectorId, agentType: AgentType, now?: Date): CoordinatorSuppressionEntry;
  acknowledgeTask(detectorId: CoordinatorDetectorId, agentType: AgentType, taskId: string, now?: Date): CoordinatorSuppressionEntry;
}

export class CoordinatorSuppressionStore implements CoordinatorSuppressionRegistry {
  private readonly filePath: string;
  private readonly feedbackPath: string;

  constructor(kookrDir: string | undefined) {
    const root = kookrDir ?? process.cwd();
    this.filePath = join(root, 'coordinator-suppressions.json');
    this.feedbackPath = join(root, 'coordinator-feedback.jsonl');
  }

  isSuppressed(detectorId: CoordinatorDetectorId, agentType: AgentType, now = new Date(), taskId?: string): boolean {
    const state = this.read();
    const keys = [
      ...(taskId ? [taskAcknowledgementKey(detectorId, agentType, taskId)] : []),
      suppressionKey(detectorId, agentType),
    ];
    return keys.some((key) => {
      const entry = state.suppressions.find((candidate) => candidate.key === key);
      return entry ? new Date(entry.suppressedUntil).getTime() > now.getTime() : false;
    });
  }

  suppress(detectorId: CoordinatorDetectorId, agentType: AgentType, now = new Date()): CoordinatorSuppressionEntry {
    const state = this.read();
    const key = suppressionKey(detectorId, agentType);
    const existing = state.suppressions.find((entry) => entry.key === key);
    const dismissalCount = (existing?.dismissalCount ?? 0) + 1;
    const durationMs = dismissalCount >= 3 ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const next: CoordinatorSuppressionEntry = {
      key,
      detectorId,
      agentType,
      dismissalCount,
      lastDismissedAt: now.toISOString(),
      suppressedUntil: new Date(now.getTime() + durationMs).toISOString(),
    };

    state.suppressions = [
      ...state.suppressions.filter((entry) => entry.key !== key),
      next,
    ].sort((left, right) => left.key.localeCompare(right.key));
    this.write(state);

    if (dismissalCount === 3) {
      appendFileSync(this.feedbackPath, `${JSON.stringify({
        type: 'suppression_widened',
        key,
        detectorId,
        agentType,
        dismissedAt: next.lastDismissedAt,
        suppressedUntil: next.suppressedUntil,
      })}\n`, 'utf8');
    }

    return next;
  }

  acknowledgeTask(detectorId: CoordinatorDetectorId, agentType: AgentType, taskId: string, now = new Date()): CoordinatorSuppressionEntry {
    const state = this.read();
    const key = taskAcknowledgementKey(detectorId, agentType, taskId);
    const next: CoordinatorSuppressionEntry = {
      key,
      detectorId,
      agentType,
      taskId,
      dismissalCount: 1,
      lastDismissedAt: now.toISOString(),
      suppressedUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    state.suppressions = [
      ...state.suppressions.filter((entry) => entry.key !== key),
      next,
    ].sort((left, right) => left.key.localeCompare(right.key));
    this.write(state);
    return next;
  }

  private read(): CoordinatorSuppressionFile {
    if (!existsSync(this.filePath)) {
      return { version: 'coordinator-suppressions.v1', suppressions: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CoordinatorSuppressionFile>;
      if (parsed.version !== 'coordinator-suppressions.v1' || !Array.isArray(parsed.suppressions)) {
        return { version: 'coordinator-suppressions.v1', suppressions: [] };
      }
      return {
        version: 'coordinator-suppressions.v1',
        suppressions: parsed.suppressions.filter(isEntry),
      };
    } catch {
      return { version: 'coordinator-suppressions.v1', suppressions: [] };
    }
  }

  private write(state: CoordinatorSuppressionFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

export function suppressionKey(detectorId: CoordinatorDetectorId, agentType: AgentType): string {
  return `${detectorId}:${agentType}`;
}

export function taskAcknowledgementKey(detectorId: CoordinatorDetectorId, agentType: AgentType, taskId: string): string {
  return `${suppressionKey(detectorId, agentType)}:task:${taskId}`;
}

function isEntry(value: unknown): value is CoordinatorSuppressionEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CoordinatorSuppressionEntry>;
  return typeof candidate.key === 'string'
    && isDetectorId(candidate.detectorId)
    && (candidate.agentType === 'claude-code' || candidate.agentType === 'codex-cli')
    && (candidate.taskId === undefined || typeof candidate.taskId === 'string')
    && typeof candidate.suppressedUntil === 'string'
    && typeof candidate.dismissalCount === 'number'
    && typeof candidate.lastDismissedAt === 'string';
}

function isDetectorId(value: unknown): value is CoordinatorDetectorId {
  return value === 'declared_edge' || value === 'stale' || value === 'duplicate' || value === 'done_not_cleared';
}
