import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  createMaintenanceBackup,
  defaultMaintenanceBackupOutDir,
  type MaintenanceBackupResult,
} from '../core/maintenance-backup.js';
import {
  planAndPruneMaintenance,
  type MaintenancePruneResult,
} from '../core/maintenance-prune.js';

/**
 * `kookr maintenance` wraps pure disk-maintenance cores. It operates directly
 * on the data directory (it does not talk to the running server), so it can run
 * during a maintenance window whether or not Kookr is up.
 *
 *   kookr maintenance prune [--dry-run] [--max-age-days N] [--dir PATH] [--json]
 *   kookr maintenance backup [--dir PATH] [--out PATH] [--json]
 */

const DEFAULT_PORT = 4800;

/**
 * Resolve the Kookr data directory from `KOOKR_PORT`, mirroring the static part
 * of the server's resolution in `src/server/start.ts`: `~/.kookr` on the
 * default port, `~/.kookr-<port>` for an explicit non-default port.
 *
 * Note the one divergence the CLI cannot reproduce: when the server is launched
 * with `KOOKR_PORT=auto` it scans for a free port and may land on a non-default
 * one (e.g. `~/.kookr-4801`). The CLI only sees the literal `auto` and falls
 * back to `~/.kookr`. Pass `--dir` to target an `auto`-launched instance
 * precisely; {@link autoPortAmbiguous} flags this case for a CLI-level warning.
 */
export function resolveKookrDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const raw = env.KOOKR_PORT?.trim();
  if (!raw) return join(home, '.kookr');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === DEFAULT_PORT) {
    return join(home, '.kookr');
  }
  return join(home, `.kookr-${port}`);
}

/**
 * True when `KOOKR_PORT=auto`: the default-dir fallback may be wrong because an
 * auto-launched server could have scanned onto a non-default port. Callers warn
 * the operator unless an explicit `--dir` was given.
 */
export function autoPortAmbiguous(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KOOKR_PORT?.trim().toLowerCase() === 'auto';
}

type MaintenanceVerb = 'prune' | 'backup';

interface ParsedArgs {
  error?: string;
  verb?: MaintenanceVerb;
  dryRun: boolean;
  json: boolean;
  maxAgeDays?: number;
  playbookMaxAgeDays?: number;
  playbookKeepLast?: number;
  dir?: string;
  outDir?: string;
}

const USAGE = [
  'Usage:',
  '  kookr maintenance prune [--dry-run] [--max-age-days N] [--playbook-max-age-days N] [--playbook-keep-last K] [--dir PATH] [--json]',
  '  kookr maintenance backup [--dir PATH] [--out PATH] [--json]',
].join('\n');

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dryRun: false, json: false };
  if (argv[0] !== 'prune' && argv[0] !== 'backup') {
    parsed.error = USAGE;
    return parsed;
  }
  parsed.verb = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        if (parsed.verb !== 'prune') {
          parsed.error = '--dry-run is only supported for `kookr maintenance prune`.';
          return parsed;
        }
        parsed.dryRun = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--max-age-days': {
        if (parsed.verb !== 'prune') {
          parsed.error = '--max-age-days is only supported for `kookr maintenance prune`.';
          return parsed;
        }
        const raw = argv[++i];
        const value = Number(raw);
        if (raw === undefined || raw.startsWith('--') || !Number.isFinite(value) || value <= 0) {
          parsed.error = `--max-age-days requires a positive number (got ${JSON.stringify(raw)}).`;
          return parsed;
        }
        parsed.maxAgeDays = value;
        break;
      }
      case '--playbook-max-age-days': {
        if (parsed.verb !== 'prune') {
          parsed.error = '--playbook-max-age-days is only supported for `kookr maintenance prune`.';
          return parsed;
        }
        const raw = argv[++i];
        const value = Number(raw);
        if (raw === undefined || raw.startsWith('--') || !Number.isFinite(value) || value <= 0) {
          parsed.error = `--playbook-max-age-days requires a positive number (got ${JSON.stringify(raw)}).`;
          return parsed;
        }
        parsed.playbookMaxAgeDays = value;
        break;
      }
      case '--playbook-keep-last': {
        if (parsed.verb !== 'prune') {
          parsed.error = '--playbook-keep-last is only supported for `kookr maintenance prune`.';
          return parsed;
        }
        const raw = argv[++i];
        const value = Number(raw);
        if (raw === undefined || raw.startsWith('--') || !Number.isInteger(value) || value < 0) {
          parsed.error = `--playbook-keep-last requires a non-negative integer (got ${JSON.stringify(raw)}).`;
          return parsed;
        }
        parsed.playbookKeepLast = value;
        break;
      }
      case '--dir': {
        const dir = argv[++i];
        if (!dir || dir.startsWith('--')) {
          parsed.error = '--dir requires a path argument.';
          return parsed;
        }
        parsed.dir = dir;
        break;
      }
      case '--out': {
        if (parsed.verb !== 'backup') {
          parsed.error = '--out is only supported for `kookr maintenance backup`.';
          return parsed;
        }
        const outDir = argv[++i];
        if (!outDir || outDir.startsWith('--')) {
          parsed.error = '--out requires a path argument.';
          return parsed;
        }
        parsed.outDir = outDir;
        break;
      }
      default:
        parsed.error = `Unknown argument: ${arg}`;
        return parsed;
    }
  }
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHuman(result: MaintenancePruneResult): string {
  const lines: string[] = [];
  const verb = result.dryRun ? 'Would remove' : 'Removed';
  lines.push(`Kookr maintenance prune — ${result.dataDir}`);
  if (result.dryRun) lines.push('  dry-run — no changes made');
  lines.push(`  age threshold: ${result.maxAgeDays} days`);
  if (result.planned.length === 0) {
    lines.push('  Nothing to prune — already clean.');
  } else {
    lines.push(`  ${verb} ${result.planned.length} artifact(s), ${formatBytes(result.reclaimedBytes)}:`);
    for (const r of result.planned) {
      if (r.kind === 'hook-log') {
        const owner = r.taskId ? `task ${r.taskId}` : 'orphan';
        lines.push(`    - ${basename(r.path)}  (${owner}, ${r.reason}, ${r.ageDays}d, ${formatBytes(r.bytes)})`);
        continue;
      }
      if (r.kind === 'activity-ledger') {
        const owner = r.taskId ? `task ${r.taskId}` : 'orphan';
        lines.push(`    - activity/${basename(r.path)}  (${owner}, ${r.reason}, ${r.ageDays}d, ${formatBytes(r.bytes)})`);
        continue;
      }
      if (r.kind === 'playbook-state-run') {
        lines.push(`    - playbook-state/${r.playbook}/${r.runKey}  (${r.reason}, ${r.ageDays}d, ${formatBytes(r.bytes)})`);
        continue;
      }
      lines.push(`    - ${basename(r.path)}  (${r.reason}, ${r.ageDays}d, ${formatBytes(r.bytes)})`);
    }
  }
  lines.push(`  Preserved ${result.preserved.length} store(s) by design (crash-recovery / audit / ambiguous mapping).`);
  for (const w of result.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}

function formatBackupHuman(result: MaintenanceBackupResult): string {
  const fileCount = result.manifest.entries.filter((entry) => entry.type === 'file').length;
  const dirCount = result.manifest.entries.filter((entry) => entry.type === 'directory').length;
  const symlinkCount = result.manifest.entries.filter((entry) => entry.type === 'symlink').length;
  const lines: string[] = [];
  lines.push(`Kookr maintenance backup — ${result.dataDir}`);
  lines.push(`  wrote: ${result.backupPath} (${formatBytes(result.archiveBytes)})`);
  lines.push(
    `  manifest: ${result.manifest.totalEntries} entr${result.manifest.totalEntries === 1 ? 'y' : 'ies'} ` +
      `(${fileCount} file(s), ${dirCount} dir(s), ${symlinkCount} symlink(s), ${formatBytes(result.manifest.totalFileBytes)} source bytes)`,
  );
  if (result.manifest.excluded.length > 0) {
    lines.push(`  excluded: ${result.manifest.excluded.length} path(s)`);
    for (const exclusion of result.manifest.excluded) {
      lines.push(`    - ${exclusion.path} (${exclusion.reason})`);
    }
  }
  lines.push(`  consistency: ${result.manifest.crashConsistency}`);
  lines.push('  restore: stop Kookr, extract the tarball, then copy data/. into the target data directory.');
  return lines.join('\n');
}

export async function runMaintenanceCli(
  argv: string[] = process.argv.slice(2),
  { out = console, env = process.env }: { out?: Pick<Console, 'log' | 'error'>; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    out.error(parsed.error);
    return 2;
  }

  const dataDir = parsed.dir ?? resolveKookrDataDir(env);
  if (!parsed.dir && autoPortAmbiguous(env)) {
    out.error(
      `Warning: KOOKR_PORT=auto — an auto-launched server may use a non-default data dir. ` +
        `Defaulting to ${dataDir}; pass --dir to target a specific instance.`,
    );
  }
  try {
    if (parsed.verb === 'backup') {
      const result = await createMaintenanceBackup({
        dataDir,
        outDir: parsed.outDir ?? defaultMaintenanceBackupOutDir(env.HOME ?? homedir()),
      });
      out.log(parsed.json ? JSON.stringify(result, null, 2) : formatBackupHuman(result));
      return 0;
    }

    const result: MaintenancePruneResult = await planAndPruneMaintenance({
      dataDir,
      dryRun: parsed.dryRun,
      maxAgeDays: parsed.maxAgeDays,
      playbookStateMaxAgeDays: parsed.playbookMaxAgeDays,
      playbookStateKeepLast: parsed.playbookKeepLast,
    });
    out.log(parsed.json ? JSON.stringify(result, null, 2) : formatHuman(result));
    return 0;
  } catch (err) {
    out.error(`kookr maintenance: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
