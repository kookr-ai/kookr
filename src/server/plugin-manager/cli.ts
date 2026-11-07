import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ClaudePluginCli — the ONE port over the `claude plugin` binary (RFC Layer 0).
 * All parsing of its output (the `list --json` records and the `details` token
 * figure) lives here, behind an injectable {@link PluginCliRunner} so tests use
 * a fake instead of the real binary. `claude plugin list --json` is the
 * registry source of truth; direct registry-file reads (`registry.ts`) are the
 * documented fallback, owned separately.
 */

export interface PluginCliRunner {
  /** Run `claude <args...>` and resolve its stdout; reject on non-zero exit. */
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

/** One record from `claude plugin list --json`. `enabled` is the CLI's RESOLVED
 * boolean (native default applied) — NOT the tri-state; resolve tri-state via
 * ClaudeSettingsStore instead. */
export interface PluginListRecord {
  id: string;
  version: string | null;
  scope: string | null;
  installPath: string | null;
}

export interface PluginDetails {
  /** Always-on token cost parsed from `claude plugin details`, or null when absent/unparseable. */
  alwaysOnTokens: number | null;
}

/** Default runner: executes the real `claude` binary via execFile (no shell). */
export function execFilePluginCliRunner(bin: string, env: NodeJS.ProcessEnv): PluginCliRunner {
  return {
    async run(args: string[]) {
      const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 120_000, env });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    },
  };
}

export class ClaudePluginCli {
  constructor(private readonly runner: PluginCliRunner) {}

  /**
   * `claude plugin list --json`. Tolerates both the bare-array shape and the
   * `{ installed: [...] }` wrapper (`--available`). Returns [] on any parse
   * failure — the caller falls back to the on-disk registry.
   */
  async list(): Promise<PluginListRecord[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.runner.run(['plugin', 'list', '--json']));
    } catch {
      return [];
    }
    return parseListOutput(stdout);
  }

  /** `claude plugin details <id>` → the always-on token figure (best-effort). */
  async details(id: string): Promise<PluginDetails> {
    let stdout: string;
    try {
      ({ stdout } = await this.runner.run(['plugin', 'details', id]));
    } catch {
      return { alwaysOnTokens: null };
    }
    return { alwaysOnTokens: parseAlwaysOnTokens(stdout) };
  }

  /** `claude plugin update <id> -y --json`. Throws on non-zero exit (caller handles). */
  async update(id: string): Promise<void> {
    await this.runner.run(['plugin', 'update', id, '-y', '--json']);
  }

  /** `claude plugin marketplace add <source>`. Throws on non-zero exit. */
  async marketplaceAdd(source: string): Promise<void> {
    await this.runner.run(['plugin', 'marketplace', 'add', source]);
  }

  /** `claude plugin install <id>`. Throws on non-zero exit. */
  async install(id: string): Promise<void> {
    await this.runner.run(['plugin', 'install', id]);
  }
}

/** Parse the output of `claude plugin list --json` (array or `{installed}` wrapper). Exported for tests. */
export function parseListOutput(stdout: string): PluginListRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { installed?: unknown }).installed)
      ? ((parsed as { installed: unknown[] }).installed)
      : null;
  if (arr === null) return [];
  const out: PluginListRecord[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    out.push({
      id: r.id,
      version: typeof r.version === 'string' ? r.version : null,
      scope: typeof r.scope === 'string' ? r.scope : null,
      installPath: typeof r.installPath === 'string' ? r.installPath : null,
    });
  }
  return out;
}

/**
 * Parse the "Always-on: ~N tok" figure from `claude plugin details` text.
 * Tolerates thousands separators ("~8,994 tok"). Returns null when absent.
 * Exported for tests.
 */
export function parseAlwaysOnTokens(detailsText: string): number | null {
  // e.g. "  Always-on:   ~8,994 tok   added to every session"
  const match = detailsText.match(/Always-on:\s*~?\s*([\d,]+)\s*tok/i);
  if (!match) return null;
  const n = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
