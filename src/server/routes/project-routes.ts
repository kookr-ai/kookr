import type { Hono } from 'hono';
import { access } from 'node:fs/promises';
import type { ProjectConfig } from '../../core/project-config-store.js';
import { configSeedsMembership, type ProjectSummary } from '../../core/project-summary.js';
import { getProjectSummaries } from '../use-cases/get-snapshot.js';
import { parseOwnerRepoSlug } from '../../shared/repo-slug.js';
import type { RouteDeps } from './shared.js';

export function registerProjectRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/projects', async (c) => {
    if (!deps.ledgerAnalytics || !deps.projectConfigStore) {
      return c.json([]);
    }
    const summaries = await filterDeadLocalProjects(getProjectSummaries({
      monitor: deps.monitor,
      ledgerAnalytics: deps.ledgerAnalytics,
      projectConfigStore: deps.projectConfigStore,
      getSkillTrackedProjects: () => deps.skillDiscoveryState?.getProjects() ?? [],
      getRegistryActiveProjects: deps.getRegistryActiveProjects,
      getSidebarProjects: () => deps.projectSidebarStore?.getSeedProjects() ?? [],
      prLessonsHolder: deps.prLessonsState,
      repoHealthCache: deps.githubScanner.getRepoHealthSnapshot(),
      getTaskGithubReferences: (taskId) => deps.githubStateStore.getReferences(taskId),
      getGithubRefOpenState: (ref) => deps.githubStateStore.isRefOpen(ref),
    }));
    if (c.req.query('tracked') === 'true') {
      return c.json(summaries.filter(isTrackedOrLocalProject));
    }
    return c.json(summaries);
  });

  app.get('/api/projects/contributions', (c) => {
    if (!deps.ossAttemptStore || !deps.ledgerAnalytics) return c.json([]);
    const project = c.req.query('project');
    if (project) {
      return c.json(deps.ledgerAnalytics.getAttemptsByProjectRecent(project, 30));
    }
    return c.json(deps.ossAttemptStore.getAllAttempts().filter((a) => a.state !== 'scouted'));
  });

  app.get('/api/projects/configs', (c) => {
    if (!deps.projectConfigStore) return c.json([]);
    return c.json(deps.projectConfigStore.getAllConfigs());
  });

  app.get('/api/projects/sidebar', (c) => {
    if (!deps.projectSidebarStore) return c.json({ error: 'Not configured' }, 500);
    return c.json(deps.projectSidebarStore.getState());
  });

  app.put('/api/projects/sidebar', async (c) => {
    if (!deps.projectSidebarStore) return c.json({ error: 'Not configured' }, 500);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const state = deps.projectSidebarStore.setState(body);
    await deps.projectSidebarStore.save();
    deps.broadcastProjectSummaries?.();
    return c.json(state);
  });

  app.post('/api/projects/configs', async (c) => {
    if (!deps.projectConfigStore) return c.json({ error: 'Not configured' }, 500);
    const body = await c.req.json() as {
      project?: string;
      tracked?: boolean;
      dailyPrLimit?: number;
      weeklyPrLimit?: number;
      notes?: string;
    };
    if (!body.project) return c.json({ error: 'project is required' }, 400);

    // Only include fields that were explicitly provided so the existing row's
    // other fields are preserved.
    const patch: {
      tracked?: boolean;
      dailyPrLimit?: number;
      weeklyPrLimit?: number;
      notes?: string;
    } = {};
    if (body.tracked !== undefined) patch.tracked = body.tracked;
    if (body.dailyPrLimit !== undefined) patch.dailyPrLimit = body.dailyPrLimit;
    if (body.weeklyPrLimit !== undefined) patch.weeklyPrLimit = body.weeklyPrLimit;
    if (body.notes !== undefined) patch.notes = body.notes;

    const config = deps.projectConfigStore.setConfig(body.project, patch);
    await deps.projectConfigStore.save();
    deps.broadcastProjectSummaries?.();
    return c.json(config);
  });

  // Thin endpoint for the GUI: takes `owner/repo`, normalizes to project ID,
  // persists as tracked in ProjectConfigStore, and broadcasts summaries.
  app.post('/api/projects/track', async (c) => {
    if (!deps.projectConfigStore) return c.json({ error: 'Not configured' }, 500);
    let body: { repo?: unknown };
    try {
      body = await c.req.json() as { repo?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const slug = parseOwnerRepoSlug(body?.repo);
    if (!slug) {
      return c.json(
        { error: 'repo must be in owner/repo format (e.g. "grafana/grafana")' },
        400,
      );
    }
    const projectId = `github.com/${slug}`;
    const config = deps.projectConfigStore.setConfig(projectId, { tracked: true });
    await deps.projectConfigStore.save();
    deps.broadcastProjectSummaries?.();
    return c.json({ project: projectId, config });
  });

  // Inverse of /track: clears the tracked flag. If no other user-set signal
  // (PR limits, notes) remains, the config row is removed entirely so
  // project-configs.json stays clean. The project may still appear in the
  // sidebar through skill discovery, contributions, or active agents.
  app.post('/api/projects/untrack', async (c) => {
    if (!deps.projectConfigStore) return c.json({ error: 'Not configured' }, 500);
    let body: { repo?: unknown };
    try {
      body = await c.req.json() as { repo?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const slug = parseOwnerRepoSlug(body?.repo);
    if (!slug) {
      return c.json(
        { error: 'repo must be in owner/repo format (e.g. "grafana/grafana")' },
        400,
      );
    }
    const projectId = `github.com/${slug}`;
    const existing = deps.projectConfigStore.getConfig(projectId);
    if (!existing) {
      // Idempotent: nothing to clear.
      return c.json({ project: projectId, config: null, removed: false });
    }

    const updated = deps.projectConfigStore.setConfig(projectId, { tracked: false });
    let removed = false;
    let configOut: ProjectConfig | null = updated;
    if (!configSeedsMembership(updated)) {
      deps.projectConfigStore.removeConfig(projectId);
      removed = true;
      configOut = null;
    }
    await deps.projectConfigStore.save();
    deps.broadcastProjectSummaries?.();
    return c.json({ project: projectId, config: configOut, removed });
  });

  // Trigger a manual rescan of ~/.claude/*-recon/recon-report.md.
  // Always returns the current snapshot so the caller can render warnings.
  app.post('/api/projects/rescan-skills', async (c) => {
    if (!deps.skillDiscoveryState) {
      return c.json({ error: 'Skill discovery not configured' }, 500);
    }
    const snapshot = await deps.skillDiscoveryState.rescan();
    await deps.prLessonsState?.rescan();
    deps.broadcastProjectSummaries?.();
    return c.json(snapshot);
  });

  // Read-only surface for the sidebar manager to show discovery warnings.
  app.get('/api/projects/discovery-status', (c) => {
    if (!deps.skillDiscoveryState) {
      return c.json({ projects: [], warnings: [] });
    }
    return c.json(deps.skillDiscoveryState.getSnapshot());
  });
}

function isTrackedOrLocalProject(summary: ProjectSummary): boolean {
  return summary.tracked === true || summary.project.startsWith('local/');
}

async function filterDeadLocalProjects(summaries: ProjectSummary[]): Promise<ProjectSummary[]> {
  const checks = await Promise.all(summaries.map(async (summary) => {
    if (!summary.project.startsWith('local/') || !summary.localPath || hasActiveTask(summary)) {
      return { summary, keep: true };
    }
    try {
      await access(summary.localPath);
      return { summary, keep: true };
    } catch {
      return { summary, keep: false };
    }
  }));
  return checks.filter((check) => check.keep).map((check) => check.summary);
}

function hasActiveTask(summary: ProjectSummary): boolean {
  return summary.recentTasks.some((task) => task.status === 'inProgress');
}
