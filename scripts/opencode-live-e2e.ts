/**
 * LIVE end-to-end harness for the opencode adapter (NOT part of `pnpm test`).
 *
 *   set -a; . /home/jean/hermes-sandbox/data/deepinfra.env; set +a
 *   node --import tsx scripts/opencode-live-e2e.ts [S1 S2 ... S9 B1 R1]
 *
 * Env: OCLIVE_SEED=0 (no config seed), OCLIVE_RAM=<MB> (TUI heap cap, 0 = off, default adapter default),
 * OCLIVE_RUNS=<n> (repeats for B1/R1). Never reads the real notebooks: every nb scenario uses a temp NB_DIR.
 *
 * Uses the real LocalDtachBackend, the real pinned opencode binary and a real
 * model. Each scenario launches its own session in a temp git repo with a temp
 * kookr dir, and cleans up only the PIDs it owns (never pkill by name).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalDtachBackend } from '../src/adapters/local-dtach-backend.js';
import { OpenCodeAdapter } from '../src/adapters/opencode-adapter.js';
import { defaultKookrClaudeHooks, resolveDefaultPluginHooksDir } from '../src/adapters/opencode-kookr-hooks.js';
import type { ClaudeHooksConfig } from '../src/adapters/opencode-instrumentation/kookr-plugin-source.js';
import { resolveOpenCodeBin } from '../src/adapters/opencode-preflight.js';
import { TaskStore } from '../src/core/tasks.js';

const REPO = resolve(__dirname, '..');
const DTACH_CANDIDATES = [join(REPO, 'vendor/dtach/dtach'), '/home/jean/git/kookr-prod/vendor/dtach/dtach'];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Rec = Record<string, any>;
interface Result { name: string; pass: boolean; evidence: string }
const results: Result[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}\n     ${evidence.replace(/\n/g, '\n     ')}`);
}

// ---------- preflight ----------
const bin = resolveOpenCodeBin(process.env).bin;
const dtachBinary = DTACH_CANDIDATES.find((p) => existsSync(p));
if (!existsSync(bin) && !spawnSync('which', [bin]).status) { console.log(`SKIP: opencode binary not found (${bin})`); process.exit(0); }
if (!process.env.OPENAI_API_KEY) { console.log('SKIP: OPENAI_API_KEY not set (source deepinfra.env)'); process.exit(0); }
if (!dtachBinary) { console.log('SKIP: no dtach binary found'); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'oclive-'));
const seedDir = join(work, 'seed-template'); // built lazily by the adapter (needs network once)
const RUNS = Number(process.env.OCLIVE_RUNS ?? 3);
const backend = new LocalDtachBackend({ dtachBinary, instanceId: `oclive-${process.pid}`, socketDir: join('/tmp', `oclive-${process.pid}`) });
const store = new TaskStore();
const pluginHooksDir = resolveDefaultPluginHooksDir() ?? '/home/jean/git/kookr-prod/plugin/hooks';
const binDir = existsSync(join(REPO, 'bin/kookr-stop-nudge.js')) ? join(REPO, 'bin') : '/home/jean/git/kookr-prod/bin';

function newRepo(): string {
  const d = mkdtempSync(join(work, 'repo-'));
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return d;
}

interface Live {
  tmux: string; cwd: string; hookFile: string; adapter: OpenCodeAdapter; taskId: string;
  hooks(): Rec[]; names(): string[];
  waitFor(pred: () => boolean, ms: number, label?: string): Promise<boolean>;
  stop(): Promise<void>;
}

interface StartOpts {
  claudeHooks?: ClaudeHooksConfig; extraEnv?: Record<string, string>; cwd?: string; tmux?: string;
  profile?: string; seed?: boolean; ramLimitMb?: number; fastBoot?: boolean;
}
async function start(prompt: string, o: StartOpts = {}): Promise<Live & { bootMs: number; sessionDir: string; seeded: boolean }> {
  let bootMsOut = -1;
  const cwd = o.cwd ?? newRepo();
  const hooksDir = mkdtempSync(join(work, 'hooks-'));
  const sessionRoot = mkdtempSync(join(work, 'sess-'));
  const tmux = o.tmux ?? `kookr-oc${Math.random().toString(36).slice(2, 8)}`;
  const adapter = new OpenCodeAdapter(backend, store, {
    hooksDir, sessionRoot, agentBin: bin,
    env: { ...process.env, KOOKR_OPENCODE_ENABLED: '1' }, // opt-in flag (hermetic harness env)
    fastBoot: o.fastBoot ?? false,
    seed: o.seed ?? process.env.OCLIVE_SEED !== '0', seedDir,
    ...(o.ramLimitMb !== undefined ? { ramLimitMb: o.ramLimitMb } : process.env.OCLIVE_RAM !== undefined ? { ramLimitMb: Number(process.env.OCLIVE_RAM) } : {}),
    profile: o.claudeHooks ? { claudeHooks: o.claudeHooks } : undefined,
    promptBracketedPaste: true,
  });
  // Mimic HookIngestion: feed each JSONL line through the adapter parser.
  const hookFile = join(hooksDir, `${tmux}.jsonl`);
  const task = store.createTask(prompt, cwd);
  // Stand in for HookIngestion: tail the JSONL and feed each line to the adapter parser.
  let fed = 0;
  const feed = setInterval(() => {
    if (!existsSync(hookFile)) return;
    const lines = readFileSync(hookFile, 'utf8').split('\n').filter(Boolean);
    for (; fed < lines.length; fed++) adapter.injectHookEvent(tmux, lines[fed]!, fed + 1);
  }, 200);
  try {
    let bootStart = 0;
    await adapter.launch(task.id, prompt, cwd, undefined, {
      tmuxName: tmux, extraEnv: o.extraEnv, ...(o.profile ? { profile: o.profile } : {}),
      onPhase: (p: string) => { if (p === 'agent-boot') bootStart = Date.now(); if (p === 'ack') bootMsOut = Date.now() - bootStart; },
    });
  } catch (err) {
    clearInterval(feed);
    if (process.env.OCLIVE_DEBUG) {
      const hf = existsSync(hookFile) ? readFileSync(hookFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return (JSON.parse(l) as Rec).hook_event_name; } catch { return '?'; } }) : [];
      console.log(`DEBUG launch failed: hooks=${JSON.stringify(hf)}\n${stripAnsi(await adapter.captureDisplay(tmux).catch(() => ''))}`);
    }
    await adapter.stop(tmux).catch(() => {});
    throw err;
  }
  const hooks = (): Rec[] => {
    if (!existsSync(hookFile)) return [];
    return readFileSync(hookFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  };
  const nameOf = (r: Rec) => r.hook_event_name ?? r.payload?.hook_event_name ?? r.event ?? '?';
  const sessionDir = (adapter.getEffectiveHookSettings(tmux)?.settingsPath ?? '').replace(/\/cfg\/plugins\/kookr\.js$/, '');
  const seeded = existsSync(join(sessionDir, 'cfg', 'package.json')) && statSync(join(sessionDir, 'cfg', 'package.json')).nlink > 1;
  const live: Live & { bootMs: number; sessionDir: string; seeded: boolean } = {
    bootMs: bootMsOut, sessionDir, seeded,
    tmux, cwd, hookFile, adapter, taskId: task.id,
    hooks, names: () => hooks().map(nameOf),
    async waitFor(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(500); } return pred(); },
    async stop() { clearInterval(feed); await adapter.stop(tmux).catch(() => {}); },
  };
  return live;
}

/** Descendants (incl. dtach masters) of processes whose args mention `tmux`. */
function ownedPids(tmux: string): { pid: number; rss: number; args: string }[] {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const rows = out.map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: +m[1]!, ppid: +m[2]!, rss: +m[3]!, args: m[4]! } : null; }).filter(Boolean) as { pid: number; ppid: number; rss: number; args: string }[];
  const roots = rows.filter((r) => r.args.includes(tmux) && r.pid !== process.pid && !r.args.startsWith('ps '));
  const seen = new Map(roots.map((r) => [r.pid, r]));
  let grew = true;
  while (grew) { grew = false; for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.set(r.pid, r); grew = true; } }
  return [...seen.values()];
}

const has = (names: string[], n: string) => names.includes(n);
const preBash = (h: Rec[]) => h.filter((r) => r.hook_event_name === 'PreToolUse' && r.tool_name === 'Bash' && typeof r.tool_input?.command === 'string');

// ---------- scenarios ----------
async function S1(): Promise<void> {
  const s = await start('Run this exact shell command using your bash tool: echo ok > out.txt   Then reply with the single word done.');
  try {
    const ok = await s.waitFor(() => has(s.names(), 'Stop') && existsSync(join(s.cwd, 'out.txt')), 120_000);
    const names = s.names();
    const need = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
    const missing = need.filter((n) => !has(names, n));
    const bash = preBash(s.hooks())[0]?.tool_input?.command;
    const out = existsSync(join(s.cwd, 'out.txt')) ? readFileSync(join(s.cwd, 'out.txt'), 'utf8').trim() : '<absent>';
    record('S1 launch->prompt->tool->hooks', ok && !missing.length && !!bash && out === 'ok',
      `events=${names.join(',')} missing=[${missing}] PreToolUse.Bash.command=${JSON.stringify(bash)} out.txt=${JSON.stringify(out)}`);
  } finally { await s.stop(); }
}

async function S2(): Promise<void> {
  const s = await start('Run this exact shell command with your bash tool: sleep 15; echo a > a.txt   Then say done.');
  try {
    await s.waitFor(() => has(s.names(), 'PreToolUse'), 90_000);
    await s.adapter.sendInput(s.tmux, 'Also, after that, run: echo b > b.txt using your bash tool.');
    const ok = await s.waitFor(() => existsSync(join(s.cwd, 'a.txt')) && existsSync(join(s.cwd, 'b.txt')), 150_000);
    const prompts = s.hooks().filter((r) => r.hook_event_name === 'UserPromptSubmit').map((r) => String(r.prompt).slice(0, 50));
    record('S2 mid-task sendInput executed', ok, `a.txt=${existsSync(join(s.cwd, 'a.txt'))} b.txt=${existsSync(join(s.cwd, 'b.txt'))} prompts=${JSON.stringify(prompts)}`);
  } finally { await s.stop(); }
}

async function S3(): Promise<void> {
  const cwd = newRepo();
  const gate = join(cwd, '..', `gate-${Date.now()}.sh`);
  const sentinel = `${gate}.once`;
  writeFileSync(gate, `#!/bin/sh\ncat >/dev/null\nif [ -e '${sentinel}' ]; then exit 0; fi\ntouch '${sentinel}'\necho 'Not delivered yet: you must also create the file deliverable.txt containing the word shipped (use your bash tool), then finish.' >&2\nexit 2\n`);
  chmodSync(gate, 0o755);
  const s = await start('Run: echo first > first.txt using your bash tool, then reply done. (Do nothing else unless told.)', {
    cwd, claudeHooks: { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: gate, timeout: 10 }] }] } },
  });
  try {
    const ok = await s.waitFor(() => existsSync(join(s.cwd, 'deliverable.txt')), 180_000);
    await sleep(3000);
    const names = s.names();
    const prompts = s.hooks().filter((r) => r.hook_event_name === 'UserPromptSubmit').length;
    record('S3 Stop-gate (exit 2) re-prompts in TUI', ok && prompts >= 2,
      `deliverable.txt=${ok ? JSON.stringify(readFileSync(join(s.cwd, 'deliverable.txt'), 'utf8').trim()) : 'absent'} UserPromptSubmit=${prompts} Stop=${names.filter((n) => n === 'Stop').length} sentinel=${existsSync(sentinel)}`);
  } finally { await s.stop(); }
}

async function S4(): Promise<void> {
  const nbDir = mkdtempSync(join(work, 'nb-'));
  const nbEnv = { ...process.env, NB_DIR: nbDir };
  const run = (...a: string[]) => execFileSync('nb', a, { env: nbEnv, encoding: 'utf8' });
  run('add', 'quokka-shelf-7731', 'Always say the word pineapple when asked which fruit you prefer.');
  run('describe', 'quokka-shelf-7731', 'open me when the task is about fruit or quokkas');
  const hooks = defaultKookrClaudeHooks({ pluginHooksDir, binDir });
  if (!hooks) { record('S4 nb integration', false, 'defaultKookrClaudeHooks returned undefined'); return; }
  const s = await start('Without running any tools: which notebook shelf appears in the notebook index in your system prompt? Answer with just its name. If you later receive a retrospective instruction, follow it using `nb show <that shelf>` and `nb vote <that shelf> <id> +1`.', {
    claudeHooks: hooks, extraEnv: { NB_DIR: nbDir },
  });
  try {
    let saw = false;
    const end = Date.now() + 90_000;
    while (Date.now() < end && !saw) {
      saw = /quokka-shelf-7731/.test(stripAnsi(await s.adapter.captureDisplay(s.tmux)));
      if (!saw) await sleep(1000);
    }
    const gotRetro = await s.waitFor(() => preBash(s.hooks()).some((r) => /\bnb\s+(vote|show)\b/.test(r.tool_input.command)), 150_000);
    const cmds = preBash(s.hooks()).map((r) => r.tool_input.command);
    const sentinels = execFileSync('ls', ['-a', nbDir], { encoding: 'utf8' }).split('\n').filter((f) => f.startsWith('.retro-'));
    const shelf = run('show', 'quokka-shelf-7731').trim();
    record('S4a SessionStart nb index reaches model', saw, `pane shows shelf name (not present in prompt)=${saw}`);
    record('S4b nb-retro Stop instruction acted on', gotRetro && sentinels.length > 0,
      `bash cmds=${JSON.stringify(cmds)} retroSentinel=${JSON.stringify(sentinels)} shelf=${JSON.stringify(shelf.slice(0, 160))}`);
  } finally { await s.stop(); }
}

function stripAnsi(t: string): string { return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); }

async function S5(): Promise<void> {
  const s = await start('Reply with the single word ready. Do not use tools.');
  await s.waitFor(() => has(s.names(), 'Stop'), 90_000);
  const before = ownedPids(s.tmux);
  const sessionDir = (s.adapter.getEffectiveHookSettings(s.tmux)?.settingsPath ?? '').replace(/\/cfg\/plugins\/kookr\.js$/, '');
  const dirBefore = existsSync(sessionDir);
  await s.adapter.stop(s.tmux);
  await sleep(2500);
  const after = ownedPids(s.tmux);
  // opencode child may have been re-parented; also look for any pid still holding the session's config dir.
  const leaked = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(sessionDir) && sessionDir.length > 10 && !l.includes('ps -eo'));
  record('S5 stop() leaves no processes, removes dir', before.length > 0 && after.length === 0 && !leaked.length && dirBefore && !existsSync(sessionDir),
    `pids before=${before.map((p) => p.pid)} after=${after.map((p) => p.pid)} leakedByConfigDir=${leaked.length} dirBefore=${dirBefore} dirAfter=${existsSync(sessionDir)}`);
  for (const p of [...after]) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function S6(): Promise<void> {
  const s = await start('Use your bash tool to run exactly: for i in 1 2 3 4 5 6; do sleep 5; echo tick $i >> ticks.txt; done   then reply done.');
  const samples: number[] = [];
  const cg: number[] = [];
  try {
    const end = Date.now() + 40_000;
    while (Date.now() < end) {
      const rss = ownedPids(s.tmux).reduce((a, p) => a + p.rss, 0);
      samples.push(rss);
      for (const f of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
        try { cg.push(+readFileSync(f, 'utf8').trim()); break; } catch { /* unreadable */ }
      }
      await sleep(2000);
    }
    const peakMb = Math.max(...samples) / 1024;
    const procs = ownedPids(s.tmux).map((p) => `${p.pid}:${(p.rss / 1024).toFixed(0)}MB:${p.args.slice(0, 40)}`);
    record('S6 memory sampling', samples.length >= 15 && peakMb > 0,
      `samples=${samples.length} peakTreeRSS=${peakMb.toFixed(0)}MB lastTreeRSS=${(samples.at(-1)! / 1024).toFixed(0)}MB cgroupPeak=${cg.length ? (Math.max(...cg) / 1048576).toFixed(0) + 'MB (machine-wide cgroup)' : 'unreadable'}\nprocs=${procs.join(' | ')}`);
  } finally { await s.stop(); }
}

// ---------- memory scenarios (S7-S9), boot timing (B1), RAM cap (R1) ----------
function makeNb(): { dir: string; env: NodeJS.ProcessEnv; run: (...a: string[]) => string } {
  const dir = mkdtempSync(join(work, 'nb-'));
  const env = { ...process.env, NB_DIR: dir };
  const run = (...a: string[]) => execFileSync('nb', a, { env, encoding: 'utf8' });
  const shelves: Array<[string, string, string]> = [
    ['patch-author', 'PA-7731', 'Before committing, reread the diff once and drop unrelated hunks. Marker PA-7731.'],
    ['change-verifier', 'CV-4410', 'Verify the change by re-running the focused check, not by reading the diff. Marker CV-4410.'],
    ['code-review', 'CR-5521', 'Trace the data flow to the consumer before calling something a bug. Marker CR-5521.'],
    ['failure-mode-analyst', 'FM-6632', 'List the inputs that make the guard fail before trusting it. Marker FM-6632.'],
    ['secret-other', 'SO-9902', 'Unrelated private lesson about gardening tools. Marker SO-9902.'],
  ];
  for (const [shelf, , lesson] of shelves) {
    run('add', shelf, lesson);
    run('describe', shelf, shelf === 'secret-other' ? 'unrelated to software work: gardening notes' : `lessons for the ${shelf} role`);
  }
  return { dir, env, run };
}
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    try { out[f] = readFileSync(join(dir, f), 'utf8'); } catch { /* directory */ }
  }
  return out;
}
function diffSnap(a: Record<string, string>, b: Record<string, string>): string {
  const d: string[] = [];
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (f.startsWith('.retro-') || f.includes('usage')) continue;
    if (a[f] === b[f]) continue;
    const ta = join(work, `d-a-${f}`), tb = join(work, `d-b-${f}`);
    writeFileSync(ta, a[f] ?? ''); writeFileSync(tb, b[f] ?? '');
    const r = spawnSync('diff', ['-u', '--label', `before/${f}`, '--label', `after/${f}`, ta, tb], { encoding: 'utf8' });
    d.push(r.stdout.replace(/^(@@.*@@)$/gm, '$1'));
  }
  return d.join('\n');
}
function pollPane(s: { adapter: OpenCodeAdapter; tmux: string }): { union: () => string; stop: () => void } {
  const seen = new Set<string>();
  const t = setInterval(() => { void s.adapter.captureDisplay(s.tmux).then((d) => { for (const l of stripAnsi(d).split('\n')) seen.add(l.trim()); }).catch(() => {}); }, 1500);
  return { union: () => [...seen].join('\n'), stop: () => clearInterval(t) };
}
const nbCmds = (h: Rec[]) => preBash(h).map((r) => String(r.tool_input.command)).filter((c) => /\bnb\s/.test(c));
const MARKERS = ['PA-7731', 'CV-4410', 'CR-5521', 'FM-6632', 'SO-9902'];
const MARKER_Q = ' Finally, in your last message list, comma separated, every lesson marker code of the form XX-0000 that appears in the "Lessons from your shelves" part of your instructions (write none if there is no such part).';

async function memoryRun(profile: string, prompt: string, cwd: string, done: (s: Awaited<ReturnType<typeof start>>) => boolean) {
  const nb = makeNb();
  const before = snapshotDir(nb.dir);
  const s = await start(prompt + MARKER_Q, { cwd, profile, extraEnv: { NB_DIR: nb.dir } });
  const agentsPath = join(s.sessionDir, 'cfg', 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const pane = pollPane(s);
  const finished = await s.waitFor(() => done(s), 300_000);
  await sleep(4000);
  const hooks = s.hooks();
  const hookText = readFileSync(s.hookFile, 'utf8');
  const display = pane.union();
  pane.stop();
  const after = snapshotDir(nb.dir);
  const inject = spawnSync('bash', [join(pluginHooksDir, 'nb-inject.sh')], { env: nb.env, input: '{}', encoding: 'utf8' }).stdout;
  await s.stop();
  return { s, nb, agents, finished, hooks, hookText, display, diff: diffSnap(before, after), inject };
}
const retroDone = (s: Awaited<ReturnType<typeof start>>) => preBash(s.hooks()).some((r) => /\bnb\s+(vote|add|rm)\b/.test(r.tool_input.command));

async function S7(): Promise<void> {
  const cwd = newRepo();
  const r = await memoryRun('scoped-fix',
    "Tiny task: create hello.txt containing the word hi, commit it with `git add hello.txt && git commit -m 'feat: add hello'`, and write a one-paragraph PR_BODY.md at the repo root.", cwd, retroDone);
  const has = (t: string, m: string) => t.includes(m);
  const ctx = [
    `AGENTS.md has Lessons section=${has(r.agents, '## Lessons from your shelves')} PA-7731=${has(r.agents, 'PA-7731')} CV-4410=${has(r.agents, 'CV-4410')}`,
    `AGENTS.md has SO-9902=${has(r.agents, 'SO-9902')} CR-5521=${has(r.agents, 'CR-5521')} FM-6632=${has(r.agents, 'FM-6632')}`,
    `pane/transcript: SO-9902=${has(r.display, 'SO-9902')} PA-7731=${has(r.display, 'PA-7731')} CV-4410=${has(r.display, 'CV-4410')}`,
    `hook JSONL SO-9902=${has(r.hookText, 'SO-9902')}`,
    `global index (nb-inject.sh) lists shelf name secret-other=${has(r.inject, 'secret-other')}, index contains lesson text SO-9902=${has(r.inject, 'SO-9902')}`,
  ];
  record('S7a profile shelves reach AGENTS.md; foreign shelf lesson does not', has(r.agents, 'PA-7731') && has(r.agents, 'CV-4410') && !has(r.agents, 'SO-9902') && !has(r.agents, 'CR-5521') && !has(r.agents, 'FM-6632') && has(r.inject, 'secret-other') && !has(r.inject, 'SO-9902'), ctx.join('\n'));
  record('S7b model context: markers seen, SO-9902 never in model output', has(r.display + r.hookText, 'PA-7731') && has(r.display + r.hookText, 'CV-4410') && !has(r.display, 'SO-9902') && !has(r.hookText, 'SO-9902'), ctx.slice(2, 4).join('\n'));
  const cmds = nbCmds(r.hooks);
  record('S7c agent ran nb show on a profile shelf', cmds.some((c) => /nb\s+show\s+(patch-author|change-verifier)/.test(c)), `nb commands=${JSON.stringify(cmds)}`);
  record('S7d retro vote/add changed the NB_DIR file', r.finished && !!r.diff.trim(), `finished=${r.finished}\nnotebook diff:\n${r.diff || '<none>'}`);
}

async function S8(): Promise<void> {
  const cwd = newRepo();
  writeFileSync(join(cwd, 'cache.js'), "const cache = {};\nfunction getUser(id, load) {\n  if (cache.last && cache.last.id !== id) cache.last = undefined;\n  cache.last = cache.last || load(id);\n  return cache.last;\n}\nmodule.exports = { getUser };\n");
  execFileSync('git', ['-C', cwd, 'add', '.']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add cache']);
  const r = await memoryRun('reviewer', 'Review cache.js for real defects and write REVIEW.md (at most 3 findings).', cwd, (s) => retroDone(s) || existsSync(join(s.cwd, 'REVIEW.md')) && s.names().filter((n) => n === 'Stop').length >= 2);
  const has = (t: string, m: string) => t.includes(m);
  const cmds = nbCmds(r.hooks);
  record('S8a reviewer AGENTS.md has its own shelves, not patch-author/change-verifier/secret', has(r.agents, 'CR-5521') && has(r.agents, 'FM-6632') && !has(r.agents, 'PA-7731') && !has(r.agents, 'CV-4410') && !has(r.agents, 'SO-9902'),
    `AGENTS.md CR-5521=${has(r.agents, 'CR-5521')} FM-6632=${has(r.agents, 'FM-6632')} PA-7731=${has(r.agents, 'PA-7731')} CV-4410=${has(r.agents, 'CV-4410')} SO-9902=${has(r.agents, 'SO-9902')}`);
  record('S8b model never sees patch-author lesson text', !has(r.display, 'PA-7731') && !has(r.hookText, 'PA-7731') && !has(r.display, 'SO-9902'), `pane PA-7731=${has(r.display, 'PA-7731')} hooks PA-7731=${has(r.hookText, 'PA-7731')} nb commands=${JSON.stringify(cmds)}\nnotebook diff:\n${r.diff || '<none>'}`);
}

async function S9(): Promise<void> {
  const list = spawnSync('kb', ['list'], { encoding: 'utf8', timeout: 20_000 });
  const search = spawnSync('kb', ['search', 'how to write a minimal fix', '--kb=agent-task-lessons'], { encoding: 'utf8', timeout: 60_000 });
  const out = stripAnsi(`${search.stdout}${search.stderr}`);
  const works = search.status === 0 && !/not initialized|INDEX_NOT_INITIALIZED|error/i.test(out);
  record('S9 kb on this host', true,
    `kb list rc=${list.status} lines=${list.stdout.split('\n').filter(Boolean).length}\nkb search rc=${search.status}: ${works ? 'returned results' : 'kb live search not verifiable here'}\n${out.split('\n').filter((l) => !l.includes('[INFO]')).slice(0, 4).join('\n')}`);
}

async function B1(): Promise<void> {
  const rows: string[] = [];
  for (const v of [{ name: 'unseeded', seed: false, fastBoot: false }, { name: 'seeded', seed: true, fastBoot: false }, { name: 'seeded+FAST_BOOT', seed: true, fastBoot: true }]) {
    const ms: number[] = [];
    let ok = 0;
    for (let i = 0; i < RUNS; i++) {
      let s: Awaited<ReturnType<typeof start>> | undefined;
      try {
        s = await start('Run this exact shell command using your bash tool: echo ok > out.txt   Then reply with the single word done.', { seed: v.seed, fastBoot: v.fastBoot });
        const delivered = await s.waitFor(() => has(s!.names(), 'UserPromptSubmit'), 60_000);
        if (delivered) ok++;
        ms.push(s.bootMs);
        rows.push(`${v.name} run${i + 1}: agent-boot->prompt-acked=${s.bootMs}ms seededOnDisk=${s.seeded} UserPromptSubmit=${delivered}`);
      } catch (err) {
        rows.push(`${v.name} run${i + 1}: LAUNCH FAILED ${String((err as Error).message).slice(0, 90)}`);
      } finally { await s?.stop(); }
    }
    rows.push(`${v.name}: ms=[${ms.join(',')}] median=${[...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 'n/a'}ms promptDelivered=${ok}/${RUNS}`);
  }
  record('B1 boot time (launch->composer ready->prompt acked)', true, rows.join('\n'));
}

function makeSlugRepo(): string {
  const d = mkdtempSync(join(work, 'slug-'));
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  writeFileSync(join(d, 'package.json'), '{"name":"slug","version":"1.0.0","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(d, 'slug.js'), "function slugify(title) {\n  return title.toLowerCase().replace(/ /g, '-');\n}\nmodule.exports = { slugify };\n");
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test/slug.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { slugify } = require('../slug.js');\ntest('lowercases and dashes', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\ntest('drops punctuation and collapses spaces', () => assert.strictEqual(slugify('Hello,   World!'), 'hello-world'));\n");
  execFileSync('git', ['-C', d, 'add', '.']);
  execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return d;
}

/** Mid-size task with the scoped-fix profile; compare with OCLIVE_RAM=512 vs OCLIVE_RAM=0 (peak tree RSS, success). */
async function R1(): Promise<void> {
  const nb = makeNb();
  for (let i = 0; i < RUNS; i++) {
    const cwd = makeSlugRepo();
    const s = await start("Issue #7: slugify() keeps punctuation and produces doubled dashes. `slugify('Hello,   World!')` returns `hello,---world!` but should return `hello-world`. The failing test is test/slug.test.js (run with `npm test`). Fix it minimally, add a regression test, commit with 'fix: slugify punctuation' and write PR_BODY.md.", { cwd, profile: 'scoped-fix', extraEnv: { NB_DIR: nb.dir, KOOKR_OPENCODE_ISSUE: '7' } });
    let peak = 0; let atRest = 0;
    const t0 = Date.now();
    const sampler = setInterval(() => { const r = ownedPids(s.tmux).reduce((a, p) => a + p.rss, 0) / 1024; if (!atRest && r > 0) atRest = r; peak = Math.max(peak, r); }, 2000);
    const tests = () => spawnSync('npm', ['test', '--silent'], { cwd, encoding: 'utf8' }).status === 0;
    const commits = () => Number(execFileSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
    const ok = await s.waitFor(() => commits() >= 2 && existsSync(join(cwd, 'PR_BODY.md')) && tests(), 420_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    clearInterval(sampler);
    const env = s.adapter.getEffectiveHookSettings(s.tmux);
    record(`R1 run${i + 1} ram=${process.env.OCLIVE_RAM ?? 'default'}`, ok, `success=${ok} (commit+PR_BODY+npm test green) wallclock=${secs}s firstTreeRSS=${atRest.toFixed(0)}MB peakTreeRSS=${peak.toFixed(0)}MB bootMs=${s.bootMs} stopHooks=${s.names().filter((n) => n === 'Stop').length} ${env ? '' : ''}`);
    await s.stop();
  }
}

const ALL: Record<string, () => Promise<void>> = { S1, S2, S3, S4, S5, S6, S7, S8, S9, B1, R1 };
async function main(): Promise<void> {
  const want = process.argv.slice(2).map((a) => a.toUpperCase());
  const run = want.length ? want : Object.keys(ALL).filter((k) => /^S\d/.test(k)); // B1 and R1 are opt-in
  console.log(`opencode=${bin} dtach=${dtachBinary} hooksDir=${pluginHooksDir} binDir=${binDir} work=${work}`);
  // keep a rolling pane capture per session for S4's index probe
  for (const name of run) {
    const fn = ALL[name];
    if (!fn) { console.log(`unknown scenario ${name}`); continue; }
    console.log(`--- ${name}`);
    try { await fn(); } catch (err) { record(`${name} crashed`, false, String((err as Error).stack ?? err)); }
  }
  backend.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
void main();
void mkdirSync;
