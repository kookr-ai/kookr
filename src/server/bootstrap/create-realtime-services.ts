import { join } from 'node:path';

import { WebSocket } from 'ws';

import type { AdapterRegistry } from '../../adapters/agent-adapter.js';
import { AVAILABLE_AGENT_TYPES, type AgentType } from '../../core/agent-types.js';
import { ACHIEVEMENT_BY_ID } from '../../core/achievement-catalog.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { Monitor } from '../../core/monitor.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { MAX_TRACKED_REPOS, type ProjectRepoHealth } from '../../core/project-summary.js';
import type { SkillDiscoveryStateHolder } from '../../core/skill-tracked-repo-discovery.js';
import type { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { AchievementWatcher, loadAchievements } from '../achievement-watcher.js';
import type { ScheduleStore } from '../../core/schedule.js';
import { toOssAttemptsSnapshot } from '../oss-attempts-snapshot.js';
import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { createSnapshotMessage, getProjectSummaries } from '../use-cases/get-snapshot.js';

export interface RealtimeServicesDeps {
  kookrDir: string;
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapterRegistry: AdapterRegistry;
  serverCwd: string;
  sttUrl?: string;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  projectSidebarStore: ProjectSidebarStore;
  skillDiscoveryState: SkillDiscoveryStateHolder;
  prLessonsState: PrLessonsStateHolder;
  getRegistryActiveProjects: () => string[];
  getRegistryActiveRepos: () => string[];
  ossAttemptStore: OssAttemptStore;
  getDefaultAgentType: () => AgentType;
}

export interface RealtimeServices {
  clients: Set<WebSocket>;
  achievementWatcher: AchievementWatcher;
  broadcastToAll: (msg: ServerMessage) => void;
  broadcastProjectSummaries: () => void;
  broadcastOssAttempts: () => void;
  getWsBroadcastCount: () => number;
  setScheduleStore: (store: ScheduleStore) => void;
  setSnapshotAchievementsReady: (ready: boolean) => void;
  setProjectSummaryGitHubDeps: (deps: ProjectSummaryGitHubDeps) => void;
}

export interface ProjectSummaryGitHubDeps {
  getRepoHealthSnapshot: () => ReadonlyMap<string, ProjectRepoHealth>;
  getTaskGithubReferences: (taskId: string) => GitHubReference[];
  setTrackedGithubRepos: (repos: string[]) => void;
}

export async function createRealtimeServices(deps: RealtimeServicesDeps): Promise<RealtimeServices> {
  const achievementsFile = join(deps.kookrDir, 'achievements.json');
  const achievementState = await loadAchievements(achievementsFile);
  const clients = new Set<WebSocket>();
  let achievementWatcher: AchievementWatcher;
  let wsBroadcastCount = 0;
  let scheduleStore: ScheduleStore | null = null;
  let snapshotAchievementsReady = false;
  let projectSummaryGitHubDeps: ProjectSummaryGitHubDeps | null = null;

  function broadcastToAll(msg: ServerMessage): void {
    wsBroadcastCount++;
    if (msg.type === 'snapshot') {
      if (snapshotAchievementsReady && achievementWatcher && scheduleStore) {
        try {
          const tasks = deps.taskStore.listTasks();
          const distinctProjectIds = new Set(
            tasks.map((t) => t.projectId).filter((p): p is string => !!p),
          );
          achievementWatcher.check({
            type: 'snapshot',
            state: {
              scheduleCount: scheduleStore.list().length,
              projectCount: distinctProjectIds.size,
              hasCodexTask: tasks.some((t) => t.agentType === 'codex-cli'),
              hasFeedbackTask: tasks.some((t) => !!t.completionFeedback),
              hasSnoozedFinding: deps.queue.getSnoozed().length > 0,
              hasKookrSubject: tasks.some(
                (t) => /\bkookr\b/i.test(t.name ?? '') || /\bkookr\b/i.test(t.prompt ?? ''),
              ),
              unsnoozedFindingCount: deps.queue.getAll().length,
            },
          });
        } catch (err) {
          console.warn('[achievements] Snapshot state check failed, continuing', err);
        }
      }
      msg = {
        ...msg,
        totalSpendUsd: deps.taskStore.getLifetimeSpendUsd(),
        achievements: achievementWatcher?.getUnlocked(),
        ...(achievementWatcher
          ? {
              achievementCounters: achievementWatcher.getCounters(),
              achievementStreak: achievementWatcher.getStreak(),
            }
          : {}),
      };
      msg = {
        ...msg,
        availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => deps.adapterRegistry.getTypes().includes(item.type)),
        defaultAgentType: deps.getDefaultAgentType(),
      };
    }
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  achievementWatcher = new AchievementWatcher(achievementsFile, achievementState, (unlock) => {
    const def = ACHIEVEMENT_BY_ID.get(unlock.id);
    if (def) {
      broadcastToAll({
        type: 'achievement:unlocked',
        id: unlock.id,
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        unlockedAt: unlock.unlockedAt,
      });
    }
  });

  function broadcastProjectSummaries(): void {
    const projects = getProjectSummaries({
      monitor: deps.monitor,
      ledgerAnalytics: deps.ledgerAnalytics,
      projectConfigStore: deps.projectConfigStore,
      getSidebarProjects: () => deps.projectSidebarStore.getSeedProjects(),
      getSkillTrackedProjects: () => deps.skillDiscoveryState.getProjects(),
      getRegistryActiveProjects: deps.getRegistryActiveProjects,
      prLessonsHolder: deps.prLessonsState,
      ...(projectSummaryGitHubDeps
        ? {
            repoHealthCache: projectSummaryGitHubDeps.getRepoHealthSnapshot(),
            getTaskGithubReferences: projectSummaryGitHubDeps.getTaskGithubReferences,
          }
        : {}),
    });
    if (projectSummaryGitHubDeps) {
      projectSummaryGitHubDeps.setTrackedGithubRepos(
        projects.map((s) => s.project).slice(0, MAX_TRACKED_REPOS),
      );
    }
    broadcastToAll({ type: 'projectSummaries', projects });
  }

  function broadcastOssAttempts(): void {
    broadcastToAll({
      type: 'ossAttempts',
      store: toOssAttemptsSnapshot(deps.ossAttemptStore, deps.getRegistryActiveRepos()),
    });
  }

  return {
    clients,
    achievementWatcher,
    broadcastToAll,
    broadcastProjectSummaries,
    broadcastOssAttempts,
    getWsBroadcastCount: () => wsBroadcastCount,
    setScheduleStore: (store) => {
      scheduleStore = store;
    },
    setSnapshotAchievementsReady: (ready) => {
      snapshotAchievementsReady = ready;
    },
    setProjectSummaryGitHubDeps: (githubDeps) => {
      projectSummaryGitHubDeps = githubDeps;
    },
  };
}
