/**
 * `kookr playbook` — read-only terminal view of the playbook catalog
 * (issue #3126). Every other CLI subsystem (`schedule`, `issue`, `emission`,
 * `queue-feeder`) has a terminal `list` verb; this brings the same
 * CLI/dashboard parity to playbooks so a terminal-first user or a script can
 * discover which playbooks are installed at project, user, or plugin scope
 * without opening the dashboard launch dialog.
 *
 *   kookr playbook list [--json]
 *
 * Discovery reads the local filesystem directly (project / user / plugin
 * tiers) via `discoverPlaybooks`, so no running server is required. Strictly
 * read-only: there is no `run` / `launch` subverb here.
 */

import { discoverPlaybooks } from '../core/playbook-discovery.js';
import type { Playbook, PlaybookScope } from '../core/playbook.js';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
/** Discovery failed to read the filesystem (rare: EACCES, TOCTOU). */
export const EXIT_DISCOVERY_ERROR = 1;

const PLAYBOOK_HELP_TEXT = `kookr playbook — inspect the playbook catalog.

Usage:
  kookr playbook list [--json]

list  Print available playbooks (name · scope · description) resolved from the
      project (\`<cwd>/.kookr/playbooks\`), user (\`~/.kookr/playbooks\`), and
      plugin tiers. Read-only.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  -h, --help   Show this help.

Exit codes:
  0  Success.
  1  Discovery failed to read the playbook directories.
  2  User error (bad flags / unknown verb).
`;

/** Projected list row — a lean view of a Playbook (drops body/parameters). */
interface PlaybookListRow {
  id: string;
  name: string;
  scope: PlaybookScope;
  description: string;
}

export interface PlaybookCliIo {
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Working directory whose project tier is scanned. Defaults to process.cwd(). */
  cwd?: string;
  /** Override discovery (tests). Defaults to the filesystem `discoverPlaybooks`. */
  discover?: (cwd: string) => Promise<Playbook[]>;
}

interface ResolvedIo {
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  cwd: string;
  discover: (cwd: string) => Promise<Playbook[]>;
}

interface ParsedPlaybookArgs {
  verb: 'list' | null;
  json: boolean;
  help: boolean;
  error?: string;
}

function parsePlaybookArgs(argv: string[]): ParsedPlaybookArgs {
  // Detect --json up front (position-independent) so an error return still emits
  // the machine-readable envelope even when the bad token precedes --json — e.g.
  // `playbook list --nope --json`. Mirrors `kookr schedule`'s argv.includes check.
  const out: ParsedPlaybookArgs = { verb: null, json: argv.includes('--json'), help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      // already captured above
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'list') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = 'list';
    } else {
      return { ...out, error: `unexpected argument: ${tok}` };
    }
  }
  return out;
}

function toRow(playbook: Playbook): PlaybookListRow {
  return {
    id: playbook.id,
    name: playbook.name,
    scope: playbook.scope,
    description: playbook.description,
  };
}

function formatPlaybookLine(row: PlaybookListRow): string {
  const description = row.description.trim() || '(no description)';
  return `${row.name} · ${row.scope} · ${description}`;
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runPlaybookCli(argv: string[], io: PlaybookCliIo = {}): Promise<number> {
  const resolved: ResolvedIo = {
    out: io.out ?? console,
    err: io.err ?? console,
    cwd: io.cwd ?? process.cwd(),
    discover: io.discover ?? ((cwd: string) => discoverPlaybooks(cwd)),
  };

  const args = parsePlaybookArgs(argv);
  if (args.help) {
    // In --json mode, help travels inside the envelope too (message "Help",
    // details.help), matching the dispatcher's subcommand-help contract that
    // `kookr status --json --help` establishes and kookr.test.ts asserts.
    if (args.json) {
      emitJson(resolved.out, {
        ok: true,
        code: 'OK',
        message: 'Help',
        details: { help: PLAYBOOK_HELP_TEXT, subcommand: 'playbook' },
      });
    } else {
      resolved.out.log(PLAYBOOK_HELP_TEXT);
    }
    return EXIT_OK;
  }
  if (args.error) {
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message: args.error,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${args.error}`);
      resolved.err.error('Run `kookr playbook --help` for usage.');
    }
    return EXIT_USER_ERROR;
  }
  if (args.verb === null) {
    const message = 'a verb is required (e.g. `kookr playbook list`).';
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${message}`);
      resolved.err.error(PLAYBOOK_HELP_TEXT);
    }
    return EXIT_USER_ERROR;
  }

  // Discovery reads the filesystem, so it can reject on a non-parse error
  // (EACCES, or a file removed between readdir and stat). Keep the failure
  // inside the envelope contract the other list commands honor rather than
  // letting it escape to the dispatcher's plain-text top-level catch.
  let playbooks: Playbook[];
  try {
    playbooks = await resolved.discover(resolved.cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `failed to read playbook directories: ${detail}`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'DISCOVERY_ERROR',
        message,
        details: { subcommand: 'playbook' },
      });
    } else {
      resolved.err.error(`kookr playbook: ${message}`);
    }
    return EXIT_DISCOVERY_ERROR;
  }

  const rows = playbooks.map(toRow);

  if (args.json) {
    emitJson(resolved.out, {
      ok: true,
      code: 'OK',
      message: `${rows.length} playbook(s).`,
      details: { playbooks: rows },
    });
    return EXIT_OK;
  }

  if (rows.length === 0) {
    resolved.out.log('No playbooks found.');
    return EXIT_OK;
  }
  for (const row of rows) resolved.out.log(formatPlaybookLine(row));
  return EXIT_OK;
}
