import { homedir } from 'node:os';
import { join } from 'node:path';

import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { OssAttemptStore, projectIdForRepo } from '../../core/oss-attempt-store.js';
import { PrLessonsDiscovery, PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import { SkillDiscoveryStateHolder, SkillTrackedRepoDiscovery } from '../../core/skill-tracked-repo-discovery.js';
import type { KookrSettings } from '../../core/settings-store.js';
import { loadExternalReposFromRegistry, OssRefresher } from '../oss-refresh.js';
import { OssRegistryWatcher, ReconReportWatcher, type OssSourceWatcherFs } from '../oss-source-watcher.js';

export interface OssServicesDeps {
  kookrDir: string;
  claudeDir?: string;
}

export interface OssServices {
  ossAttemptStore: OssAttemptStore;
  ledgerAnalytics: LedgerAnalytics;
  ossRegistryPath: string;
  resolvedClaudeDir: string;
  skillDiscoveryState: SkillDiscoveryStateHolder;
  prLessonsState: PrLessonsStateHolder;
  ossRefresher: OssRefresher;
  getRegistryActiveProjects: () => string[];
  getRegistryActiveRepos: () => string[];
  reloadRegistryActiveRepos: () => Promise<void>;
}

export async function createOssServices(deps: OssServicesDeps): Promise<OssServices> {
  const ossAttemptStore = new OssAttemptStore(deps.kookrDir);
  await ossAttemptStore.load();
  await ossAttemptStore.loadFromLedger();
  const ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
  const ossRegistryPath = join(deps.kookrDir, 'oss-repos.json');
  let ossRegistryActiveRepos = await loadExternalReposFromRegistry(
    ossRegistryPath,
    ossAttemptStore.getOwnNamespaces(),
  );
  const ossRefresher = new OssRefresher({ store: ossAttemptStore, kookrDir: deps.kookrDir, registryPath: ossRegistryPath });

  const resolvedClaudeDir = deps.claudeDir ?? join(homedir(), '.claude');
  const skillDiscoveryState = new SkillDiscoveryStateHolder(
    new SkillTrackedRepoDiscovery(resolvedClaudeDir),
  );
  const initialDiscovery = await skillDiscoveryState.rescan();
  if (initialDiscovery.warnings.length > 0) {
    console.warn(
      `[skill-discovery] ${initialDiscovery.warnings.length} warning(s): ${initialDiscovery.warnings.join('; ')}`,
    );
  }
  if (initialDiscovery.lastError) {
    console.warn(`[skill-discovery] Initial scan failed: ${initialDiscovery.lastError}`);
  } else {
    console.log(`[skill-discovery] Loaded ${initialDiscovery.projects.length} skill-tracked repo(s)`);
  }

  const prLessonsState = new PrLessonsStateHolder(
    new PrLessonsDiscovery(resolvedClaudeDir),
  );
  await prLessonsState.rescan();

  return {
    ossAttemptStore,
    ledgerAnalytics,
    ossRegistryPath,
    resolvedClaudeDir,
    skillDiscoveryState,
    prLessonsState,
    ossRefresher,
    getRegistryActiveProjects: () => ossRegistryActiveRepos.map(projectIdForRepo),
    getRegistryActiveRepos: () => [...ossRegistryActiveRepos],
    reloadRegistryActiveRepos: async () => {
      ossRegistryActiveRepos = await loadExternalReposFromRegistry(
        ossRegistryPath,
        ossAttemptStore.getOwnNamespaces(),
      );
    },
  };
}

export interface OssSourceWatchersDeps {
  services: OssServices;
  settings: () => KookrSettings;
  debounceMs?: number;
  runFs?: Partial<OssSourceWatcherFs>;
  broadcastProjectSummaries: () => void;
  broadcastOssAttempts: () => void;
}

export interface OssSourceWatchers {
  ossRegistryWatcher: OssRegistryWatcher;
  reconReportWatcher: ReconReportWatcher;
}

export function createOssSourceWatchers(deps: OssSourceWatchersDeps): OssSourceWatchers {
  const ossRegistryWatcher = new OssRegistryWatcher({
    registryPath: deps.services.ossRegistryPath,
    enabled: () => deps.settings().autoWatchOssSources,
    debounceMs: deps.debounceMs,
    runFs: deps.runFs,
    onChange: async () => {
      await deps.services.reloadRegistryActiveRepos();
      deps.broadcastProjectSummaries();
      deps.broadcastOssAttempts();
    },
  });
  const reconReportWatcher = new ReconReportWatcher({
    claudeDir: deps.services.resolvedClaudeDir,
    enabled: () => deps.settings().autoWatchOssSources,
    debounceMs: deps.debounceMs,
    runFs: deps.runFs,
    onChange: async () => {
      const snapshot = await deps.services.skillDiscoveryState.rescan();
      if (snapshot.lastError) {
        console.warn(`[skill-discovery] Auto rescan failed: ${snapshot.lastError}`);
      }
      deps.broadcastProjectSummaries();
    },
  });

  if (deps.settings().autoWatchOssSources) {
    ossRegistryWatcher.start();
    reconReportWatcher.start();
  } else {
    console.log('[settings] OSS source auto-watch disabled by user settings');
  }

  return { ossRegistryWatcher, reconReportWatcher };
}
