#!/usr/bin/env node
/**
 * One-time, idempotent migration that stamps an operator-decided `scope` onto
 * the four schedules broken by commit #1018 (which relocated operational
 * playbooks out of the project tier into the plugin and user tiers). The four
 * schedules point at just two relocated playbooks, so the targets below are
 * keyed by playbook path, not by schedule. See
 * docs/rfc/rfc-schedule-playbook-resolution.md (R4).
 *
 * It is NOT a runtime backfill: nothing here probes the filesystem to *guess*
 * a tier. The intended tier for each known-broken schedule is hard-coded below
 * (a reviewed human decision), the script prints a before/after diff for the
 * operator, and re-running it is a no-op once every target is stamped.
 *
 * Usage:
 *   node --import tsx scripts/migrate-schedule-scopes.ts [schedules.json] [--dry-run]
 *
 * Defaults to `~/.kookr/schedules.json` (the port-4800 home). Pass an explicit
 * path (or set KOOKR_SCHEDULES_FILE) to target another node's store.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlaybookScope } from '../src/core/playbook.js';

/**
 * The relocated playbooks (rfc problem table), keyed by the bare `playbook.path`
 * that #1018 moved out of the project tier — the thing that actually determines
 * the correct tier. Keying on the path (not the schedule's display name) makes
 * the migration robust to display-name drift: it stamps every schedule pointing
 * at a relocated playbook, regardless of what the schedule is called.
 *
 *   - repository-idea-scout.md → plugin tier (the file already lives there).
 *   - kb-scout-reflection.md   → user tier (a single shared copy placed in
 *     ~/.kookr/playbooks/, immune to future plugin-name collisions).
 */
export const SCOPE_BY_PLAYBOOK_PATH: Readonly<Record<string, PlaybookScope>> = {
  'repository-idea-scout.md': 'plugin',
  'kb-scout-reflection.md': 'user',
};

interface RawSchedule {
  id?: string;
  name?: string;
  playbook?: { path?: string; scope?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ScopeMigrationChange {
  name: string;
  playbookPath: string;
  before: string | undefined;
  after: PlaybookScope;
}

export interface ScopeMigrationResult {
  changes: ScopeMigrationChange[];
  /** New schedules array (same instances when unchanged) and whether it differs. */
  schedules: RawSchedule[];
  changed: boolean;
}

/**
 * Pure core: compute the stamped schedules array and the diff. Stamps a target
 * only when its current scope differs from the intended one, so re-running is a
 * no-op. Exported for tests.
 */
export function migrateScheduleScopes(schedules: RawSchedule[]): ScopeMigrationResult {
  const changes: ScopeMigrationChange[] = [];
  const next = schedules.map((schedule) => {
    const playbookPath = schedule.playbook?.path;
    const intended = playbookPath ? SCOPE_BY_PLAYBOOK_PATH[playbookPath] : undefined;
    if (!intended || !playbookPath) return schedule;
    const current = schedule.playbook?.scope;
    if (current === intended) return schedule; // already stamped — idempotent
    changes.push({
      name: typeof schedule.name === 'string' ? schedule.name : '<unnamed>',
      playbookPath,
      before: typeof current === 'string' ? current : undefined,
      after: intended,
    });
    return {
      ...schedule,
      playbook: { ...(schedule.playbook ?? {}), path: playbookPath, scope: intended },
    };
  });
  return { changes, schedules: next, changed: changes.length > 0 };
}

function resolveSchedulesPath(argv: string[]): string {
  const positional = argv.find((arg) => !arg.startsWith('--'));
  if (positional) return positional;
  if (process.env.KOOKR_SCHEDULES_FILE) return process.env.KOOKR_SCHEDULES_FILE;
  return join(homedir(), '.kookr', 'schedules.json');
}

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const filePath = resolveSchedulesPath(argv);

  if (!existsSync(filePath)) {
    console.error(`[migrate-schedule-scopes] No schedules file at ${filePath}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error(`[migrate-schedule-scopes] Unexpected format (expected an array): ${filePath}`);
    process.exit(1);
  }

  const { changes, schedules, changed } = migrateScheduleScopes(parsed as RawSchedule[]);

  console.log(`[migrate-schedule-scopes] ${filePath}`);
  if (!changed) {
    console.log('  No changes — all enumerated schedules are already stamped (or absent). No-op.');
    return;
  }

  console.log('  Proposed scope stamps:');
  for (const change of changes) {
    console.log(`    "${change.name}" (${change.playbookPath}): ${change.before ?? '<none>'} → ${change.after}`);
  }

  if (dryRun) {
    console.log('  --dry-run: not writing. Re-run without --dry-run to apply.');
    return;
  }

  writeFileSync(filePath, `${JSON.stringify(schedules, null, 2)}\n`, 'utf-8');
  console.log(`  Wrote ${changes.length} change(s) to ${filePath}.`);
}

// Run only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
