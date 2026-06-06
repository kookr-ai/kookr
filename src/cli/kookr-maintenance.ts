import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  planAndPruneMaintenance,
  type MaintenancePruneResult,
} from '../core/maintenance-prune.js';

/**
 * `kookr maintenance prune` (issue #706) — a thin CLI wrapper around the pure
 * {@link planAndPruneMaintenance} core. Operates directly on the data directory
 * (it does not talk to the running server), so it is safe to run during a
 * maintenance window whether or not Kookr is up; the core's terminal+aged
 * gating means even a concurrent live server keeps its active state.
 *
 *   kookr maintenance prune [--dry-run] [--max-age-days N] [--dir PATH] [--json]
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

interface ParsedArgs {
  error?: string;
  dryRun: boolean;
  json: boolean;
  maxAgeDays?: number;
  dir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dryRun: false, json: false };
  // First positional must be the `prune` verb.
  if (argv[0] !== 'prune') {
    parsed.error = 'Usage: kookr maintenance prune [--dry-run] [--max-age-days N] [--dir PATH] [--json]';
    return parsed;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--max-age-days': {
        const raw = argv[++i];
        const value = Number(raw);
        if (raw === undefined || raw.startsWith('--') || !Number.isFinite(value) || value <= 0) {
          parsed.error = `--max-age-days requires a positive number (got ${JSON.stringify(raw)}).`;
          return parsed;
        }
        parsed.maxAgeDays = value;
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
    lines.push(`  ${verb} ${result.planned.length} hook log(s), ${formatBytes(result.reclaimedBytes)}:`);
    for (const r of result.planned) {
      const owner = r.taskId ? `task ${r.taskId}` : 'orphan';
      lines.push(`    - ${r.tmuxSession}.jsonl  (${owner}, ${r.reason}, ${r.ageDays}d, ${formatBytes(r.bytes)})`);
    }
  }
  lines.push(`  Preserved ${result.preserved.length} store(s) by design (crash-recovery / audit / ambiguous mapping).`);
  for (const w of result.warnings) lines.push(`  ! ${w}`);
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
  let result: MaintenancePruneResult;
  try {
    result = await planAndPruneMaintenance({
      dataDir,
      dryRun: parsed.dryRun,
      maxAgeDays: parsed.maxAgeDays,
    });
  } catch (err) {
    out.error(`kookr maintenance: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  out.log(parsed.json ? JSON.stringify(result, null, 2) : formatHuman(result));
  return 0;
}
