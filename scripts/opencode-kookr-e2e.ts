/**
 * Real, isolated Kookr-server end-to-end for the opencode agent (NOT part of `pnpm test`).
 *
 *   set -a; . /path/to/deepinfra.env; set +a      # exports OPENAI_API_KEY
 *   node --import tsx scripts/opencode-kookr-e2e.ts
 *
 * What it does: starts a Kookr server from this checkout with a hermetic environment (temp HOME so the
 * data dir is `<tmp>/home/.kookr-<port>`, loopback, a free port, no relay/telegram/STT/TTS and no
 * inherited KOOKR_* variables), builds two tiny fixture repos (each a linked worktree with a failing
 * test, a PR template and a PR-body lint script), launches two concurrent `scoped-fix` opencode tasks
 * through `POST /api/tasks`, and checks: hook trail, deliverable gate result (commit with `Closes #N`,
 * lint-clean PR_BODY.md, passing tests), the agent raising `completion-ready` through `kookr` on its
 * PATH, a mid-task `POST /api/agents/:id/message`, session/config/hook-file isolation, token usage
 * after stop, resource-watchdog counting, no leftover processes, peak RSS. Then (mainProfiles): a
 * RESUME proof (abort a task, reopen it over the WebSocket, assert opencode continued the same `ses_...`
 * session from the per-task persistent data dir and recalls a codename that exists only in the earlier
 * transcript), a `reviewer` proof (planted bug, deliverable gate REVIEW.md, source untouched) and a
 * `test-auditor` proof (weak tests, AUDIT.md + new passing tests, mutation check), each with profile-scoped
 * nb shelf lessons, `kookr peek`, POST /api/agents/:id/message and DELETE. See docs/reference/opencode-agent.md.
 *
 * It SKIPs (exit 0) without OPENAI_API_KEY, the pinned opencode binary or a dtach binary. It only ever
 * kills the server PID it spawned (never pkill by name) and never touches ~/.kookr or port 4800.
 * The hermetic env sets KOOKR_OPENCODE_ENABLED=1. Override: KOOKR_OPENCODE_BIN, E2E_PORT, E2E_KEEP=1 (keep the temp dir).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// PR-body lint: needs `Closes #N`, no unticked box, and >= 4 ticked-or-struck-through items.
const lint = join(work, 'lint-pr-body.sh');
writeFileSync(lint, `#!/usr/bin/env bash
f="\${1:?usage: lint-pr-body.sh <file>}"; rc=0
grep -qE 'Closes #[0-9]+' "$f" || { echo "lint: missing 'Closes #N'"; rc=1; }
grep -qE '^- \\[ \\]' "$f" && { echo "lint: unticked checklist item(s)"; rc=1; }
n=$(grep -cE '^- \\[[xX]\\]|^- ~~' "$f"); [ "$n" -ge 4 ] || { echo "lint: expected 4 checklist items, found $n"; rc=1; }
exit $rc
`);
chmodSync(lint, 0o755);

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
    KOOKR_PR_LINT_CMD: `${lint} {pr_body}`,
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
    const r = await api('POST', '/api/tasks', { prompt: f.prompt, cwd: f.cwd, agentType: 'opencode', profile: 'scoped-fix', issue: f.issue });
    if (r.status !== 201 && r.status !== 200) { record('launch via POST /api/tasks', false, JSON.stringify(r.json).slice(0, 400)); return; }
    const t = r.json;
    launches.push({ taskId: t.id, session: '', fx: f });
    if (!t.metadata?.opencodeIssue || t.metadata?.opencodeProfile !== 'scoped-fix') { record('profile+issue persisted on task metadata', false, JSON.stringify(t.metadata)); }
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
    const msgText = git(l.fx.cwd, 'log', '-1', '--format=%B');
    const prBody = join(l.fx.cwd, 'PR_BODY.md');
    const lintOk = existsSync(prBody) && spawnSync(lint, [prBody]).status === 0;
    const testsOk = spawnSync('npm', ['test'], { cwd: l.fx.cwd, encoding: 'utf8' }).status === 0;
    record(`[${l.fx.issue}] deliverable: commit "Closes #${l.fx.issue}", lint-clean PR_BODY.md, tests pass`,
      new RegExp(`^Closes #${l.fx.issue}$`, 'm').test(msgText) && lintOk && testsOk,
      `${git(l.fx.cwd, 'log', '--oneline', '-2').trim()}\nlintOk=${lintOk} testsOk=${testsOk}`);
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
  record('concurrent sessions are isolated (own cfg dir, task id, issue, hook file)',
    !!da && !!db && pa.includes(a.taskId) && pa.includes('"KOOKR_OPENCODE_ISSUE":"7"') && db.includes(b.taskId) && db.includes('"KOOKR_OPENCODE_ISSUE":"9"')
      && !pa.includes(b.taskId) && a.session !== b.session && hookEvents(a.session).length > 0 && hookEvents(b.session).length > 0,
    `sessionDirs=${dirs.length}; hook files: ${a.session}.jsonl(${hookEvents(a.session).length}) ${b.session}.jsonl(${hookEvents(b.session).length})`);
  const agentsMd = da ? readFileSync(join(da, 'cfg', 'AGENTS.md'), 'utf8') : '';
  record('profile instructions reached the session (AGENTS.md)', agentsMd.includes('focused implementation worker'), `AGENTS.md ${agentsMd.length} bytes`);

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
// Phase 2: resume + the `reviewer` and `test-auditor` profiles (all through the isolated server).
// ---------------------------------------------------------------------------------------------------
const MARK_REVIEW = 'MARKER-REVIEW-4F2A';
const MARK_FMA = 'MARKER-FMA-9C1D';
const MARK_AUDIT = 'MARKER-AUDIT-7B3E';
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

const STATS_V1 = `'use strict';
// Rolling statistics used by the daily report.
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
module.exports = { mean };
`;
const STATS_V2 = `'use strict';
// Rolling statistics used by the daily report.
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Every full window of \`size\` consecutive values. */
function rollingWindows(values, size) {
  const windows = [];
  const current = [];
  for (const v of values) {
    current.push(v);
    if (current.length > size) current.shift();
    if (current.length === size) windows.push(current);
  }
  return windows;
}

function rollingMeans(values, size) {
  return rollingWindows(values, size).map(mean);
}
module.exports = { mean, rollingWindows, rollingMeans };
`;
const REPORT_JS = `'use strict';
const { rollingMeans } = require('./stats.js');
// Daily report: 3-day moving average of the sales series.
function movingAverage(sales) {
  return rollingMeans(sales, 3);
}
module.exports = { movingAverage };
`;

function makeReviewerFixture(): { cwd: string; bugLine: number } {
  const v1 = { 'src/stats.js': STATS_V1, 'package.json': '{ "name": "report", "version": "1.0.0" }\n' };
  const r = makeRepo('rev', [v1, { 'src/stats.js': STATS_V2, 'src/report.js': REPORT_JS }]);
  // PR.diff = the "recently merged PR" (commit 2 relative to commit 1), committed so the tree stays clean.
  writeFileSync(join(r.cwd, 'PR.diff'), `Merged PR #41: add rolling mean to the daily report\n\n${git(r.cwd, 'diff', 'HEAD~1', 'HEAD')}`);
  git(r.cwd, 'add', '-A');
  git(r.cwd, 'commit', '-qm', 'add PR.diff for review');
  const bugLine = STATS_V2.split('\n').findIndex((l) => l.includes('windows.push(current)')) + 1;
  return { cwd: r.cwd, bugLine };
}

const PAGINATE_JS = `'use strict';
function paginate(items, page, pageSize) {
  if (pageSize < 1) throw new RangeError('pageSize must be >= 1');
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages: Math.ceil(items.length / pageSize),
    hasNext: start + pageSize < items.length,
  };
}
function clampPage(page, totalPages) {
  return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}
module.exports = { paginate, clampPage };
`;
const PAGINATE_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../src/paginate.js');
test('first page', () => assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 1, 2).items, [1, 2]));
`;
const PAGINATE_MUTATIONS: Array<[string, string]> = [
  ['hasNext uses <', 'start + pageSize < items.length|start + pageSize <= items.length'],
  ['totalPages rounds up', 'Math.ceil(items.length / pageSize)|Math.floor(items.length / pageSize)'],
  ['pageSize guard boundary', 'pageSize < 1|pageSize < 0'],
  ['clampPage lower bound', 'Math.max(page, 1)|Math.max(page, 0)'],
  ['clampPage empty list', 'Math.max(totalPages, 1)|totalPages'],
];

function makeAuditorFixture(): { cwd: string } {
  const r = makeRepo('aud', [{
    'src/paginate.js': PAGINATE_JS,
    'test/paginate.test.js': PAGINATE_TEST,
    'package.json': '{ "name": "pager", "version": "1.0.0", "scripts": { "test": "node --test" } }\n',
  }]);
  return { cwd: r.cwd };
}

const tasksList = async (): Promise<Rec[]> => (await api('GET', '/api/tasks')).json as Rec[];
const taskOf = async (id: string): Promise<Rec | undefined> => (await tasksList()).find((t) => t.id === id);
const sessionsOf = async (id: string): Promise<string[]> => ((await taskOf(id))?.sessions ?? []).map((x: Rec) => x.tmuxSession);
const tally = (ev: Rec[]): Record<string, number> => ev.reduce((m: Record<string, number>, e) => { m[e.hook_event_name] = (m[e.hook_event_name] ?? 0) + 1; return m; }, {});
const gateBlocks = (ev: Rec[]): number => ev.filter((e) => e.hook_event_name === 'UserPromptSubmit' && /Deliverable gate \(\d\/\d\)/.test(String(e.prompt ?? ''))).length;
const sessionDirOf = (session: string): string | undefined => sessDirs().map((d) => join(tmpdir(), d)).find((d) => d.includes(session));
const agentsMdOf = (session: string): string => { const d = sessionDirOf(session); return d && existsSync(join(d, 'cfg', 'AGENTS.md')) ? readFileSync(join(d, 'cfg', 'AGENTS.md'), 'utf8') : ''; };
const dataRoot = (): string => join(home, `.kookr-${port}`, 'opencode-data');
const dbOf = (taskId: string): string => join(dataRoot(), taskId, 'data', 'opencode', 'opencode.db');
const stopped = async (taskId: string): Promise<boolean> => (await sessionsOf(taskId)).length > 0 && ocProcs().every((l) => !l.includes(taskId));

async function launchProfile(profile: string, cwd: string, prompt: string): Promise<{ taskId: string; session: string }> {
  const r = await api('POST', '/api/tasks', { prompt, cwd, agentType: 'opencode', profile });
  if (r.status !== 201 && r.status !== 200) throw new Error(`launch ${profile}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
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

async function mainProfiles(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  // Profile-scoped notebook shelves: each profile must only see its OWN shelves' lessons.
  nbRun('add', 'code-review', `${MARK_REVIEW}: check whether a collection pushed inside a loop is the same object each time.`);
  nbRun('add', 'failure-mode-analyst', `${MARK_FMA}: state shared across iterations is a classic hidden failure.`);
  nbRun('add', 'test-quality-reviewer', `${MARK_AUDIT}: pin boundaries with exact values, not just does-not-throw.`);

  const rev = makeReviewerFixture();
  const aud = makeAuditorFixture();
  const resumeRepo = makeRepo('res', [{ 'README.md': '# resume probe\n', 'package.json': '{ "name": "res", "version": "1.0.0" }\n' }]);

  const revPrompt = 'Review the recently merged change described by PR.diff in this repository. '
    + 'Before doing anything else, tell me your review plan in chat as 3 short bullets and then END YOUR TURN right there: '
    + 'do not create or edit any file yet and do not run any tool.';
  const audPrompt = 'Audit the tests of src/paginate.js (run them with `npm test`). Follow your profile.';
  const resPrompt = `The secret codename for this task is ${CODENAME}. Never write the codename into any file. `
    + 'Create REVIEW.md at the repo root containing exactly the line "resume probe: nothing to review", then say done.';

  const [R, V, T] = await Promise.all([
    launchProfile('reviewer', resumeRepo.cwd, resPrompt),
    launchProfile('reviewer', rev.cwd, revPrompt),
    launchProfile('test-auditor', aud.cwd, audPrompt),
  ]);
  record('phase 2: reviewer x2 + test-auditor launch concurrently', new Set([R.session, V.session, T.session]).size === 3,
    `resume=${R.taskId.slice(0, 8)}/${R.session} reviewer=${V.taskId.slice(0, 8)}/${V.session} auditor=${T.taskId.slice(0, 8)}/${T.session}`);

  // Memory scoping, read while the sessions run (their dirs are removed on stop).
  await sleep(1500);
  const amV = agentsMdOf(V.session), amT = agentsMdOf(T.session);
  record('profile-scoped shelf lessons: reviewer sees code-review + failure-mode-analyst only',
    amV.includes(MARK_REVIEW) && amV.includes(MARK_FMA) && !amV.includes(MARK_AUDIT) && !amV.includes('Run the failing test first'),
    `AGENTS.md ${amV.length}B: review=${amV.includes(MARK_REVIEW)} fma=${amV.includes(MARK_FMA)} audit=${amV.includes(MARK_AUDIT)} patch-author=${amV.includes('Run the failing test first')}`);
  record('profile-scoped shelf lessons: test-auditor sees test-quality-reviewer only',
    amT.includes(MARK_AUDIT) && !amT.includes(MARK_REVIEW) && !amT.includes(MARK_FMA) && !amT.includes('Run the failing test first'),
    `AGENTS.md ${amT.length}B: audit=${amT.includes(MARK_AUDIT)} review=${amT.includes(MARK_REVIEW)} fma=${amT.includes(MARK_FMA)} patch-author=${amT.includes('Run the failing test first')}`);

  const flowResume = async (): Promise<void> => {
  // ----- Resume: stage 1 (the agent finishes), then abort and reopen -----
  const r1 = await settled(R.session, 12_000, 300_000);
  const reviewMdPath = join(resumeRepo.cwd, 'REVIEW.md');
  await waitFor(async () => (await taskOf(R.taskId))?.pendingSignal?.kind === 'completion_ready' || (await taskOf(R.taskId))?.stuckReason === 'awaiting_completion_ack', 60_000);
  const rEv1 = hookEvents(R.session);
  record('[resume] stage 1: agent created REVIEW.md and finished', r1 && existsSync(reviewMdPath),
    `settled=${r1} REVIEW.md=${existsSync(reviewMdPath) ? JSON.stringify(readFileSync(reviewMdPath, 'utf8').trim()) : 'missing'} events=${JSON.stringify(tally(rEv1))}`);
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
  record('[resume] resumed session re-composed config (plugin/hooks env/AGENTS.md) and delivered NO new initial prompt',
    ev2.some((e) => e.hook_event_name === 'SessionStart') && !ev2.some((e) => e.hook_event_name === 'UserPromptSubmit')
      && agentsMdOf(session2).includes(MARK_REVIEW) && sessionDirPlugin(sessionDirOf(session2)).includes(R.taskId),
    `events before follow-up=${JSON.stringify(tally(ev2))} AGENTS.md=${agentsMdOf(session2).length}B`);

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
  const flowReviewer = async (): Promise<void> => {
  // ----- Reviewer -----
  const vSettled = await settled(V.session, 12_000, 360_000);
  const vEv = hookEvents(V.session);
  const blocks = gateBlocks(vEv);
  const gatePrompts = vEv.filter((e) => e.hook_event_name === 'UserPromptSubmit' && /Deliverable gate/.test(String(e.prompt ?? ''))).map((e) => String(e.prompt).slice(0, 160).replace(/\n/g, ' '));
  const reviewPath = join(rev.cwd, 'REVIEW.md');
  const review = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '';
  const lineRefs = [...review.matchAll(/stats\.js[:#L\s]*(\d+)(?:\s*[-\u2013]\s*L?(\d+))?/g)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])] as const);
  const status = git(rev.cwd, 'status', '--porcelain').trim();
  const tV = (await taskOf(V.taskId)) ?? {};
  record('[reviewer] deliverable gate fired: first Stop rejected (REVIEW.md missing), worker then wrote it',
    blocks >= 1 && existsSync(reviewPath),
    `gateBlocks=${blocks} (honest record: ${blocks >= 1 ? 'the gate DID fire' : 'the gate did NOT fire; the worker wrote REVIEW.md before its first Stop'}) settled=${vSettled}\n${gatePrompts.join('\n')}`);
  record('[reviewer] REVIEW.md names the planted bug (stats.js:line) and mentions the shared/aliased window array',
    lineRefs.some(([lo, hi]) => rev.bugLine >= lo - 1 && rev.bugLine <= hi + 1) && /same (array|object)|alias|shared|reference|mutat/i.test(review),
    `planted line=${rev.bugLine}; refs in REVIEW.md=${JSON.stringify(lineRefs)}\n${review.split('\n').filter((l) => /stats\.js/.test(l)).slice(0, 3).join('\n')}`);
  record('[reviewer] source files NOT modified (git status clean except REVIEW.md)', status === '?? REVIEW.md' && git(rev.cwd, 'diff', '--stat').trim() === '',
    `git status --porcelain: ${JSON.stringify(status)}`);
  const msgV = await api('POST', `/api/agents/${V.session}/message`, { input: 'Follow-up: also write the single word ACK-REV into FOLLOWUP.txt (untracked is fine), then say done.' });
  const fu = await waitFor(() => existsSync(join(rev.cwd, 'FOLLOWUP.txt')), 180_000);
  const peekV = peek(V.taskId);
  await settled(V.session, 8_000, 60_000);
  const vEvFinal = hookEvents(V.session);
  const tV2 = (await taskOf(V.taskId)) ?? {};
  await api('POST', `/api/tasks/${V.taskId}/complete`, {});
  await waitFor(async () => ((await taskOf(V.taskId))?.tokenUsage?.inputTokens ?? 0) > 0, 40_000);
  const tV3 = (await taskOf(V.taskId)) ?? {};
  record('[reviewer] profile summary (task, hook counts, gate blocks, usage, completion-ready)',
    (tV3.tokenUsage?.inputTokens ?? 0) > 0 && !!vEvFinal.length,
    `task=${V.taskId} events=${JSON.stringify(tally(vEvFinal))} gateBlocks=${gateBlocks(vEvFinal)} usage=${JSON.stringify(tV3.tokenUsage)}\n`
      + `completion-ready before follow-up: pendingSignal=${JSON.stringify(tV.pendingSignal)?.slice(0, 120)} stuckReason=${tV.stuckReason ?? '-'}; after: stuckReason=${tV2.stuckReason ?? '-'}`);
  record('[reviewer] POST /api/agents/:id/message follow-up executed; kookr peek works',
    msgV.status === 200 && fu && peekV.status === 0 && peekV.out.includes(V.taskId),
    `message=${msgV.status} FOLLOWUP.txt=${fu ? JSON.stringify(readFileSync(join(rev.cwd, 'FOLLOWUP.txt'), 'utf8').trim()) : 'missing'}\npeek exit=${peekV.status}: ${peekV.out.slice(0, 500).replace(/\n/g, ' ')}`);

  };
  const flowAuditor = async (): Promise<void> => {
  // ----- Test auditor -----
  const tSettled = await settled(T.session, 12_000, 360_000);
  const tEv = hookEvents(T.session);
  const auditMd = join(aud.cwd, 'AUDIT.md');
  const untracked = git(aud.cwd, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const newTests = untracked.filter((f) => /\.test\.[cm]?js$/.test(f) && f !== 'test/paginate.test.js');
  const run = spawnSync('npm', ['test'], { cwd: aud.cwd, encoding: 'utf8' });
  const srcDirty = git(aud.cwd, 'status', '--porcelain', '--', 'src').trim() + git(aud.cwd, 'diff', '--stat').trim();
  record('[test-auditor] AUDIT.md and new test files exist', tSettled && existsSync(auditMd) && newTests.length > 0,
    `AUDIT.md=${existsSync(auditMd) ? readFileSync(auditMd, 'utf8').length + 'B' : 'missing'} new tests=${JSON.stringify(newTests)} settled=${tSettled}`);
  record('[test-auditor] new tests pass on the current code (ran npm test) and src/ + existing tests are unmodified', run.status === 0 && srcDirty === '',
    `npm test exit=${run.status}; ${run.stdout.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' ')}; git status/diff for src: ${JSON.stringify(srcDirty)}`);
  // Mutation check: do the NEW tests actually fail under plausible bugs?
  const killed: string[] = []; const survived: string[] = [];
  for (const [label, spec] of PAGINATE_MUTATIONS) {
    const [from, to] = spec.split('|');
    const mdir = mkdtempSync(join(work, 'mut-'));
    mkdirSync(join(mdir, 'src'), { recursive: true }); mkdirSync(join(mdir, 'test'), { recursive: true });
    writeFileSync(join(mdir, 'src/paginate.js'), PAGINATE_JS.replace(from!, to!));
    for (const f of newTests) { mkdirSync(join(mdir, f, '..'), { recursive: true }); writeFileSync(join(mdir, f), readFileSync(join(aud.cwd, f))); }
    const r = spawnSync(process.execPath, ['--test', ...newTests], { cwd: mdir, encoding: 'utf8' });
    (r.status === 0 ? survived : killed).push(label);
  }
  record('[test-auditor] new tests catch plausible mutations of the module (mutation check, informational >= 1 killed)', killed.length >= 1,
    `killed ${killed.length}/${PAGINATE_MUTATIONS.length}: ${JSON.stringify(killed)} survived: ${JSON.stringify(survived)}`);
  const peekT = peek(T.taskId);
  const msgT = await api('POST', `/api/agents/${T.session}/message`, { input: 'Follow-up: also write the single word ACK-AUD into FOLLOWUP.txt (untracked is fine), then say done.' });
  const fuT = await waitFor(() => existsSync(join(aud.cwd, 'FOLLOWUP.txt')), 180_000);
  await settled(T.session, 8_000, 60_000);
  const tEvFinal = hookEvents(T.session);
  const tT = (await taskOf(T.taskId)) ?? {};
  const usageT = await readOpenCodeDataHomeUsage(join(dataRoot(), T.taskId, 'data'));
  record('[test-auditor] profile summary (task, hook counts, gate blocks, usage, completion-ready)',
    usageT.kind === 'ok' && tEvFinal.length > 0,
    `task=${T.taskId} events=${JSON.stringify(tally(tEvFinal))} gateBlocks=${gateBlocks(tEvFinal)} (events at settle: ${tEv.length})\n`
      + `usage (read from the task's persistent opencode DB before DELETE) = ${JSON.stringify(usageT.kind === 'ok' ? usageT.usage : usageT)}\n`
      + `completion-ready: pendingSignal=${JSON.stringify(tT.pendingSignal)?.slice(0, 120)} stuckReason=${tT.stuckReason ?? '-'}`);
  record('[test-auditor] POST /api/agents/:id/message follow-up executed; kookr peek works',
    msgT.status === 200 && fuT && peekT.status === 0 && peekT.out.includes(T.taskId),
    `message=${msgT.status} FOLLOWUP.txt=${fuT ? 'present' : 'missing'}\npeek exit=${peekT.status}: ${peekT.out.slice(0, 500).replace(/\n/g, ' ')}`);

  };
  await Promise.all([flowResume(), flowReviewer(), flowAuditor()]);

  // ----- DELETE (live session) removes the task and, after the post-stop sweep, its persistent data -----
  const dirT = join(dataRoot(), T.taskId);
  const dirR = join(dataRoot(), R.taskId);
  const dirV = join(dataRoot(), V.taskId);
  const keptBefore = existsSync(dirT);
  const del = await api('DELETE', `/api/tasks/${T.taskId}`);
  const gone = await waitFor(() => !existsSync(dirT), 60_000);
  record('DELETE /api/tasks/:id works and the deleted task\'s persistent opencode data is removed (retention sweep)',
    del.status === 200 && keptBefore && gone && (await taskOf(T.taskId)) === undefined,
    `delete=${del.status} dataDirBefore=${keptBefore} removedAfter=${gone} task404=${(await taskOf(T.taskId)) === undefined}`);
  record('completed tasks keep their persistent data for the reopen grace period (default 24 h) and disk use is bounded',
    existsSync(dirR) && existsSync(dirV),
    `kept: resume task=${existsSync(dirR)} reviewer task=${existsSync(dirV)}; root=${dataRoot()} entries=${JSON.stringify(readdirSync(dataRoot()).map((d) => d.slice(0, 8)))}`);
  await sleep(3000);
  record('phase 2: no opencode process or session dir remains', ocProcs().length === 0 && sessDirs().length === 0,
    `leftover=${JSON.stringify(ocProcs())} leftoverDirs=${JSON.stringify(sessDirs())}`);
}

void (async () => {
try {
  await main();
  await mainProfiles();
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
