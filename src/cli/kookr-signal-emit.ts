// `kookr signal-emit` — write an operator signal into the delivery outbox
// (issue #1716). Monitors and cloud routines call this to turn a status
// reading or a liveness check into a spooled signal that the in-server
// SignalDeliveryService then pushes to Discord / Telegram.
//
// Two subcommands:
//
//   kookr signal-emit transition --source deploy-lag --status alert \
//       [--detail "7 commits / 9.5h behind origin/main"]
//     Records the current status for <source> and, when it crosses the
//     ok/alert boundary vs the persisted last-known status, spools a fire
//     (ok→alert) or clear (alert→ok) signal. --status accepts ok|alert|unknown.
//
//   kookr signal-emit liveness --registry <path.json> [--now <iso>]
//     Checks a liveness registry (JSON array of {name,maxAgeMs,path?,enabled?})
//     against artifact mtimes and spools one signal per newly-stale or
//     recovered artifact (re-emits a still-stale artifact at most once / 6h).
//
// Exit codes: 0 ok (whether or not a signal was emitted), 2 user error.

import { readFileSync, statSync } from 'node:fs';

import {
  defaultOperatorSignalDir,
  runLivenessEmit,
  runTransitionEmit,
  type LivenessRegistryEntry,
  type MonitorStatus,
} from '../observability/signal-delivery/index.js';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;

const HELP = `kookr signal-emit — spool an operator signal for delivery (issue #1716).

Usage:
  kookr signal-emit transition --source <name> --status ok|alert|unknown [--detail <text>]
  kookr signal-emit liveness --registry <path.json> [--now <iso>]

Common:
  --dir <path>   Override the operator-signal outbox dir
                 (default: KOOKR_OPERATOR_SIGNAL_DIR or ~/.kookr/playbook-state/operator-signals).
  -h, --help     Show this help.
`;

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function isStatus(v: string): v is MonitorStatus {
  return v === 'ok' || v === 'alert' || v === 'unknown';
}

export async function runSignalEmitCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const flags = parseFlags(rest);

  if (!sub || flags.help || sub === '-h' || sub === '--help') {
    process.stdout.write(HELP);
    return sub ? EXIT_OK : EXIT_USER_ERROR;
  }

  const dir = str(flags, 'dir') ?? defaultOperatorSignalDir(process.env);

  if (sub === 'transition') {
    const source = str(flags, 'source');
    const status = str(flags, 'status');
    if (!source) {
      process.stderr.write('signal-emit transition: --source is required\n');
      return EXIT_USER_ERROR;
    }
    if (!status || !isStatus(status)) {
      process.stderr.write('signal-emit transition: --status must be ok|alert|unknown\n');
      return EXIT_USER_ERROR;
    }
    const detail = str(flags, 'detail');
    const result = await runTransitionEmit({ dir, source, curr: status, ...(detail !== undefined ? { detail } : {}) });
    process.stdout.write(
      result.emitted
        ? `emitted ${result.fileName} (${result.prev} → ${result.next})\n`
        : `no transition (${result.prev} → ${result.next})\n`,
    );
    return EXIT_OK;
  }

  if (sub === 'liveness') {
    const registryPath = str(flags, 'registry');
    if (!registryPath) {
      process.stderr.write('signal-emit liveness: --registry <path.json> is required\n');
      return EXIT_USER_ERROR;
    }
    let registry: LivenessRegistryEntry[];
    try {
      const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('registry must be a JSON array');
      registry = parsed as LivenessRegistryEntry[];
    } catch (err) {
      process.stderr.write(`signal-emit liveness: cannot read registry: ${err instanceof Error ? err.message : String(err)}\n`);
      return EXIT_USER_ERROR;
    }
    const nowIso = str(flags, 'now');
    const now = nowIso ? () => new Date(nowIso) : () => new Date();
    const result = await runLivenessEmit({ dir, registry, now, ageMsOf: (entry) => artifactAgeMs(entry, now()) });
    process.stdout.write(`emitted ${result.emitted} liveness signal(s)\n`);
    return EXIT_OK;
  }

  process.stderr.write(`signal-emit: unknown subcommand '${sub}'\n${HELP}`);
  return EXIT_USER_ERROR;
}

/** Age of an artifact by mtime, or null when it is missing/unreadable. */
function artifactAgeMs(entry: LivenessRegistryEntry, now: Date): number | null {
  if (!entry.path) return null;
  try {
    const mtime = statSync(entry.path).mtimeMs;
    return Math.max(0, now.getTime() - mtime);
  } catch {
    return null;
  }
}
