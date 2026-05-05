/**
 * WorkspaceAttemptRepository — single owner of durable attempt records.
 *
 * Every preflight and cleanup action writes a record here.
 * Records survive UI disconnects and partial failures.
 * StartWorkService and CleanupService write through this boundary;
 * ContributionWorkspaceQuery reads through it.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  WorkspaceAttemptRecord,
  AttemptType,
  AttemptStatus,
  AttemptDisposition,
  StartWorkHandoff,
} from './workspace-types.js';

interface WorkspaceAttemptFile {
  version: 1;
  attempts: WorkspaceAttemptRecord[];
  handoffs: StartWorkHandoff[];
}

export class WorkspaceAttemptRepository {
  private attempts = new Map<string, WorkspaceAttemptRecord>();
  private handoffs = new Map<string, StartWorkHandoff>();
  private filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Create a new attempt record. Returns the generated attemptId. */
  createAttempt(params: {
    type: AttemptType;
    projectId: string;
    worktreePath?: string;
    branch?: string;
    baselineRef?: string;
    baselineSha?: string;
    reasonCode: string;
    source: string;
    evidenceSummary: string;
    correlatedTaskId?: string;
    correlatedSessionId?: string;
    requestedDeleteBranch?: boolean;
    requestedDiscardDirtyState?: boolean;
    reviewFingerprint?: string;
    sweepRunId?: string;
  }): WorkspaceAttemptRecord {
    const now = new Date().toISOString();
    const record: WorkspaceAttemptRecord = {
      attemptId: randomUUID(),
      type: params.type,
      projectId: params.projectId,
      worktreePath: params.worktreePath,
      branch: params.branch,
      baselineRef: params.baselineRef,
      baselineSha: params.baselineSha,
      reasonCode: params.reasonCode,
      source: params.source,
      observedAt: now,
      startedAt: now,
      status: 'running',
      disposition: 'blocked',
      evidenceSummary: params.evidenceSummary,
      correlatedTaskId: params.correlatedTaskId,
      correlatedSessionId: params.correlatedSessionId,
      requestedDeleteBranch: params.requestedDeleteBranch,
      requestedDiscardDirtyState: params.requestedDiscardDirtyState,
      reviewFingerprint: params.reviewFingerprint,
      sweepRunId: params.sweepRunId,
    };
    this.attempts.set(record.attemptId, record);
    this.persist();
    return record;
  }

  /** Update an attempt's status and disposition. */
  updateAttempt(
    attemptId: string,
    patch: {
      status?: AttemptStatus;
      disposition?: AttemptDisposition;
      finishedAt?: string;
      lastProgressAt?: string;
      evidenceSummary?: string;
      stderrSummary?: string;
      correlatedTaskId?: string;
      correlatedSessionId?: string;
    },
  ): WorkspaceAttemptRecord | undefined {
    const record = this.attempts.get(attemptId);
    if (!record) return undefined;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.disposition !== undefined) record.disposition = patch.disposition;
    if (patch.finishedAt !== undefined) record.finishedAt = patch.finishedAt;
    if (patch.lastProgressAt !== undefined) record.lastProgressAt = patch.lastProgressAt;
    if (patch.evidenceSummary !== undefined) record.evidenceSummary = patch.evidenceSummary;
    if (patch.stderrSummary !== undefined) record.stderrSummary = patch.stderrSummary;
    if (patch.correlatedTaskId !== undefined) record.correlatedTaskId = patch.correlatedTaskId;
    if (patch.correlatedSessionId !== undefined) record.correlatedSessionId = patch.correlatedSessionId;
    this.persist();
    return record;
  }

  /** Complete an attempt (set status + disposition + finishedAt). */
  completeAttempt(
    attemptId: string,
    disposition: AttemptDisposition,
    evidenceSummary?: string,
  ): WorkspaceAttemptRecord | undefined {
    return this.updateAttempt(attemptId, {
      status: 'completed',
      disposition,
      finishedAt: new Date().toISOString(),
      evidenceSummary,
    });
  }

  /** Mark an attempt as passed. */
  passAttempt(attemptId: string, evidenceSummary?: string): WorkspaceAttemptRecord | undefined {
    return this.updateAttempt(attemptId, {
      status: 'passed',
      disposition: 'passed',
      finishedAt: new Date().toISOString(),
      evidenceSummary,
    });
  }

  /** Mark an attempt as blocked. */
  blockAttempt(attemptId: string, evidenceSummary?: string): WorkspaceAttemptRecord | undefined {
    return this.updateAttempt(attemptId, {
      status: 'blocked',
      disposition: 'blocked',
      finishedAt: new Date().toISOString(),
      evidenceSummary,
    });
  }

  /** Get a single attempt by ID. */
  getAttempt(attemptId: string): WorkspaceAttemptRecord | undefined {
    return this.attempts.get(attemptId);
  }

  /** List attempts for a project, ordered by startedAt descending. */
  listByProject(projectId: string, limit = 20): WorkspaceAttemptRecord[] {
    const result: WorkspaceAttemptRecord[] = [];
    for (const record of this.attempts.values()) {
      if (record.projectId === projectId) {
        result.push(record);
      }
    }
    result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return result.slice(0, limit);
  }

  /** Record a Start Work handoff. */
  recordHandoff(params: {
    projectId: string;
    taskId: string;
    sessionId?: string;
    prompt: string;
    playbookId?: string;
  }): StartWorkHandoff {
    const handoff: StartWorkHandoff = {
      handoffId: randomUUID(),
      projectId: params.projectId,
      taskId: params.taskId,
      sessionId: params.sessionId,
      launchedAt: new Date().toISOString(),
      prompt: params.prompt,
      playbookId: params.playbookId,
    };
    this.handoffs.set(handoff.handoffId, handoff);
    this.persist();
    return handoff;
  }

  /** Get recent handoffs for a project. */
  listHandoffsByProject(projectId: string, limit = 10): StartWorkHandoff[] {
    const result: StartWorkHandoff[] = [];
    for (const handoff of this.handoffs.values()) {
      if (handoff.projectId === projectId) {
        result.push(handoff);
      }
    }
    result.sort((a, b) => b.launchedAt.localeCompare(a.launchedAt));
    return result.slice(0, limit);
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WorkspaceAttemptFile>;
      for (const attempt of parsed.attempts ?? []) {
        this.attempts.set(attempt.attemptId, attempt);
      }
      for (const handoff of parsed.handoffs ?? []) {
        this.handoffs.set(handoff.handoffId, handoff);
      }
    } catch (err) {
      console.warn('[workspace] Failed to load workspace attempt history:', err instanceof Error ? err.message : err);
      this.attempts.clear();
      this.handoffs.clear();
    }
  }

  private persist(): void {
    if (!this.filePath) return;

    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = join(dirname(this.filePath), `.tmp-${randomUUID()}`);
    const payload: WorkspaceAttemptFile = {
      version: 1,
      attempts: Array.from(this.attempts.values()),
      handoffs: Array.from(this.handoffs.values()),
    };

    const fd = openSync(tempPath, 'w');
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tempPath, this.filePath);
  }
}
