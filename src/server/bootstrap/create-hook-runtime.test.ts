import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpPushTracker } from '../../core/http-push-tracker.js';
import type { InjectHookEventResult } from '../../core/types.js';
import type { HookEventInjector } from '../hook-ingestion.js';
import { createHookRuntime, type HookRuntimeDeps } from './create-hook-runtime.js';

describe('createHookRuntime', () => {
  it('wires hook ingestion, activity ledger, watcher, and parse degradation callback', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-hook-runtime-'));
    try {
      const hooksDir = join(kookrDir, 'hooks');
      await mkdir(hooksDir);
      const sessionHookFile = join(hooksDir, 'session-1.jsonl');
      await writeFile(sessionHookFile, '');
      const injected: Array<{ sessionId: string; raw: string; sequence?: number }> = [];
      const adapter: HookEventInjector = {
        injectHookEvent(sessionId, raw, sequence): InjectHookEventResult {
          injected.push({ sessionId, raw, sequence });
          return {
            parseStatus: 'malformed',
            agentType: 'claude-code',
            error: 'fixture parse failure',
          };
        },
      };
      const degradations: Array<Parameters<HookRuntimeDeps['onParseDegradation']>[0]> = [];

      const runtime = createHookRuntime({
        kookrDir,
        hooksDir,
        adapter,
        httpPushTracker: new HttpPushTracker(),
        taskStore: {
          findTaskIdBySession: () => undefined,
        },
        onParseDegradation: (args) => degradations.push(args),
      });

      const result = runtime.hookIngestion.ingestFromHttp('session-1', '{bad json');
      await runtime.activityLedger.flush();

      expect(result.dispatched).toBe(false);
      expect(injected).toEqual([{ sessionId: 'session-1', raw: '{bad json', sequence: 1 }]);
      expect(degradations).toHaveLength(1);
      expect(degradations[0]?.event.kookrSessionId).toBe('session-1');
      expect(degradations[0]?.evaluation.alert.type).toBe('alert');
      expect(degradations[0]?.evaluation.anomaly.type).toBe('hook_parse_degraded');
      expect(degradations[0]?.hookIngestion).toBe(runtime.hookIngestion);
      expect(await runtime.activityLedger.readAll('session-1')).toEqual([
        expect.objectContaining({
          envelope: expect.objectContaining({
            kookrSessionId: 'session-1',
            source: 'http',
            parseStatus: 'malformed',
          }),
          projection: 'diagnostic_only',
          error: 'fixture parse failure',
        }),
      ]);
      runtime.hookWatcher.watch('session-1');
      expect(runtime.hookWatcher.isWatching('session-1')).toBe(true);
      runtime.hookWatcher.stop('session-1');
      expect(runtime.hookWatcher.isWatching('session-1')).toBe(false);

      await writeFile(sessionHookFile, JSON.stringify({
        session_id: 'provider-session-1',
        transcript_path: '/transcript.jsonl',
        cwd: '/cwd',
        hook_event_name: 'SessionStart',
      }) + '\n');

      runtime.hookWatcher.watch('session-1', { replayExisting: true });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const checkpoint = JSON.parse(
        await readFile(join(kookrDir, 'hook-replay-checkpoints.json'), 'utf-8'),
      ) as { sessions: Record<string, { filePath: string; offsetChars: number }> };
      expect(checkpoint.sessions['session-1']).toEqual(expect.objectContaining({
        filePath: sessionHookFile,
        offsetChars: expect.any(Number),
      }));
      runtime.hookWatcher.stop('session-1');
    } finally {
      await rm(kookrDir, { recursive: true, force: true });
    }
  });
});
