/**
 * LIVE checks for opencode worker containers (RFC #3541, S2d). Operator-run; NOT part of `pnpm test` or the PR gate.
 *
 *   node --import tsx scripts/opencode-containers-live.ts --image opencode-worker-kookr:s1 [--only <check,...>]
 *   (set -a; . ~/hermes-sandbox/data/deepinfra.env; set +a; \
 *     node --import tsx scripts/opencode-containers-live.ts --image opencode-worker-kookr:s1 --real-model)
 *
 * Default mode drives the REAL adapter, REAL docker and the REAL image against a local mock OpenAI-compatible provider
 * (reachable from containers on the docker bridge gateway), so every control-plane check is deterministic and costs no
 * tokens. `--real-model` runs ONE smoke with the real provider (OPENAI_API_KEY / OPENAI_BASE_URL from the environment,
 * model deepseek-ai/DeepSeek-V4.1-Flash-1017) and prints the wrapper-vs-REST verdict and the first real-model RSS.
 *
 * Hermetic: a fresh temp root holds the data dir, runtime dir, instance id, repo and intents; nothing under ~/.kookr or
 * the production server is read or written. Only containers this script launched (recorded by exact name) are removed,
 * and only processes inside those containers are signalled (`docker exec`, by PID found with `ps`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeTerminalBackend } from '../src/adapters/fake-terminal-backend.js';
import { OpenCodeContainerAdapter, type OpenCodeContainerAdapterConfig } from '../src/adapters/opencode-container-adapter.js';
import { stageContainerHooks } from '../src/adapters/opencode-container-hooks.js';
import { openCodeDbPathForDataHome, readOpenCodeDataHomeUsage } from '../src/adapters/opencode-usage-scanner.js';
import { openCodeTaskDataHome, openCodeTaskDir } from '../src/adapters/opencode-task-data.js';
import { A2aHttpClient } from '../src/containers/a2a-http-client.js';
import { DockerCliRunner } from '../src/containers/docker-cli-runner.js';
import { fsckClean, extractDeliverable } from '../src/containers/clone-extract.js';
import { IntentStore } from '../src/containers/intent-store.js';
import { ContainerLedgerIngest, ledgerLocation } from '../src/containers/ledger-ingest.js';
import { TaskStore } from '../src/core/tasks.js';

const REPO = resolve(__dirname, '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const IMAGE = opt('--image') ?? '';
const ONLY = opt('--only')?.split(',');
const REAL = flag('--real-model');
if (!IMAGE) { console.error('usage: opencode-containers-live.ts --image <worker image> [--only a,b] [--real-model]'); process.exit(2); }
const docker = new DockerCliRunner();
const dockerCli = (args: string[], t = 60_000) => execFileSync('docker', args, { encoding: 'utf8', timeout: t }).trim();

interface Result { name: string; pass: boolean; evidence: string }
const results: Result[] = [];
const record = (name: string, pass: boolean, evidence: string) => {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}\n     ${evidence.replace(/\n/g, '\n     ')}`);
};

// ---------- hermetic root, repo, mock provider ----------
const ROOT = mkdtempSync(join(tmpdir(), 'oc-containers-live-'));
if (!ROOT.startsWith(join(tmpdir(), 'oc-containers-live-'))) throw new Error('unexpected root');
const SRC = join(ROOT, 'repo');
const launchedNames = new Set<string>();

function initRepo(): void {
  mkdirSync(SRC, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', SRC, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', SRC]);
  writeFileSync(join(SRC, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
}

/**
 * Mock OpenAI-compatible provider (scripts/opencode-containers-mock-provider.mjs) in a throwaway container on the default
 * bridge: Docker may run in a VM (WSL2/Desktop), so the host is not a reliable address for workers to call.
 */
const mock = { name: '', ip: '', hostPort: 0, lastScenario: '' };
async function mockStats(): Promise<{ requests: number; held: number }> {
  return (await (await fetch(`http://127.0.0.1:${mock.hostPort}/__stats`)).json()) as { requests: number; held: number };
}
async function startMock(): Promise<void> {
  mock.name = `oc-live-mock-${Date.now().toString(36)}`;
  dockerCli(['run', '-d', '--name', mock.name, '--entrypoint', 'node', '-p', '127.0.0.1::9999', '-v', `${join(REPO, 'scripts', 'opencode-containers-mock-provider.mjs')}:/mock.mjs:ro`, IMAGE, '/mock.mjs']);
  mock.ip = dockerCli(['inspect', '-f', '{{.NetworkSettings.Networks.bridge.IPAddress}}', mock.name]);
  mock.hostPort = Number(/:(\d+)$/m.exec(dockerCli(['port', mock.name, '9999/tcp']))![1]);
  await waitFor(async () => { try { await mockStats(); return true; } catch { return false; } }, 20_000, 'mock provider');
}
function stopMock(): void {
  if (mock.name) { try { dockerCli(['rm', '-f', mock.name]); } catch { /* already gone */ } }
}

// ---------- adapter factory (a fresh object graph == "Kookr restarted") ----------
const instanceId = `live-${Date.now().toString(36)}`;
const store = new TaskStore();
const backend = new FakeTerminalBackend(); // the supervisor `docker logs -f` session is simulated; real terminal backends are exercised in prod
const a2a = new A2aHttpClient();
function makeAdapter(over: Partial<OpenCodeContainerAdapterConfig> = {}, env?: NodeJS.ProcessEnv): OpenCodeContainerAdapter {
  const e: NodeJS.ProcessEnv = env ?? { ...process.env, OPENAI_API_KEY: REAL ? process.env.OPENAI_API_KEY : 'mock-key' };
  delete e.KOOKR_PR_LINT_CMD;
  return new OpenCodeContainerAdapter(
    {
      docker, a2a, taskStore: store, backend, instanceId, intents: new IntentStore(join(ROOT, 'intents')),
      ledger: new ContainerLedgerIngest(join(ROOT, 'rt', 'spool'), { watch() {}, stop() {}, isWatching: () => false }),
    },
    {
      image: IMAGE, cap: 1, runtimeRoot: join(ROOT, 'rt'), dataRoot: join(ROOT, 'data'),
      hostBinDir: join(REPO, 'bin'), hostPluginHooksDir: join(REPO, 'plugin', 'hooks'),
      profilesDir: join(REPO, 'plugin', 'opencode-profiles'), env: e,
      model: {
        providerId: 'deepinfra', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', apiKeyEnv: 'OPENAI_API_KEY',
        baseUrl: REAL ? (process.env.OPENAI_BASE_URL ?? 'https://api.deepinfra.com/v1/openai') : `http://${mock.ip}:9999/v1`,
      },
      ...over,
    },
  );
}

const newTask = (profile?: string) => store.createTask({ prompt: 'live', cwd: SRC, ...(profile ? { metadata: { opencodeProfile: profile } } : {}) });
async function launch(a: OpenCodeContainerAdapter, prompt: string, profile?: string) {
  const t = newTask(profile);
  const handle = await a.launch(t.id, prompt, SRC);
  launchedNames.add(handle);
  return { task: t, handle };
}
const ledgerOf = (taskId: string, handle: string) => {
  const token = handle.split('-').pop()!;
  const f = ledgerLocation(join(ROOT, 'rt', 'spool'), taskId, token).file;
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};
const exec = (name: string, ...cmd: string[]) => spawnSync('docker', ['exec', name, ...cmd], { encoding: 'utf8', timeout: 20_000 });
const procs = (name: string) => exec(name, 'ps', '-eo', 'pid,ppid,args').stdout.split('\n').slice(1);
const inContainerPids = (name: string, needle: string) => procs(name).filter((l) => l.includes(needle) && !l.includes('ps -eo')).map((l) => Number(l.trim().split(/\s+/)[0]));
const stateOf = (name: string) => dockerCli(['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}}', name]);
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(500); }
  throw new Error(`timeout waiting for ${what}`);
}
async function cleanup(a?: OpenCodeContainerAdapter): Promise<void> {
  for (const n of launchedNames) {
    try { await (a ?? makeAdapter()).stop(n); } catch { /* fall through to forced removal */ }
    try { dockerCli(['rm', '-f', n]); } catch { /* already gone */ }
  }
  launchedNames.clear();
}
const containerGone = (n: string) => spawnSync('docker', ['inspect', n], { encoding: 'utf8' }).status !== 0;

// ---------- checks ----------
type Check = { name: string; run: () => Promise<void> };
const checks: Check[] = [];
const check = (name: string, run: () => Promise<void>) => checks.push({ name, run });

check('launch_and_basics', async () => {
  const a = makeAdapter();
  const { task, handle } = await launch(a, 'SCENARIO:text hello');
  const ledger = ledgerOf(task.id, handle);
  const uid = exec(handle, 'id', '-u').stdout.trim();
  const mounts = JSON.parse(dockerCli(['inspect', '-f', '{{json .Mounts}}', handle])) as Array<{ Destination: string; RW: boolean }>;
  const ro = Object.fromEntries(mounts.map((m) => [m.Destination, !m.RW]));
  const env = dockerCli(['inspect', '-f', '{{json .Config.Env}}', handle]);
  const ports = dockerCli(['inspect', '-f', '{{json .NetworkSettings.Ports}}', handle]);
  record('launch_and_basics', ledger.length > 0 && uid === String(process.getuid!()) && ro['/cfg'] && ro['/run/secrets'] && ro['/kookr-hooks'] && !env.includes('mock-key') && ports.includes('127.0.0.1'),
    `ledger records=${ledger.length} uid=${uid} ro(/cfg,/run/secrets,/kookr-hooks)=${ro['/cfg']},${ro['/run/secrets']},${ro['/kookr-hooks']} key-in-env=${env.includes('mock-key')} publish=${ports}`);
  await a.stop(handle);
  record('stop_cleans_up', containerGone(handle) && !existsSync(join(ROOT, 'rt', 'tasks', task.id, 'secrets')),
    `container gone=${containerGone(handle)} secrets removed=${!existsSync(join(ROOT, 'rt', 'tasks', task.id, 'secrets'))}; data kept=${existsSync(openCodeTaskDir(join(ROOT, 'data'), task.id))}`);
});

check('host_reads_bind_mounted_db', async () => {
  const a = makeAdapter();
  const { task, handle } = await launch(a, 'SCENARIO:text hello');
  const dataHome = openCodeTaskDataHome(openCodeTaskDir(join(ROOT, 'data'), task.id));
  await waitFor(() => existsSync(openCodeDbPathForDataHome(dataHome)), 30_000, 'opencode db');
  await waitFor(async () => { const u = await readOpenCodeDataHomeUsage(dataHome); return u.kind === 'ok' && u.usage.requestCount > 0; }, 60_000, 'usage > 0');
  const u = await readOpenCodeDataHomeUsage(dataHome);
  await a.stop(handle);
  record('host_reads_bind_mounted_db', u.kind === 'ok', `host read usage from ${openCodeDbPathForDataHome(dataHome)}: ${JSON.stringify(u.kind === 'ok' ? u.usage : u)}; after stop the task has usage=${JSON.stringify(store.getTask(task.id)?.tokenUsage ?? null)} opencodeSessionId=${store.getTask(task.id)?.metadata?.opencodeSessionId ?? 'none'}`);
});

const CANCEL_VARIANTS: Array<{ label: string; scenario: string; detached: boolean }> = [
  { label: 'plain-sleep', scenario: 'tool:sleep%20300', detached: false },
  { label: 'setsid', scenario: 'tool:setsid%20sleep%20301%20%26%20sleep%20300', detached: true },
  { label: 'nohup', scenario: 'tool:nohup%20sleep%20302%20%3E%2Fdev%2Fnull%202%3E%261%20%26%20sleep%20300', detached: true },
  { label: 'background', scenario: 'tool:sleep%20303%20%26%20sleep%20300', detached: true },
  { label: 'model-call', scenario: 'hold', detached: false },
];
check('cancel_10x', async () => {
  const rows: string[] = [];
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const v = CANCEL_VARIANTS[i % CANCEL_VARIANTS.length]!;
    const a = makeAdapter();
    const { task, handle } = await launch(a, `SCENARIO:${v.scenario} go`);
    const rec = JSON.parse(readFileSync(join(ROOT, 'rt', 'tasks', task.id, 'runtime.json'), 'utf8')) as { port: number; a2aToken: string };
    const ep = `http://127.0.0.1:${rec.port}`;
    // wait until the work is in flight: the tool process exists, or the model call is held open
    if (v.scenario === 'hold') await waitFor(async () => (await mockStats()).held > 0, 60_000, 'held model call');
    else await waitFor(() => inContainerPids(handle, 'sleep 30').length > 0, 60_000, 'tool sleeping');
    const cur = await a2a.currentTask(ep, rec.a2aToken, 5000);
    const t0 = Date.now();
    const finalState = cur ? await a2a.cancelTask(ep, rec.a2aToken, cur.taskId, 10_000) : 'NO_TASK';
    const cancelMs = Date.now() - t0; // cancel call + state re-read, before the settle wait below
    await sleep(2500);
    const sleepsAfterCancel = v.scenario === 'hold' ? 0 : inContainerPids(handle, 'sleep 30').length;
    const heldAfterCancel = (await mockStats()).held;
    await a.stop(handle);
    const gone = containerGone(handle);
    const pass = finalState === 'CANCELED' && gone && (!!v.detached || sleepsAfterCancel === 0) && (v.scenario !== 'hold' || heldAfterCancel === 0);
    if (pass) ok++;
    rows.push(`#${i + 1} ${v.label}: state=${finalState} tool-procs-after-cancel=${sleepsAfterCancel}${v.detached ? ' (detached: survival after cancel is expected, container stop must kill it)' : ''} held-model-calls-after-cancel=${heldAfterCancel} cancel+read=${cancelMs}ms container-gone-after-stop=${gone} ${pass ? 'ok' : 'FAIL'}`);
  }
  record('cancel_10x', ok === 10, `${ok}/10\n${rows.join('\n')}`);
});

check('kill9_opencode', async () => {
  const a = makeAdapter();
  const { handle } = await launch(a, 'SCENARIO:text hi');
  const pids = inContainerPids(handle, 'opencode serve');
  const target = pids[0];
  if (!target) throw new Error('no opencode serve process found');
  exec(handle, 'kill', '-9', String(target));
  await waitFor(() => !stateOf(handle).startsWith('running'), 30_000, 'container exit');
  const st = stateOf(handle);
  const listed = (await docker.listContainers({ key: 'kookr.instance', value: instanceId })).find((c) => c.name === handle);
  record('kill9_opencode', st.includes('exit=11') && listed?.state === 'exited', `after kill -9 of PID ${target}: ${st}; docker ps -a reports state=${listed?.state}`);
  await a.stop(handle);
});

check('stop_reprompt_through_a2a', async () => {
  // scoped-fix has a commit-and-pr-body gate: the worker answers "done" with nothing committed, so the gate exits 2 and
  // the plugin re-prompts through the opencode client. The mock counts model calls.
  const before = (await mockStats()).requests;
  const a = makeAdapter();
  const { task, handle } = await launch(a, 'SCENARIO:text do nothing', 'scoped-fix');
  await waitFor(() => ledgerOf(task.id, handle).some((l) => /"Stop"|hook_event_name":"Stop/.test(l)), 90_000, 'Stop record in ledger');
  await sleep(8000);
  const stops = ledgerOf(task.id, handle).filter((l) => /"Stop"/.test(l)).length;
  const calls = (await mockStats()).requests - before;
  const rec = JSON.parse(readFileSync(join(ROOT, 'rt', 'tasks', task.id, 'runtime.json'), 'utf8')) as { port: number; a2aToken: string };
  const tasks = (await (await fetch(`http://127.0.0.1:${rec.port}/tasks`, { headers: { authorization: `Bearer ${rec.a2aToken}` } })).json()) as { tasks: Array<{ status: { state: string } }> };
  record('stop_reprompt_through_a2a', stops >= 2 && calls >= 3,
    `ledger Stop records=${stops}, mock model calls=${calls} (>=3 means the gate re-prompted after the first answer), A2A task states=${tasks.tasks.map((t) => t.status.state).join(',')}\n` +
    `(A2A says the task finished after the FIRST turn; the re-prompt turn runs after that, so truth = ledger + container, as the RFC states)`);
  await a.stop(handle);
});

check('adopt_after_restart', async () => {
  const a1 = makeAdapter();
  const { task, handle } = await launch(a1, 'SCENARIO:text first');
  const reqBefore = (await mockStats()).requests;
  const a2 = makeAdapter(); // fresh adapter + fresh ledger ingest, same persisted dirs and the same container
  const adopted = await a2.adoptRunning();
  await a2.sendInput(handle, 'SCENARIO:text second turn');
  await waitFor(async () => (await mockStats()).requests > reqBefore, 60_000, 'second model call');
  await a2.stop(handle);
  record('adopt_after_restart', adopted.includes(handle) && containerGone(handle), `adopted=${JSON.stringify(adopted)}; sendInput after restart reached the model (${(await mockStats()).requests - reqBefore} new call(s)); stop from persisted state removed the container=${containerGone(handle)}; task ${task.id.slice(0, 8)}`);
});

check('hook_missing_blocks_launch', async () => {
  // A hook asset deliberately missing from the staged copy: the entrypoint's self-test must refuse to start (exit 14).
  const t = newTask();
  const dir = join(ROOT, 'hm'); mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'work'), { recursive: true }); mkdirSync(join(dir, 'data'), { recursive: true });
  await stageContainerHooks({ hostBinDir: join(REPO, 'bin'), hostPluginHooksDir: join(REPO, 'plugin', 'hooks'), destDir: join(dir, 'hooks'), omit: ['kookr-opencode-gate.js'] });
  for (const [f, v] of [['opencode_password', 'pw1'], ['a2a_token', 'tok1']] as const) { writeFileSync(join(dir, 'secrets', f), v, { mode: 0o600 }); }
  const name = `kookr-oc-${t.id.slice(0, 8)}-hm${Date.now().toString(36)}`;
  launchedNames.add(name);
  const r = spawnSync('docker', ['run', '--rm', '--name', name, '--read-only', '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', `/home/worker:uid=${process.getuid!()}`,
    '-e', 'HOME=/home/worker', '-v', `${join(dir, 'data')}:/data`, '-v', `${join(dir, 'work')}:/work`, '-v', `${join(dir, 'secrets')}:/run/secrets:ro`, '-v', `${join(dir, 'hooks')}:/kookr-hooks:ro`, IMAGE], { encoding: 'utf8', timeout: 60_000 });
  record('hook_missing_blocks_launch', r.status === 14 && /hook self-test/.test(r.stderr), `docker run exit=${r.status} stderr=${r.stderr.split('\n').find((l) => l.includes('hook self-test')) ?? r.stderr.slice(0, 200)}`);
  launchedNames.delete(name);
});

check('uid_not_1000', async () => {
  // The worker must run as an arbitrary uid (the host user's). Simulate a host user other than 1000: chown the task dirs
  // with a root container, run the image as that uid, then chown back.
  const uid = 54321;
  const dir = join(ROOT, 'uid'); for (const d of ['secrets', 'work', 'data', 'spool']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'opencode_password'), 'pw2', { mode: 0o600 }); writeFileSync(join(dir, 'secrets', 'a2a_token'), 'tok2', { mode: 0o600 });
  execFileSync('git', ['init', '-q', join(dir, 'work')]);
  const chown = (to: string) => dockerCli(['run', '--rm', '-v', `${dir}:/t`, '--entrypoint', 'chown', IMAGE, '-R', to, '/t'].map((x, i) => (i === 0 ? x : x)), 60_000);
  chmodSync(join(dir, 'secrets'), 0o700);
  try {
    // chown needs root: run the image's chown as uid 0
    dockerCli(['run', '--rm', '--user', '0', '-v', `${dir}:/t`, '--entrypoint', 'chown', IMAGE, '-R', `${uid}:${uid}`, '/t']);
    const name = `kookr-oc-uid00000-${Date.now().toString(36)}`; launchedNames.add(name);
    dockerCli(['run', '-d', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${uid}`, '--tmpfs', `/home/worker:uid=${uid}`,
      '--tmpfs', '/tmp', '-e', 'HOME=/home/worker', '-v', `${dir}/data:/data`, '-v', `${dir}/work:/work`, '-v', `${dir}/secrets:/run/secrets:ro`, IMAGE]);
    await waitFor(() => dockerCli(['inspect', '-f', '{{.State.Health.Status}}', name]) === 'healthy', 90_000, 'healthy as uid 54321');
    const id = exec(name, 'id', '-u').stdout.trim();
    record('uid_not_1000', id === String(uid), `worker healthy as uid ${id} (host user is ${process.getuid!()}); secrets 0600 owned by ${uid} were readable by the entrypoint`);
    dockerCli(['rm', '-f', name]); launchedNames.delete(name);
  } finally {
    try { dockerCli(['run', '--rm', '--user', '0', '-v', `${dir}:/t`, '--entrypoint', 'chown', IMAGE, '-R', `${process.getuid!()}:${process.getgid!()}`, '/t']); } catch { /* best-effort */ }
    void chown;
  }
});

check('deliverable_extract_fsck', async () => {
  const a = makeAdapter();
  const { task, handle } = await launch(a, 'SCENARIO:tool:' + encodeURIComponent("git config user.email w@x && git config user.name w && echo two > a.txt && git commit -qam worker && echo tamper >> .git/config") + ' go');
  const clone = join(ROOT, 'rt', 'tasks', task.id, 'work');
  await waitFor(() => spawnSync('git', ['-C', clone, 'log', '--oneline'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length >= 2, 90_000, 'worker commit');
  await a.stop(handle);
  const r = await extractDeliverable(SRC, clone, task.id);
  record('deliverable_extract_fsck', (await fsckClean(SRC)) && readFileSync(join(SRC, 'a.txt'), 'utf8') === 'one\n',
    `worker committed in the container clone (tampered its own .git/config); host fetched ${r.ref}@${r.head.slice(0, 8)} with no host code run; host repo fsck clean; source working tree untouched`);
});

check('a2a_completion_semantics', async () => {
  // Diagnostic for the wrapper-vs-REST decision: when does the A2A task reach COMPLETED, with and without returnImmediately?
  const a = makeAdapter();
  const { task, handle } = await launch(a, 'SCENARIO:text first');
  const rec = JSON.parse(readFileSync(join(ROOT, 'rt', 'tasks', task.id, 'runtime.json'), 'utf8')) as { port: number; a2aToken: string; contextId: string; a2aTaskId: string };
  const ep = `http://127.0.0.1:${rec.port}`;
  const H = { authorization: `Bearer ${rec.a2aToken}`, 'content-type': 'application/json' };
  const stateOf1 = async (id: string) => { const j = (await (await fetch(`${ep}/tasks/${id}`, { headers: H })).json()) as { status?: { state: string } }; if (!j.status) throw new Error(`task ${id}: ${JSON.stringify(j).slice(0, 200)}`); return j.status.state.replace('TASK_STATE_', ''); };
  const settle = async (id: string, ms: number) => { const t = Date.now(); for (;;) { const s = await stateOf1(id); if (s !== 'WORKING' && s !== 'SUBMITTED') return `${s} after ${Date.now() - t}ms`; if (Date.now() - t > ms) return `still ${s} after ${ms}ms`; await sleep(2000); } };
  const r1 = await settle(rec.a2aTaskId, 45_000);
  const send = async (text: string, immediate: boolean) => {
    const t = Date.now();
    const res = (await (await fetch(`${ep}/message:send`, { method: 'POST', headers: H, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ message: { messageId: `m-${Date.now()}`, contextId: rec.contextId, role: 'ROLE_USER', parts: [{ text }] }, configuration: { returnImmediately: immediate } }) })).json()) as { task?: { id: string; status: { state: string } } };
    if (!res.task) throw new Error(`message:send (returnImmediately=${immediate}) returned no task: ${JSON.stringify(res).slice(0, 300)}`);
    return { id: res.task.id, firstState: res.task.status.state.replace('TASK_STATE_', ''), ms: Date.now() - t };
  };
  const blocking = await send('SCENARIO:text second', false);
  const imm = await send('SCENARIO:text third', true);
  const r3 = await settle(imm.id, 45_000);
  await a.stop(handle);
  record('a2a_completion_semantics', true,
    `first task (returnImmediately:true via adapter): ${r1}\n` +
    `blocking message:send (returnImmediately:false): returned ${blocking.firstState} after ${blocking.ms}ms\n` +
    `returnImmediately:true message: first state ${imm.firstState}; settles: ${r3}`);
});

check('real_model_smoke', async () => {
  if (!REAL) { record('real_model_smoke', true, 'SKIPPED (pass --real-model with OPENAI_API_KEY set)'); return; }
  // One worker, no deliverable profile (so no Stop-gate loop confounds the A2A state): a plain task, a follow-up that is
  // cancelled during a live model call, then a third message proving the context survives the cancel.
  const a = makeAdapter();
  const t0 = Date.now();
  const { task, handle } = await launch(a, 'In the repository root create hello.txt containing exactly the word hi, then commit it with the message "add hello" (set a git identity first if needed). Reply with the word done.');
  const launchMs = Date.now() - t0;
  const rec = JSON.parse(readFileSync(join(ROOT, 'rt', 'tasks', task.id, 'runtime.json'), 'utf8')) as { port: number; a2aToken: string };
  const ep = `http://127.0.0.1:${rec.port}`;
  const get = async (path: string): Promise<{ state: string; ms: number }> => {
    const s0 = Date.now();
    try {
      const r = await fetch(`${ep}${path}`, { headers: { authorization: `Bearer ${rec.a2aToken}` }, signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { status?: { state?: string } };
      return { state: (j.status?.state ?? 'UNKNOWN').replace('TASK_STATE_', ''), ms: Date.now() - s0 };
    } catch { return { state: 'UNREACHABLE', ms: Date.now() - s0 }; }
  };
  let peak = 0;
  const memNow = () => { const m = /([\d.]+)(MiB|GiB|KiB)/.exec(dockerCli(['stats', '--no-stream', '--format', '{{.MemUsage}}', handle])); return m ? Number(m[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 } as Record<string, number>)[m[2]!]! : 0; };
  const polls: Array<{ state: string; ms: number }> = [];
  const clone = join(ROOT, 'rt', 'tasks', task.id, 'work');
  const waitTerminal = async (taskId: string, limitMs: number): Promise<{ state: string; ms: number }> => {
    const start = Date.now();
    for (;;) {
      peak = Math.max(peak, memNow());
      const p = await get(`/tasks/${taskId}`); polls.push(p);
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(p.state)) return { state: p.state, ms: Date.now() - start };
      if (Date.now() - start > limitMs) return { state: `TIMEOUT(${p.state})`, ms: Date.now() - start };
      await sleep(2000);
    }
  };
  const first = await a2a.currentTask(ep, rec.a2aToken, 10_000);
  const firstEnd = first ? await waitTerminal(first.taskId, 4 * 60_000) : { state: 'NO_TASK', ms: 0 };
  const committed = existsSync(join(clone, 'hello.txt')) && spawnSync('git', ['-C', clone, 'log', '--oneline'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length >= 2;
  const ledgerAfterFirst = ledgerOf(task.id, handle);
  // follow-up on the SAME context, cancelled while the model is working
  await a.sendInput(handle, 'Now list all prime numbers below 3000 and give a short primality justification for each one.');
  await sleep(4000);
  const second = await a2a.currentTask(ep, rec.a2aToken, 10_000);
  const secondId = second!.taskId;
  const midState = (await get(`/tasks/${secondId}`)).state;
  const cancelReturned = await a2a.cancelTask(ep, rec.a2aToken, secondId, 15_000);
  const reread3 = (await sleepThen(3000, () => get(`/tasks/${secondId}`))).state;
  const reread10 = (await sleepThen(7000, () => get(`/tasks/${secondId}`))).state;
  // the context must survive the cancel
  await a.sendInput(handle, 'Reply with the single word ok.');
  const third = await a2a.currentTask(ep, rec.a2aToken, 10_000);
  const thirdEnd = third ? await waitTerminal(third.taskId, 2 * 60_000) : { state: 'NO_TASK', ms: 0 };
  peak = Math.max(peak, memNow());
  const health = dockerCli(['inspect', '-f', '{{.State.Health.Status}}', handle]);
  const ledger = ledgerOf(task.id, handle);
  const hookKinds = [...new Set(ledger.map((l) => /"hook_event_name":\s*"(\w+)"/.exec(l)?.[1]).filter(Boolean))];
  const fails = polls.filter((p) => p.state === 'UNREACHABLE').length;
  const lat = polls.filter((p) => p.state !== 'UNREACHABLE').map((p) => p.ms).sort((x, y) => x - y);
  const pct = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? -1;
  // Two channels, judged separately. COMMAND: submit, follow-up on the same context, cancel that stays cancelled, and a
  // context that survives the cancel (the third message reaching the model is proven by its ledger records, not its A2A state).
  // STATE: the A2A task reaches a terminal state when the work is done.
  const commandFit = launchMs < 90_000 && committed && cancelReturned === 'CANCELED' && reread3 === 'CANCELED' && reread10 === 'CANCELED'
    && ledger.length > ledgerAfterFirst.length && ledger.length > 0 && health === 'healthy';
  const stateFit = firstEnd.state === 'COMPLETED' && thirdEnd.state === 'COMPLETED';
  const fit = commandFit && stateFit;
  const verdict = fit ? 'FIT (keep opencode-a2a for command and state)'
    : commandFit ? 'PARTIAL: command channel FIT, state channel UNFIT (tasks never reach a terminal state with returnImmediately); use plain opencode REST for state and completion'
    : 'UNFIT (use plain opencode REST)';
  await a.stop(handle);
  const u = store.getTask(task.id)?.tokenUsage;
  record('real_model_smoke', fit,
    `WRAPPER_VERDICT: ${verdict}\ncommand channel fit=${commandFit} state channel fit=${stateFit}\n` +
    `launch=${launchMs}ms; first task -> ${firstEnd.state} in ${firstEnd.ms}ms, hello.txt committed in the container clone=${committed}\n` +
    `follow-up on the same context: mid=${midState}; cancel during the live model call returned ${cancelReturned}; re-read after 3s=${reread3}, after 10s=${reread10} (F5 check: must stay CANCELED)\n` +
    `third message after the cancel (same context) -> ${thirdEnd.state} in ${thirdEnd.ms}ms; container health after all of it=${health}\n` +
    `GET /tasks/<id> polls: n=${polls.length} unreachable=${fails} latency p50=${pct(0.5)}ms p95=${pct(0.95)}ms max=${lat.at(-1) ?? -1}ms\n` +
    `ledger records=${ledger.length} (after first turn ${ledgerAfterFirst.length}) hook kinds=${hookKinds.join(',')}\n` +
    `FIRST_REAL_MODEL_PEAK_RSS_MIB=${peak.toFixed(0)} (docker stats MemUsage = cgroup incl. page cache; limit 2g) tokens=${JSON.stringify(u ?? null)}`);
});
async function sleepThen<T>(ms: number, fn: () => Promise<T>): Promise<T> { await sleep(ms); return fn(); }

// ---------- run ----------
(async () => {
  initRepo();
  if (!REAL) await startMock();
  console.log(`root=${ROOT} image=${IMAGE} instance=${instanceId} mode=${REAL ? 'REAL MODEL' : `mock provider container ${mock.name} at ${mock.ip}:9999`}`);
  for (const c of checks) {
    if (ONLY && !ONLY.includes(c.name)) continue;
    if (!REAL && c.name === 'real_model_smoke') continue;
    try { await c.run(); } catch (e) { record(c.name, false, `threw: ${(e as Error).message}`); }
    await cleanup();
  }
  stopMock();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  writeFileSync(join(ROOT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`results: ${join(ROOT, 'results.json')} (root kept for inspection; remove with: rm -rf ${ROOT})`);
  void readdirSync; void rmSync;
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error(e); stopMock(); await cleanup(); process.exit(1); });
