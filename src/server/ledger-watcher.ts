import { watch, type FSWatcher } from 'node:fs';

import type { OssAttemptStore } from '../core/oss-attempt-store.js';
import type { LedgerAnalytics } from '../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { ServerMessage } from '../shared/protocol.js';

interface LedgerWatcherDeps {
  ossAttemptStore: OssAttemptStore;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  broadcastProjectSummaries: () => void;
  broadcastOssAttempts?: () => void;
  broadcastToAll: (msg: ServerMessage) => void;
  debounceMs?: number;
}

export interface LedgerWatcherHandle {
  close(): void;
}

export function startLedgerWatcher({
  ossAttemptStore,
  ledgerAnalytics,
  projectConfigStore,
  broadcastProjectSummaries,
  broadcastOssAttempts,
  broadcastToAll,
  debounceMs = 300,
}: LedgerWatcherDeps): LedgerWatcherHandle {
  let ledgerWatcher: FSWatcher | null = null;
  let ledgerReloadTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const ledgerPath = ossAttemptStore.getLedgerPath();
    ledgerWatcher = watch(ledgerPath, () => {
      if (ledgerReloadTimer) clearTimeout(ledgerReloadTimer);
      ledgerReloadTimer = setTimeout(async () => {
        try {
          const prevBlocked = ledgerAnalytics.getTodayBlockedEntries().length;
          await ossAttemptStore.loadFromLedger();
          await projectConfigStore.loadRateLimits();
          broadcastProjectSummaries();
          // Ledger ingestion can upsert new PR-keyed attempts; re-broadcast
          // the OSS snapshot so the productivity dashboard reflects them
          // without waiting for the next refresh run.
          broadcastOssAttempts?.();

          const blockedEntries = ledgerAnalytics.getTodayBlockedEntries();
          if (blockedEntries.length > prevBlocked) {
            const latest = blockedEntries[blockedEntries.length - 1];
            const project = `github.com/${latest.repo.toLowerCase()}`;
            const reason = latest.blockReason ?? `PR blocked: ${latest.action}`;
            broadcastToAll({
              type: 'contributionWarning',
              project,
              message: reason,
              severity: 'exceeded',
            });
          }
        } catch (err) {
          console.warn('[ledger-watcher] Failed to reload ledger:', err instanceof Error ? err.message : err);
        }
      }, debounceMs);
    });
    ledgerWatcher.on('error', () => {
      ledgerWatcher = null;
    });
  } catch {
    console.log('[ledger-watcher] No contribution ledger found, skipping watch');
  }

  return {
    close(): void {
      if (ledgerWatcher) ledgerWatcher.close();
      if (ledgerReloadTimer) clearTimeout(ledgerReloadTimer);
    },
  };
}
