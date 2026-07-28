import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

import { LocalDtachBackend } from '../src/adapters/local-dtach-backend.js';
import { createKookrServerInternal } from '../src/server/index.js';
import type { SnapshotMessage } from '../src/shared/contracts/messages.js';
import { firstReadyKookrSTTEndpoint } from '../src/shared/contracts/speech.js';

interface FileSnapshot {
  entries: Map<string, { type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>;
}

const textDecoder = new TextDecoder();

// Phase 6 (issue #333): the local-only smoke test exercises STT/TTS through
// the legacy snapshot fields. These URLs are advertised in the snapshot only;
// no STT/TTS server is reachable here, which is enough to assert the legacy
// fields and the additive descriptors are emitted unchanged.
const SMOKE_STT_URL = 'ws://127.0.0.1:8003';
const SMOKE_TTS_URL = 'http://127.0.0.1:8004';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function snapshotDir(root: string): FileSnapshot {
  const entries = new Map<string, { type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>();

  function walk(dir: string): void {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      const rel = relative(root, path);
      const stat = statSync(path);
      entries.set(rel, {
        type: name.isDirectory() ? 'dir' : name.isFile() ? 'file' : 'other',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (name.isDirectory()) walk(path);
    }
  }

  try {
    walk(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  return { entries };
}

function assertKookrDiff(before: FileSnapshot, after: FileSnapshot): void {
  const forbiddenBasenames = new Set([
    'audit.db',
    'audit.jsonl',
    'command-journal.jsonl',
    'node-epoch',
    'policy-cache.json',
  ]);
  const isAllowedLocalOnlyChange = (entry: string): boolean => {
    return entry === 'tasks.json'
      || /^tasks\.json\.daily\.\d{8}$/.test(entry)
      || entry === 'oss-attempts.json'
      || entry === 'project-configs.json'
      || entry === 'detection-stats.json'
      || entry === 'schedules.json'
      || entry === 'schedule-rollups.json'
      || entry === 'hook-replay-checkpoints.json'
      || entry === 'activity'
      || entry.startsWith('activity/')
      || entry === 'hooks'
      || entry.startsWith('hooks/')
      || entry === 'sessions'
      || entry.startsWith('sessions/')
      || entry === 'settings'
      || entry.startsWith('settings/');
  };
  const errors: string[] = [];
  for (const [entry, meta] of after.entries) {
    const base = entry.split('/').at(-1) ?? entry;
    if (forbiddenBasenames.has(base) || entry.startsWith('remote/') || entry.startsWith('relay/')) {
      errors.push(`forbidden ${meta.type}: ${entry}`);
      continue;
    }
    const previous = before.entries.get(entry);
    if (!previous && !isAllowedLocalOnlyChange(entry)) {
      errors.push(`new ${meta.type}: ${entry}`);
      continue;
    }
    if (previous && !isAllowedLocalOnlyChange(entry) && (previous.size !== meta.size || previous.mtimeMs !== meta.mtimeMs)) {
      errors.push(`changed ${meta.type}: ${entry}`);
    }
  }
  for (const entry of before.entries.keys()) {
    if (!after.entries.has(entry) && !isAllowedLocalOnlyChange(entry)) {
      errors.push(`removed: ${entry}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`~/.kookr changed outside tasks.json:\n${errors.join('\n')}`);
  }
}

function writeScriptedAgent(path: string): void {
  writeFileSync(path, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

if (process.argv.includes('--version')) {
  process.stdout.write('smoke-agent 1.0.0\\n');
  process.exit(0);
}

function settingsPathFromArgv(argv) {
  const idx = argv.indexOf('--settings');
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function userPromptHookTarget() {
  const settingsPath = settingsPathFromArgv(process.argv);
  if (!settingsPath) return undefined;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const command = settings?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string') return undefined;
  const file = command.match(/--file '([^']+)'/)?.[1]
    ?? command.match(/awk -v file='([^']+)'/)?.[1];
  const url = command.match(/--url '([^']+)'/)?.[1]
    ?? command.match(/curl -s -X POST ([^ ]+)/)?.[1];
  return { file, url };
}

const hookTarget = userPromptHookTarget();
const transcriptPath = join(process.cwd(), 'smoke-transcript.jsonl');
let submitted = false;
let buffer = '';

function emitUserPromptSubmit(prompt) {
  if (!hookTarget || submitted) return;
  submitted = true;
  appendFileSync(transcriptPath, JSON.stringify({ type: 'user', prompt }) + '\\n');
  const event = {
    session_id: 'smoke-session',
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    hook_event_name: 'UserPromptSubmit',
    prompt,
  };
  const line = JSON.stringify(event) + '\\n';
  if (hookTarget.file) appendFileSync(hookTarget.file, line);
  if (hookTarget.url) {
    fetch(hookTarget.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: line,
    }).catch(() => {});
  }
}

function stripPasteControls(text) {
  return text.replaceAll('\\x1b[200~', '').replaceAll('\\x1b[201~', '');
}

process.stdout.write('\\x1b[?2004hClaude Code ❯ kookr-smoke-agent ready\\n');
process.stdout.write('permission prompt: local operator approval required\\n');

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (buffer.includes('\\x1b[201~')) {
    emitUserPromptSubmit(stripPasteControls(buffer));
  }
  if (!/[\\r\\n]/.test(buffer)) return;
  const line = stripPasteControls(buffer).replace(/[\\r\\n]+$/g, '');
  buffer = '';
  emitUserPromptSubmit(line);
  process.stdout.write(\`echo:\${line}\\n\`);
  if (line.includes('complete')) {
    process.stdout.write('task complete\\n');
  }
});

setInterval(() => {
  process.stdout.write('Claude Code ❯ kookr-smoke-agent ready\\n');
}, 1000);
`, 'utf8');
  chmodSync(path, 0o755);
}

function assertNoStartupErrorLogs(logs: string[]): void {
  const watched = [
    'ralph-loop',
    'schedule',
    'achievement',
    'ledger',
    'telemetry',
    'supervisor',
    'project drawer',
    'oss source',
  ];
  const offenders = logs.filter((line) => /level=error/i.test(line) && watched.some((label) => line.toLowerCase().includes(label)));
  if (offenders.length > 0) {
    throw new Error(`startup error logs found:\n${offenders.join('\n')}`);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as T;
}

async function closeBackend(backend: LocalDtachBackend): Promise<void> {
  try {
    for (const session of await backend.listSessions()) {
      await backend.killSession(session).catch(() => {});
    }
  } finally {
    backend.close();
  }
}

async function closeServer(server: Awaited<ReturnType<typeof createKookrServerInternal>>): Promise<void> {
  await Promise.race([
    server.close(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForBytes(ws: WebSocket, predicate: (text: string) => boolean, label: string): Promise<string> {
  let acc = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}; received ${JSON.stringify(acc)}`)), 10_000);
    ws.on('message', (data) => {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      acc += textDecoder.decode(chunk, { stream: true });
      if (predicate(acc)) {
        clearTimeout(timer);
        resolve(acc);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Open a dashboard `/ws` connection and return its first snapshot message. */
async function readDashboardSnapshot(port: number): Promise<SnapshotMessage> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    return await new Promise<SnapshotMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dashboard snapshot timeout')), 5_000);
      ws.on('message', (data) => {
        let parsed: SnapshotMessage;
        try {
          parsed = JSON.parse(data.toString()) as SnapshotMessage;
        } catch (err) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (parsed.type !== 'snapshot') return;
        clearTimeout(timer);
        resolve(parsed);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  const previousRelay = process.env.KOOKR_RELAY_URL;
  delete process.env.KOOKR_RELAY_URL;
  process.env.KOOKR_FAKE_TERMINAL = 'false';
  process.env.KOOKR_USE_FAKE_AGENT = 'false';
  process.env.KOOKR_STT = 'false';
  process.env.KOOKR_TTS = 'false';
  process.env.KOOKR_REMOTE_CHAT_DISABLED = '1';

  const tempRoot = mkdtempSync(join(tmpdir(), 'kookr-local-only-smoke-'));
  const home = join(tempRoot, 'home');
  const kookrDir = join(home, '.kookr');
  const hooksDir = join(kookrDir, 'hooks');
  const settingsDir = join(kookrDir, 'settings');
  const cwd = join(tempRoot, 'project');
  mkdirSync(kookrDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(kookrDir, 'tasks.json'), '[]\n');

  const agentBin = join(tempRoot, 'smoke-agent.js');
  writeScriptedAgent(agentBin);

  const port = await getFreePort();
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    originalError(...args);
  };

  const before = snapshotDir(kookrDir);
  const backend = new LocalDtachBackend({
    socketDir: join(tempRoot, 'dtach'),
    instanceId: 'local-only-smoke',
    dtachBinary: join(process.cwd(), 'vendor', 'dtach', 'dtach'),
    ringFlushIntervalMs: 25,
  });
  let server: Awaited<ReturnType<typeof createKookrServerInternal>> | null = null;
  let terminal: WebSocket | null = null;
  const backends = [backend];

  try {
    server = await createKookrServerInternal({
      port,
      host: '127.0.0.1',
      kookrDir,
      tasksFile: join(kookrDir, 'tasks.json'),
      hooksDir,
      settingsDir,
      serverCwd: cwd,
      frontendDir: join(process.cwd(), 'dist', 'frontend'),
      saveIntervalMs: 100,
      livenessIntervalMs: 60_000,
      terminalBackend: backend,
      useFakeTerminalBridge: false,
      agentBin,
      claudeDir: join(tempRoot, 'claude'),
      // STT/TTS configured via the legacy URL fields so the snapshot
      // advertises them (issue #333 acceptance gate 1). KOOKR_STT/KOOKR_TTS
      // stay false above so no STT/TTS manager process is spawned.
      sttUrl: SMOKE_STT_URL,
      ttsUrl: SMOKE_TTS_URL,
      preflightOnFatal: (snapshot) => {
        throw new Error(`agent preflight failed: ${JSON.stringify(snapshot)}`);
      },
    });

    const base = `http://127.0.0.1:${port}`;
    const dashboard = await fetch(`${base}/`);
    if (!dashboard.ok) throw new Error(`dashboard did not load: ${dashboard.status}`);
    await fetchJson(`${base}/api/health`);
    assertNoStartupErrorLogs(logs);

    const launched = await fetchJson<{ id: string; sessions: Array<{ tmuxSession: string }> }>(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
      body: JSON.stringify({ prompt: 'local-only smoke prompt', cwd, agentType: 'claude-code' }),
    });
    const sessionId = launched.sessions.at(-1)?.tmuxSession;
    if (!sessionId) throw new Error('launched task did not create a session');

    terminal = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${encodeURIComponent(sessionId)}`);
    await new Promise<void>((resolve, reject) => {
      terminal!.once('open', resolve);
      terminal!.once('error', reject);
    });
    await waitForBytes(terminal, (text) => text.includes('kookr-smoke-agent ready'), 'initial terminal stream');

    terminal.send(Buffer.from('hello local terminal\r'));
    await waitForBytes(terminal, (text) => text.includes('echo:hello local terminal'), 'terminal input echo');

    await fetchJson(`${base}/api/hook-event/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: `sess-${Date.now()}`,
        transcript_path: join(tempRoot, 'transcript.jsonl'),
        cwd,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'printf smoke' },
        permission_mode: 'default',
      }),
    });
    const snapshot = await fetchJson<Array<{ agentId: string; anomaly: { type: string } | null }>>(`${base}/api/snapshot`);
    const agent = snapshot.find((candidate) => candidate.agentId === sessionId);
    if (agent?.anomaly?.type !== 'permission_blocked') {
      throw new Error(`permission prompt did not render in local snapshot: ${JSON.stringify(agent)}`);
    }

    terminal.send(Buffer.from('a'));
    const afterApproval = await fetchJson<Array<{ agentId: string; anomaly: { type: string } | null }>>(`${base}/api/snapshot`);
    if (afterApproval.find((candidate) => candidate.agentId === sessionId)?.anomaly) {
      throw new Error('local terminal approval keystroke did not clear permission_blocked anomaly');
    }

    // Phase 6 acceptance gate 1 (issue #333): the local STT/TTS paths must
    // keep working through the legacy snapshot fields. A regression on the
    // legacy fields blocks the phase.
    const sttHealth = await fetchJson<{ status?: string }>(`${base}/api/health/stt`);
    if (typeof sttHealth.status !== 'string') {
      throw new Error(`STT health probe returned no status: ${JSON.stringify(sttHealth)}`);
    }
    const speechSnapshot = await readDashboardSnapshot(port);
    if (speechSnapshot.sttEnabled !== true || speechSnapshot.sttUrl !== SMOKE_STT_URL) {
      throw new Error(`legacy STT snapshot fields regressed: ${JSON.stringify({
        sttEnabled: speechSnapshot.sttEnabled,
        sttUrl: speechSnapshot.sttUrl,
      })}`);
    }
    if (speechSnapshot.ttsEnabled !== true || speechSnapshot.ttsUrl !== SMOKE_TTS_URL) {
      throw new Error(`legacy TTS snapshot fields regressed: ${JSON.stringify({
        ttsEnabled: speechSnapshot.ttsEnabled,
        ttsUrl: speechSnapshot.ttsUrl,
      })}`);
    }
    // The additive Phase 6 descriptors must coexist with the legacy fields,
    // for both STT and TTS, and advertise the same endpoints.
    if (firstReadyKookrSTTEndpoint(speechSnapshot.speechCapabilities) !== SMOKE_STT_URL) {
      throw new Error(`Phase 6 STT descriptor missing or wrong endpoint: ${JSON.stringify(speechSnapshot.speechCapabilities)}`);
    }
    const speechDescriptors = Object.values(
      speechSnapshot.speechCapabilities?.capabilitiesByDevice ?? {},
    ).flat();
    const ttsDescriptor = speechDescriptors.find((capability) => capability.kind === 'tts');
    if (!ttsDescriptor || ttsDescriptor.kind !== 'tts') {
      throw new Error('Phase 6 TTS descriptor missing from local-only snapshot');
    }
    if (ttsDescriptor.endpointUrl !== SMOKE_TTS_URL) {
      throw new Error(`Phase 6 TTS descriptor wrong endpoint: ${ttsDescriptor.endpointUrl}`);
    }

    terminal.send(Buffer.from('complete\r'));
    await waitForBytes(terminal, (text) => text.includes('task complete'), 'completion echo');

    await closeServer(server);
    await closeBackend(backend);
    server = null;

    const restartedBackend = new LocalDtachBackend({
      socketDir: join(tempRoot, 'dtach-restart'),
      instanceId: 'local-only-smoke-restart',
      dtachBinary: join(process.cwd(), 'vendor', 'dtach', 'dtach'),
      ringFlushIntervalMs: 25,
    });
    backends.push(restartedBackend);
    const restarted = await createKookrServerInternal({
      port,
      host: '127.0.0.1',
      kookrDir,
      tasksFile: join(kookrDir, 'tasks.json'),
      hooksDir,
      settingsDir,
      serverCwd: cwd,
      frontendDir: join(process.cwd(), 'dist', 'frontend'),
      saveIntervalMs: 100,
      livenessIntervalMs: 60_000,
      terminalBackend: restartedBackend,
      useFakeTerminalBridge: false,
      agentBin,
      claudeDir: join(tempRoot, 'claude'),
    });
    const tasksAfterRestart = await fetchJson<Array<{ id: string }>>(`${base}/api/tasks`);
    if (!tasksAfterRestart.some((task) => task.id === launched.id)) {
      throw new Error('task list did not reappear after restart');
    }
    await closeServer(restarted);
    await closeBackend(restartedBackend);

    const after = snapshotDir(kookrDir);
    assertKookrDiff(before, after);

    const tasksFile = readFileSync(join(kookrDir, 'tasks.json'), 'utf8');
    if (!tasksFile.includes(launched.id)) {
      throw new Error('tasks.json did not persist launched smoke task');
    }
  } finally {
    terminal?.close();
    if (server) await closeServer(server);
    for (const b of backends) {
      await closeBackend(b).catch(() => {});
    }
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    if (previousRelay !== undefined) process.env.KOOKR_RELAY_URL = previousRelay;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
