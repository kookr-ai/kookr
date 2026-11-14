/**
 * The fleet check (RFC "Plugins for the Kookr fleet", section 2, R5): what a
 * Claude agent launched with the current fleet set actually loads.
 *
 * Claude Code fails quietly: an enabled id that is not installed is ignored,
 * and a plugin that cannot load leaves only a `plugin_errors` entry, sometimes
 * under a different id than the one requested (a plugin its marketplace has
 * renamed is reported under the new name). So the check starts a one-shot
 * print-mode session with the adapter's binary and plugin flags plus the
 * `enabledPlugins` a spawn would get, reads its `system/init` message, and
 * stops the process right after it, before any model reply.
 *
 * The probe settings carry `enabledPlugins` only, never Kookr's hook block, so
 * the probe emits no hook events for a session Kookr does not know.
 *
 * This is a pre-flight: it shows what a NEW agent would load, not what a
 * particular running agent did load.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { renderEnabledPlugins } from '../../core/claude-settings/loadout.js';
import type {
  FleetCheckPluginResult,
  FleetCheckResult,
} from '../../shared/contracts/plugins.js';
import { partitionByInstalled, type LoadoutStore } from './loadout-store.js';
import type { InstalledPlugins } from './registry.js';

/** The `system/init` fields the check reads. */
export interface ClaudeInitMessage {
  plugins?: Array<{ name?: string; source?: string; version?: string | null; path?: string }>;
  plugin_errors?: Array<{ plugin?: string; type?: string; message?: string }>;
}

/** Binary, plugin flags and directory-loaded plugin names, as the Claude adapter spawns them. */
export interface FleetProbeCommand {
  bin: string;
  args: string[];
  dirLoadedPluginNames: readonly string[];
}

/** Runs the probe process and returns its init message. Injectable for tests. */
export type InitProbe = (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<
  { init: ClaudeInitMessage } | { init: null; error: string }
>;

/** Argv for the probe: print mode, stream-json, the adapter's flags, and the rendered plugin settings. */
export function buildFleetCheckArgs(
  adapterArgs: readonly string[],
  enabledPlugins: Record<string, boolean> | undefined,
): string[] {
  return [
    '-p',
    'say OK',
    '--output-format',
    'stream-json',
    '--verbose',
    ...adapterArgs,
    ...(enabledPlugins ? ['--settings', JSON.stringify({ enabledPlugins })] : []),
  ];
}

/**
 * Find the `system/init` message in stream-json output. Other system messages
 * (hook start events) can come first, so this scans every line.
 */
export function findInitMessage(lines: Iterable<string>): ClaudeInitMessage | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; subtype?: string };
      if (parsed.type === 'system' && parsed.subtype === 'init') return parsed as ClaudeInitMessage;
    } catch {
      // not a JSON line
    }
  }
  return null;
}

/**
 * Compare what was requested with what the init message reports. Pure.
 *
 * - A requested id is `loaded` when an init plugin has that `source`, else
 *   `errored` when a `plugin_errors` entry names it, else `missing`.
 * - `@builtin` plugins and the directory-loaded plugins (`<name>@inline`) are
 *   expected and never `unexpected`.
 * - Errors that name no requested id are returned as `otherErrors`, so their
 *   text is never lost.
 */
export function evaluateFleetCheck(
  requested: readonly string[],
  init: ClaudeInitMessage,
  dirLoadedPluginNames: readonly string[],
): Pick<FleetCheckResult, 'plugins' | 'unexpected' | 'otherErrors'> {
  const loaded = new Map<string, string | null>();
  for (const p of init.plugins ?? []) {
    if (typeof p.source === 'string') loaded.set(p.source, typeof p.version === 'string' ? p.version : null);
  }
  const errors = (init.plugin_errors ?? []).filter((e) => typeof e.plugin === 'string');
  const requestedSet = new Set(requested);
  const plugins: FleetCheckPluginResult[] = requested.map((id) => {
    if (loaded.has(id)) return { id, state: 'loaded', version: loaded.get(id) ?? null };
    const err = errors.find((e) => e.plugin === id);
    if (err) return { id, state: 'errored', error: err.message ?? err.type ?? 'plugin error' };
    return { id, state: 'missing' };
  });
  const inline = new Set(dirLoadedPluginNames.map((n) => `${n}@inline`));
  const unexpected = [...loaded.keys()]
    .filter((src) => !requestedSet.has(src) && !src.endsWith('@builtin') && !inline.has(src))
    .sort();
  const otherErrors = errors
    .filter((e) => !requestedSet.has(e.plugin!))
    .map((e) => ({ plugin: e.plugin!, ...(e.type ? { type: e.type } : {}), message: e.message ?? '' }));
  return { plugins, unexpected, otherErrors };
}

/**
 * Default probe: spawn the binary, read stdout line by line, and kill it as
 * soon as the init message arrives (measured at about five seconds). Hard
 * timeout; never throws. Runs in the system temp directory so no project
 * settings or instructions are picked up.
 */
export const spawnInitProbe: InitProbe = (bin, args, { timeoutMs }) =>
  new Promise((resolvePromise) => {
    let settled = false;
    let buffer = '';
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const finish = (result: { init: ClaudeInitMessage } | { init: null; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGTERM');
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ init: null, error: `no init message within ${timeoutMs} ms` }), timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const init = findInitMessage(lines);
      if (init) finish({ init });
    });
    child.on('error', (err) => finish({ init: null, error: err.message }));
    child.on('close', (code) => {
      const init = findInitMessage([buffer]);
      finish(init ? { init } : { init: null, error: `probe exited (code ${code}) before an init message` });
    });
  });

export interface FleetCheckServiceDeps {
  loadoutStore: LoadoutStore;
  installedPlugins: InstalledPlugins;
  /** The Claude adapter's probe command; null when no Claude adapter is registered. */
  probeCommand: () => Promise<FleetProbeCommand | null>;
  probe?: InitProbe;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Owns the last fleet check result (in memory) and runs at most one check at a
 * time: a second request while one runs gets the same promise.
 */
export class FleetCheckService {
  private last: FleetCheckResult | null = null;
  private inFlight: Promise<FleetCheckResult> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: FleetCheckServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get lastResult(): FleetCheckResult | null {
    return this.last;
  }

  get running(): boolean {
    return this.inFlight !== null;
  }

  /** Run a check now (or join the one already running). Never throws. */
  run(trigger: string): Promise<FleetCheckResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce(trigger).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Fire-and-forget variant for automatic triggers (fleet change, plugin update, external change). */
  runInBackground(trigger: string): void {
    void this.run(trigger).catch(() => undefined);
  }

  private async runOnce(trigger: string): Promise<FleetCheckResult> {
    const started = this.now();
    const base = { checkedAt: started.toISOString(), trigger };
    const fail = (error: string, extra: Partial<FleetCheckResult> = {}): FleetCheckResult => ({
      ...base,
      durationMs: this.now().getTime() - started.getTime(),
      ok: false,
      error,
      plugins: [],
      skipped: [],
      unexpected: [],
      otherErrors: [],
      ...extra,
    });
    let result: FleetCheckResult;
    try {
      const command = await this.deps.probeCommand();
      if (!command) {
        result = fail('no Claude adapter is registered on this server');
      } else {
        const resolution = await this.deps.loadoutStore.resolveForLaunch({}, { mode: 'bypass' });
        const installed = await this.deps.installedPlugins.read().catch(() => new Map());
        const part = partitionByInstalled(resolution, installed, command.dirLoadedPluginNames);
        const enabledPlugins = renderEnabledPlugins(part.loadout, { dirLoadedPluginNames: command.dirLoadedPluginNames });
        const requested = part.plugins.map((p) => p.id);
        const outcome = await (this.deps.probe ?? spawnInitProbe)(
          command.bin,
          buildFleetCheckArgs(command.args, enabledPlugins),
          { timeoutMs: this.deps.timeoutMs ?? 30_000 },
        );
        if (outcome.init === null) {
          result = fail(outcome.error, { skipped: part.skipped });
        } else {
          result = {
            ...base,
            durationMs: this.now().getTime() - started.getTime(),
            ok: true,
            skipped: part.skipped,
            ...evaluateFleetCheck(requested, outcome.init, command.dirLoadedPluginNames),
          };
        }
      }
    } catch (err) {
      result = fail(err instanceof Error ? err.message : String(err));
    }
    const notLoaded = result.plugins.filter((p) => p.state !== 'loaded').length;
    const line =
      `[fleet-check] trigger=${trigger} ok=${result.ok} plugins=${result.plugins.length} ` +
      `not_loaded=${notLoaded} skipped=${result.skipped.length} unexpected=${result.unexpected.length} ` +
      `other_errors=${result.otherErrors.length} duration_ms=${result.durationMs}` +
      (result.error ? ` error=${JSON.stringify(result.error)}` : '');
    if (!result.ok || notLoaded > 0 || result.otherErrors.length > 0) console.warn(line);
    else console.log(line);
    this.last = result;
    return result;
  }
}
