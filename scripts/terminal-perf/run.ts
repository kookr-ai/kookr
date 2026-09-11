/**
 * Headed native-terminal diagnostic, optionally including the real dashboard.
 * Run: node --import tsx scripts/terminal-perf/run.ts --agents=20 --seconds=30
 * A dedicated harness clock spans emission commands and browser render ACKs.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { fork, type ChildProcess } from 'node:child_process';
import { tmpdir, cpus, platform, release } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser } from '@playwright/test';
import { WebSocket } from 'ws';
import { TERMINAL_V2_PROTOCOL } from '../../src/shared/terminal-protocol.js';
import { sanitizedChildServerEnv } from '../../e2e/child-server-env.js';

function argument(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  return value === undefined ? fallback : Number(value);
}
const agents = argument('agents', 1);
const seconds = argument('seconds', 15);
const panes = argument('panes', 1);
const bytesPerSecond = argument('bytes-per-second', 20_480);
const scrolling = process.argv.includes('--scroll');
const mixed = process.argv.includes('--mixed');
const profile = process.argv.includes('--profile');
const isolated = process.argv.includes('--isolated');
const retained = argument('retained', agents);
const overloadSeconds = argument('overload-seconds', 0);
const sourceRoot = resolve(process.argv.find((arg) => arg.startsWith('--source-root='))?.slice('--source-root='.length) ?? '.');
if (![1, 10, 20].includes(agents) || ![1, 4].includes(panes) || panes > agents
  || (mixed && panes !== 1) || retained < agents || retained > 1000 || overloadSeconds < 0 || overloadSeconds > 120
  || !(seconds > 0 && seconds <= 900) || !(bytesPerSecond > 0 && bytesPerSecond <= 10_000_000)) {
  throw new Error('Expected agents=1/10/20, panes=1/4, seconds=1..900, bytes-per-second=1..10000000');
}
async function main() {
  const artifactDir = await mkdtemp(join(tmpdir(), 'kookr-terminal-perf-'));
  const outputDir = join(artifactDir, 'frontend');
  const producers = new Map<string, Socket>();
  const controlServer = createServer((socket) => {
    let pending = '';
    socket.on('data', (bytes) => {
      pending += bytes.toString();
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const { id } = JSON.parse(pending.slice(0, newline));
      pending = '';
      if (/^probe-\d+$/.test(id)) producers.set(id, socket);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
  const controlAddress = controlServer.address();
  if (!controlAddress || typeof controlAddress === 'string') throw new Error('No emitter control port');

  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const markers = new Map<number, { started: number; observed?: number }>();
  const browserErrors: string[] = [];
  let emittedBytes = 0;
  let missedEmissionCommands = 0;
  const serverSamples: unknown[] = [];
  const dashboard = { messages: 0, bytes: 0, maxMessageBytes: 0 };
  let slowViewer: WebSocket | undefined;
  let slowViewerClose: { code: number; afterMs: number } | undefined;
  let nextSequence = 1;
  const fixture = Buffer.from(('log: compiling a module ✓ 日本語 😀\r\n').repeat(1000));
  function emit(id: string, bytes: Buffer, mark = false) {
    const socket = producers.get(id);
    if (!socket || socket.writableLength > 128 * 1024) { missedEmissionCommands++; return; }
    const sequence = nextSequence++;
    const payload = mark ? Buffer.concat([bytes, Buffer.from(`\r\nKMARK:${sequence}:END\r\n`)]) : bytes;
    if (mark) markers.set(sequence, { started: performance.now() });
    socket.write(JSON.stringify({ bytes: payload.toString('base64') }) + '\n');
    emittedBytes += payload.length;
  }
  function percentile(values: number[], fraction: number) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
  }

  try {
    await build({ configFile: false, root: resolve('scripts/terminal-perf'), logLevel: 'warn',
      resolve: { dedupe: ['react', 'react-dom', 'zustand'] },
      plugins: [react(), { name: 'terminal-probe-only', enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/terminal-perf/browser.tsx')) return code.replaceAll('../../src/frontend', `${sourceRoot}/src/frontend`);
          if (!id.endsWith('/components/TerminalPanel.tsx')) return;
          const anchor = 'terminalRef.current = terminal;';
          if (!code.includes(anchor)) throw new Error('Terminal instrumentation anchor moved');
          return code.replace(anchor, `${anchor}\n(globalThis as any).__terminalProbe?.(terminal);`);
        } }],
      build: { outDir: outputDir, emptyOutDir: false, modulePreload: false, minify: !profile },
      define: { __KOOKR_DISABLE_ONBOARDING__: JSON.stringify('1') },
    });
    const childEnv = sanitizedChildServerEnv({ TERMINAL_PROBE_SOURCE_ROOT: sourceRoot,
      TERMINAL_PROBE_MIXED: String(mixed), TERMINAL_PROBE_ISOLATED: String(isolated), TERMINAL_PROBE_RETAINED: String(retained),
      KOOKR_REMOTE_CHAT_DISABLED: 'true', KOOKR_HOSTED_RELAY_ENABLED: 'false', KOOKR_PLUGIN_DIR: '', KOOKR_DIR: artifactDir,
      GH_CONFIG_DIR: join(artifactDir, 'gh') });
    // This fixture never calls a model/provider. Do not let the real server's
    // optional services discover credentials inherited from the invoking shell.
    for (const key of Object.keys(childEnv)) if (/(API_KEY|TOKEN|SECRET)$/.test(key)) delete childEnv[key];
    server = fork(resolve('scripts/terminal-perf/server.ts'), [outputDir, artifactDir, String(controlAddress.port), String(agents)], {
      execArgv: ['--import', 'tsx'], env: childEnv, silent: true,
    });
    let serverLog = '';
    server.stdout?.on('data', (bytes) => { serverLog = (serverLog + bytes).slice(-65_536); });
    server.stderr?.on('data', (bytes) => { serverLog = (serverLog + bytes).slice(-65_536); });
    const port = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Server startup timeout: ${serverLog}`)), 30_000);
      server!.on('message', (message: { port?: number; kind?: string }) => {
        if (message.kind === 'sample') { if (serverSamples.length < 1200) serverSamples.push(message); return; }
        if (message.port) { clearTimeout(deadline); resolve(message.port); }
      });
      server!.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`Server exited ${code}: ${serverLog}`)); });
    });
    for (let i = 0; i < 100 && producers.size !== agents; i++) await delay(50);
    if (producers.size !== agents) throw new Error(`Only ${producers.size}/${agents} emitters connected`);
    for (const id of producers.keys()) emit(id, Buffer.from('Ready\r\n'));
    await delay(250);
    browser = await chromium.launch({ headless: false, ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('websocket', (socket) => {
      if (!socket.url().endsWith('/ws')) return;
      socket.on('framereceived', (frame) => {
        const bytes = typeof frame.payload === 'string' ? Buffer.byteLength(frame.payload) : frame.payload.length;
        dashboard.messages++; dashboard.bytes += bytes; dashboard.maxMessageBytes = Math.max(dashboard.maxMessageBytes, bytes);
      });
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.exposeFunction('terminalMarker', (sequence: number) => {
      const marker = markers.get(sequence);
      if (marker && marker.observed === undefined) marker.observed = performance.now() - marker.started;
    });
    await page.goto(`http://127.0.0.1:${port}/?panes=${panes}${mixed ? '&mixed=1' : ''}`);
    if (mixed) {
      await page.waitForFunction(() => (globalThis as any).terminalProbeState?.projection().rows > 0);
      await page.evaluate(() => (globalThis as any).terminalProbeState.select('probe-0'));
    }
    await page.waitForFunction((count) => (globalThis as any).terminalProbeState?.terminals.length === count, panes);
    await page.waitForFunction(() => !document.querySelector('.terminal-attach-pending'), undefined, { timeout: 10_000 });
    const graphics = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return { webdriver: navigator.webdriver, userAgent: navigator.userAgent,
        renderer: info ? gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        webglCanvases: document.querySelectorAll('.xterm-screen canvas').length };
    });
    // Warm up enough history for scroll measurements, then clear warmup samples.
    for (const id of producers.keys()) emit(id, fixture);
    await delay(750);
    await page.evaluate(() => (globalThis as any).terminalProbeState.reset());
    const profiler = profile ? await page.context().newCDPSession(page) : undefined;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    const started = performance.now();
    emittedBytes = 0;
    let tick = 0;
    const line = Buffer.from('log: compiling a module ✓ 日本語 😀\r\n');
    const payloadFor = (rate: number) => Buffer.from(line.toString().repeat(Math.max(1, Math.ceil(rate / 20 / line.length))));
    const steadyPayload = payloadFor(bytesPerSecond);
    const noisyPayload = payloadFor(1024 * 1024);
    let overload = false;
    timer = setInterval(() => {
      tick++;
      for (let i = 0; i < agents; i++) emit(`probe-${i}`, overload && i === agents - 1 ? noisyPayload : steadyPayload,
        !scrolling && i < panes && tick % 10 === 0);
    }, 50);
    if (scrolling) {
      await page.mouse.move(600, 300);
      while (performance.now() - started < seconds * 1000) {
        await page.mouse.wheel(0, -40);
        await delay(16);
      }
    } else await delay(seconds * 1000);
    if (overloadSeconds > 0) {
      overload = true;
      const opened = performance.now();
      slowViewer = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/probe-${agents - 1}`, TERMINAL_V2_PROTOCOL);
      slowViewer.on('message', (data, binary) => {
        if (binary) return; // Deliberately withhold parsed-byte credit.
        const frame = JSON.parse(data.toString());
        if (frame.type === 'hello') slowViewer!.send(JSON.stringify({ type: 'attach', generation: frame.generation,
          attachId: 'slow-probe', cols: 120, rows: 40 }));
      });
      slowViewer.on('close', (code) => { slowViewerClose = { code, afterMs: performance.now() - opened }; });
      slowViewer.on('error', () => {});
      await delay(overloadSeconds * 1000);
      overload = false;
      await delay(10_000); // Observe recovery under the original steady workload.
    }
    clearInterval(timer); timer = undefined;
    if (profiler) {
      const result = await profiler.send('Profiler.stop');
      await writeFile(join(artifactDir, 'browser.cpuprofile'), JSON.stringify(result.profile));
      await profiler.detach();
    }
    for (let i = 0; i < panes; i++) emit(`probe-${i}`, Buffer.from('\r\nfinal checkpoint\r\n'), !scrolling);
    await delay(1500);
    const measurements = await page.evaluate(() => {
      const state = (globalThis as any).terminalProbeState;
      return { frames: state.frames as number[], longTasks: state.longTasks as number[],
        sizes: state.terminals.map((terminal: any) => ({ cols: terminal.cols, rows: terminal.rows })),
        projection: state.projection(),
        notices: Array.from(document.querySelectorAll('.terminal-attach-pending')).map((element) => element.textContent) };
    });
    await page.screenshot({ path: join(artifactDir, 'terminal.png') });
    const latencies = [...markers.values()].flatMap((marker) => marker.observed === undefined ? [] : [marker.observed]);
    const report = {
      scope: mixed ? 'headed native PTY + real dashboard/hooks/transcripts/captures; synthetic output fixture' : 'terminal-only diagnostic',
      sourceRoot, agents, panes, seconds, scrolling, mixed, isolated, retained, overloadSeconds,
      requestedBytesPerSecondPerProducer: bytesPerSecond,
      actualEmittedBytes: emittedBytes, missedEmissionCommands,
      hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length },
      browserVersion: browser.version(), graphics, fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
      markers: { emitted: markers.size, observed: latencies.length, timedOut: markers.size - latencies.length,
        renderAckP50Ms: percentile(latencies, 0.5), renderAckP95Ms: percentile(latencies, 0.95),
        renderAckMaxMs: latencies.length ? Math.max(...latencies) : null },
      frameIntervalP95Ms: percentile(measurements.frames, 0.95),
      longTasks: measurements.longTasks, sizes: measurements.sizes, notices: measurements.notices, browserErrors,
      projection: measurements.projection, dashboard, serverSamples, slowViewerClose,
    };
    await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(artifactDir, 'server.log'), serverLog);
    console.log(JSON.stringify({ artifactDir, ...report }, null, 2));
  } finally {
    if (timer) clearInterval(timer);
    slowViewer?.terminate();
    await browser?.close();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise<void>((resolve) => server!.once('exit', () => resolve())), delay(5000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    for (const socket of producers.values()) socket.destroy();
    controlServer.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
