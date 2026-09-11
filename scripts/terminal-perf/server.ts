import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { LocalDtachBackend } from '../../src/adapters/local-dtach-backend.js';
import type { TerminalBackend } from '../../src/adapters/terminal-backend.js';
import { TerminalHostBackend } from '../../src/server/terminal-host.js';
import { TerminalInputCoordinator, type TerminalInputCoordinatorPort } from '../../src/server/terminal-input-coordinator.js';
import { SessionBridge } from '../../src/server/session-bridge.js';
import { ViewerConnectionRegistry } from '../../src/server/viewer-connection-registry.js';
import { TERMINAL_V2_PROTOCOL } from '../../src/shared/terminal-protocol.js';
import type { KookrServerInternal } from '../../src/server/server-test-helpers.js';
import { generateSyntheticHookStorm } from '../load-harness-core.js';

const [outputDir, socketDir, producerPort, countArg] = process.argv.slice(2);
const count = Number(countArg);
const mixed = process.env.TERMINAL_PROBE_MIXED === 'true';
const retained = Number(process.env.TERMINAL_PROBE_RETAINED ?? count);
let backend: TerminalBackend;
let host: TerminalHostBackend | undefined;
let input: TerminalInputCoordinatorPort;
let Bridge = SessionBridge;
let app: KookrServerInternal | undefined;
let hookTimer: ReturnType<typeof setInterval> | undefined;
let captureTimer: ReturnType<typeof setInterval> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
const sessions: string[] = [];
const bridges = new Set<SessionBridge>();
const registry = new ViewerConnectionRegistry();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false,
  handleProtocols: (protocols) => protocols.has(TERMINAL_V2_PROTOCOL) ? TERMINAL_V2_PROTOCOL : false });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const file = resolve(outputDir!, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${resolve(outputDir!)}/`)) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(file);
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.on('upgrade', (req, socket, head) => {
  const id = /^\/ws\/terminal\/(probe-\d+)$/.exec(req.url ?? '')?.[1];
  if (!id || !sessions.includes(id)) { socket.destroy(); return; }
  if (host && socket instanceof Socket) { host.handoff(req, socket, head, id, { kind: 'owner' }, registry); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const bridge = new Bridge(id, ws, backend, input);
    bridges.add(bridge);
    ws.on('close', () => { bridge.dispose(); bridges.delete(bridge); });
    void bridge.start();
  });
});

let stopping = false;
const lifecycle = new AbortController();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(hookTimer); clearInterval(captureTimer); clearInterval(statsTimer);
  registry.stopSweep(); lifecycle.abort();
  for (const ws of wss.clients) ws.terminate();
  for (const bridge of bridges) bridge.dispose();
  if (backend) {
    for (const id of sessions) await backend.killSession(id).catch(() => {});
    if (app) await app.close();
    else if (backend.closeAndDrain) await backend.closeAndDrain(); else backend.close?.();
  }
  server.close(); process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());

async function main() {
  const sourceRoot = process.env.TERMINAL_PROBE_SOURCE_ROOT;
  const load = (file: string) => import(pathToFileURL(resolve(sourceRoot ?? '.', file)).href);
  const pick = (module: Record<string, unknown>, key: string): any => module[key] ?? (module.default as Record<string, unknown>)?.[key];
  let Backend = LocalDtachBackend; let Coordinator = TerminalInputCoordinator;
  if (sourceRoot && resolve(sourceRoot) !== process.cwd()) {
    const modules = await Promise.all([load('src/adapters/local-dtach-backend.ts'),
      load('src/server/terminal-input-coordinator.ts'), load('src/server/session-bridge.ts')]);
    Backend = pick(modules[0], 'LocalDtachBackend'); Coordinator = pick(modules[1], 'TerminalInputCoordinator'); Bridge = pick(modules[2], 'SessionBridge');
  }
  const options = { instanceId: 'probe', socketDir, dtachBinary: resolve('vendor/dtach/dtach') };
  host = process.env.TERMINAL_PROBE_ISOLATED === 'true' ? await TerminalHostBackend.create(options) : undefined;
  backend = host ?? new Backend(options);
  input = host?.inputCoordinator ?? new Coordinator(backend);
  if (mixed) {
    const create = pick(await load('src/server/index.ts'), 'createKookrServerInternal');
    app = await create({ port: 0, host: '127.0.0.1', kookrDir: socketDir,
      tasksFile: join(socketDir!, 'tasks.json'), hooksDir: join(socketDir!, 'hooks'),
      settingsDir: join(socketDir!, 'settings'), serverCwd: socketDir, frontendDir: outputDir,
      saveIntervalMs: 5000, livenessIntervalMs: 5000, terminalBackend: backend,
      terminalHost: host, terminalInputCoordinator: input,
      claudeDir: join(socketDir!, 'claude'), lifecycleSignal: lifecycle.signal, validateLaunchCwd: async () => {} });
  }
  for (let i = 0; i < count; i++) {
    const id = `probe-${i}`;
    sessions.push(id);
    await backend.createSession({ id, command: process.execPath,
      args: [resolve('scripts/terminal-perf/producer.cjs'), producerPort!, id], size: { cols: 120, rows: 40 } });
    if (app) {
      const task = app.taskStore.createTask({ prompt: `Terminal probe ${i}`, cwd: socketDir!, agentType: 'claude-code' });
      app.taskStore.startTask(task.id);
      app.taskStore.addSession(task.id, { tmuxSession: id, agentType: 'claude-code', cwd: socketDir!, createdAt: new Date() });
      app.monitor.registerAgent(id);
    }
  }
  if (app) {
    for (let i = count; i < retained; i++) {
      const task = app.taskStore.createTask({ prompt: `Completed probe ${i}`, cwd: socketDir!, agentType: 'claude-code' });
      app.taskStore.startTask(task.id);
      app.taskStore.completeTask(task.id);
    }
    const records = generateSyntheticHookStorm({ sessions: count, eventsPerSession: 101, seed: 926, cwd: socketDir!, nowMs: Date.now() });
    let next = 0; let hookCount = 0; let captureCount = 0; let pendingTick = false; let pendingCaptures = false;
    const inject = async () => {
      if (pendingTick || stopping) return;
      pendingTick = true;
      try {
        const record = records[next++ % records.length]!;
        const sessionIndex = Number(record.event.session_id?.toString().split('-').at(-1));
        const id = sessions[sessionIndex % sessions.length]!;
        const transcript = join(socketDir!, `${id}.jsonl`);
        await appendFile(transcript, JSON.stringify({ type: 'assistant', message: { id: `m-${hookCount}`, model: 'probe',
          content: [{ type: 'text', text: 'Compiled a synthetic module.' }], usage: { input_tokens: 200, output_tokens: 50 } } }) + '\n');
        app!.adapter.injectHookEvent(id, JSON.stringify({ ...record.event, transcript_path: transcript, kookr_hook_written_at_ms: Date.now() }));
        hookCount++;
      } finally { pendingTick = false; }
    };
    // Twenty hooks/second fleet-wide, real JSONL append/ingestion, and one
    // bounded fleet capture per second compete with the terminal lane.
    hookTimer = setInterval(() => { void inject().catch(() => {}); }, 50);
    captureTimer = setInterval(() => {
      if (pendingCaptures || stopping) return;
      pendingCaptures = true;
      void Promise.all(sessions.map(async (id) => { await backend.captureBytes(id, 64 * 1024); captureCount++; }))
        .catch(() => {}).finally(() => { pendingCaptures = false; });
    }, 1000);
    statsTimer = setInterval(() => process.send?.({ kind: 'sample', at: Date.now(), hookCount, captureCount,
      retained: app!.taskStore.countTasks(), rss: process.memoryUsage().rss, backend: backend.getStats(), host: host?.getHostHealth() }), 1000);
    const address = app.httpServer.address();
    if (address && typeof address !== 'string') process.send?.({ port: address.port });
  } else {
    statsTimer = setInterval(() => process.send?.({ kind: 'sample', at: Date.now(), rss: process.memoryUsage().rss,
      backend: backend.getStats(), host: host?.getHostHealth() }), 1000);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address !== 'string') process.send?.({ port: address.port });
    });
  }
}
void main().catch(async (error) => { console.error(error); await stop(); });
