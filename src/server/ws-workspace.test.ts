import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';

// Hoist mock so it's available in vi.mock factory
const { mockExecFile, mockRemovalGuard } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRemovalGuard: vi.fn(),
}));

// Mock child_process for git calls in CleanupInspector and RepoPolicyResolver
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('../adapters/worktree-safety.js', () => ({
  getWorktreeRemovalGuardReason: mockRemovalGuard,
  isProtectedBranch: () => false,
}));

// Mock existsSync so test paths pass validation. Marker files (`.kookr-protected`)
// are excluded so cleanup-inspector's protection check does not falsely classify
// every test worktree as protected.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => !p.toString().endsWith('.kookr-protected')),
  };
});

import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { MessageRouter } from './ws.js';
import { WorkspaceAttemptRepository } from '../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../core/worktree-lease-service.js';
import { createCleanupFingerprint } from './use-cases/workspace-cleanup-detail-query.js';

/**
 * Make mockExecFile respond based on git subcommand.
 * handlers maps a substring of args to { stdout } or 'error'.
 */
function mockGitResponses(handlers: Record<string, string | 'error'>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], maybeOpts: unknown, maybeCb?: Function) => {
    const cb = typeof maybeCb === 'function'
      ? maybeCb
      : maybeOpts as Function;
    const argsStr = args.join(' ');
    for (const [pattern, response] of Object.entries(handlers)) {
      if (argsStr.includes(pattern)) {
        if (response === 'error') {
          cb(new Error('git error'), { stdout: '', stderr: 'git error' });
        } else {
          cb(null, { stdout: response, stderr: '' });
        }
        return;
      }
    }
    if (argsStr.includes('remote get-url origin')) {
      cb(null, { stdout: 'local/test-repo', stderr: '' });
      return;
    }
    // Default: succeed with empty output
    cb(null, { stdout: '', stderr: '' });
  });
}

describe('WebSocket workspace message routing', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let sentMessages: ServerMessage[];
  let mockLaunchTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemovalGuard.mockResolvedValue(undefined);
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    sentMessages = [];
    mockLaunchTask = vi.fn().mockResolvedValue({
      task: { id: 'task-1' },
      queued: false,
    });
  });

  /** Build a MessageRouter with workspace services enabled. */
  function createRouter(opts?: { workspaceEnabled?: boolean; serverProjectId?: string | null }) {
    return new MessageRouter({
      taskStore,
      queue,
      monitor,
      adapter: { sendInput: vi.fn(), sendKeystroke: vi.fn(), launch: vi.fn() } as any,
      send: (msg) => sentMessages.push(msg),
      serverCwd: '/test/repo',
      workspaceEnabled: opts?.workspaceEnabled ?? true,
      attemptRepository: new WorkspaceAttemptRepository(),
      policyResolver: new RepoPolicyResolver(),
      leaseService: new WorktreeLeaseService(),
      launchTask: mockLaunchTask,
      serverProjectId: opts && 'serverProjectId' in opts ? opts.serverProjectId ?? undefined : 'local/test-repo',
    });
  }

  // ---- workspace:getView ----

  test('workspace:getView sends workspaceView response', async () => {
    // Mock git commands for worktree list and baseline resolution
    mockGitResponses({
      '--git-common-dir': '/test/repo/.git',
      'worktree list': 'worktree /test/repo\nHEAD abc1234\nbranch refs/heads/main\n',
      'symbolic-ref': 'refs/remotes/origin/HEAD',
      'rev-parse': 'abc1234abc1234abc1234abc1234abc1234abc123',
    });

    const router = createRouter();
    await router.handleMessageSafe({
      type: 'workspace:getView',
      projectId: 'local/test-repo',
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].view.projectId).toBe('local/test-repo');
      expect(viewMsgs[0].view.displayName).toBe('test-repo');
    }
  });

  test('workspace:getView sends error when workspace disabled', async () => {
    const router = createRouter({ workspaceEnabled: false });
    await router.handleMessageSafe({
      type: 'workspace:getView',
      projectId: 'local/test-repo',
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].error).toBe('Workspace is not available');
    }
  });

  test('workspace:getView error sends workspaceView with error', async () => {
    const router = new MessageRouter({
      taskStore,
      queue,
      monitor,
      adapter: { sendInput: vi.fn(), sendKeystroke: vi.fn(), launch: vi.fn() } as any,
      send: (msg) => sentMessages.push(msg),
      serverCwd: '/test',
      serverProjectId: 'local/test-repo',
      workspaceEnabled: true,
      attemptRepository: new WorkspaceAttemptRepository(),
      policyResolver: new RepoPolicyResolver(),
      leaseService: {
        listActiveLeases: () => { throw new Error('lease service exploded'); },
        isLeased: () => false,
      } as any,
      launchTask: mockLaunchTask,
    });

    await router.handleMessageSafe({
      type: 'workspace:getView',
      projectId: 'local/test-repo',
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].error).toContain('lease service exploded');
      expect(viewMsgs[0].view.candidates).toEqual([]);
    }
  });

  test('workspace:getView reports an unresolved project root', async () => {
    const router = createRouter({ serverProjectId: null });
    await router.handleMessageSafe({
      type: 'workspace:getView',
      projectId: 'local/test-repo',
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].error).toContain('Unable to determine repository root');
    }
  });

  test('workspace:getCleanupDetail sends on-demand cleanup detail', async () => {
    mockGitResponses({
      '--git-common-dir': '/test/repo/.git',
      'worktree list': [
        'worktree /test/repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /test/repo-wt',
        'HEAD def456',
        'branch refs/heads/feature/test',
        '',
      ].join('\n'),
      'status --porcelain': '',
      'merge-base --is-ancestor feature/test main': '',
      'rev-parse HEAD': 'def456',
      'rev-parse --verify refs/heads/feature/test': 'def456',
      'rev-list --left-right --count main...feature/test': '0 0',
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': 'def456\u001fJean\u001f2026-04-04T00:00:00Z\u001fSafe cleanup branch',
      'rev-parse --verify main': 'abc123',
      'rev-parse main': 'abc123',
    });

    const router = createRouter();
    await router.handleMessageSafe({
      type: 'workspace:getCleanupDetail',
      projectId: 'local/test-repo',
      worktreePath: '/test/repo-wt',
    });

    const detailMsgs = sentMessages.filter((m) => m.type === 'workspaceCleanupDetail');
    expect(detailMsgs).toHaveLength(1);
    if (detailMsgs[0].type === 'workspaceCleanupDetail') {
      expect(detailMsgs[0].detail?.worktreePath).toBe('/test/repo-wt');
      expect(detailMsgs[0].detail?.classification).toBe('merged');
      expect(detailMsgs[0].detail?.fingerprint).toBeTruthy();
    }
  });

  test('workspace:runCleanupDiagnostic launches a normal task for a reviewed dirty candidate', async () => {
    mockGitResponses({
      '--git-common-dir': '/test/repo/.git',
      'worktree list': [
        'worktree /test/repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /test/repo-wt',
        'HEAD def456',
        'branch refs/heads/feature/dirty',
        '',
      ].join('\n'),
      'status --porcelain': '?? scratch.txt',
      'rev-parse HEAD': 'def456',
      'rev-parse --verify refs/heads/feature/dirty': 'def456',
      'rev-list --left-right --count main...feature/dirty': '0 1',
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': 'def456\u001fJean\u001f2026-04-05T00:00:00Z\u001fInvestigate dirty worktree',
      'rev-parse --verify main': 'abc123',
      'rev-parse main': 'abc123',
    });

    const router = createRouter();
    await router.handleMessageSafe({
      type: 'workspace:runCleanupDiagnostic',
      projectId: 'local/test-repo',
      worktreePath: '/test/repo-wt',
      reviewFingerprint: createCleanupFingerprint({
        headOid: 'def456',
        branchRefOid: 'def456',
        baselineOid: 'abc123',
        statusDigest: '?? scratch.txt',
      }),
    });

    expect(mockLaunchTask).toHaveBeenCalledTimes(1);
    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].diagnosticLaunch?.taskId).toBe('task-1');
      expect(viewMsgs[0].diagnosticLaunch?.worktreePath).toBe('/test/repo-wt');
    }
  });

  test('workspace:cleanupCandidate resolves repo context on the server', async () => {
    mockGitResponses({
      '--git-common-dir': '/test/repo/.git',
      'worktree list': [
        'worktree /test/repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /test/repo-wt',
        'HEAD def456',
        'branch refs/heads/feature/test',
        '',
      ].join('\n'),
      'status --porcelain': '',
      'merge-base --is-ancestor feature/test main': '',
      'rev-parse HEAD': 'def456',
      'rev-parse --verify refs/heads/feature/test': 'def456',
      'rev-list --left-right --count main...feature/test': '0 0',
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': 'def456\u001fJean\u001f2026-04-04T00:00:00Z\u001fSafe cleanup branch',
      'rev-parse --verify main': 'abc123',
      'rev-parse main': 'abc123',
      'worktree remove /test/repo-wt': '',
      'worktree prune': '',
      'update-ref -d refs/heads/feature/test def456': '',
    });

    const router = createRouter();
    await router.handleMessageSafe({
      type: 'workspace:cleanupCandidate',
      projectId: 'local/test-repo',
      worktreePath: '/test/repo-wt',
      deleteBranch: true,
      reviewFingerprint: createCleanupFingerprint({
        headOid: 'def456',
        branchRefOid: 'def456',
        baselineOid: 'abc123',
        statusDigest: '',
      }),
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].cleanupResult?.branch).toBe('feature/test');
      expect(viewMsgs[0].cleanupResult?.branchRemoved).toBe(true);
    }
  });

  test('workspace:bulkSafeCleanup runs only the current safe set and returns bulk results', async () => {
    mockGitResponses({
      '--git-common-dir': '/test/repo/.git',
      'worktree list': [
        'worktree /test/repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /test/repo-safe-a',
        'HEAD def456',
        'branch refs/heads/feature/safe-a',
        '',
        'worktree /test/repo-safe-b',
        'HEAD fedcba',
        'branch refs/heads/feature/safe-b',
        '',
        'worktree /test/repo-unique',
        'HEAD 999999',
        'branch refs/heads/feature/unique',
        '',
      ].join('\n'),
      'status --porcelain': '',
      'merge-base --is-ancestor feature/safe-a main': '',
      'merge-base --is-ancestor feature/safe-b main': 'error',
      'merge-base --is-ancestor feature/unique main': 'error',
      '--cherry-pick --right-only main...feature/safe-b': '',
      '--cherry-pick --right-only main...feature/unique': 'abc123 unique commit',
      'rev-parse HEAD': 'def456',
      'rev-parse --verify refs/heads/feature/safe-a': 'def456',
      'rev-parse --verify refs/heads/feature/safe-b': 'fedcba',
      'rev-list --left-right --count main...feature/safe-a': '0 0',
      'rev-list --left-right --count main...feature/safe-b': '0 0',
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': 'def456\u001fJean\u001f2026-04-05T00:00:00Z\u001fSafe cleanup branch',
      'rev-parse --verify main': 'abc123',
      'rev-parse main': 'abc123',
      'worktree remove /test/repo-safe-a': '',
      'worktree remove /test/repo-safe-b': '',
      'worktree prune': '',
      'update-ref -d refs/heads/feature/safe-a def456': '',
      'update-ref -d refs/heads/feature/safe-b fedcba': '',
    });

    const router = createRouter();
    await router.handleMessageSafe({
      type: 'workspace:bulkSafeCleanup',
      projectId: 'local/test-repo',
    });

    const viewMsgs = sentMessages.filter((m) => m.type === 'workspaceView');
    expect(viewMsgs).toHaveLength(1);
    if (viewMsgs[0].type === 'workspaceView') {
      expect(viewMsgs[0].cleanupResults?.map((result) => result.branch)).toEqual([
        'feature/safe-a',
        'feature/safe-b',
      ]);
    }
  });

  // ---- handleConnect snapshot ----

  test('handleConnect includes workspaceEnabled in snapshot', () => {
    const router = createRouter({ workspaceEnabled: true });
    router.handleConnect();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      expect(msg.workspaceEnabled).toBe(true);
    }
  });

  test('handleConnect omits workspaceEnabled when false', () => {
    const router = createRouter({ workspaceEnabled: false });
    router.handleConnect();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      expect(msg).not.toHaveProperty('workspaceEnabled');
    }
  });
});
