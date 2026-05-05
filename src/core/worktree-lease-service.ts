/**
 * WorktreeLeaseService — single owner of authoritative Kookr occupancy state.
 *
 * This is the primary source of truth for whether a worktree is "busy".
 * Task and session lifecycle must write through this service.
 * Direct task/session state is not allowed to independently determine busy.
 */

import type { WorktreeLease } from './workspace-types.js';
import type { TaskStore } from './tasks.js';

const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface LeaseServiceOptions {
  staleThresholdMs?: number;
}

export class WorktreeLeaseService {
  private leases = new Map<string, WorktreeLease>();
  private staleThresholdMs: number;

  constructor(opts?: LeaseServiceOptions) {
    this.staleThresholdMs = opts?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  /** Acquire a lease for a worktree. Fails if already actively held by a different owner. Stale leases are overwritten. */
  acquire(worktreePath: string, ownerId: string): WorktreeLease {
    const existing = this.leases.get(worktreePath);
    if (existing && existing.ownerId !== ownerId) {
      // Allow overwriting stale leases (heartbeat exceeded threshold)
      const age = Date.now() - new Date(existing.lastHeartbeatAt).getTime();
      if (age < this.staleThresholdMs) {
        throw new Error(
          `Worktree ${worktreePath} is already leased by ${existing.ownerId}`,
        );
      }
    }

    const now = new Date().toISOString();
    // Preserve acquiredAt only when the same owner re-acquires
    const preserveAcquiredAt = existing?.ownerId === ownerId ? existing.acquiredAt : now;
    const lease: WorktreeLease = {
      worktreePath,
      ownerId,
      acquiredAt: preserveAcquiredAt,
      lastHeartbeatAt: now,
    };
    this.leases.set(worktreePath, lease);
    return lease;
  }

  /** Release a lease. Only the owner can release. */
  release(worktreePath: string, ownerId: string): boolean {
    const existing = this.leases.get(worktreePath);
    if (!existing) return false;
    if (existing.ownerId !== ownerId) return false;
    this.leases.delete(worktreePath);
    return true;
  }

  /** Update heartbeat timestamp. Only the owner can heartbeat. */
  heartbeat(worktreePath: string, ownerId: string): boolean {
    const existing = this.leases.get(worktreePath);
    if (!existing || existing.ownerId !== ownerId) return false;
    existing.lastHeartbeatAt = new Date().toISOString();
    return true;
  }

  /** List all active (non-stale) leases. */
  listActiveLeases(): WorktreeLease[] {
    const now = Date.now();
    const result: WorktreeLease[] = [];
    for (const lease of this.leases.values()) {
      const age = now - new Date(lease.lastHeartbeatAt).getTime();
      if (age < this.staleThresholdMs) {
        result.push({ ...lease });
      }
    }
    return result;
  }

  /** Check if a worktree has an active lease. */
  isLeased(worktreePath: string): boolean {
    const lease = this.leases.get(worktreePath);
    if (!lease) return false;
    const age = Date.now() - new Date(lease.lastHeartbeatAt).getTime();
    return age < this.staleThresholdMs;
  }

  /** Get the lease for a worktree, if any. */
  getLease(worktreePath: string): WorktreeLease | undefined {
    return this.leases.get(worktreePath);
  }

  /**
   * Backfill leases from existing task/session state.
   * Called at startup and crash recovery to ensure lease state
   * reflects reality before cleanup becomes actionable.
   */
  reconcileFromTaskStore(taskStore: TaskStore): { backfilled: number; released: number } {
    const activeSessions = taskStore.getActiveSessions();
    const activeWorktrees = new Set<string>();
    let backfilled = 0;

    // Backfill leases for active sessions with worktree paths
    for (const { taskId, session } of activeSessions) {
      if (session.gitIsWorktree && session.cwd) {
        activeWorktrees.add(session.cwd);
        if (!this.leases.has(session.cwd)) {
          this.acquire(session.cwd, taskId);
          backfilled++;
        }
      }
    }

    // Release leases for worktrees that no longer have active sessions
    let released = 0;
    for (const [path] of this.leases) {
      if (!activeWorktrees.has(path)) {
        this.leases.delete(path);
        released++;
      }
    }

    return { backfilled, released };
  }

  /**
   * Force-clear a stale lease. This is an operator action that must be
   * audited and surfaced in logs.
   */
  clearStaleLease(worktreePath: string, operator: string): boolean {
    const existing = this.leases.get(worktreePath);
    if (!existing) return false;
    console.log(
      `[lease] Forced stale-lease clear: path=${worktreePath} ` +
      `previousOwner=${existing.ownerId} operator=${operator}`,
    );
    this.leases.delete(worktreePath);
    return true;
  }

  /** Get all leases (including potentially stale ones). */
  getAllLeases(): WorktreeLease[] {
    return Array.from(this.leases.values()).map((l) => ({ ...l }));
  }
}
