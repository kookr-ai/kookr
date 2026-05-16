import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandOutcome, RemoteCommandAction } from '../remote/command-journal.js';

export interface AggregatedCommandOutcome {
  source: 'local' | 'remote';
  commandId?: string;
  action: string;
  outcome: CommandOutcome;
  timestamp?: string;
  agentId?: string;
  taskId?: string;
  reason?: string;
}

async function readJsonl(path: string): Promise<unknown[]> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

async function collectLocalInteractionPaths(kookrDir: string): Promise<string[]> {
  const sessionsDir = join(kookrDir, 'sessions');
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [join(kookrDir, 'interaction-log.jsonl')];
  }
  return [
    join(kookrDir, 'interaction-log.jsonl'),
    ...entries.map((entry) => join(sessionsDir, entry, 'interactions.jsonl')),
  ];
}

function localAction(type: string): string | null {
  switch (type) {
    case 'user_input': return 'presetReply';
    case 'finding_skipped': return 'skip';
    case 'finding_snoozed': return 'snooze';
    case 'task_completed': return 'mark-done';
    default: return null;
  }
}

export async function collectCommandOutcomes(opts: {
  kookrDir?: string;
  commandId?: string;
} = {}): Promise<AggregatedCommandOutcome[]> {
  const kookrDir = opts.kookrDir ?? join(process.env.HOME ?? '.', '.kookr');
  const outcomes: AggregatedCommandOutcome[] = [];

  for (const path of await collectLocalInteractionPaths(kookrDir)) {
    for (const row of await readJsonl(path)) {
      const event = row as { type?: unknown; timestamp?: unknown; agentId?: unknown; taskId?: unknown; commandId?: unknown };
      if (typeof event.type !== 'string') continue;
      const action = localAction(event.type);
      if (!action) continue;
      if (opts.commandId && event.commandId !== opts.commandId) continue;
      outcomes.push({
        source: 'local',
        commandId: typeof event.commandId === 'string' ? event.commandId : undefined,
        action,
        outcome: 'accepted',
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
        agentId: typeof event.agentId === 'string' ? event.agentId : undefined,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
      });
    }
  }

  for (const row of await readJsonl(join(kookrDir, 'audit.jsonl'))) {
    const event = row as {
      type?: unknown;
      commandId?: unknown;
      action?: unknown;
      outcome?: unknown;
      timestamp?: unknown;
      reason?: unknown;
    };
    if (event.type !== 'command.result' && event.type !== 'command.pre-audit-reject') continue;
    if (typeof event.commandId !== 'string' || typeof event.action !== 'string' || typeof event.outcome !== 'string') continue;
    if (opts.commandId && event.commandId !== opts.commandId) continue;
    outcomes.push({
      source: 'remote',
      commandId: event.commandId,
      action: event.action as RemoteCommandAction,
      outcome: event.outcome as CommandOutcome,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      reason: typeof event.reason === 'string' ? event.reason : undefined,
    });
  }

  return outcomes.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
}

export async function runCommandOutcomeCli(argv = process.argv.slice(2)): Promise<number> {
  const commandId = argv[0];
  const outcomes = await collectCommandOutcomes({ commandId });
  if (commandId && outcomes.length === 0) {
    console.log(JSON.stringify({ commandId, outcome: 'unknown-never-seen' }));
    return 0;
  }
  for (const outcome of outcomes) console.log(JSON.stringify(outcome));
  return 0;
}
