// PR Checklist Contract — local-gate degrade log (P3).
//
// The opt-in hook (hooks/pr-workflow-gate.sh) appends one JSON line per
// fail-open to ~/.kookr/pr-checklist-degrade.log:
//   {"at":"<iso8601>","event":"fail-open","reason":"<content-free text>"}
// `kookr pr-checklist doctor` reads and summarizes it so a silent, long-term
// fail-open (the gate quietly not enforcing) is detectable (RFC M4). This is
// the pure domain logic — parsing + windowed summary; the CLI does only the
// file I/O and printing. Extracted from the CLI for the same reason `gh`
// command parsing lives in `adapters/gh.ts`: fragile, reusable logic belongs
// outside the CLI glue (boundary-critic).

import { join } from 'node:path';

export const DEGRADE_LOG_NAME = 'pr-checklist-degrade.log';

/** Resolve the JSONL degrade log path — the same `~/.kookr` dir the hook writes to. */
export function degradeLogPath(env: NodeJS.ProcessEnv): string {
  const dir = env.HOME ? join(env.HOME, '.kookr') : '.kookr';
  return join(dir, DEGRADE_LOG_NAME);
}

export interface DegradeEntry {
  at: string;
  event: string;
  reason?: string;
}

export interface DegradeSummary {
  /** `warn` when any fail-open occurred in the last 7 days — the gate isn't enforcing. */
  status: 'ok' | 'warn';
  total: number;
  last24h: number;
  last7d: number;
  malformedLines: number;
  /** The most recent (up to 5) entries, oldest→newest. */
  recent: DegradeEntry[];
}

/** Parse the JSONL degrade log, tolerating and counting malformed lines. Pure. */
export function parseDegradeLog(text: string): { entries: DegradeEntry[]; malformed: number } {
  const entries: DegradeEntry[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o && typeof o.at === 'string' && typeof o.event === 'string') {
        entries.push({ at: o.at, event: o.event, reason: typeof o.reason === 'string' ? o.reason : undefined });
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed };
}

/** Windowed counts + a health status from parsed entries. Pure (time injected as `nowMs`). */
export function summarizeDegrades(entries: DegradeEntry[], malformed: number, nowMs: number): DegradeSummary {
  const within = (hours: number) =>
    entries.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && nowMs - t <= hours * 3_600_000;
    }).length;
  const last24h = within(24);
  const last7d = within(24 * 7);
  return {
    status: last7d > 0 ? 'warn' : 'ok',
    total: entries.length,
    last24h,
    last7d,
    malformedLines: malformed,
    recent: entries.slice(-5),
  };
}
