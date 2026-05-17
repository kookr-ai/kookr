import { createHash } from 'node:crypto';
import { W_OK } from 'node:constants';
import { accessSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { envRelayConnectionCredentials, loadStoredRelayConnectionCredentials, type RelayConnectionCredentials } from './relay-connection-store.js';

export type RelayLifecycleMode = 'detached';
export type RelayProcessState = 'running' | 'stopped' | 'stale-pid' | 'foreign-process' | 'foreign-port';
export type RelayEnvState = 'ok' | 'missing-env' | 'missing-admin-token' | 'restart-required';
export type RelayNodeState = 'not-configured' | 'ok' | 'token-rejected' | 'unreachable' | 'error';

export interface RelayLifecyclePaths {
  kookrDir: string;
  pidPath: string;
  logPath: string;
  statePath: string;
  dbPath: string;
}

export interface RelayStateFile {
  schemaVersion: 'relay-lifecycle-state.v1';
  mode: RelayLifecycleMode;
  pid: number;
  command: string[];
  cwd: string;
  bindHost: string;
  port: number;
  relayUrl: string;
  stateDbPath: string;
  logPath: string;
  startedAt: string;
  envFilePath?: string;
  envFileHash?: string;
}

export interface RelayProcessDiagnosis {
  state: RelayProcessState;
  pid?: number;
  expectedPid?: number;
  commandLine?: string;
  bindHost: string;
  port: number;
  relayUrl: string;
  message: string;
}

export interface RelayEnvDiagnosis {
  state: RelayEnvState;
  envFilePath: string;
  envFilePresent: boolean;
  adminTokenConfigured: boolean;
  insecureDev: boolean;
  processAdminTokenConfigured: boolean;
  requiresRestart: boolean;
  message: string;
}

export interface RelayNodeDiagnosis {
  state: RelayNodeState;
  relayUrl?: string;
  nodeId?: string;
  message: string;
}

export interface RelayStorageDiagnosis {
  state: 'ok' | 'db-write-failed';
  dbPath: string;
  message: string;
}

export interface RelayDoctorReport {
  checkedAt: string;
  paths: RelayLifecyclePaths;
  process: RelayProcessDiagnosis;
  env: RelayEnvDiagnosis;
  node: RelayNodeDiagnosis;
  storage: RelayStorageDiagnosis;
  policy: {
    nodeCount?: number;
    invitationCount?: number;
    maxPolicyVersion?: number;
    status: 'unavailable' | 'ok' | 'unauthorized';
  };
  recentLogs: string[];
  nextActions: string[];
}

export interface RelayLifecycleOptions {
  cwd?: string;
  kookrDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface RuntimeConfig {
  cwd: string;
  paths: RelayLifecyclePaths;
  bindHost: string;
  port: number;
  relayUrl: string;
  envFilePath: string;
  stateDbPath: string;
}

const STATE_VERSION = 'relay-lifecycle-state.v1';
const RELAY_ENV_HASH_KEYS = [
  'KOOKR_RELAY_ACCOUNT_ID',
  'KOOKR_RELAY_ACCOUNT_TOKEN',
  'KOOKR_RELAY_ADMIN_TOKEN',
  'KOOKR_RELAY_ALLOW_INSECURE_BIND',
  'KOOKR_RELAY_BIND_HOST',
  'KOOKR_RELAY_CLIENT_TOKEN',
  'KOOKR_RELAY_INSECURE_DEV',
  'KOOKR_RELAY_PORT',
  'KOOKR_RELAY_STATE_DB_PATH',
  `KOOKR_RELAY_${'TRUSTED_PROXY'}`,
  'PORT',
];
const TOKEN_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(KOOKR_[A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD)=)[^\s]+/g,
  /(kookr_tok_v1_)[A-Za-z0-9_-]+/g,
  /("?(?:relayToken|nodeToken|adminToken|accountToken)"?\s*:\s*")[^"]+/g,
];

export function relayLifecyclePaths(kookrDir = join(homedir(), '.kookr')): RelayLifecyclePaths {
  return {
    kookrDir,
    pidPath: join(kookrDir, 'relay.pid'),
    logPath: join(kookrDir, 'relay.log'),
    statePath: join(kookrDir, 'relay.state.json'),
    dbPath: join(kookrDir, 'relay.sqlite'),
  };
}

export function redactRelaySecret(text: string): string {
  let redacted = text;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, '$1[redacted]');
  }
  return redacted;
}

function relayStateFileHash(path: string): string | undefined {
  try {
    return relayRelevantEnvHash(parseDotEnv(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function readRelayState(paths: RelayLifecyclePaths): RelayStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, 'utf8')) as Partial<RelayStateFile>;
    if (parsed.schemaVersion !== STATE_VERSION || typeof parsed.pid !== 'number') return null;
    if (!Array.isArray(parsed.command) || typeof parsed.cwd !== 'string') return null;
    if (typeof parsed.bindHost !== 'string' || typeof parsed.port !== 'number') return null;
    if (typeof parsed.relayUrl !== 'string' || typeof parsed.stateDbPath !== 'string') return null;
    return parsed as RelayStateFile;
  } catch {
    return null;
  }
}

export function diagnoseRelayEnv(opts: RelayLifecycleOptions = {}): RelayEnvDiagnosis {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const envFilePath = env.KOOKR_RELAY_ENV_FILE ? resolve(env.KOOKR_RELAY_ENV_FILE) : join(cwd, '.env');
  const processAdminTokenConfigured = Boolean(env.KOOKR_RELAY_ADMIN_TOKEN?.trim());
  const insecureDev = env.KOOKR_RELAY_INSECURE_DEV === '1';
  let envFilePresent = false;
  let adminTokenConfigured = false;
  let envFileHash: string | undefined;
  try {
    const text = readFileSync(envFilePath, 'utf8');
    envFilePresent = true;
    const parsed = parseDotEnv(text);
    envFileHash = relayRelevantEnvHash(parsed);
    adminTokenConfigured = Boolean(parsed.KOOKR_RELAY_ADMIN_TOKEN?.trim()) || parsed.KOOKR_RELAY_INSECURE_DEV === '1';
  } catch {
    envFilePresent = false;
  }

  const paths = relayLifecyclePaths(opts.kookrDir);
  const state = readRelayState(paths);
  const requiresRestart = Boolean(state?.envFileHash && envFileHash && state.envFileHash !== envFileHash);
  if (!envFilePresent && !processAdminTokenConfigured && !insecureDev) {
    return {
      state: 'missing-env',
      envFilePath,
      envFilePresent,
      adminTokenConfigured,
      insecureDev,
      processAdminTokenConfigured,
      requiresRestart: false,
      message: 'No .env file or process relay admin token was found.',
    };
  }
  if (!processAdminTokenConfigured && !adminTokenConfigured && !insecureDev) {
    return {
      state: 'missing-admin-token',
      envFilePath,
      envFilePresent,
      adminTokenConfigured,
      insecureDev,
      processAdminTokenConfigured,
      requiresRestart: false,
      message: 'KOOKR_RELAY_ADMIN_TOKEN is missing. Set it in .env or use KOOKR_RELAY_INSECURE_DEV=1 for local development only.',
    };
  }
  if (requiresRestart) {
    return {
      state: 'restart-required',
      envFilePath,
      envFilePresent,
      adminTokenConfigured,
      insecureDev,
      processAdminTokenConfigured,
      requiresRestart: true,
      message: 'The relay env file changed after the relay process started; restart relay with pnpm relay:restart.',
    };
  }
  return {
    state: 'ok',
    envFilePath,
    envFilePresent,
    adminTokenConfigured,
    insecureDev,
    processAdminTokenConfigured,
    requiresRestart: false,
    message: 'Relay env is usable.',
  };
}

export async function diagnoseRelayProcess(opts: RelayLifecycleOptions = {}): Promise<RelayProcessDiagnosis> {
  const config = resolveRuntimeConfig(opts);
  const state = readRelayState(config.paths);
  const pid = readPid(config.paths, state);
  if (pid) {
    const commandLine = readProcessCommandLine(pid);
    if (!commandLine) {
      return {
        state: 'stale-pid',
        expectedPid: pid,
        bindHost: config.bindHost,
        port: config.port,
        relayUrl: config.relayUrl,
        message: `Stale relay pid file points at ${pid}.`,
      };
    }
    if (!looksLikeRelayCommand(commandLine)) {
      return {
        state: 'foreign-process',
        pid,
        commandLine: redactRelaySecret(commandLine),
        bindHost: config.bindHost,
        port: config.port,
        relayUrl: config.relayUrl,
        message: `Pid ${pid} is alive but does not look like the Kookr relay.`,
      };
    }
    if (!state || state.pid !== pid) {
      return {
        state: 'foreign-process',
        pid,
        commandLine: redactRelaySecret(commandLine),
        bindHost: config.bindHost,
        port: config.port,
        relayUrl: config.relayUrl,
        message: `Pid ${pid} looks like a relay, but relay state does not prove ownership.`,
      };
    }
    if (!stateMatchesRuntimeConfig(state, config)) {
      return {
        state: 'foreign-process',
        pid,
        commandLine: redactRelaySecret(commandLine),
        bindHost: config.bindHost,
        port: config.port,
        relayUrl: config.relayUrl,
        message: `Pid ${pid} belongs to a different relay runtime topology; refusing to manage it from this worktree.`,
      };
    }
    return {
      state: 'running',
      pid,
      commandLine: redactRelaySecret(commandLine),
      bindHost: state?.bindHost ?? config.bindHost,
      port: state?.port ?? config.port,
      relayUrl: state?.relayUrl ?? config.relayUrl,
      message: `Relay is running as pid ${pid}.`,
    };
  }

  if (await portIsListening(config.bindHost, config.port)) {
    return {
      state: 'foreign-port',
      bindHost: config.bindHost,
      port: config.port,
      relayUrl: config.relayUrl,
      message: `Port ${config.port} is already listening but is not owned by a tracked relay process.`,
    };
  }

  return {
    state: 'stopped',
    bindHost: config.bindHost,
    port: config.port,
    relayUrl: config.relayUrl,
    message: 'Relay is stopped.',
  };
}

export async function diagnoseRelayNode(opts: RelayLifecycleOptions = {}): Promise<RelayNodeDiagnosis> {
  const env = opts.env ?? process.env;
  const kookrDir = opts.kookrDir ?? join(homedir(), '.kookr');
  let credentials: RelayConnectionCredentials | null = envRelayConnectionCredentials(env);
  if (!credentials) {
    try {
      credentials = await loadStoredRelayConnectionCredentials(kookrDir);
    } catch {
      credentials = null;
    }
  }
  if (!credentials) {
    return { state: 'not-configured', message: 'No node credential is configured.' };
  }
  try {
    const res = await fetch(new URL('/relay/node/status', credentials.relayUrl), {
      headers: { authorization: `Bearer ${credentials.relayToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        state: 'token-rejected',
        relayUrl: credentials.relayUrl,
        nodeId: credentials.nodeId,
        message: 'Relay rejected the configured node token; re-pair this node.',
      };
    }
    if (!res.ok) {
      return {
        state: 'error',
        relayUrl: credentials.relayUrl,
        nodeId: credentials.nodeId,
        message: `Relay node status returned HTTP ${res.status}.`,
      };
    }
    const body = await res.json().catch(() => null) as { nodeId?: unknown } | null;
    return {
      state: 'ok',
      relayUrl: credentials.relayUrl,
      nodeId: typeof body?.nodeId === 'string' ? body.nodeId : credentials.nodeId,
      message: 'Relay accepted the configured node token.',
    };
  } catch {
    return {
      state: 'unreachable',
      relayUrl: credentials.relayUrl,
      nodeId: credentials.nodeId,
      message: 'Relay URL is unreachable from this process.',
    };
  }
}

export async function buildRelayDoctorReport(opts: RelayLifecycleOptions = {}): Promise<RelayDoctorReport> {
  const config = resolveRuntimeConfig(opts);
  const [processDiagnosis, nodeDiagnosis, policy] = await Promise.all([
    diagnoseRelayProcess(opts),
    diagnoseRelayNode(opts),
    fetchRelayPolicySummary(opts),
  ]);
  const envDiagnosis = diagnoseRelayEnv(opts);
  const storage = diagnoseRelayStorage(config);
  return {
    checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
    paths: config.paths,
    process: processDiagnosis,
    env: envDiagnosis,
    node: nodeDiagnosis,
    storage,
    policy,
    recentLogs: await readRecentRelayLogs(config.paths.logPath, 30),
    nextActions: nextActions(processDiagnosis, envDiagnosis, nodeDiagnosis, storage, policy),
  };
}

export async function startRelay(opts: RelayLifecycleOptions = {}): Promise<string> {
  const config = resolveRuntimeConfig(opts);
  mkdirSync(config.paths.kookrDir, { recursive: true });
  const envDiagnosis = diagnoseRelayEnv(opts);
  if (envDiagnosis.state === 'missing-env' || envDiagnosis.state === 'missing-admin-token') {
    throw new Error(`${envDiagnosis.message} Fix env first; relay was not started.`);
  }
  const processDiagnosis = await diagnoseRelayProcess(opts);
  if (processDiagnosis.state === 'running') return processDiagnosis.message;
  if (processDiagnosis.state === 'foreign-process' || processDiagnosis.state === 'foreign-port') {
    throw new Error(`${processDiagnosis.message} Stop the owning process or choose KOOKR_RELAY_PORT.`);
  }
  if (processDiagnosis.state === 'stale-pid') {
    rmSync(config.paths.pidPath, { force: true });
    rmSync(config.paths.statePath, { force: true });
  }

  const command = relayServerCommand(config.cwd);
  const logStream = createWriteStream(config.paths.logPath, { flags: 'a' });
  await appendFile(config.paths.logPath, `[relay-lifecycle] starting at ${new Date().toISOString()}\n`, 'utf8');
  const child = spawn(command[0]!, command.slice(1), {
    cwd: config.cwd,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: {
      ...loadDotEnv(config.envFilePath),
      ...process.env,
      ...(opts.env ?? {}),
      PORT: String(config.port),
      KOOKR_RELAY_BIND_HOST: config.bindHost,
      KOOKR_RELAY_STATE_DB_PATH: config.stateDbPath,
    },
  });
  child.unref();
  if (!child.pid) throw new Error('Relay process did not expose a pid.');
  writeFileSync(config.paths.pidPath, `${child.pid}\n`, 'utf8');
  writeRelayState(config, child.pid, command);
  return `Relay starting as pid ${child.pid} on ${config.relayUrl}. Logs: ${config.paths.logPath}`;
}

export async function stopRelay(opts: RelayLifecycleOptions = {}): Promise<string> {
  const config = resolveRuntimeConfig(opts);
  const diagnosis = await diagnoseRelayProcess(opts);
  if (diagnosis.state === 'stopped') return 'Relay is already stopped.';
  if (diagnosis.state === 'stale-pid') {
    rmSync(config.paths.pidPath, { force: true });
    rmSync(config.paths.statePath, { force: true });
    return 'Removed stale relay pid file.';
  }
  if (diagnosis.state !== 'running' || !diagnosis.pid) {
    throw new Error(`${diagnosis.message} Refusing to stop an unowned process.`);
  }
  process.kill(diagnosis.pid, 'SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  if (readProcessCommandLine(diagnosis.pid)) {
    process.kill(diagnosis.pid, 'SIGKILL');
  }
  rmSync(config.paths.pidPath, { force: true });
  rmSync(config.paths.statePath, { force: true });
  return `Stopped relay pid ${diagnosis.pid}.`;
}

export async function restartRelay(opts: RelayLifecycleOptions = {}): Promise<string> {
  const stopped = await stopRelay(opts).catch((err: unknown) => {
    if (err instanceof Error && err.message.includes('Refusing to stop')) throw err;
    return err instanceof Error ? err.message : String(err);
  });
  const started = await startRelay(opts);
  return `${stopped}\n${started}`;
}

export async function readRecentRelayLogs(logPath: string, maxLines = 80): Promise<string[]> {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(redactRelaySecret);
  } catch {
    return [];
  }
}

export function formatRelayDoctorReport(report: RelayDoctorReport): string {
  const safe = {
    checkedAt: report.checkedAt,
    relayUrl: report.process.relayUrl,
    process: report.process,
    env: report.env,
    node: report.node,
    storage: report.storage,
    policy: report.policy,
    paths: {
      pid: report.paths.pidPath,
      log: report.paths.logPath,
      state: report.paths.statePath,
      sqlite: report.paths.dbPath,
    },
    recentLogs: report.recentLogs,
    nextActions: report.nextActions,
  };
  return `${JSON.stringify(safe, null, 2)}\n`;
}

function resolveRuntimeConfig(opts: RelayLifecycleOptions): RuntimeConfig {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const baseEnv = opts.env ?? process.env;
  const configuredEnvFilePath = baseEnv.KOOKR_RELAY_ENV_FILE ? resolve(baseEnv.KOOKR_RELAY_ENV_FILE) : join(cwd, '.env');
  const env = { ...loadDotEnv(configuredEnvFilePath), ...process.env, ...(opts.env ?? {}) };
  const paths = relayLifecyclePaths(opts.kookrDir ?? env.KOOKR_DIR ?? join(homedir(), '.kookr'));
  const bindHost = env.KOOKR_RELAY_BIND_HOST ?? '127.0.0.1';
  const port = positiveInt(env.KOOKR_RELAY_PORT ?? env.PORT, 8080);
  const relayHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  return {
    cwd,
    paths,
    bindHost,
    port,
    relayUrl: `http://${relayHost}:${port}`,
    envFilePath: configuredEnvFilePath,
    stateDbPath: env.KOOKR_RELAY_STATE_DB_PATH ?? paths.dbPath,
  };
}

function writeRelayState(config: RuntimeConfig, pid: number, command: string[]): void {
  const envHash = relayStateFileHash(config.envFilePath);
  const state: RelayStateFile = {
    schemaVersion: STATE_VERSION,
    mode: 'detached',
    pid,
    command,
    cwd: config.cwd,
    bindHost: config.bindHost,
    port: config.port,
    relayUrl: config.relayUrl,
    stateDbPath: config.stateDbPath,
    logPath: config.paths.logPath,
    startedAt: new Date().toISOString(),
    envFilePath: config.envFilePath,
    ...(envHash ? { envFileHash: envHash } : {}),
  };
  mkdirSync(dirname(config.paths.statePath), { recursive: true });
  writeFileSync(config.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function readPid(paths: RelayLifecyclePaths, state: RelayStateFile | null): number | undefined {
  try {
    const raw = readFileSync(paths.pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch {
    // fall through to state file
  }
  return state?.pid;
}

function readProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }
}

function looksLikeRelayCommand(commandLine: string): boolean {
  return commandLine.includes('relay/server.ts') || commandLine.includes('relay/server.js') || commandLine.includes('/relay/server');
}

async function portIsListening(bindHost: string, port: number): Promise<boolean> {
  const host = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

function relayServerCommand(cwd: string): string[] {
  const built = join(cwd, 'dist', 'relay', 'server.js');
  if (existsSync(built)) return [process.execPath, built];
  return [process.execPath, '--import', 'tsx', join(cwd, 'relay', 'server.ts')];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    parsed[trimmed.slice(0, eq).trim()] = unquote(trimmed.slice(eq + 1).trim());
  }
  return parsed;
}

function relayRelevantEnvHash(parsed: Record<string, string>): string {
  const relevant = RELAY_ENV_HASH_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(parsed, key))
    .map((key) => [key, parsed[key]] as const);
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function loadDotEnv(path: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function fetchRelayPolicySummary(opts: RelayLifecycleOptions): Promise<RelayDoctorReport['policy']> {
  const config = resolveRuntimeConfig(opts);
  const env = { ...loadDotEnv(config.envFilePath), ...process.env, ...(opts.env ?? {}) };
  const adminToken = env.KOOKR_RELAY_ADMIN_TOKEN?.trim();
  if (!adminToken && env.KOOKR_RELAY_INSECURE_DEV !== '1') return { status: 'unavailable' };
  const headers: Record<string, string> | undefined = adminToken ? { authorization: `Bearer ${adminToken}` } : undefined;
  try {
    const [nodesRes, invitationsRes] = await Promise.all([
      fetch(new URL('/relay/admin/nodes', config.relayUrl), { headers }),
      fetch(new URL('/relay/admin/invitations', config.relayUrl), { headers }),
    ]);
    if (nodesRes.status === 401 || invitationsRes.status === 401) return { status: 'unauthorized' };
    if (!nodesRes.ok || !invitationsRes.ok) return { status: 'unavailable' };
    const nodesBody = await nodesRes.json().catch(() => ({})) as { nodes?: unknown };
    const invitationsBody = await invitationsRes.json().catch(() => ({})) as { invitations?: unknown };
    const invitations = Array.isArray(invitationsBody.invitations) ? invitationsBody.invitations : [];
    return {
      status: 'ok',
      nodeCount: Array.isArray(nodesBody.nodes) ? nodesBody.nodes.length : 0,
      invitationCount: invitations.length,
      maxPolicyVersion: invitations.reduce((max, invitation) => {
        const version = typeof (invitation as { policyVersion?: unknown }).policyVersion === 'number'
          ? (invitation as { policyVersion: number }).policyVersion
          : 0;
        return Math.max(max, version);
      }, 0),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

function nextActions(
  processDiagnosis: RelayProcessDiagnosis,
  envDiagnosis: RelayEnvDiagnosis,
  nodeDiagnosis: RelayNodeDiagnosis,
  storageDiagnosis: RelayStorageDiagnosis,
  policy: RelayDoctorReport['policy'],
): string[] {
  const actions: string[] = [];
  if (processDiagnosis.state === 'stopped') actions.push('Start the local relay with pnpm relay:start.');
  if (processDiagnosis.state === 'stale-pid') actions.push('Remove the stale pid or run pnpm relay:start to clean it up.');
  if (processDiagnosis.state === 'foreign-port') actions.push('Free the relay port or set KOOKR_RELAY_PORT to a different value.');
  if (envDiagnosis.state === 'missing-env' || envDiagnosis.state === 'missing-admin-token') actions.push('Fix .env before starting relay.');
  if (envDiagnosis.state === 'restart-required') actions.push('Restart the relay with pnpm relay:restart.');
  if (nodeDiagnosis.state === 'token-rejected') actions.push('Re-pair this Kookr node in Settings or with scripts/install/kookr-relay-init.ts.');
  if (nodeDiagnosis.state === 'unreachable') actions.push('Restart relay if it is local; otherwise check relay URL/network.');
  if (storageDiagnosis.state === 'db-write-failed') actions.push('Fix relay state database path permissions or set KOOKR_RELAY_STATE_DB_PATH.');
  if (policy.status === 'unauthorized') actions.push('Check KOOKR_RELAY_ADMIN_TOKEN; admin diagnostics were rejected.');
  return actions;
}

function diagnoseRelayStorage(config: RuntimeConfig): RelayStorageDiagnosis {
  try {
    const paths = config.paths;
    mkdirSync(paths.kookrDir, { recursive: true });
    if (existsSync(config.stateDbPath)) {
      accessSync(config.stateDbPath, W_OK);
    } else {
      const probePath = join(dirname(config.stateDbPath), `.relay-db-write-probe-${process.pid}`);
      mkdirSync(dirname(config.stateDbPath), { recursive: true });
      writeFileSync(probePath, 'ok', 'utf8');
      rmSync(probePath, { force: true });
    }
    return {
      state: 'ok',
      dbPath: config.stateDbPath,
      message: 'Relay state database path is writable.',
    };
  } catch (err) {
    return {
      state: 'db-write-failed',
      dbPath: config.stateDbPath,
      message: `Relay state database path is not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function stateMatchesRuntimeConfig(state: RelayStateFile, config: RuntimeConfig): boolean {
  return resolve(state.cwd) === config.cwd
    && state.bindHost === config.bindHost
    && state.port === config.port
    && state.stateDbPath === config.stateDbPath
    && state.logPath === config.paths.logPath;
}
