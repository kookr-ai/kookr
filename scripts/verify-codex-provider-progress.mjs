#!/usr/bin/env node

/**
 * Exercise real Codex streaming through a separate Kookr server and dtach TUI.
 * The local provider leaves a custom exec call incomplete: no tool can run.
 * Run with node --import tsx; evidence contains timings and metadata only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`Verify that real Codex output keeps a managed Kookr session fresh.\n\n` +
    `Usage: node --import tsx scripts/verify-codex-provider-progress.mjs [options]\n\n` +
    `  --codex PATH          Installed CLI from a verified CLI/host runtime pair\n` +
    `  --expected-source-commit SHA  Require the installed pair to match this commit\n` +
    `  --cwd PATH            Already-trusted workspace used read-only\n` +
    `  --model-catalog PATH  Codex model catalog JSON (defaults to the local fork)\n` +
    `  --out PATH            Evidence directory (defaults to runs/provider-progress-TIME)\n` +
    `  --stream-ms N         Nonempty streaming duration, at least 240000 (default 245000)\n` +
    `  --silence-ms N        Empty deltas and keepalives, at least 65000 (default 75000)\n` +
    `  --expect-baseline     Expect the old binary to become stale during streaming\n` +
    `  --help, -h            Print this help without creating files or launching sessions\n\n` +
    `The default mode expects continued progress to stay healthy, followed by a real\n` +
    `stall during silence. Both modes launch an isolated Kookr server and a real TUI.\n` +
    `The provider never completes its custom tool call, so no generated tool runs.\n` +
    `Codex records this synthetic session in its normal runtime database; provider\n` +
    `and authentication settings remain unchanged. All test sessions are stopped.\n`);
  process.exit(0);
}

const [{ LocalDtachBackend }, { upsertCodexTrustEntry }, { createKookrServerInternal }, { summarizeActivity }] = await Promise.all([
  import('../src/adapters/local-dtach-backend.ts'), import('../src/adapters/codex-config.ts'),
  import('../src/server/index.ts'), import('../src/shared/contracts/activity-summary.ts'),
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codex = option('--codex', join(homedir(), 'bin/codex'));
const cwd = option('--cwd', join(homedir(), 'git/kookr'));
const modelCatalog = option('--model-catalog', join(homedir(), 'git/codex/codex-rs/models-manager/models.json'));
const streamMs = Number(option('--stream-ms', '245000'));
const silenceMs = Number(option('--silence-ms', '75000'));
const expectBaseline = process.argv.includes('--expect-baseline');
assert(streamMs >= 240000, 'streaming proof must last at least four minutes');
assert(silenceMs >= 65000, 'silence must exceed the existing sixty-second threshold');
const runDir = resolve(option('--out', join(repository, 'runs', `provider-progress-${Date.now()}`)));
await mkdir(runDir, { recursive: true });
const stateDir = await mkdtemp(join(tmpdir(), 'k3356-'));
const userConfig = await readFile(join(homedir(), '.codex/config.toml'), 'utf8');
assert.equal(upsertCodexTrustEntry(userConfig, cwd), userConfig,
  'Use an already-trusted --cwd; this harness must not edit global Codex settings');
const cliPath = await realpath(codex);
const hostPath = await realpath(join(dirname(codex), 'codex-code-mode-host'));
assert.equal(dirname(cliPath), dirname(hostPath), 'installed CLI and host must belong to one pair');
const pair = JSON.parse(await readFile(join(dirname(cliPath), 'codex-pair.json'), 'utf8'));
const expectedSourceCommit = option('--expected-source-commit');
if (expectedSourceCommit) assert.equal(pair.sourceCommit, expectedSourceCommit);
for (const [path, expected] of [[cliPath, pair.cliSha256], [hostPath, pair.hostSha256]]) {
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected);
}

// These overrides affect only this harness process and its isolated server.
process.env.KOOKR_PLUGIN_DIR = '';
process.env.KOOKR_REMOTE_CHAT_DISABLED = '1';
process.env.KOOKR_REAP_ORPHAN_SESSIONS = 'false';
process.env.KOOKR_RESOURCE_WATCHDOG = 'false';
process.env.KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE = '0';
process.env.KOOKR_LESSON_SPOOL = '0';
process.env.KOOKR_SIGNAL_OUTBOX = '0';
process.env.KOOKR_HOST_STALE_DTACH_REAP = '0';
process.env.KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS = '0';
process.env.KOOKR_UMBRELLA_CHAIN_ADVANCER = '0';
process.env.KOOKR_GROK_BUILD_DISABLE_NEW_LAUNCHES = 'true';
delete process.env.KOOKR_RELAY_URL;
delete process.env.KOOKR_RELAY_TOKEN;
for (const name of Object.keys(process.env)) {
  if (name.endsWith('API_KEY')) delete process.env[name];
}

const evidence = {
  schemaVersion: 'codex-provider-progress.v1',
  mode: expectBaseline ? 'baseline' : 'fixed',
  startedAt: new Date().toISOString(),
  codexVersion: spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  sourceCommit: pair.sourceCommit,
  kookrCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim(),
  kookrDirtyFiles: spawnSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean),
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  stateDir, streamMs, silenceMs,
  provider: { requests: 0, nonemptyDeltas: 0, emptyDeltas: 0, keepalives: 0, completedResponses: 0 },
  samples: [],
};
let response;
let firstDeltaAt;
let lastDeltaAt;
let providerTimer;
let taskId;
let sessionId;
let transcriptPath;
let server;
let terminal;
const lifecycle = new AbortController();

function send(event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const provider = createServer(async (request, result) => {
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
    result.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  // Keep only schema facts, never prompts, credentials, or generated content.
  // Responses Lite carries tool definitions in an additional_tools input item.
  const definitions = payload.tools ?? (payload.input ?? []).flatMap((item) => item.type === 'additional_tools' ? item.tools : []);
  const tools = definitions.flatMap((tool) => tool.tools ?? [tool]);
  // The real TUI also opens a hidden title-generation thread. Finish only that
  // unrelated metadata request; the measured tool-generation response stays open.
  if (payload.text?.format?.schema?.properties?.title) {
    evidence.provider.auxiliaryTitleRequests = (evidence.provider.auxiliaryTitleRequests ?? 0) + 1;
    result.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const title = JSON.stringify({ title: 'Verify provider progress' });
    const item = { id: 'msg_fixture_title', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: title, annotations: [] }] };
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture_title', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: title },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture_title', status: 'completed', output: [item] } },
    ]) result.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    result.end();
    return;
  }
  evidence.provider.requests++;
  evidence.provider.execToolAdvertised = tools.some((tool) => tool.name === 'exec' && tool.type === 'custom');
  evidence.provider.requestShape = { stream: payload.stream, model: payload.model, fields: Object.keys(payload),
    tools: tools.map((tool) => ({ type: tool.type, name: tool.name })),
    text: payload.text, inputTypes: (payload.input ?? []).map((item) => ({type:item.type,role:item.role})),
    fixturePromptPresent: JSON.stringify(payload.input).includes('Synthetic provider-progress verification'),
  };
  if (!evidence.provider.execToolAdvertised) {
    result.writeHead(500).end('Expected a custom exec tool');
    return;
  }
  if (response) {
    result.writeHead(500).end('This fixture serves exactly one response');
    return;
  }
  response = result;
  result.on('close', () => { evidence.provider.connectionClosedAt = Date.now(); });
  result.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  send({ type: 'response.created', response: { id: 'resp_progress_fixture', status: 'in_progress' } });
  send({ type: 'response.output_item.added', output_index: 0, item: {
    type: 'custom_tool_call', id: 'ctc_progress_fixture', call_id: 'call_progress_fixture',
    namespace: 'functions', name: 'exec', input: '', status: 'in_progress',
  } });
  const tick = () => {
    const now = Date.now();
    firstDeltaAt ??= now;
    const streaming = now - firstDeltaAt < streamMs;
    send({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_progress_fixture',
      call_id: 'call_progress_fixture', delta: streaming ? '/* synthetic incomplete exec input */\n' : '' });
    if (streaming) {
      lastDeltaAt = now;
      evidence.provider.nonemptyDeltas++;
    } else {
      evidence.provider.emptyDeltas++;
    }
    result.write(': synthetic network keepalive\n\n');
    evidence.provider.keepalives++;
  };
  tick();
  providerTimer = setInterval(tick, 1000);
});

async function json(path, init) {
  const result = await fetch(`${evidence.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30000) });
  const body = await result.json();
  assert(result.ok, `${path}: ${result.status} ${JSON.stringify(body)}`);
  return body;
}

async function sample() {
  const [task, health] = await Promise.all([
    json(`/api/tasks/${taskId}`), json('/api/diagnostics/session-health'),
  ]);
  const item = task.task ?? task;
  sessionId ??= item.sessions?.[0]?.tmuxSession;
  transcriptPath ??= item.sessions?.[0]?.transcriptPath;
  if (!sessionId) return;
  const session = health.sessions.find((entry) => entry.sessionId === sessionId);
  const agent = server.monitor.getAgentState(sessionId);
  const state = server.watchdog.getState(sessionId);
  let rawHooks = [];
  try {
    rawHooks = (await readFile(join(stateDir, 'kookr/hooks', `${sessionId}.jsonl`), 'utf8'))
      .trim().split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const progress = rawHooks.filter((hook) => hook.hook_event_name === 'Notification' && hook.notification_type === 'provider_progress');
  const historyProgress = agent?.events.filter((event) => event.type === 'provider_progress'
    || (event.type === 'notification' && event.notificationType === 'provider_progress')) ?? [];
  evidence.toolUseHooks = rawHooks.filter((hook) => hook.hook_event_name === 'PreToolUse').length;
  evidence.progressHooks = progress.map((hook) => ({
    observedAtMs: hook.observed_at_ms, writtenAtMs: hook.kookr_hook_written_at_ms,
    turnId: hook.turn_id, sessionId: hook.session_id, bytes: Buffer.byteLength(JSON.stringify(hook)),
  }));
  const activity = summarizeActivity(agent?.events ?? []);
  const value = {
    at: Date.now(), elapsedMs: firstDeltaAt ? Date.now() - firstDeltaAt : null,
    phase: firstDeltaAt && Date.now() - firstDeltaAt >= streamMs ? 'silence' : 'streaming',
    taskStatus: item.status, stuckReason: item.stuckReason ?? null,
    anomaly: agent?.anomaly?.type ?? null, turnState: agent?.turnState ?? null,
    classification: session?.classification ?? null,
    hookAgeMs: session?.signals.hooks.ageMs ?? null,
    transcriptAgeMs: session?.signals.transcript.ageMs ?? null,
    transcriptLastProgressAt: session?.signals.transcript.lastProgressAt ?? null,
    ptyRingHead: session?.signals.pty.ringHead ?? null,
    transportState: session?.backend.transportState ?? null,
    attachState: session?.backend.attachState ?? null,
    lastEventAt: state?.lastEventAt ?? null,
    lastTokenActivityAt: state?.lastTokenActivityAt ?? null,
    progressEvents: progress.length,
    historyProgressEvents: historyProgress.length,
    timelineItems: activity.length,
    timelineProgressItems: activity.filter((entry) => entry.type === 'system_notice'
      && /provider.progress|provider output is advancing/i.test(entry.text)).length,
  };
  evidence.samples.push(value);
  await writeFile(join(runDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  const providerPort = provider.address().port;
  // Per-launch argv selects the fixture; the user's provider configuration stays intact.
  const overrides = [
    `model_provider="kookr_progress_fixture"`,
    `model_providers.kookr_progress_fixture={name="Kookr progress fixture",base_url="http://127.0.0.1:${providerPort}/v1",wire_api="responses",requires_openai_auth=false,stream_idle_timeout_ms=600000}`,
    'features.code_mode={enabled=true}', 'features.code_mode_only=true',
    'features.code_mode_host={enabled=true,disable_in_process_fallback=true}',
    'check_for_update_on_startup=false',
    'features.apps=false',
    `model_catalog_json=${JSON.stringify(modelCatalog)}`,
    `log_dir=${JSON.stringify(join(stateDir, 'codex-log'))}`,
    ...[...userConfig.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((match) => `mcp_servers.${match[1]}.enabled=false`),
    ...[...userConfig.matchAll(/^\[plugins\.("[^"]+")\]/gm)].map((match) => `plugins.${match[1]}.enabled=false`),
  ];
  class FixtureTerminal extends LocalDtachBackend {
    async createSession(spec) {
      assert.equal(spec.command, codex, 'The isolated server may only launch the fixture Codex');
      const args = [...spec.args, ...overrides.flatMap((value) => ['-c', value])];
      return super.createSession({ ...spec, args,
        env: { ...spec.env, CODEX_EXEC_SERVER_URL: 'none' } });
    }
  }
  terminal = new FixtureTerminal({ socketDir: join(stateDir, 'dtach'), instanceId: 'fixture',
    dtachBinary: join(repository, 'vendor/dtach/dtach') });
  server = await createKookrServerInternal({
    port: 0, host: '127.0.0.1', kookrDir: join(stateDir, 'kookr'),
    tasksFile: join(stateDir, 'kookr/tasks.json'), hooksDir: join(stateDir, 'kookr/hooks'),
    settingsDir: join(stateDir, 'kookr/settings'), serverCwd: cwd,
    frontendDir: join(repository, 'dist/frontend'), claudeDir: join(stateDir, 'claude'),
    terminalBackend: terminal, terminalInstanceDir: terminal.getInstanceDir(),
    codexBin: codex,
    preflightOnFatal: (failure) => { throw new Error(failure.reason); },
    bypassAllPermissions: true, speakFindingEnabled: false,
    saveIntervalMs: 5000, livenessIntervalMs: 5000, lifecycleSignal: lifecycle.signal,
  });
  evidence.baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const created = await json('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    prompt: JSON.stringify({ name: 'Synthetic provider-progress verification', prompt: 'Wait for the incomplete custom exec response.' }),
    cwd, agentType: 'codex-cli', model: 'gpt-6-astra',
  }) });
  taskId = (created.task ?? created).id;
  evidence.taskId = taskId;
  const startupDeadline = Date.now() + 90000;
  while (!firstDeltaAt) {
    assert(evidence.provider.execToolAdvertised !== false,
      `Unexpected provider request schema: ${JSON.stringify(evidence.provider.requestShape)}`);
    assert(Date.now() < startupDeadline, 'Codex never reached the controlled provider');
    await sample();
    await sleep(3000);
  }
  while (Date.now() - firstDeltaAt < streamMs + silenceMs) {
    assert(!evidence.provider.connectionClosedAt, 'Codex closed the provider stream before the observation finished');
    assert.equal(evidence.provider.requests, 1, 'Unexpected additional non-title provider request');
    await sample();
    await sleep(5000);
  }
  await sample();
  evidence.sessionId = sessionId;
  evidence.provider.firstDeltaAt = firstDeltaAt;
  evidence.provider.lastDeltaAt = lastDeltaAt;
  const during = evidence.samples.filter((entry) => entry.elapsedMs >= 70000 && entry.phase === 'streaming');
  const activeSamples = evidence.samples.filter((entry) => entry.elapsedMs >= 10000 && entry.phase === 'streaming');
  const final = evidence.samples.at(-1);
  assert(evidence.provider.execToolAdvertised, 'The provider request did not advertise the custom exec tool');
  assert.equal(evidence.provider.requests, 1, 'The provider must remain on one incomplete response');
  assert(lastDeltaAt - firstDeltaAt >= 240000, 'The provider did not stream for four minutes');
  assert(during.length > 0);
  assert.equal(new Set(during.map((entry) => entry.lastTokenActivityAt)).size, 1,
    'Transcript or token totals unexpectedly refreshed during partial tool generation');
  assert(during.every((entry) => entry.transcriptLastProgressAt !== null), 'A real rollout must be observable');
  assert.equal(new Set(during.map((entry) => entry.transcriptLastProgressAt)).size, 1,
    'Transcript writes unexpectedly supplied freshness during partial tool generation');
  assert(transcriptPath, 'The managed session did not report its own rollout path');
  const rollout = (await readFile(transcriptPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  evidence.rollout = {
    recordCount: rollout.length,
    tokenTotals: rollout.filter((record) => record.type === 'event_msg' && record.payload?.type === 'token_count').length,
    completedTurns: rollout.filter((record) => record.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(record.payload?.type)).length,
    completedToolCalls: rollout.filter((record) => record.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(record.payload?.type)).length,
  };
  assert.equal(evidence.rollout.tokenTotals, 0, 'The fixture must not write a token-usage total');
  assert.equal(evidence.rollout.completedTurns, 0, 'The fixture must not complete the provider response');
  assert.equal(evidence.rollout.completedToolCalls, 0, 'The fixture must not finish the custom tool input');
  assert.equal(evidence.toolUseHooks, 0, 'The fixture must not execute any tool');
  assert(evidence.samples.at(-1).ptyRingHead > evidence.samples.find((entry) => entry.phase === 'silence').ptyRingHead,
    'Terminal bytes must continue during provider silence');
  if (expectBaseline) {
    assert(during.some((entry) => entry.stuckReason === 'hung_suspect'), 'Baseline failed to reproduce false stale');
  } else {
    assert(activeSamples.every((entry) => entry.classification === 'healthy-working' && entry.stuckReason === null && entry.anomaly === null),
      'Active nonempty provider output was incorrectly classified stale');
    assert(during.some((entry) => entry.progressEvents > 0), 'No provider-progress notification reached Kookr');
    assert(new Set(during.map((entry) => entry.lastEventAt)).size > 10, 'Observed progress did not advance watchdog freshness');
    assert(evidence.samples.every((entry) => entry.historyProgressEvents === 0), 'Progress polluted monitor history');
    assert(evidence.samples.every((entry) => entry.timelineProgressItems === 0), 'Progress polluted the activity timeline');
    assert(evidence.progressHooks.length <= Math.ceil(streamMs / 10000) + 2, 'Progress delivery exceeded its bounded cadence');
    assert(evidence.progressHooks.every((hook) => hook.bytes < 2048 && hook.observedAtMs <= lastDeltaAt + 1000),
      'Progress metadata was unbounded or invented observations during silence');
    assert.equal(new Set(evidence.progressHooks.map((hook) => hook.turnId)).size, 1, 'Turn attribution changed within one response');
    assert.equal(new Set(evidence.progressHooks.map((hook) => hook.sessionId)).size, 1, 'Session attribution changed within one response');
  }
  assert.equal(final.classification, 'provider-or-agent-stalled');
  assert.equal(final.stuckReason, 'hung_suspect');
  assert.equal(final.anomaly, 'stale_agent');
  assert.equal(final.attachState, 'alive');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  clearInterval(providerTimer);
  response?.destroy();
  provider.closeAllConnections();
  await new Promise((resolveClose) => provider.close(resolveClose));
  lifecycle.abort();
  for (const ownedSession of await terminal?.listSessions() ?? []) {
    await terminal.killSession(ownedSession).catch(() => {});
  }
  await server?.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(runDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${evidence.result}: ${join(runDir, 'evidence.json')}\n`);
}
process.exit(process.exitCode ?? 0);
