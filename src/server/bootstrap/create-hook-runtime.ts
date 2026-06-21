import { join } from 'node:path';

import { ActivityLedger } from '../../core/activity-ledger.js';
import type { HttpPushTracker } from '../../core/http-push-tracker.js';
import type { TaskStore } from '../../core/tasks.js';
import { HookFileWatcher } from '../hook-watcher.js';
import {
  HookIngestion,
  type HookEventInjector,
  type HookParseDegradationEvent,
} from '../hook-ingestion.js';
import {
  createHookParseDegradationEvaluator,
  type HookParseDegradationEvaluation,
} from '../hook-parse-degradation-rules.js';

export interface HookRuntimeDeps {
  kookrDir: string;
  hooksDir: string;
  adapter: HookEventInjector;
  httpPushTracker: HttpPushTracker;
  taskStore: Pick<TaskStore, 'findTaskBySession'>;
  onParseDegradation: (args: {
    event: HookParseDegradationEvent;
    evaluation: HookParseDegradationEvaluation;
    hookIngestion: HookIngestion;
  }) => void;
}

export interface HookRuntime {
  activityLedger: ActivityLedger;
  hookIngestion: HookIngestion;
  hookWatcher: HookFileWatcher;
}

/**
 * HookIngestion serializes file-source and HTTP-source delivery through a
 * content-hash dedup window. ActivityLedger records every observed hook record
 * under <kookrDir>/activity/ for task activity diagnostics. Startup replay is
 * still orchestrated by the composition root after crash recovery.
 */
export function createHookRuntime(deps: HookRuntimeDeps): HookRuntime {
  const activityLedger = new ActivityLedger(join(deps.kookrDir, 'activity'));
  const hookParseDegradationEvaluator = createHookParseDegradationEvaluator();
  let hookIngestion: HookIngestion;
  hookIngestion = new HookIngestion({
    adapter: deps.adapter,
    httpPushTracker: deps.httpPushTracker,
    activityLedger,
    taskStore: deps.taskStore,
    onParseDegradation: (event) => {
      const evaluation = hookParseDegradationEvaluator.evaluate(event);
      if (!evaluation) return;
      // HookIngestion only emits parse degradation while ingesting records, so
      // this callback can safely pass back the constructed ingestion handle.
      deps.onParseDegradation({ event, evaluation, hookIngestion });
    },
  });

  return {
    activityLedger,
    hookIngestion,
    hookWatcher: new HookFileWatcher(deps.hooksDir, hookIngestion),
  };
}
