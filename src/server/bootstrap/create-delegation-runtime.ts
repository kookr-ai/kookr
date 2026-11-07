import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createA2aClient, type A2aClient } from '../delegation/a2a-client.js';
import {
  parseDelegationConfig,
  readWorkerTokens,
  validateWorkerRegistry,
  type RegistryIssue,
} from '../delegation/registry.js';
import { DelegationService, type DelegationServiceDeps } from '../delegation/service.js';
import { createSnapshotManager } from '../delegation/snapshots.js';
import { DelegationStore } from '../delegation/store.js';
import { readHermesDelegationConfigPathFromEnv, readHermesDelegationOptInFromEnv } from '../config.js';

/**
 * Composition root for Kookr->Hermes delegation (RFC `rfc-kookr-hermes-delegation`, slice 1a).
 *
 * Plain-language summary: decide at startup whether delegation runs at all, and if so build
 * and start the service. Delegation ships dark. It runs only when BOTH the operator opted in
 * (`KOOKR_HERMES_DELEGATION=1`) AND a worker configuration file exists and passes
 * validation (distinct tokens, loopback or allow-listed worker URLs, attested read-only
 * leaf workers). If either is missing, this returns no service, the HTTP routes answer a typed
 * 503 `delegation_disabled`, and one log line states which condition failed. Log lines name missing
 * fields and files; they never contain a token, a token path's contents, or a result body.
 */

export interface DelegationRuntime {
  /** Undefined when delegation is not running; routes then answer 503 `delegation_disabled`. */
  service?: DelegationService;
  decision: { enabled: boolean; reason: string; missing: string[] };
  /** Set when there is no service: the typed reason code the routes report. */
  disabled?: { reason: 'flag_off' | 'no_config' | 'invalid_config'; missing: string[] };
  stop(): void;
}

export interface CreateDelegationRuntimeOptions {
  kookrDir: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Test seams. */
  client?: A2aClient;
  serviceOverrides?: Partial<DelegationServiceDeps>;
}

export async function createDelegationRuntime(options: CreateDelegationRuntimeOptions): Promise<DelegationRuntime> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const decide = (enabled: boolean, reason: string, missing: string[] = []): DelegationRuntime['decision'] => {
    log(JSON.stringify({ component: 'delegation', event: 'startup_decision', enabled, reason, missing }));
    return { enabled, reason, missing };
  };
  const off = (
    code: 'flag_off' | 'no_config' | 'invalid_config',
    reason: string,
    missing: string[] = [],
  ): DelegationRuntime => ({
    decision: decide(false, reason, missing),
    disabled: { reason: code, missing },
    stop() {},
  });

  if (!readHermesDelegationOptInFromEnv(env)) return off('flag_off', 'KOOKR_HERMES_DELEGATION is not set', ['KOOKR_HERMES_DELEGATION']);

  const configFile = readHermesDelegationConfigPathFromEnv(options.kookrDir, env);
  let rawText: string;
  try {
    rawText = await readFile(configFile, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    return off('no_config', `delegation config file ${code}`, [configFile]);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return off('invalid_config', 'delegation config file is not valid JSON', [configFile]);
  }
  const parsed = parseDelegationConfig(json);
  if (!parsed.ok) return off('invalid_config', 'delegation config is invalid', issueMessages(parsed.issues));

  // Relative paths in the file resolve against the file's own directory.
  const base = dirname(resolve(configFile));
  const config = parsed.config;
  config.snapshotsRoot = resolve(base, config.snapshotsRoot);
  for (const p of Object.values(config.projects)) p.repoDir = resolve(base, p.repoDir);
  for (const w of config.workers) w.tokenFile = resolve(base, w.tokenFile);

  const tokens = await readWorkerTokens(config.workers);
  const validated = validateWorkerRegistry(config, tokens);
  if (!validated.ok) return off('invalid_config', 'worker registry validation failed', issueMessages(validated.issues));

  const store = new DelegationStore(join(options.kookrDir, 'delegations.json'), {
    newInstanceId: () => randomUUID().slice(0, 8),
    ...(config.maxTerminalRecords ? { maxTerminalRecords: config.maxTerminalRecords } : {}),
  });
  const service = new DelegationService({
    config,
    workers: validated.workers,
    store,
    client: options.client ?? createA2aClient(),
    snapshots: createSnapshotManager({
      root: config.snapshotsRoot,
      projects: config.projects,
      log: (line) => log(JSON.stringify({ component: 'delegation', event: 'snapshot', note: line })),
    }),
    readAccepting: async () => {
      // Re-read the config file on every submit so the ordered disable needs no restart.
      const fresh = parseDelegationConfig(JSON.parse(await readFile(configFile, 'utf-8')));
      // A file that parses but no longer validates must not read as "accepting": throw so the
      // service keeps its last known value.
      if (!fresh.ok) throw new Error('delegation config no longer validates');
      return fresh.config.acceptingNewDelegations !== false;
    },
    log,
    ...options.serviceOverrides,
  });
  await service.start();
  const info = service.disabledInfo;
  if (info) {
    // Registered-but-disabled: routes answer a typed delegation_disabled naming the file.
    return {
      service,
      decision: decide(false, info.reason, info.file ? [info.file] : info.missing),
      stop: () => service.stop(),
    };
  }
  return {
    service,
    decision: decide(true, 'enabled', []),
    stop: () => service.stop(),
  };
}

function issueMessages(issues: readonly RegistryIssue[]): string[] {
  return issues.map((i) => i.message);
}
