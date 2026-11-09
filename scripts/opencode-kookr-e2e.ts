/**
 * Real, isolated Kookr-server end-to-end for the opencode agent (NOT part of `pnpm test`).
 *
 *   set -a; . /path/to/deepinfra.env; set +a      # exports OPENAI_API_KEY
 *   node --import tsx scripts/opencode-kookr-e2e.ts
 *
 * What it does: starts a Kookr server from this checkout with a hermetic environment (temp HOME so the
 * data dir is `<tmp>/home/.kookr-<port>`, loopback, a free port, no relay/telegram/STT/TTS and no
 * inherited KOOKR_* variables), builds two tiny fixture repos (each a linked worktree with a failing
 * test), launches two concurrent opencode tasks through `POST /api/tasks`, and checks: hook trail, the
 * agent raising `completion-ready` through `kookr` on its PATH (default Kookr hooks), a mid-task
 * `POST /api/agents/:id/message`, session/config/hook-file isolation, token usage after stop,
 * resource-watchdog counting, no leftover processes, peak RSS. Then (mainResume): a RESUME proof (abort a
 * task, reopen it over the WebSocket, assert opencode continued the same `ses_...` session from the
 * per-task persistent data dir and recalls a codename that exists only in the earlier transcript),
 * `kookr peek`, and DELETE removing the task's persistent data. See docs/reference/opencode-agent.md.
 *
 * It SKIPs (exit 0) without OPENAI_API_KEY, the pinned opencode binary or a dtach binary. It only ever
 * kills the server PID it spawned (never pkill by name) and never touches ~/.kookr or port 4800.
 * The hermetic env sets KOOKR_OPENCODE_ENABLED=1. Override: KOOKR_OPENCODE_BIN, E2E_PORT, E2E_KEEP=1 (keep the temp dir).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { createResourceWatchdogHostSampler } from '../src/server/resource-watchdog-sampler.js';
import { readOpenCodeDataHomeUsage } from '../src/adapters/opencode-usage-scanner.js';

const REPO = resolve(__dirname, '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const OPENCODE_BIN = process.env.KOOKR_OPENCODE_BIN
  ?? join(process.env.HOME ?? '', '.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode');
const DTACH = join(REPO, 'vendor/dtach/dtach');

if (!process.env.OPENAI_API_KEY) { console.log('SKIP: OPENAI_API_KEY not set'); process.exit(0); }
if (!existsSync(OPENCODE_BIN)) { console.log(`SKIP: opencode binary not found (${OPENCODE_BIN})`); process.exit(0); }
if (!existsSync(DTACH)) { console.log(`SKIP: no vendored dtach at ${DTACH} (pnpm build:dtach)`); process.exit(0); }

type Rec = Record<string, any>;
const results: Array<{ name: string; pass: boolean; evidence: string }> = [];
function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}\n     ${evidence.replace(/\n/g, '\n     ')}`);
}

async function freePort(): Promise<number> {
  if (process.env.E2E_PORT) return Number(process.env.E2E_PORT);
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const work = mkdtempSync(join(tmpdir(), 'oc-kookr-e2e-'));
const home = join(work, 'home');
const nbDir = join(work, 'nb');
mkdirSync(home, { recursive: true });
mkdirSync(nbDir, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** Fixture: a base repo plus one linked worktree (Kookr tasks never run in a main checkout). */
function makeFixture(name: string, kind: 'slug' | 'mean'): { cwd: string; prompt: string; issue: number } {
  const base = join(work, `${name}-base`);
  mkdirSync(join(base, '.github'), { recursive: true });
  mkdirSync(join(base, 'test'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  git(base, 'config', 'user.name', 'fixture');
  git(base, 'config', 'user.email', 'fixture@example.com');
  const fixtures = {
    slug: {
      src: ['slug.js', "function slugify(title) {\n  return title.toLowerCase().replace(/ /g, '-');\n}\nmodule.exports = { slugify };\n"],
      test: ['test/slug.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { slugify } = require('../slug.js');\ntest('lowercases and dashes', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\ntest('drops punctuation and collapses spaces', () => assert.strictEqual(slugify('Hello,   World!'), 'hello-world'));\n"],
      prompt: "Issue #7: slugify() keeps punctuation and produces doubled dashes.\n\n`slugify('Hello,   World!')` returns `hello,---world!` but should return `hello-world`. The failing test is test/slug.test.js (run with `npm test`). Keep the fix minimal.\n",
      issue: 7,
    },
    mean: {
      src: ['mean.js', 'function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\nmodule.exports = { mean };\n'],
      test: ['test/mean.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { mean } = require('../mean.js');\ntest('mean of numbers', () => assert.strictEqual(mean([1, 2, 3]), 2));\ntest('mean of empty array is 0, not NaN', () => assert.strictEqual(mean([]), 0));\n"],
      prompt: 'Issue #9: mean([]) returns NaN instead of 0.\n\nThe failing test is test/mean.test.js (run with `npm test`). Keep the fix minimal.\n',
      issue: 9,
    },
  } as const;
  const f = fixtures[kind];
  writeFileSync(join(base, f.src[0]), f.src[1]);
  writeFileSync(join(base, f.test[0]), f.test[1]);
  writeFileSync(join(base, 'package.json'), '{ "name": "fixture", "version": "1.0.0", "scripts": { "test": "node --test" } }\n');
  writeFileSync(join(base, 'README.md'), '# fixture\nTiny library. Run `npm test`.\n');
  writeFileSync(join(base, '.github/PULL_REQUEST_TEMPLATE.md'),
    '## Summary\n<one paragraph>\n\nCloses #<issue>\n\n## Checklist\n- [ ] Regression test added\n- [ ] Tests pass locally (`npm test`)\n- [ ] README updated\n- [ ] No unrelated changes\n');
  git(base, 'add', '-A');
  git(base, 'commit', '-qm', 'initial fixture');
  const cwd = join(work, `${name}-wt`);
  git(base, 'worktree', 'add', '-q', cwd, '-b', `fix-${name}`);
  return { cwd, prompt: f.prompt, issue: f.issue };
}

const nbRun = (...args: string[]) => execFileSync(process.execPath, [join(REPO, 'bin/nb.js'), ...args],
  { env: { PATH: process.env.PATH ?? '', HOME: home, NB_DIR: nbDir } });
// A one-shelf notebook so the SessionStart nb-inject hook has an index to inject.
execFileSync(process.execPath, [join(REPO, 'bin/nb.js'), 'add', 'patch-author', 'Run the failing test first; fix the root cause, not the test.'],
  { env: { PATH: process.env.PATH ?? '', HOME: home, NB_DIR: nbDir } });

let server: ChildProcess | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base()}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json };
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(1000); }
  return false;
}
function hookEvents(session: string): Rec[] {
  const p = join(home, `.kookr-${port}`, 'hooks', `${session}.jsonl`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const ocProcs = (): string[] => spawnSync('ps', ['-eo', 'pid,rss,args'], { encoding: 'utf8' }).stdout.split('\n')
  .filter((l) => l.includes(work) && (/\.bin\/opencode /.test(l) || l.includes(`port-${port}`)));

const peakRssKb = new Map<string, number>();
const sampler = setInterval(() => {
  for (const l of ocProcs()) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S*\.bin\/opencode)\s+(\S+)/);
    if (m) peakRssKb.set(m[4]!, Math.max(peakRssKb.get(m[4]!) ?? 0, Number(m[2])));
  }
}, 2000);

async function main(): Promise<void> {
  port = await freePort();
  // Hermetic env: nothing from the operator's shell (telegram, relay, STT, KOOKR_TASK_ID, ...) leaks in.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
    KOOKR_PORT: String(port), KOOKR_HOST: '127.0.0.1',
    KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '1', // temp dir on a nearly-full disk must not refuse launches
    KOOKR_RESOURCE_WATCHDOG: '1',
    KOOKR_OPENCODE_ENABLED: '1', // opt-in flag: the agent is not registered without it
    KOOKR_OPENCODE_SEED_DIR: join(work, 'seed'), // never write the seed under the real ~/.kookr
    KOOKR_OPENCODE_BIN: OPENCODE_BIN,
    NB_DIR: nbDir,
  };
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const logFile = join(work, 'server.log');
  const onLog = (d: Buffer | string) => { log += d; try { appendFileSync(logFile, d); } catch { /* ignore */ } };
  server.stdout!.on('data', onLog);
  server.stderr!.on('data', onLog);
  const up = await waitFor(async () => { try { return (await fetch(`${base()}/api/health`)).ok; } catch { return false; } }, 90_000);
  if (!up) { record('server boots (isolated)', false, log.slice(-1500)); return; }
  record('server boots (isolated)', true, `pid=${server.pid} port=${port} dataDir=${home}/.kookr-${port}\n${log.split('\n').filter((l) => /adapter=opencode|agent-launcher/.test(l)).join('\n')}`);

  const fx = [makeFixture('a', 'slug'), makeFixture('b', 'mean')];
  const launches: Array<{ taskId: string; session: string; fx: (typeof fx)[number] }> = [];
  for (const f of fx) {
    const r = await api('POST', '/api/tasks', { prompt: f.prompt, cwd: f.cwd, agentType: 'opencode' });
    if (r.status !== 201 && r.status !== 200) { record('launch via POST /api/tasks', false, JSON.stringify(r.json).slice(0, 400)); return; }
    const t = r.json;
    launches.push({ taskId: t.id, session: '', fx: f });
  }
  const sessionOf = async (taskId: string): Promise<string> => {
    const list = (await api('GET', '/api/tasks')).json as Rec[];
    return list.find((t) => t.id === taskId)?.sessions?.[0]?.tmuxSession ?? '';
  };
  await waitFor(async () => { for (const l of launches) l.session = await sessionOf(l.taskId); return launches.every((l) => l.session); }, 30_000);
  record('two concurrent tasks launch', launches.every((l) => l.session) && launches[0]!.session !== launches[1]!.session,
    launches.map((l) => `${l.taskId.slice(0, 8)} -> ${l.session}`).join('\n'));

  // Wait for both tasks to finish their stop sequence (>= 1 Stop and a completion signal or a long idle).
  await waitFor(async () => {
    const list = (await api('GET', '/api/tasks')).json as Rec[];
    return launches.every((l) => {
      const t = list.find((x) => x.id === l.taskId);
      return t?.pendingSignal?.kind === 'completion_ready' || t?.stuckReason === 'awaiting_completion_ack';
    });
  }, 300_000);

  // The closing Stop lands a moment after the signal's tool call.
  await waitFor(() => launches.every((l) => hookEvents(l.session).at(-1)?.hook_event_name === 'Stop'), 30_000);
  const list = (await api('GET', '/api/tasks')).json as Rec[];
  for (const l of launches) {
    const t = list.find((x) => x.id === l.taskId) ?? {};
    const ev = hookEvents(l.session);
    const names = ev.map((e) => e.hook_event_name);
    record(`[${l.fx.issue}] hook trail SessionStart..Stop`, names[0] === 'SessionStart' && names.includes('UserPromptSubmit') && names.includes('PreToolUse') && names.at(-1) === 'Stop',
      `${names.length} events; stops=${names.filter((n) => n === 'Stop').length}; first=${names[0]} last=${names.at(-1)}`);
    const testsOk = spawnSync('npm', ['test'], { cwd: l.fx.cwd, encoding: 'utf8' }).status === 0;
    record(`[${l.fx.issue}] deliverable: the fixture's tests pass`, testsOk, `testsOk=${testsOk}`);
    const bashCmds = ev.filter((e) => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Bash').map((e) => String(e.tool_input?.command ?? ''));
    record(`[${l.fx.issue}] agent ran the lesson decision then \`kookr signal completion-ready\` (kookr on PATH, reached this server)`,
      bashCmds.some((c) => /No generic KB lesson|kb remember/.test(c)) && bashCmds.some((c) => /kookr signal completion-ready/.test(c)) && t.pendingSignal?.kind === 'completion_ready',
      `pendingSignal=${JSON.stringify(t.pendingSignal)?.slice(0, 120)} stuckReason=${t.stuckReason}`);
    record(`[${l.fx.issue}] status machine does not flag it hung/blocked`, t.status === 'inProgress' && t.stuckReason !== 'hung_suspect',
      `status=${t.status} stuckReason=${t.stuckReason ?? '-'}`);
  }

  // Follow-up message to the first task (a new prompt resumes the turn, so the completion signal is
  // cleared by design; do it after the signal checks above).
  const first = launches[0]!;
  const msg = await api('POST', `/api/agents/${first.session}/message`, { input: 'Follow-up: also create a file FOLLOWUP.txt containing exactly the word ACK-7 (untracked is fine), then say done.' });
  const followed = await waitFor(() => existsSync(join(first.fx.cwd, 'FOLLOWUP.txt')), 180_000);
  record('POST /api/agents/:id/message follow-up executed', msg.status === 200 && followed,
    `status=${msg.status} FOLLOWUP.txt=${followed ? readFileSync(join(first.fx.cwd, 'FOLLOWUP.txt'), 'utf8').trim() : 'missing'}`);

  const a = launches[0]!, b = launches[1]!;
  const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith('kookr-opencode-kookr-'));
  const sessDir = (s: string) => dirs.map((d) => join(tmpdir(), d)).find((d) => d.includes(s));
  const da = sessDir(a.session), db = sessionDirPlugin(sessDir(b.session));
  const pa = sessionDirPlugin(da);
  record('concurrent sessions are isolated (own cfg dir, task id, hook file)',
    !!da && !!db && pa.includes(a.taskId) && db.includes(b.taskId)
      && !pa.includes(b.taskId) && a.session !== b.session && hookEvents(a.session).length > 0 && hookEvents(b.session).length > 0,
    `sessionDirs=${dirs.length}; hook files: ${a.session}.jsonl(${hookEvents(a.session).length}) ${b.session}.jsonl(${hookEvents(b.session).length})`);
  const wd = createResourceWatchdogHostSampler().sample();
  record('resource watchdog sampler counts the opencode process family', wd.processCounts.opencode! >= 2, JSON.stringify(wd.processCounts));

  // Stop: complete one task, abort the other (usage is recorded on stop; DELETE removes the record).
  await api('POST', `/api/tasks/${a.taskId}/complete`, {});
  await api('POST', '/api/tasks/abort', { taskIds: [b.taskId], reason: 'e2e' });
  const usage = await waitFor(async () => {
    const l = (await api('GET', '/api/tasks')).json as Rec[];
    return [a, b].every((x) => l.find((t) => t.id === x.taskId)?.tokenUsage?.inputTokens > 0);
  }, 30_000);
  const l2 = (await api('GET', '/api/tasks')).json as Rec[];
  record('token usage/cost recorded on both stop paths', usage,
    [a, b].map((x) => JSON.stringify(l2.find((t) => t.id === x.taskId)?.tokenUsage)).join('\n'));
  await sleep(3000);
  record('no opencode/dtach process of these sessions remains after stop', ocProcs().length === 0 && sessDirs().length === 0,
    `leftover=${JSON.stringify(ocProcs())} leftoverDirs=${JSON.stringify(sessDirs())}`);
  record('peak RSS per opencode process (KB)', peakRssKb.size > 0, JSON.stringify([...peakRssKb.entries()]));
}

function sessDirs(): string[] { return readdirSync(tmpdir()).filter((d) => d.startsWith('kookr-opencode-kookr-')); }
function sessionDirPlugin(d: string | undefined): string {
  return d && existsSync(join(d, 'cfg', 'plugins', 'kookr.js')) ? readFileSync(join(d, 'cfg', 'plugins', 'kookr.js'), 'utf8') : '';
}

// ---------------------------------------------------------------------------------------------------
// Phase 2: resume (through the isolated server).
// ---------------------------------------------------------------------------------------------------
const CODENAME = `KQ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/** A base repo (with `commits`: each a file map) plus one linked worktree; returns the worktree. */
function makeRepo(name: string, commits: Array<Record<string, string>>): { base: string; cwd: string } {
  const base = join(work, `${name}-base`);
  mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  git(base, 'config', 'user.name', 'fixture');
  git(base, 'config', 'user.email', 'fixture@example.com');
  commits.forEach((files, i) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(base, f, '..'), { recursive: true });
      writeFileSync(join(base, f), body);
    }
    git(base, 'add', '-A');
    git(base, 'commit', '-qm', `commit ${i + 1}`);
  });
  const cwd = join(work, `${name}-wt`);
  git(base, 'worktree', 'add', '-q', cwd, '-b', `work-${name}`);
  return { base, cwd };
}

const tasksList = async (): Promise<Rec[]> => (await api('GET', '/api/tasks')).json as Rec[];
const taskOf = async (id: string): Promise<Rec | undefined> => (await tasksList()).find((t) => t.id === id);
const sessionsOf = async (id: string): Promise<string[]> => ((await taskOf(id))?.sessions ?? []).map((x: Rec) => x.tmuxSession);
const tally = (ev: Rec[]): Record<string, number> => ev.reduce((m: Record<string, number>, e) => { m[e.hook_event_name] = (m[e.hook_event_name] ?? 0) + 1; return m; }, {});
const sessionDirOf = (session: string): string | undefined => sessDirs().map((d) => join(tmpdir(), d)).find((d) => d.includes(session));
const dataRoot = (): string => join(home, `.kookr-${port}`, 'opencode-data');
const dbOf = (taskId: string): string => join(dataRoot(), taskId, 'data', 'opencode', 'opencode.db');
const stopped = async (taskId: string): Promise<boolean> => (await sessionsOf(taskId)).length > 0 && ocProcs().every((l) => !l.includes(taskId));

async function launchTask(cwd: string, prompt: string): Promise<{ taskId: string; session: string }> {
  const r = await api('POST', '/api/tasks', { prompt, cwd, agentType: 'opencode' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`launch: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const taskId = r.json.id as string;
  let session = '';
  await waitFor(async () => { session = (await sessionsOf(taskId))[0] ?? ''; return !!session; }, 60_000);
  return { taskId, session };
}
/** Wait until the session's last hook is a Stop that is not followed by more work for `quietMs`. */
async function settled(session: string, quietMs: number, maxMs: number): Promise<boolean> {
  let lastLen = -1; let since = Date.now();
  return waitFor(() => {
    const ev = hookEvents(session);
    if (ev.length !== lastLen) { lastLen = ev.length; since = Date.now(); }
    return ev.at(-1)?.hook_event_name === 'Stop' && Date.now() - since >= quietMs;
  }, maxMs);
}
function peek(taskId: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(REPO, 'bin/kookr.js'), 'peek', taskId, '--json'], {
    env: { PATH: process.env.PATH ?? '', HOME: home, KOOKR_API_BASE_URL: base() }, encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
async function viaWs(msg: Rec): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.send(JSON.stringify(msg));
  await sleep(2000);
  ws.close();
}

async function mainResume(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const resumeRepo = makeRepo('res', [{ 'README.md': '# resume probe\n', 'package.json': '{ "name": "res", "version": "1.0.0" }\n' }]);
  const resPrompt = `The secret codename for this task is ${CODENAME}. Never write the codename into any file. `
    + 'Create NOTES.md at the repo root containing exactly the line "resume probe", then say done.';
  const R = await launchTask(resumeRepo.cwd, resPrompt);
  record('phase 2: resume task launches', !!R.session, `resume=${R.taskId.slice(0, 8)}/${R.session}`);

  const flowResume = async (): Promise<void> => {
  // ----- Resume: stage 1 (the agent finishes), then abort and reopen -----
  const r1 = await settled(R.session, 12_000, 300_000);
  const reviewMdPath = join(resumeRepo.cwd, 'NOTES.md');
  await waitFor(async () => (await taskOf(R.taskId))?.pendingSignal?.kind === 'completion_ready' || (await taskOf(R.taskId))?.stuckReason === 'awaiting_completion_ack', 60_000);
  const rEv1 = hookEvents(R.session);
  record('[resume] stage 1: agent created NOTES.md and finished', r1 && existsSync(reviewMdPath),
    `settled=${r1} NOTES.md=${existsSync(reviewMdPath) ? JSON.stringify(readFileSync(reviewMdPath, 'utf8').trim()) : 'missing'} events=${JSON.stringify(tally(rEv1))}`);
  const ab = await api('POST', '/api/tasks/abort', { taskIds: [R.taskId], reason: 'e2e resume' });
  await waitFor(async () => (await taskOf(R.taskId))?.tokenUsage?.inputTokens > 0, 30_000);
  const t1 = (await taskOf(R.taskId)) ?? {};
  await sleep(3000);
  const sid1 = t1.metadata?.opencodeSessionId as string | undefined;
  const dbExists = existsSync(dbOf(R.taskId));
  record('[resume] abort stops the session but keeps the per-task opencode data + records the ses_ id',
    ab.status === 200 && /^ses_/.test(sid1 ?? '') && dbExists && ocProcs().every((l) => !l.includes(R.taskId)),
    `abort=${ab.status} status=${t1.status} metadata.opencodeSessionId=${sid1} db=${dbOf(R.taskId)} exists=${dbExists} usage1=${JSON.stringify(t1.tokenUsage)}`);

  await viaWs({ type: 'reopenTask', taskId: R.taskId });
  let session2 = '';
  const reopened = await waitFor(async () => { const s = await sessionsOf(R.taskId); session2 = s.at(-1) ?? ''; return s.length >= 2 && session2 !== R.session; }, 180_000);
  await waitFor(() => hookEvents(session2).some((e) => e.hook_event_name === 'SessionStart'), 60_000);
  const proc2 = ocProcs().find((l) => l.includes('--session')) ?? '';
  record('[resume] reopen relaunches `opencode --session <same ses_ id>`',
    reopened && !!sid1 && proc2.includes(`--session ${sid1}`),
    `session2=${session2} proc=${proc2.trim().slice(0, 200)}`);
  const ev2 = hookEvents(session2);
  record('[resume] resumed session re-composed config (plugin/hooks env) and delivered NO new initial prompt',
    ev2.some((e) => e.hook_event_name === 'SessionStart') && !ev2.some((e) => e.hook_event_name === 'UserPromptSubmit')
      && sessionDirPlugin(sessionDirOf(session2)).includes(R.taskId),
    `events before follow-up=${JSON.stringify(tally(ev2))}`);

  const noCodenameOnDisk = spawnSync('grep', ['-r', CODENAME, resumeRepo.cwd, '--exclude-dir=.git'], { encoding: 'utf8' }).status === 1;
  const ask = await api('POST', `/api/agents/${session2}/message`, { input: 'Question about this conversation: what was the secret codename I gave you in my first message, and what was the name of the file you created? Do not search the filesystem. Create ANSWER.txt containing the codename and the file name on one line, then say done.' });
  const answerPath = join(resumeRepo.cwd, 'ANSWER.txt');
  const answered = await waitFor(() => existsSync(answerPath) && readFileSync(answerPath, 'utf8').trim() !== '', 240_000);
  await settled(session2, 8_000, 120_000);
  const answer = answered ? readFileSync(answerPath, 'utf8').trim() : '';
  record('[resume] agent recalled a codename that exists only in the earlier transcript',
    ask.status === 200 && noCodenameOnDisk && answer.includes(CODENAME),
    `codename=${CODENAME} (on disk before question: ${!noCodenameOnDisk}) ANSWER.txt=${JSON.stringify(answer)} message=${ask.status}`);

  const toolCalls2 = hookEvents(session2);
  const peekR = peek(R.taskId);
  const cResume = await api('POST', `/api/tasks/${R.taskId}/complete`, {});
  await waitFor(async () => { const t = await taskOf(R.taskId); return t?.status === 'completed' && (t?.tokenUsage?.inputTokens ?? 0) > (t1.tokenUsage?.inputTokens ?? 0); }, 40_000);
  const t2 = (await taskOf(R.taskId)) ?? {};
  const { default: Sqlite } = await import('better-sqlite3');
  const sessionIds = existsSync(dbOf(R.taskId)) ? new Sqlite(dbOf(R.taskId), { readonly: true }) : undefined;
  const rows = sessionIds ? (sessionIds.prepare('SELECT id, parent_id, (SELECT count(*) FROM message m WHERE m.session_id = session.id) AS msgs FROM session').all() as Rec[]) : [];
  sessionIds?.close();
  const roots = rows.filter((r) => r.parent_id === null);
  record('[resume] same opencode session continued: one root ses_ in the DB, usage accumulated, metadata id unchanged',
    roots.length === 1 && roots[0]!.id === sid1 && t2.metadata?.opencodeSessionId === sid1
      && t2.tokenUsage.inputTokens > t1.tokenUsage.inputTokens && t2.tokenUsage.outputTokens > t1.tokenUsage.outputTokens,
    `sessions=${JSON.stringify(rows)}\nusage before resume=${JSON.stringify(t1.tokenUsage)}\nusage after resume =${JSON.stringify(t2.tokenUsage)}\ncomplete=${cResume.status}`);
  record('[resume] kookr peek works on the resumed task', peekR.status === 0 && peekR.out.includes(R.taskId),
    `exit=${peekR.status} ${peekR.out.slice(0, 600).replace(/\n/g, ' ')}`);
  void toolCalls2;

  };
  await flowResume();

  // ----- DELETE removes the task and, after the post-stop sweep, its persistent data -----
  const dirR = join(dataRoot(), R.taskId);
  const keptBefore = existsSync(dirR);
  record('a completed task keeps its persistent data for the reopen grace period (default 24 h)', keptBefore,
    `kept=${keptBefore}; root=${dataRoot()} entries=${JSON.stringify(readdirSync(dataRoot()).map((d) => d.slice(0, 8)))}`);
  const del = await api('DELETE', `/api/tasks/${R.taskId}`);
  const gone = await waitFor(() => !existsSync(dirR), 60_000);
  record('DELETE /api/tasks/:id works and the deleted task\'s persistent opencode data is removed (retention sweep)',
    del.status === 200 && keptBefore && gone && (await taskOf(R.taskId)) === undefined,
    `delete=${del.status} dataDirBefore=${keptBefore} removedAfter=${gone} task404=${(await taskOf(R.taskId)) === undefined}`);
  await sleep(3000);
  record('phase 2: no opencode process or session dir remains', ocProcs().length === 0 && sessDirs().length === 0,
    `leftover=${JSON.stringify(ocProcs())} leftoverDirs=${JSON.stringify(sessDirs())}`);
}

void (async () => {
try {
  await main();
  await mainResume();
} catch (err) {
  record('harness error', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  clearInterval(sampler);
  if (server?.pid) {
    server.kill('SIGTERM'); // only the PID we spawned
    await sleep(2000);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (process.env.E2E_KEEP !== '1') rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
})();
