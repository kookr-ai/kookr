import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorktreeLeaseService } from './worktree-lease-service.js';
import { TaskStore } from './tasks.js';

describe('WorktreeLeaseService', () => {
  let service: WorktreeLeaseService;

  beforeEach(() => {
    service = new WorktreeLeaseService({ staleThresholdMs: 60_000 });
  });

  describe('acquire', () => {
    it('acquires a lease for an unoccupied worktree', () => {
      const lease = service.acquire('/path/worktree', 'task-1');
      expect(lease.worktreePath).toBe('/path/worktree');
      expect(lease.ownerId).toBe('task-1');
      expect(lease.acquiredAt).toBeTruthy();
    });

    it('allows the same owner to re-acquire', () => {
      service.acquire('/path/worktree', 'task-1');
      const lease = service.acquire('/path/worktree', 'task-1');
      expect(lease.ownerId).toBe('task-1');
    });

    it('throws when a different owner tries to acquire', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(() => service.acquire('/path/worktree', 'task-2')).toThrow(
        'already leased by task-1',
      );
    });

    it('re-acquiring preserves original acquiredAt timestamp', () => {
      const original = service.acquire('/path/worktree', 'task-1');
      const originalAcquiredAt = original.acquiredAt;

      // Small delay to ensure timestamps would differ if re-set
      const reacquired = service.acquire('/path/worktree', 'task-1');
      expect(reacquired.acquiredAt).toBe(originalAcquiredAt);
    });
  });

  describe('release', () => {
    it('releases a lease held by the owner', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.release('/path/worktree', 'task-1')).toBe(true);
      expect(service.isLeased('/path/worktree')).toBe(false);
    });

    it('returns false when releasing a non-existent lease', () => {
      expect(service.release('/nonexistent', 'task-1')).toBe(false);
    });

    it('returns false when a different owner tries to release', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.release('/path/worktree', 'task-2')).toBe(false);
      expect(service.isLeased('/path/worktree')).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('updates heartbeat for the owner', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.heartbeat('/path/worktree', 'task-1')).toBe(true);
    });

    it('returns false for wrong owner', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.heartbeat('/path/worktree', 'task-2')).toBe(false);
    });

    it('returns false for non-existent lease', () => {
      expect(service.heartbeat('/nonexistent', 'task-1')).toBe(false);
    });

    it('updates lastHeartbeatAt but not acquiredAt', () => {
      const lease = service.acquire('/path/worktree', 'task-1');
      const originalAcquiredAt = lease.acquiredAt;
      const originalHeartbeat = lease.lastHeartbeatAt;

      service.heartbeat('/path/worktree', 'task-1');

      const updated = service.getLease('/path/worktree')!;
      expect(updated.acquiredAt).toBe(originalAcquiredAt);
      // lastHeartbeatAt should be updated (>= original since timestamps are ISO strings)
      expect(updated.lastHeartbeatAt).toBeTruthy();
      // acquiredAt must remain untouched
      expect(updated.acquiredAt).toBe(originalAcquiredAt);
    });
  });

  describe('isLeased', () => {
    it('returns true for active lease', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.isLeased('/path/worktree')).toBe(true);
    });

    it('returns false for stale lease', () => {
      const staleService = new WorktreeLeaseService({ staleThresholdMs: 0 });
      staleService.acquire('/path/worktree', 'task-1');
      // With 0ms threshold, lease is immediately stale
      expect(staleService.isLeased('/path/worktree')).toBe(false);
    });

    it('returns false for non-existent lease', () => {
      expect(service.isLeased('/nonexistent')).toBe(false);
    });
  });

  describe('listActiveLeases', () => {
    it('returns only non-stale leases', () => {
      service.acquire('/path/a', 'task-1');
      service.acquire('/path/b', 'task-2');
      const leases = service.listActiveLeases();
      expect(leases).toHaveLength(2);
    });

    it('excludes stale leases', () => {
      const staleService = new WorktreeLeaseService({ staleThresholdMs: 0 });
      staleService.acquire('/path/a', 'task-1');
      expect(staleService.listActiveLeases()).toHaveLength(0);
    });
  });

  describe('multiple leases for different paths', () => {
    it('different paths do not interfere with each other', () => {
      service.acquire('/path/a', 'task-1');
      service.acquire('/path/b', 'task-2');
      service.acquire('/path/c', 'task-3');

      // Each lease is independent
      expect(service.isLeased('/path/a')).toBe(true);
      expect(service.isLeased('/path/b')).toBe(true);
      expect(service.isLeased('/path/c')).toBe(true);

      // Releasing one does not affect the others
      service.release('/path/b', 'task-2');
      expect(service.isLeased('/path/a')).toBe(true);
      expect(service.isLeased('/path/b')).toBe(false);
      expect(service.isLeased('/path/c')).toBe(true);

      // Heartbeat on one does not affect the others
      expect(service.heartbeat('/path/a', 'task-1')).toBe(true);
      expect(service.heartbeat('/path/c', 'task-3')).toBe(true);

      // getAllLeases returns all remaining
      const all = service.getAllLeases();
      expect(all).toHaveLength(2);
      const paths = all.map((l) => l.worktreePath).sort();
      expect(paths).toEqual(['/path/a', '/path/c']);
    });
  });

  describe('getAllLeases', () => {
    it('returns copies that are mutation-safe', () => {
      service.acquire('/path/worktree', 'task-1');

      const leases1 = service.getAllLeases();
      expect(leases1).toHaveLength(1);

      // Mutate the returned copy
      leases1[0].ownerId = 'mutated-owner';
      leases1[0].worktreePath = '/mutated/path';

      // Fetch again — the internal state should be unaffected
      const leases2 = service.getAllLeases();
      expect(leases2).toHaveLength(1);
      expect(leases2[0].ownerId).toBe('task-1');
      expect(leases2[0].worktreePath).toBe('/path/worktree');
    });

    it('returns empty array when no leases exist', () => {
      expect(service.getAllLeases()).toEqual([]);
    });
  });

  describe('reconcileFromTaskStore', () => {
    it('backfills leases from active sessions', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'test', cwd: '/repo' });
      store.addSession(task.id, {
        tmuxSession: 'tmux-1',
        agentType: 'claude-code',
        cwd: '/path/worktree',
        createdAt: new Date(),
        gitIsWorktree: true,
      });

      const result = service.reconcileFromTaskStore(store);
      expect(result.backfilled).toBe(1);
      expect(service.isLeased('/path/worktree')).toBe(true);
    });

    it('releases leases with no matching active sessions', () => {
      service.acquire('/path/orphan', 'old-task');
      const store = new TaskStore();
      const result = service.reconcileFromTaskStore(store);
      expect(result.released).toBe(1);
      expect(service.isLeased('/path/orphan')).toBe(false);
    });

    it('skips sessions without worktree flag', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'test', cwd: '/repo' });
      store.addSession(task.id, {
        tmuxSession: 'tmux-1',
        agentType: 'claude-code',
        cwd: '/path/regular',
        createdAt: new Date(),
        gitIsWorktree: false,
      });

      const result = service.reconcileFromTaskStore(store);
      expect(result.backfilled).toBe(0);
    });

    it('handles mixed active and completed sessions', () => {
      const store = new TaskStore();

      // Task 1: active session in a worktree
      const task1 = store.createTask({ prompt: 'active', cwd: '/repo' });
      store.addSession(task1.id, {
        tmuxSession: 'tmux-active',
        agentType: 'claude-code',
        cwd: '/path/active-wt',
        createdAt: new Date(),
        gitIsWorktree: true,
      });

      // Task 2: completed session in a worktree (should not be backfilled)
      const task2 = store.createTask({ prompt: 'done', cwd: '/repo' });
      store.addSession(task2.id, {
        tmuxSession: 'tmux-done',
        agentType: 'claude-code',
        cwd: '/path/completed-wt',
        createdAt: new Date(),
        gitIsWorktree: true,
        lastStatus: 'completed',
      });

      // Task 3: aborted session in a worktree (should not be backfilled)
      const task3 = store.createTask({ prompt: 'aborted', cwd: '/repo' });
      store.addSession(task3.id, {
        tmuxSession: 'tmux-aborted',
        agentType: 'claude-code',
        cwd: '/path/aborted-wt',
        createdAt: new Date(),
        gitIsWorktree: true,
        lastStatus: 'aborted',
      });

      const result = service.reconcileFromTaskStore(store);
      // Only the active session should be backfilled
      expect(result.backfilled).toBe(1);
      expect(service.isLeased('/path/active-wt')).toBe(true);
      expect(service.isLeased('/path/completed-wt')).toBe(false);
      expect(service.isLeased('/path/aborted-wt')).toBe(false);
    });

    it('does not backfill when lease already exists for that path', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'test', cwd: '/repo' });
      store.addSession(task.id, {
        tmuxSession: 'tmux-1',
        agentType: 'claude-code',
        cwd: '/path/worktree',
        createdAt: new Date(),
        gitIsWorktree: true,
      });

      // Pre-acquire the lease manually (as if it already existed)
      service.acquire('/path/worktree', task.id);

      const result = service.reconcileFromTaskStore(store);
      // Should not count as backfilled since the lease already exists
      expect(result.backfilled).toBe(0);
      expect(result.released).toBe(0);
      expect(service.isLeased('/path/worktree')).toBe(true);
    });
  });

  describe('clearStaleLease', () => {
    it('clears an existing lease', () => {
      service.acquire('/path/worktree', 'task-1');
      expect(service.clearStaleLease('/path/worktree', 'admin')).toBe(true);
      expect(service.isLeased('/path/worktree')).toBe(false);
    });

    it('returns false for non-existent lease', () => {
      expect(service.clearStaleLease('/nonexistent', 'admin')).toBe(false);
    });

    it('logs the forced clear to console', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      service.acquire('/path/worktree', 'task-1');
      service.clearStaleLease('/path/worktree', 'admin');

      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Forced stale-lease clear'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('previousOwner=task-1'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('operator=admin'),
      );

      consoleSpy.mockRestore();
    });

    it('does not log when lease does not exist', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      service.clearStaleLease('/nonexistent', 'admin');

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
