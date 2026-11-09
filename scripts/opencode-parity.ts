/**
 * PARITY + SCALE harness for the opencode agent, through a real ISOLATED Kookr server (NOT part of `pnpm test`).
 *
 *   set -a; . ~/hermes-sandbox/data/deepinfra.env; set +a      # OPENAI_API_KEY (+ OPENAI_BASE_URL)
 *   node --import tsx scripts/opencode-parity.ts                         # all 6 replay cases, sequentially
 *   node --import tsx scripts/opencode-parity.ts --case agent-notebook-273
 *   node --import tsx scripts/opencode-parity.ts --scale 4 [--case agent-notebook-273]
 *   node --import tsx scripts/opencode-parity.ts --grade-only [--case ...]   # (re)run bake-off grade.sh only
 *
 * Parity: per case, a fresh hermetic server (temp HOME, free port, rebuilt env, port-scoped dtach namespace,
 * KOOKR_PR_LINT_CMD = per-case wrapper around pr-body-lint.sh) runs ONE `scoped-fix` opencode task whose cwd is a
 * fresh no-remote clone at the replay base commit on branch `work/issue-N`; the prompt is the exact bake-off replay
 * prompt with the container path `/w` rewritten to the clone path. It samples the process tree every 2 s,
 * collects hook/gate/usage data, writes the bake-off result dir (report.json, numstat.txt, committed.patch,
 * PR_BODY.md, mem.csv), then runs bakeoff/grade.sh. Scale: N concurrent tasks (same case, N clones) on one server.
 *
 * It only kills the server PID it spawned, never pkills by name, never touches ~/.kookr or port 4800.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const REPO = resolve(__dirname, '..');
const HERMES = process.env.KOOKR_PARITY_HERMES_DIR ?? join(homedir(), 'hermes-sandbox');
const BAKEOFF = `${HERMES}/shadow-run/bakeoff`;
const LINT = `${HERMES}/bin/pr-body-lint.sh`;
const OPENCODE_BIN = process.env.KOOKR_OPENCODE_BIN ?? join(homedir(), '.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode');
const HARD_TIMEOUT_MS = 40 * 60_000;
const SAMPLE_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Rec = Record<string, any>;

interface CaseDef { slug: string; issue: number; base: string; fixpr: number }
const CASES: Record<string, CaseDef> = {
  'agent-notebook-90': { slug: 'jeanibarz/agent-notebook', issue: 90, base: 'ebb914214f6f03f1c6f8d6671669bfe4af741b05', fixpr: 92 },
  'agent-notebook-273': { slug: 'jeanibarz/agent-notebook', issue: 273, base: 'ed9a88fa3c453fd34c7959587253142fdeb5322f', fixpr: 298 },
  'agent-notebook-300': { slug: 'jeanibarz/agent-notebook', issue: 300, base: '2be1bdd44cf7b9347435339f9da56879dc4d0287', fixpr: 322 },
  'lucy-3265': { slug: 'jeanibarz/lucy', issue: 3265, base: '86498cc420c253211598a7ef8faf17eb1e997dbf', fixpr: 3268 },
  'knowledge-base-mcp-server-1165': { slug: 'jeanibarz/knowledge-base-mcp-server', issue: 1165, base: '8fc4729281c66fb7dd0c2715607094057541c386', fixpr: 1166 },
  'lucy-3315': { slug: 'jeanibarz/lucy', issue: 3315, base: '9e98fd24a003c9cdd6662abed0990fe7c46170eb', fixpr: 3324 },
};

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const SCALE = Number(flag('--scale') ?? 0);
const GRADE_ONLY = argv.includes('--grade-only');
const NO_GRADE = argv.includes('--no-grade');
const caseArg = flag('--case');
const caseKeys = caseArg ? caseArg.split(',') : SCALE ? ['agent-notebook-273'] : Object.keys(CASES);
for (const k of caseKeys) if (!CASES[k]) { console.error(`unknown case ${k}`); process.exit(2); }

const resultName = (k: string) => `${CASES[k]!.slug.split('/')[1]}-${CASES[k]!.issue}-opencode-kookr`;
const resultDir = (k: string) => `${BAKEOFF}/results/${resultName(k)}`;
const DOCS_DATA = join(REPO, 'docs/reports/opencode-parity-data');

async function gradeCase(k: string): Promise<void> {
  const c = CASES[k]!;
  console.log(`[grade] ${resultName(k)}`);
  const r = spawnSync('bash', [`${BAKEOFF}/grade.sh`, resultName(k), c.slug, c.base, String(c.fixpr)], { encoding: 'utf8', timeout: 25 * 60_000 });
  console.log((r.stdout || '').trim().slice(-400), (r.stderr || '').trim().slice(-300));
  for (const f of ['verdict.txt', 'grade.json']) {
    const src = join(resultDir(k), f);
    if (existsSync(src)) { mkdirSync(join(DOCS_DATA, resultName(k)), { recursive: true }); copyFileSync(src, join(DOCS_DATA, resultName(k), f)); }
  }
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const gitSoft = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};
const num = (f: string, re: RegExp): number => Number(readFileSync(f, 'utf8').match(re)?.[1] ?? 0);

// ---------------------------------------------------------------- process sampling
interface Proc { pid: number; ppid: number; rssKb: number; comm: string; args: string; cwd: string; ticks: number }
function scanProcs(): Proc[] {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,rss=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const out: Proc[] = [];
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let cwd = '';
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone / not ours */ }
    let ticks = 0;
    try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); ticks = Number(f[11]) + Number(f[12]); } catch { /* gone */ }
    out.push({ pid, ppid: Number(m[2]), rssKb: Number(m[3]), comm: m[4]!, args: m[5]!, cwd, ticks });
  }
  return out;
}
function pssKb(pid: number): number {
  try { return num(`/proc/${pid}/smaps_rollup`, /^Pss:\s+(\d+)/m); } catch { return 0; }
}
/** Processes belonging to a task: cwd inside its clone, plus all their descendants. */
function attribute(all: Proc[], clone: string): Proc[] {
  const mine = new Map<number, Proc>();
  for (const p of all) if (p.cwd === clone || p.cwd.startsWith(`${clone}/`)) mine.set(p.pid, p);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.set(p.pid, p); grew = true; }
  }
  return [...mine.values()];
}
const isWrapper = (p: Proc) => /^(sh|bash|dash)$/.test(p.comm) && / -c /.test(p.args);
const isDtach = (p: Proc) => p.comm === 'dtach';
const isHarness = (p: Proc) => /(^|\/)\.?opencode( |$)/.test(p.args) || /^\.?opencode/.test(p.comm) || /\.bin\/opencode/.test(p.args);

// ---------------------------------------------------------------- server
interface Server { proc: ChildProcess; port: number; home: string; work: string; log: () => string; api: (m: string, p: string, b?: unknown) => Promise<{ status: number; json: any }> }
async function startServer(work: string, lintCmd: string, debugFile: string): Promise<Server> {
  const home = join(work, 'home');
  const nbDir = join(work, 'nb');
  mkdirSync(home, { recursive: true });
  mkdirSync(nbDir, { recursive: true });
  execFileSync(process.execPath, [join(REPO, 'bin/nb.js'), 'add', 'patch-author', 'Run the failing test first; fix the root cause, not the test.'],
    { env: { PATH: process.env.PATH ?? '', HOME: home, NB_DIR: nbDir } });
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
    KOOKR_PORT: String(port), KOOKR_HOST: '127.0.0.1',
    KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '1',
    KOOKR_HOST_STALE_DTACH_REAP: '0', // host-wide reaper: must never see other agents' dtach masters
    KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE: '0',
    KOOKR_OPENCODE_ENABLED: '1', // opt-in flag: the agent is not registered without it
    KOOKR_OPENCODE_SEED_DIR: join(work, 'seed'), // never write the seed under the real ~/.kookr
    KOOKR_OPENCODE_BIN: OPENCODE_BIN,
    KOOKR_OPENCODE_PLUGIN_DEBUG: debugFile,
    KOOKR_PR_LINT_CMD: lintCmd,
    NB_DIR: nbDir,
  };
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout!.on('data', (d) => { log += d; });
  proc.stderr!.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = text; try { json = JSON.parse(text); } catch { /* keep */ }
    return { status: res.status, json };
  };
  const end = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > end || proc.exitCode !== null) throw new Error(`server did not boot: ${log.slice(-1500)}`);
    await sleep(1000);
  }
  return { proc, port, home, work, log: () => log, api };
}
async function stopServer(s: Server): Promise<void> {
  if (!s.proc.pid) return;
  s.proc.kill('SIGTERM'); // only the PID we spawned
  for (let i = 0; i < 10 && s.proc.exitCode === null; i++) await sleep(500);
  if (s.proc.exitCode === null) s.proc.kill('SIGKILL');
}

// ---------------------------------------------------------------- per-task fixture
interface Task {
  idx: number; key: string; def: CaseDef; clone: string; taskId: string; session: string; launchedAt: number; launchOk: boolean; launchErr?: string;
  firstHookAt?: number; firstHookSec?: number; state: 'launching' | 'running' | 'done' | 'failed';
  doneReason?: string; doneAt?: number; signalAt?: number; lastEventCount: number; lastEventChange: number;
  mem: string[]; peakHarness: number; peakOther: number; peakTotal: number; peakPss: number; peakNOther: number; peakProcs: number;
  gateBlocksSeen: number; sessionDir?: string; throttleHits: string[]; apiErrorCount: number; metrics?: Rec; usage?: Rec; taskRec?: Rec; wallSec?: number; completedHttp?: number;
  hookEvents: Rec[];
}

function prepareClone(work: string, key: string, idx: number, cache: string): { clone: string; promptPath: string } {
  const def = CASES[key]!;
  const clone = join(work, 'clones', `${key}-${idx}`);
  mkdirSync(join(work, 'clones'), { recursive: true });
  git(cache, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--local', cache, clone]);
  git(clone, 'checkout', '-q', def.base);
  spawnSync('git', ['-C', clone, 'remote', 'remove', 'origin']);
  git(clone, 'checkout', '-q', '-b', `work/issue-${def.issue}`);
  git(clone, 'config', 'user.name', 'bakeoff-worker');
  git(clone, 'config', 'user.email', 'bakeoff-worker@localhost');
  const short = def.slug.split('/')[1]!;
  const original = readFileSync(`${BAKEOFF}/results/${short}-${def.issue}-opencode/prompt.md`, 'utf8');
  const rewritten = original.replace(/(?<![\w/.-])\/w(?![\w-])/g, clone);
  const prompt = `NOTE: your working directory is ${clone} (the checkout described below as /w). Work only there.\n\n${rewritten}`;
  const promptPath = join(work, 'prompts', `${key}-${idx}.md`);
  mkdirSync(join(work, 'prompts'), { recursive: true });
  writeFileSync(promptPath, prompt);
  return { clone, promptPath };
}

const THROTTLE_RE = /"statusCode":\s*429|status(?:_code)?[ =:]+429|too many requests|rate_limit_exceeded|overloaded_error|APIError/i;
/**
 * Throttle / API-error evidence. Only structured markers are counted (a bare "rate limit" or "overloaded" also
 * appears in repo code and in the replay prompt, which the opencode db stores verbatim): HTTP 429 status fields,
 * "Too Many Requests", `APIError` error objects, retry statuses. Searched in the session's db/log files and the server log.
 */
function grepSessionDirForThrottle(dir: string | undefined, serverLog: string): { hits: string[]; apiErrors: number } {
  const hits: string[] = [];
  let apiErrors = 0;
  if (dir && existsSync(dir)) {
    const pat = '"statusCode":[ ]*429|"status_code":[ ]*429|Too Many Requests|rate_limit_exceeded|overloaded_error|"name":"APIError"|"type":"retry"|isRetryable":true';
    const r = spawnSync('grep', ['-raoE', '--include=*.db', '--include=*.db-wal', '--include=*.log', pat, dir], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000 });
    const lines = (r.stdout || '').split('\n').filter(Boolean);
    apiErrors = lines.length;
    for (const l of lines.slice(0, 10)) hits.push(l.slice(0, 220));
  }
  for (const l of serverLog.split('\n')) if (THROTTLE_RE.test(l)) hits.push(`serverlog: ${l.slice(0, 200)}`);
  return { hits, apiErrors };
}

// ---------------------------------------------------------------- run N tasks on one server
interface RunOpts { label: string; tasks: Array<{ key: string }>; keepArtifacts: boolean }
async function runTasks(opts: RunOpts): Promise<{ tasks: Task[]; hostSamples: string[]; serverPid: number; port: number; work: string }> {
  const work = mkdtempSync(join(tmpdir(), 'oc-parity-'));
  const debugFile = join(work, 'plugin-debug.jsonl');
  const keys = [...new Set(opts.tasks.map((t) => t.key))];
  // one pristine GitHub clone per distinct case, then cheap local clones per task
  const caches = new Map<string, string>();
  for (const k of keys) {
    const cache = join(work, 'cache', k);
    mkdirSync(join(work, 'cache'), { recursive: true });
    execFileSync('git', ['clone', '-q', `https://github.com/${CASES[k]!.slug}.git`, cache], { stdio: 'inherit' });
    git(cache, 'checkout', '-q', CASES[k]!.base);
    caches.set(k, cache);
  }
  // PR lint wrapper: hardcodes the base and resolves the repo from $PWD (the gate runs lint with cwd = the clone;
  // in a one-case run this is exactly that clone). KOOKR_PR_LINT_CMD is server-wide, so one wrapper per run.
  const lintBase = CASES[keys[0]!]!.base;
  const wrapper = join(work, 'pr-lint-wrapper.sh');
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec ${LINT} "$1" --repo "$PWD" --base ${lintBase}\n`);
  chmodSync(wrapper, 0o755);
  if (keys.length > 1) throw new Error('one server run supports a single case (lint wrapper hardcodes the base)');

  const server = await startServer(work, `${wrapper} {pr_body}`, debugFile);
  console.log(`[${opts.label}] server pid=${server.proc.pid} port=${server.port} work=${work}`);
  const tasks: Task[] = [];
  const hostSamples: string[] = ['t,mem_available_mb,load1,host_cpu_pct,workers_cpu_cores,n_active_tasks,n_procs,total_rss_mb,total_pss_mb,harness_rss_mb,other_rss_mb'];
  const t0 = Date.now();
  try {
    for (let i = 0; i < opts.tasks.length; i++) {
      const key = opts.tasks[i]!.key;
      const { clone, promptPath } = prepareClone(work, key, i, caches.get(key)!);
      tasks.push({
        idx: i, key, def: CASES[key]!, clone, taskId: '', session: '', launchedAt: 0, launchOk: false, state: 'launching', lastEventCount: 0, lastEventChange: Date.now(),
        mem: ['t,cg_current_mb,cg_peak_mb,harness_rss_mb,other_rss_mb,n_other'], peakHarness: 0, peakOther: 0, peakTotal: 0, peakPss: 0, peakNOther: 0, peakProcs: 0,
        gateBlocksSeen: 0, throttleHits: [], apiErrorCount: 0, hookEvents: [],
      });
      (tasks[i] as any).promptPath = promptPath;
    }
    // launch all concurrently (sequential POSTs back to back; the server queues/admits)
    for (const t of tasks) {
      const prompt = readFileSync((t as any).promptPath, 'utf8');
      t.launchedAt = Date.now();
      try {
        const r = await server.api('POST', '/api/tasks', { prompt, cwd: t.clone, agentType: 'opencode', profile: 'scoped-fix', issue: t.def.issue });
        if (r.status === 200 || r.status === 201) { t.taskId = r.json.id; t.launchOk = true; t.state = 'running'; }
        else { t.launchErr = `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`; t.state = 'failed'; t.doneReason = 'launch_failed'; }
      } catch (e) { t.launchErr = String(e); t.state = 'failed'; t.doneReason = 'launch_failed'; }
      console.log(`[${opts.label}] launch #${t.idx} -> ${t.launchOk ? t.taskId : t.launchErr}`);
    }

    const dataDir = join(server.home, `.kookr-${server.port}`);
    const hookFile = (s: string) => join(dataDir, 'hooks', `${s}.jsonl`);
    let prevCpu: number[] | undefined; let prevWorkerTicks = 0; let prevTime = Date.now();
    const hz = 100;
    const lastSnapshotProcs = new Map<number, number>();
    for (;;) {
      const now = Date.now();
      const running = tasks.filter((t) => t.state === 'running');
      if (!running.length && tasks.every((t) => t.state !== 'launching')) break;

      // --- API state
      let list: Rec[] = [];
      try { list = (await server.api('GET', '/api/tasks')).json as Rec[]; } catch { /* transient */ }
      for (const t of running) {
        const rec = list.find((x) => x.id === t.taskId);
        if (rec) {
          t.taskRec = rec;
          if (!t.session) { t.session = rec.sessions?.[0]?.tmuxSession ?? ''; }
        }
        if (t.session) {
          const hp = hookFile(t.session);
          if (existsSync(hp)) {
            const lines = readFileSync(hp, 'utf8').trim().split('\n').filter(Boolean);
            if (lines.length !== t.lastEventCount) { t.lastEventCount = lines.length; t.lastEventChange = now; }
            if (lines.length && !t.firstHookAt) { t.firstHookAt = now; let ts = now; try { ts = Number(JSON.parse(lines[0]!).kookr_hook_written_at_ms) || now; } catch { /* keep poll time */ } t.firstHookSec = Math.round((ts - t.launchedAt) / 100) / 10; }
            t.hookEvents = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
          }
          // session dir (cfg, opencode db, gate counters)
          if (!t.sessionDir) {
            const d = readdirSync(tmpdir()).find((x) => x.startsWith('kookr-opencode-kookr-') && x.includes(t.session));
            if (d) t.sessionDir = join(tmpdir(), d);
          }
          if (t.sessionDir && existsSync(t.sessionDir)) {
            try {
              for (const f of readdirSync(t.sessionDir)) if (/^kookr-opencode-gate-.*\.count$/.test(f)) t.gateBlocksSeen = Math.max(t.gateBlocksSeen, Number(readFileSync(join(t.sessionDir, f), 'utf8')) || 0);
            } catch { /* racing deletion */ }
          }
        }
        const sig = rec?.pendingSignal?.kind === 'completion_ready' || rec?.stuckReason === 'awaiting_completion_ack';
        if (sig && !t.signalAt) t.signalAt = now;
        const lastName = t.hookEvents.at(-1)?.hook_event_name;
        if (t.signalAt && lastName === 'Stop' && now - t.lastEventChange > 8000) { t.state = 'done'; t.doneReason = 'completion_ready'; }
        else if (t.signalAt && now - t.signalAt > 90_000) { t.state = 'done'; t.doneReason = 'completion_ready(late stop)'; }
        else if (!t.signalAt && lastName === 'Stop' && now - t.lastEventChange > 300_000) { t.state = 'done'; t.doneReason = 'idle_no_signal'; }
        else if (now - t.launchedAt > HARD_TIMEOUT_MS) { t.state = 'done'; t.doneReason = 'timeout'; }
        else if (t.launchOk && rec && /^(failed|aborted|completed)/i.test(String(rec.status ?? ''))) { t.state = 'done'; t.doneReason = `task_status_${rec.status}`; }
        if (t.state === 'done') t.doneAt = now;
      }

      // --- process sampling (one scan for everyone)
      const all = scanProcs();
      const rel = Math.round((now - t0) / 1000);
      let totRss = 0, totPss = 0, totH = 0, totO = 0, nProcs = 0, ticks = 0;
      for (const t of tasks.filter((x) => x.launchOk && (x.state === 'running' || (x.state === 'done' && now - (x.doneAt ?? 0) < 1)))) {
        const mine = attribute(all, t.clone).filter((p) => p.pid !== process.pid);
        const h = mine.filter((p) => !isWrapper(p) && !isDtach(p) && isHarness(p));
        const o = mine.filter((p) => !isWrapper(p) && !isDtach(p) && !isHarness(p));
        const harness = h.reduce((a, p) => a + p.rssKb, 0) / 1024;
        const other = o.reduce((a, p) => a + p.rssKb, 0) / 1024;
        const total = mine.reduce((a, p) => a + p.rssKb, 0) / 1024;
        const pss = mine.reduce((a, p) => a + pssKb(p.pid), 0) / 1024;
        t.peakHarness = Math.max(t.peakHarness, harness); t.peakOther = Math.max(t.peakOther, other);
        t.peakTotal = Math.max(t.peakTotal, total); t.peakPss = Math.max(t.peakPss, pss);
        t.peakNOther = Math.max(t.peakNOther, o.length); t.peakProcs = Math.max(t.peakProcs, mine.length);
        t.mem.push(`${Math.round((now - t.launchedAt) / 1000)},${total.toFixed(0)},${t.peakTotal.toFixed(0)},${harness.toFixed(0)},${other.toFixed(0)},${o.length}`);
        totRss += total; totPss += pss; totH += harness; totO += other; nProcs += mine.length;
        ticks += mine.reduce((a, p) => a + p.ticks, 0);
        void lastSnapshotProcs;
      }
      // host
      const memAvail = num('/proc/meminfo', /^MemAvailable:\s+(\d+)/m) / 1024;
      const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
      const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.split(/\s+/).slice(1, 9).map(Number);
      let hostCpu = 0;
      if (prevCpu) {
        const dTot = cpu.reduce((a, b) => a + b, 0) - prevCpu.reduce((a, b) => a + b, 0);
        const dIdle = (cpu[3]! + cpu[4]!) - (prevCpu[3]! + prevCpu[4]!);
        hostCpu = dTot > 0 ? (100 * (dTot - dIdle)) / dTot : 0;
      }
      prevCpu = cpu;
      const dt = (now - prevTime) / 1000; prevTime = now;
      const workerCores = ticks >= prevWorkerTicks && prevWorkerTicks > 0 && dt > 0 ? (ticks - prevWorkerTicks) / hz / dt : 0;
      prevWorkerTicks = ticks;
      hostSamples.push(`${rel},${memAvail.toFixed(0)},${load1},${hostCpu.toFixed(1)},${workerCores.toFixed(2)},${running.length},${nProcs},${totRss.toFixed(0)},${totPss.toFixed(0)},${totH.toFixed(0)},${totO.toFixed(0)}`);

      // --- finalize tasks that just finished (needs the session dir while it still exists)
      for (const t of tasks.filter((x) => x.state === 'done' && !x.metrics)) await finalizeTask(server, t, debugFile, opts.label);
      await sleep(Math.max(100, SAMPLE_MS - (Date.now() - now)));
      void appendFileSync;
    }
  } finally {
    // evidence copy before teardown
    for (const t of tasks) {
      if (t.state === 'running') { try { await server.api('POST', '/api/tasks/abort', { taskIds: [t.taskId], reason: 'harness teardown' }); } catch { /* best effort */ } }
    }
    await stopServer(server);
  }
  const serverPid = server.proc.pid!;
  (tasks as any).debugLines = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
  (tasks as any).serverLog = server.log();
  return { tasks, hostSamples, serverPid, port: server.port, work };
}

async function finalizeTask(server: Server, t: Task, debugFile: string, label: string): Promise<void> {
  const wallSec = Math.round(((t.doneAt ?? Date.now()) - t.launchedAt) / 1000);
  t.wallSec = wallSec;
  // throttle / API-error evidence while the session dir (opencode.db, logs) still exists
  const g = grepSessionDirForThrottle(t.sessionDir, server.log());
  t.throttleHits = g.hits; t.apiErrorCount = g.apiErrors;
  // complete -> usage recorded from the per-session db
  let completeStatus = 0;
  if (t.launchOk) {
    try { completeStatus = (await server.api('POST', `/api/tasks/${t.taskId}/complete`, {})).status; } catch { /* ignore */ }
    t.completedHttp = completeStatus;
    const end = Date.now() + 45_000;
    for (;;) {
      const rec = ((await server.api('GET', '/api/tasks')).json as Rec[]).find((x) => x.id === t.taskId);
      if (rec) t.taskRec = rec;
      if (rec?.tokenUsage?.inputTokens > 0 || Date.now() > end) break;
      await sleep(1500);
    }
  }
  t.usage = t.taskRec?.tokenUsage;
  console.log(`[${label}] #${t.idx} done reason=${t.doneReason} wall=${wallSec}s usage=${JSON.stringify(t.usage)} gateBlocks=${t.gateBlocksSeen} throttle=${t.throttleHits.length}`);
  t.metrics = { finalized: true };
  void debugFile;
}

// ---------------------------------------------------------------- reporting helpers
function hookCounts(events: Rec[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of events) c[e.hook_event_name ?? '?'] = (c[e.hook_event_name ?? '?'] ?? 0) + 1;
  return c;
}
function debugGateBlocks(debugLines: string): number {
  let n = 0;
  for (const l of debugLines.split('\n').filter(Boolean)) {
    try { const j = JSON.parse(l); if (j.hook === 'Stop' && /opencode-gate/.test(String(j.command)) && j.code === 2) n++; } catch { /* skip */ }
  }
  return n;
}
function debugStopHookCodes(debugLines: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const l of debugLines.split('\n').filter(Boolean)) {
    try { const j = JSON.parse(l); if (j.hook === 'Stop') { const k = `${String(j.command).split('/').pop()?.split(' ')[0]?.replace(/[^\w.-]/g, '')}#${j.code}`; c[k] = (c[k] ?? 0) + 1; } } catch { /* skip */ }
  }
  return c;
}

/** Bake-off style result dir for one parity task (shapes copied from run-arm.sh). */
function writeBakeoffResult(t: Task, run: { tasks: Task[]; hostSamples: string[]; serverPid: number; port: number; work: string }): Rec {
  const name = resultName(t.key);
  const R = resultDir(t.key);
  rmSync(R, { recursive: true, force: true });
  mkdirSync(R, { recursive: true });
  const G = (...a: string[]) => gitSoft(t.clone, ...a);
  const BASE = G('rev-parse', t.def.base).trim();
  const commits = Number(G('rev-list', '--count', `${BASE}..HEAD`).trim() || 0);
  const status = G('status', '--porcelain').split('\n').filter((l) => l && !/ PR_BODY\.md$/.test(l)).length;
  const closes = new RegExp(`^closes #${t.def.issue}\\b`, 'im').test(G('log', '--format=%B', `${BASE}..HEAD`));
  writeFileSync(join(R, 'committed.patch'), G('diff', BASE, 'HEAD'));
  const numstat = G('diff', '--numstat', BASE, 'HEAD');
  writeFileSync(join(R, 'numstat.txt'), numstat);
  const body = join(t.clone, 'PR_BODY.md');
  let bodyPresent = false, bodyOk = false, lint = '';
  if (existsSync(body)) {
    copyFileSync(body, join(R, 'PR_BODY.md'));
    bodyPresent = true;
    const r = spawnSync(LINT, [body, '--repo', t.clone, '--base', BASE], { encoding: 'utf8' });
    lint = `${r.stdout}${r.stderr}`.trim();
    bodyOk = r.status === 0;
  }
  let f = 0, ins = 0, dels = 0;
  for (const l of numstat.split('\n')) { const a = l.split('\t'); if (a.length >= 3) { f++; ins += /^\d+$/.test(a[0]!) ? Number(a[0]) : 0; dels += /^\d+$/.test(a[1]!) ? Number(a[1]) : 0; } }
  const exitCode = t.doneReason?.startsWith('completion_ready') ? 0 : t.doneReason === 'timeout' ? 124 : 1;
  const rep = {
    name, commits, committed: commits >= 1, closes_issue: closes, uncommitted_files: status, pr_body_present: bodyPresent, body_ok: bodyOk,
    body_lint: lint.slice(-800), diff: { files: f, ins, dels }, exit: `exit=${exitCode} secs=${t.wallSec}`, delivered: commits >= 1 && bodyOk,
  };
  writeFileSync(join(R, 'report.json'), JSON.stringify(rep, null, 1));
  writeFileSync(join(R, 'mem.csv'), `${t.mem.join('\n')}\n`);
  const dbg = (run.tasks as any).debugLines as string;
  const hooks = t.hookEvents.map((e) => JSON.stringify(e)).join('\n');
  const metrics = {
    task_id: t.taskId, session: t.session, server_pid: run.serverPid, port: run.port, done_reason: t.doneReason, wall_sec: t.wallSec,
    first_hook_sec: t.firstHookSec, hook_event_counts: hookCounts(t.hookEvents), stop_hook_exit_codes_from_plugin_debug: debugStopHookCodes(dbg),
    gate_blocks_plugin_debug: debugGateBlocks(dbg), gate_blocks_counter_file: t.gateBlocksSeen, stop_events: t.hookEvents.filter((e) => e.hook_event_name === 'Stop').length,
    usage: t.usage, task_status: t.taskRec?.status, pending_signal: t.taskRec?.pendingSignal, stuck_reason: t.taskRec?.stuckReason, complete_http: t.completedHttp,
    peak_rss_mb: { harness_tui: Math.round(t.peakHarness), other_tool_children: Math.round(t.peakOther), total_tree: Math.round(t.peakTotal), total_pss: Math.round(t.peakPss), max_n_other_procs: t.peakNOther, max_procs: t.peakProcs },
    throttle_hits: t.throttleHits, api_error_markers: t.apiErrorCount,
    prompt_note: `/w rewritten to ${t.clone}`,
  };
  writeFileSync(join(R, 'kookr-metrics.json'), JSON.stringify(metrics, null, 1));
  writeFileSync(join(R, 'hooks.jsonl.gz'), gzipSync(hooks));
  writeFileSync(join(R, 'plugin-debug.jsonl.gz'), gzipSync(dbg));
  writeFileSync(join(R, 'exit.txt'), `${rep.exit}\n`);
  copyFileSync(String((t as any).promptPath), join(R, 'prompt.kookr.md'));
  // slim copy into the repo docs data dir
  const D = join(DOCS_DATA, name);
  mkdirSync(D, { recursive: true });
  for (const fl of ['report.json', 'kookr-metrics.json', 'mem.csv', 'numstat.txt', 'PR_BODY.md', 'committed.patch', 'hooks.jsonl.gz', 'plugin-debug.jsonl.gz']) if (existsSync(join(R, fl))) copyFileSync(join(R, fl), join(D, fl));
  return { rep, metrics };
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  if (SCALE > 0) {
    const key = caseKeys[0]!;
    const label = `scale${SCALE}`;
    const run = await runTasks({ label, tasks: Array.from({ length: SCALE }, () => ({ key })), keepArtifacts: false });
    const outDir = join(REPO, 'docs/reports/opencode-scale-data');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `scale${SCALE}-host.csv`), `${run.hostSamples.join('\n')}\n`);
    const rows: Rec[] = [];
    for (const t of run.tasks) {
      const w = writeBakeoffScaleTask(t, run, outDir, label);
      rows.push(w);
    }
    const hs = run.hostSamples.slice(1).map((l) => l.split(',').map(Number));
    const col = (i: number) => hs.map((r) => r[i]!);
    const summary = {
      scale: SCALE, case: key, server_pid: run.serverPid, port: run.port,
      peak_total_rss_mb: Math.max(...col(7)), peak_total_pss_mb: Math.max(...col(8)), peak_harness_rss_mb: Math.max(...col(9)), peak_other_rss_mb: Math.max(...col(10)),
      peak_host_cpu_pct: Math.max(...col(3)), mean_host_cpu_pct: col(3).reduce((a, b) => a + b, 0) / Math.max(1, hs.length),
      peak_workers_cpu_cores: Math.max(...col(4)), peak_load1: Math.max(...col(2)),
      mem_available_start_mb: col(1)[0], mem_available_min_mb: Math.min(...col(1)), mem_available_delta_mb: col(1)[0]! - Math.min(...col(1)),
      n_tasks: SCALE, tasks: rows,
    };
    writeFileSync(join(outDir, `scale${SCALE}-summary.json`), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    cleanup(run.work);
    return;
  }
  for (const key of caseKeys) {
    console.log(`\n=== parity case ${key} ===`);
    let run;
    try {
      run = await runTasks({ label: key, tasks: [{ key }], keepArtifacts: true });
    } catch (e) { console.error(`case ${key} failed to run: ${e}`); continue; }
    const t = run.tasks[0]!;
    const { rep, metrics } = writeBakeoffResult(t, run);
    console.log(JSON.stringify({ rep: { delivered: rep.delivered, commits: rep.commits, diff: rep.diff, exit: rep.exit }, metrics: { gate: metrics.gate_blocks_plugin_debug, hooks: metrics.hook_event_counts, usage: metrics.usage, rss: metrics.peak_rss_mb } }));
    cleanup(run.work); // clone + temp HOME (npm cache) + sessions: artifacts already copied
    if (!NO_GRADE) { /* graded after all cases, so docker npm ci does not disturb the next case's RSS samples */ }
  }
  if (!NO_GRADE) for (const k of caseKeys) if (existsSync(join(resultDir(k), 'committed.patch'))) await gradeCase(k);
}

function writeBakeoffScaleTask(t: Task, run: { tasks: Task[]; hostSamples: string[]; serverPid: number; port: number; work: string }, outDir: string, label: string): Rec {
  const G = (...a: string[]) => gitSoft(t.clone, ...a);
  const BASE = G('rev-parse', t.def.base).trim();
  const commits = Number(G('rev-list', '--count', `${BASE}..HEAD`).trim() || 0);
  const closes = new RegExp(`^closes #${t.def.issue}\\b`, 'im').test(G('log', '--format=%B', `${BASE}..HEAD`));
  const body = join(t.clone, 'PR_BODY.md');
  let bodyOk = false;
  if (existsSync(body)) bodyOk = spawnSync(LINT, [body, '--repo', t.clone, '--base', BASE], { encoding: 'utf8' }).status === 0;
  const dir = join(outDir, `${label}-task${t.idx}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'committed.patch'), G('diff', BASE, 'HEAD'));
  if (existsSync(body)) copyFileSync(body, join(dir, 'PR_BODY.md'));
  writeFileSync(join(dir, 'mem.csv'), `${t.mem.join('\n')}\n`);
  const dbg = (run.tasks as any).debugLines as string;
  const row = {
    idx: t.idx, task_id: t.taskId, launch_ok: t.launchOk, launch_err: t.launchErr, done_reason: t.doneReason, wall_sec: t.wallSec,
    first_hook_sec: t.firstHookSec, commits, closes_issue: closes, body_ok: bodyOk, delivered: commits >= 1 && bodyOk,
    gate_blocks_counter_file: t.gateBlocksSeen, stop_events: t.hookEvents.filter((e) => e.hook_event_name === 'Stop').length, hook_event_counts: hookCounts(t.hookEvents),
    usage: t.usage, peak_rss_mb: { harness_tui: Math.round(t.peakHarness), other: Math.round(t.peakOther), total_tree: Math.round(t.peakTotal), total_pss: Math.round(t.peakPss) },
    throttle_hits: t.throttleHits, api_error_markers: t.apiErrorCount, plugin_debug_stop_codes_all_tasks: debugStopHookCodes(dbg),
  };
  writeFileSync(join(dir, 'task.json'), JSON.stringify(row, null, 1));
  return row;
}

function cleanup(work: string): void {
  // explicit, known path only (our own mkdtemp dir)
  if (work.startsWith(join(tmpdir(), 'oc-parity-')) && process.env.PARITY_KEEP !== '1') rmSync(work, { recursive: true, force: true });
}

if (!GRADE_ONLY) {
  if (!process.env.OPENAI_API_KEY) { console.log('SKIP: OPENAI_API_KEY not set'); process.exit(0); }
  if (!existsSync(OPENCODE_BIN)) { console.log(`SKIP: opencode binary not found (${OPENCODE_BIN})`); process.exit(0); }
}

if (GRADE_ONLY) {
  void (async () => { for (const k of caseKeys) await gradeCase(k); })();
} else {
  void main();
}
