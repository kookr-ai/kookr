import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeDocker } from '../containers/fake-docker.js';
import { IntentStore } from '../containers/intent-store.js';
import { ContainerLedgerIngest, type LedgerWatcherPort } from '../containers/ledger-ingest.js';
import type { A2aClientPort, A2aTaskState } from '../containers/ports.js';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { ContainerUnsupportedError, OpenCodeContainerAdapter, type OpenCodeContainerAdapterConfig } from './opencode-container-adapter.js';

const repo = resolve(__dirname, '..', '..');

class FakeA2a implements A2aClientPort {
  sent: Array<{ text: string; contextId?: string; token: string; endpoint: string }> = [];
  cancelled: string[] = [];
  state: A2aTaskState = 'WORKING';
  failSend?: Error;
  async health() { return 'ok' as const; }
  async taskState() { return this.state; }
  async currentTask() { return { taskId: `task-${this.sent.length}`, state: this.state }; }
  async sendMessage(endpoint: string, token: string, msg: { text: string; contextId?: string }) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ ...msg, token, endpoint });
    return { taskId: `task-${this.sent.length}`, contextId: msg.contextId ?? 'ctx-1', state: 'WORKING' as const };
  }
  async cancelTask(_e: string, _t: string, id: string) { this.cancelled.push(id); return 'CANCELED' as const; }
}

class FakeWatcher implements LedgerWatcherPort {
  watched = new Map<string, { filePath: string; untrusted: boolean; replayExisting?: boolean }>();
  watch(key: string, o: { filePath: string; untrusted: boolean; replayExisting?: boolean }) { this.watched.set(key, o); }
  stop(key: string) { this.watched.delete(key); }
  isWatching(key: string) { return this.watched.has(key); }
}

let root: string;
let src: string;
let docker: FakeDocker;
let a2a: FakeA2a;
let store: TaskStore;
let backend: FakeTerminalBackend;
let watcher: FakeWatcher;
const SECRET = 'sk-test-provider-key-0123456789';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();

function make(over: Partial<OpenCodeContainerAdapterConfig> = {}, env: Record<string, string | undefined> = { OPENAI_API_KEY: SECRET, PATH: process.env.PATH }) {
  return new OpenCodeContainerAdapter(
    { docker, a2a, taskStore: store, backend, ledger: new ContainerLedgerIngest(join(root, 'rt', 'spool'), watcher), intents: new IntentStore(join(root, 'intents')), instanceId: 'INST' },
    {
      image: 'opencode-worker-kookr:s1', cap: 1, runtimeRoot: join(root, 'rt'), dataRoot: join(root, 'data'),
      hostBinDir: join(repo, 'bin'), hostPluginHooksDir: join(repo, 'plugin', 'hooks'),
      model: { providerId: 'deepinfra', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKeyEnv: 'OPENAI_API_KEY' },
      env: env as NodeJS.ProcessEnv, user: '4242:4242', sleep: async () => undefined, readyTimeoutMs: 50, canaryTimeoutMs: 50,
      ledgerSize: async () => 1, ...over,
    },
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-container-'));
  src = join(root, 'src');
  mkdirSync(src);
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  writeFileSync(join(src, 'a.txt'), 'one\n');
  g(src, 'add', '.');
  g(src, 'commit', '-qm', 'init');
  docker = new FakeDocker();
  a2a = new FakeA2a();
  store = new TaskStore();
  backend = new FakeTerminalBackend();
  watcher = new FakeWatcher();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const newTask = () => store.createTask({ prompt: 'fix it', cwd: src });

describe('OpenCodeContainerAdapter launch', () => {
  test('happy path: hardened run spec, private secrets, container-path hooks, derived logs session, A2A prompt', async () => {
    const task = newTask();
    const a = make();
    const handle = await a.launch(task.id, 'fix the bug', src);
    expect(handle).toMatch(/^kookr-oc-[0-9a-f]{8}-[0-9a-f]{12}$/);

    const spec = docker.runs[0]!;
    expect(spec.name).toBe(handle);
    expect(spec.labels).toMatchObject({ 'kookr.task': task.id, 'kookr.instance': 'INST' });
    expect(spec.user).toBe('4242:4242');
    expect(spec.publishPort).toBe(8000);
    // the provider key never reaches docker args/env
    expect(JSON.stringify(spec)).not.toContain(SECRET);
    expect(Object.keys(spec.env).sort()).toEqual(['HOME', 'WORKSPACE', 'XDG_DATA_HOME']);
    expect(spec.env.XDG_DATA_HOME).toBe('/data/data');
    const byTarget = Object.fromEntries(spec.mounts.map((m) => [m.target, m]));
    for (const t of ['/cfg', '/run/secrets', '/kookr-hooks']) expect(byTarget[t]!.readOnly).toBe(true);
    for (const t of ['/work', '/data', '/kookr-spool']) expect(byTarget[t]!.readOnly).toBe(false);

    // secrets: 0600 files; the key is only in the secret file and referenced by {file:}
    const secrets = byTarget['/run/secrets']!.source;
    for (const f of readdirSync(secrets)) expect(statSync(join(secrets, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(secrets, 'provider_key'), 'utf8')).toBe(SECRET);
    const cfgDir = byTarget['/cfg']!.source;
    const oc = readFileSync(join(cfgDir, 'opencode.json'), 'utf8');
    expect(oc).toContain('{file:/run/secrets/provider_key}');
    expect(oc).not.toContain(SECRET);
    expect(oc).not.toContain('{env:');

    // hooks: container paths only, no host path
    const plugin = readFileSync(join(cfgDir, 'plugins', 'kookr.js'), 'utf8');
    expect(plugin).toContain('/kookr-hooks/bin/kookr-hook-writer.js');
    expect(plugin).toContain("/kookr-spool/ledger.jsonl");
    expect(plugin).not.toContain(repo);
    expect(plugin).not.toContain(process.execPath);
    expect(plugin).not.toContain('localhost');

    // clone is a real, separate repo
    expect(g(byTarget['/work']!.source, 'rev-parse', 'HEAD')).toBe(g(src, 'rev-parse', 'HEAD'));
    expect(byTarget['/work']!.source).not.toBe(src);

    // supervisor session + task registration + ledger watched untrusted under the same key
    expect(backend.sessions.get(handle)!.spec).toMatchObject({ command: 'docker', args: expect.arrayContaining(['logs', '-f', handle]) });
    expect(store.getTask(task.id)!.sessions[0]).toMatchObject({ tmuxSession: handle, agentType: 'opencode' });
    expect(watcher.watched.get(handle)).toMatchObject({ untrusted: true, filePath: expect.stringContaining('ledger.jsonl') });

    // prompt via A2A with the per-task bearer token, on loopback
    expect(a2a.sent).toHaveLength(1);
    expect(a2a.sent[0]).toMatchObject({ text: 'fix the bug', endpoint: 'http://127.0.0.1:40123' });
    expect(a2a.sent[0]!.token).toBe(readFileSync(join(secrets, 'a2a_token'), 'utf8'));
    expect(statSync(join(root, 'rt', 'tasks', task.id, 'runtime.json')).mode & 0o777).toBe(0o600);
  });

  test('cap 1: a second launch is refused while one container is live, and creates nothing', async () => {
    const a = make();
    await a.launch(newTask().id, 'one', src);
    const second = newTask();
    await expect(a.launch(second.id, 'two', src)).rejects.toMatchObject({ reason: 'container_cap_reached' });
    expect(docker.runs).toHaveLength(1);
    expect(store.getTask(second.id)!.sessions).toHaveLength(0);
  });

  test('refuses before creating anything: no provider key, KOOKR_PR_LINT_CMD set, docker down', async () => {
    const t = newTask();
    await expect(make({}, { PATH: process.env.PATH }).launch(t.id, 'x', src)).rejects.toMatchObject({ reason: 'provider_key_missing' });
    await expect(make({}, { OPENAI_API_KEY: SECRET, KOOKR_PR_LINT_CMD: '/host/lint.sh' }).launch(t.id, 'x', src)).rejects.toMatchObject({ reason: 'pr_lint_unresolvable' });
    docker.listContainers = async () => { throw new Error('Cannot connect to the Docker daemon'); };
    await expect(make().launch(t.id, 'x', src)).rejects.toMatchObject({ reason: 'docker_down' });
    expect(docker.runs).toHaveLength(0);
    expect(existsSync(join(root, 'rt', 'tasks', t.id, 'secrets'))).toBe(false);
  });

  test('missing image is classified, and the failed launch leaves no container, session or secrets', async () => {
    docker.runContainer = async () => { throw new Error('Unable to find image \'x\' locally'); };
    const t = newTask();
    await expect(make().launch(t.id, 'x', src)).rejects.toMatchObject({ reason: 'image_missing' });
    expect(docker.containers).toHaveLength(0);
    expect(backend.sessions.size).toBe(0);
    expect(existsSync(join(root, 'rt', 'tasks', t.id, 'secrets'))).toBe(false);
  });

  test('container that exits during startup (hook self-test = 14) fails fast as hook_assets_missing and is force-removed', async () => {
    docker.health = 'starting';
    const orig = docker.runContainer.bind(docker);
    docker.runContainer = async (s) => { const id = await orig(s); docker.containers[0]!.state = 'exited'; docker.containers[0]!.exitCode = 14; return id; };
    const t = newTask();
    await expect(make().launch(t.id, 'x', src)).rejects.toMatchObject({ reason: 'hook_assets_missing' });
    expect(docker.calls).toContain(`rm-f ${docker.runs[0]!.name}`);
    expect(docker.containers).toHaveLength(0);
  });

  test('never-healthy container times out as health_timeout and is removed', async () => {
    docker.health = 'starting';
    let t = 0;
    const a = make({ now: () => (t += 40) });
    await expect(a.launch(newTask().id, 'x', src)).rejects.toMatchObject({ reason: 'health_timeout' });
    expect(docker.containers).toHaveLength(0);
  });

  test('no ledger record within the canary window = plugin_not_loaded; session marked aborted, container removed', async () => {
    let t = 0;
    const task = newTask();
    const a = make({ ledgerSize: async () => 0, now: () => (t += 40), readyTimeoutMs: 10_000 });
    await expect(a.launch(task.id, 'x', src)).rejects.toMatchObject({ reason: 'plugin_not_loaded' });
    expect(docker.containers).toHaveLength(0);
    expect(store.getTask(task.id)!.sessions[0]!.lastStatus).toBe('aborted');
    expect(watcher.watched.size).toBe(0);
  });

  test('a 401 from the A2A wrapper is a2a_unauth, not a generic failure', async () => {
    a2a.failSend = new Error('a2a POST /message:send -> HTTP 401');
    await expect(make().launch(newTask().id, 'x', src)).rejects.toMatchObject({ reason: 'a2a_unauth' });
    expect(docker.containers).toHaveLength(0);
  });

  test('a missing hook asset is refused before docker run (a broken gate must never launch)', async () => {
    await expect(make({ hostBinDir: undefined }).launch(newTask().id, 'x', src)).rejects.toMatchObject({ reason: 'hook_assets_missing' });
    expect(docker.runs).toHaveLength(0);
  });
});

describe('OpenCodeContainerAdapter control, including after a Kookr restart', () => {
  test('sendInput continues the same A2A context; sendKeystroke is a typed Unsupported', async () => {
    const a = make();
    const h = await a.launch(newTask().id, 'first', src);
    await a.sendInput(h, 'nudge');
    expect(a2a.sent[1]).toMatchObject({ text: 'nudge', contextId: 'ctx-1' });
    await expect(a.sendKeystroke(h, 'Enter')).rejects.toBeInstanceOf(ContainerUnsupportedError);
  });

  test('a NEW adapter instance (restarted Kookr) can sendInput and stop from persisted state alone', async () => {
    const task = newTask();
    const h = await make().launch(task.id, 'first', src);
    const restarted = make();
    await restarted.sendInput(h, 'after restart');
    expect(a2a.sent.at(-1)).toMatchObject({ text: 'after restart', contextId: 'ctx-1' });
    await restarted.stop(h);
    expect(docker.calls).toContain(`stop ${h}`);
    expect(docker.calls).toContain(`rm ${h}`);
    expect(a2a.cancelled).toEqual(['task-2']); // the newest (post-restart) task is the one cancelled
    expect(existsSync(join(root, 'rt', 'tasks', task.id, 'secrets'))).toBe(false);
    // the conversation data and the clone are kept for resume / deliverable extraction
    expect(existsSync(join(root, 'rt', 'tasks', task.id, 'work', '.git'))).toBe(true);
  });

  test('stop still stops the container when the A2A cancel fails (A2A is advisory)', async () => {
    const a = make();
    const h = await a.launch(newTask().id, 'x', src);
    a2a.cancelTask = async () => { throw new Error('boom'); };
    await a.stop(h);
    expect(docker.calls).toContain(`stop ${h}`);
  });

  test('a failed docker stop falls back to rm -f', async () => {
    const a = make();
    const h = await a.launch(newTask().id, 'x', src);
    docker.failOn = `stop ${h}`;
    await a.stop(h);
    expect(docker.calls).toContain(`rm-f ${h}`);
  });

  test('adoptRunning re-attaches the ledger of a live container under the same key; exited ones are skipped', async () => {
    const task = newTask();
    const h = await make().launch(task.id, 'x', src);
    watcher.watched.clear();
    // the supervisor session survived the restart: startup recovery re-arms the watch, adopt must NOT pre-empt it
    expect(await make().adoptRunning()).toEqual([h]);
    expect(watcher.watched.size).toBe(0);
    // no supervisor session survived: adopt attaches the ledger itself, under the same key
    await backend.killSession(h);
    expect(await make().adoptRunning()).toEqual([h]);
    expect(watcher.watched.get(h)).toMatchObject({ untrusted: true, replayExisting: true });
    watcher.watched.clear();
    docker.containers[0]!.state = 'exited';
    expect(await make().adoptRunning()).toEqual([]);
  });

  test('ledgerFor resolves only container tasks (the startup-recovery watcher override)', async () => {
    const task = newTask();
    const a = make();
    const h = await a.launch(task.id, 'x', src);
    expect(a.ledgerFor(h)).toBeUndefined(); // mode not persisted yet: the routing adapter records it after launch
    store.recordOpenCodeLaunchMode(task.id, 'container');
    expect(a.ledgerFor(h)).toMatchObject({ untrusted: true, filePath: expect.stringMatching(/spool\/.+\/ledger\.jsonl$/) });
    expect(a.ledgerFor('kookr-abc123')).toBeUndefined();
    appendFileSync(a.ledgerFor(h)!.filePath, '');
  });
});

