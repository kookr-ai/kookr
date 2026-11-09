/**
 * Hermetic live proof for `kookr ask` (NOT part of `pnpm test`).
 *
 *   node --import tsx scripts/ask-live-proof.ts [--evidence <file.md>]
 *
 * Starts a real Kookr server from this checkout in a temp HOME on a free
 * loopback port, with Telegram pointed at the in-process fake Telegram server
 * (src/integrations/telegram/fake-telegram-server.ts). A real task is launched
 * through `POST /api/tasks`; its "agent" is a tiny fake `claude` binary
 * (KOOKR_AGENT_BIN) that does exactly what a real agent would: it runs the real
 * `kookr ask` CLI with the task's own KOOKR_TASK_ID, and records everything
 * typed into its terminal. The operator's button press is simulated by queueing
 * a Telegram callback_query. Proves, end to end:
 *   1. non-blocking `kookr ask` prints an ask id and the operator sees buttons;
 *   2. a forged button and a non-allowlisted tap change nothing;
 *   3. the real button records the answer, edits the message, and the answer
 *      arrives in the task's terminal as "Operator answered ask <id>: <label>";
 *   4. `kookr ask --wait` prints the chosen label and exits 0;
 *   5. an unanswered ask expires: message edited, `--wait` exits 5;
 *   6. with Telegram unconfigured, `kookr ask` exits 7 and nothing is written.
 * Never touches ~/.kookr or port 4800; only kills the server PID it spawned.
 * Env: E2E_PORT, E2E_KEEP=1 (keep the temp dir).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeTelegram } from '../src/integrations/telegram/fake-telegram-server.js';

const REPO = resolve(__dirname, '..');
const DTACH = join(REPO, 'vendor/dtach/dtach');
const USER = 4242;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Rec = Record<string, any>;

const results: Array<{ name: string; pass: boolean; evidence: string }> = [];
function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}\n     ${evidence.replace(/\n/g, '\n     ')}`);
}

if (!existsSync(DTACH)) { console.log(`SKIP: no vendored dtach at ${DTACH} (pnpm build:dtach)`); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'ask-live-proof-'));
const home = join(work, 'home');
const proof = join(work, 'proof');
mkdirSync(home, { recursive: true });
mkdirSync(proof, { recursive: true });

async function freePort(): Promise<number> {
  if (process.env.E2E_PORT) return Number(process.env.E2E_PORT);
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
}
const read = (f: string): string => { try { return readFileSync(join(proof, f), 'utf8'); } catch { return ''; } };

// The fake agent. `--version` must answer (the adapter probes the binary).
const fakeAgent = join(work, 'fake-claude');
writeFileSync(fakeAgent, `#!/usr/bin/env bash
# A stand-in for \`claude\`: speaks just enough of its lifecycle (hook events) for Kookr to treat it as a live
# session, and otherwise behaves like an agent that calls the real \`kookr ask\` CLI.
if [ "$1" = "--version" ]; then echo "2.0.0 (fake)"; exit 0; fi
P="${proof}"
echo "$@" > "$P/argv.txt"
SETTINGS=""
while [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then SETTINGS="$2"; fi; shift; done
hookcmd() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const h=(d.hooks||{})[process.argv[2]];process.stdout.write((h&&h[0]&&h[0].hooks[0].command)||"")' "$SETTINGS" "$1"; }
fire() { C=$(hookcmd "$1"); [ -n "$C" ] || return 0; node -e 'process.stdout.write(JSON.stringify({hook_event_name:process.argv[1],session_id:"fake-session",cwd:process.cwd(),prompt:process.argv[2]||""}))' "$1" "$2" | sh -c "$C" >/dev/null 2>&1; }
# next non-empty line typed into the terminal, minus bracketed-paste markers (what a TUI would show as the message)
nextmsg() { local L; MSG=""; while IFS= read -r -t "$1" L; do L=$(printf '%s' "$L" | sed -e 's/\x1b\\[20[01]~//g' -e 's/\r$//'); if [ -n "$L" ]; then MSG="$L"; return 0; fi; done; return 1; }
echo "task=$KOOKR_TASK_ID" > "$P/agent-started.txt"
fire SessionStart ""
# the initial prompt is multi-line: read until the terminal goes quiet, like an agent TUI would
read -r -t 120 INITIAL
while IFS= read -r -t 2 MORE; do INITIAL="$INITIAL"$'\\n'"$MORE"; done
fire UserPromptSubmit "$INITIAL"
# 1. non-blocking ask: prints the ask id and returns immediately
kookr ask --question "Deploy build 42 to staging?" --context "CI is green; 3 files changed" --option "Deploy" --option "Hold" > "$P/ask1-stdout.txt" 2> "$P/ask1-stderr.txt"
echo $? > "$P/ask1-exit.txt"
fire Stop ""
# the answer is typed into this terminal like any user message
nextmsg 120; LINE="$MSG"
fire UserPromptSubmit "$LINE"
printf '%s\\n' "$LINE" > "$P/typed-reply-1.txt"
# 2. blocking ask: --wait prints the chosen label
kookr ask --question "Which database?" --option "Postgres" --option "SQLite" --wait=120 > "$P/ask2-stdout.txt" 2> "$P/ask2-stderr.txt"
echo $? > "$P/ask2-exit.txt"
nextmsg 60; LINE2="$MSG"
fire UserPromptSubmit "$LINE2"
printf '%s\\n' "$LINE2" > "$P/typed-reply-2.txt"
# 3. an ask nobody answers: expires
kookr ask --question "Anyone there?" --option "Yes" --option "No" --timeout 30s --wait > "$P/ask3-stdout.txt" 2> "$P/ask3-stderr.txt"
echo $? > "$P/ask3-exit.txt"
fire Stop ""
sleep 600
`);
chmodSync(fakeAgent, 0o755);

const repo = join(work, 'repo');
mkdirSync(repo, { recursive: true });
for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'proof@example.invalid'], ['config', 'user.name', 'proof'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
  execFileSync('git', ['-C', repo, ...args]);
}

let server: ChildProcess | undefined;
let port = 0;
const usedPorts: number[] = [];
const base = () => `http://127.0.0.1:${port}`;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base()}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json };
}

function serverEnv(over: Record<string, string>): Record<string, string> {
  // Hermetic: nothing from the operator's shell (telegram, relay, KOOKR_TASK_ID, ...) leaks in.
  return {
    PATH: `${join(REPO, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    KOOKR_PORT: String(port), KOOKR_HOST: '127.0.0.1',
    KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '1',
    KOOKR_AGENT_BIN: fakeAgent,
    KOOKR_PLUGIN_DIR: '',
    ...over,
  };
}
async function startServer(env: Record<string, string>): Promise<boolean> {
  usedPorts.push(port);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout!.on('data', (d) => { log += d; });
  server.stderr!.on('data', (d) => { log += d; });
  const up = await waitFor(async () => { try { return (await fetch(`${base()}/api/health`)).ok; } catch { return false; } }, 90_000, 1000);
  if (!up) console.log(log.slice(-1500));
  (startServer as any).log = () => log;
  return up;
}
async function stopServer(): Promise<void> {
  if (server?.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ } await sleep(1500); }
  server = undefined;
}

async function main(): Promise<void> {
  port = await freePort();
  const fake = await startFakeTelegram();
  try {
    const up = await startServer(serverEnv({
      KOOKR_TELEGRAM_BOT_TOKEN: 'fake-bot-token',
      KOOKR_TELEGRAM_ALLOWED_USERS: String(USER),
      KOOKR_REMOTE_CHAT_PROJECTS: repo,
      KOOKR_TELEGRAM_API_URL: fake.baseUrl,
    }));
    record('server boots (isolated, Telegram -> fake server)', up, `pid=${server?.pid} port=${port} dataDir=${home}/.kookr-${port}`);
    if (!up) return;

    const launched = await api('POST', '/api/tasks', { prompt: 'ask-proof', cwd: repo, agentType: 'claude-code' });
    const taskId: string | undefined = launched.json?.task?.id ?? launched.json?.id ?? launched.json?.taskId;
    record('task launched through POST /api/tasks', (launched.status === 201 || launched.status === 200) && !!taskId, `status=${launched.status} taskId=${taskId} ${JSON.stringify(launched.json).slice(0, 200)}`);
    if (!taskId) return;

    // 1. non-blocking ask from inside the task
    const started = await waitFor(() => read('agent-started.txt').includes(taskId), 30_000);
    record('fake agent started with the task id in its environment', started, read('agent-started.txt').trim());
    const sent1 = await waitFor(() => fake.outbound.sendMessage.some((m) => m.text.includes('Deploy build 42')), 30_000);
    const msg1 = fake.outbound.sendMessage.find((m) => m.text.includes('Deploy build 42'));
    const kb1 = ((msg1?.reply_markup as any)?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data: string }>;
    record('operator receives the question with one button per option', sent1 && kb1.map((b) => b.text).join('|') === 'Deploy|Hold',
      `to chat ${msg1?.chat_id}: ${JSON.stringify(msg1?.text)}\nbuttons: ${kb1.map((b) => b.text).join(' | ')}`);
    const askId = read('ask1-stdout.txt').trim();
    record('non-blocking `kookr ask` printed the ask id and exited 0', /^[0-9a-f]{12}$/.test(askId) && read('ask1-exit.txt').trim() === '0', `stdout=${askId} exit=${read('ask1-exit.txt').trim()}`);
    const ask1 = (await api('GET', `/api/asks/${askId}`)).json.ask as Rec;
    record('ask is pending and its view never exposes the nonce', ask1?.state === 'pending' && !JSON.stringify(ask1).includes('nonce'), JSON.stringify(ask1));
    const messageId: number = ask1.delivery.messageId;

    // 2. forged and unauthorised taps change nothing
    const tap = (data: string, from = USER, msgId = messageId, chatId = USER) => fake.queueUpdates([{
      update_id: Math.floor(Math.random() * 1e9), callback_query: { id: `cb-${Math.random()}`, from: { id: from }, data, message: { message_id: msgId, chat: { id: chatId, type: 'private' } } },
    } as any]);
    tap(`ask:${askId}:0:${'0'.repeat(16)}`);
    tap(kb1[0]!.callback_data, 999, messageId, 999);
    await waitFor(() => fake.outbound.answerCallbackQuery.some((a) => a.text === 'Invalid button.'), 10_000);
    await sleep(500);
    const still = (await api('GET', `/api/asks/${askId}`)).json.ask as Rec;
    record('forged button and non-allowlisted tap are rejected; ask stays pending, nothing typed', still.state === 'pending' && read('typed-reply-1.txt') === '',
      `state=${still.state} toasts=${JSON.stringify(fake.outbound.answerCallbackQuery.map((a) => a.text))}`);

    // 3. the real button
    tap(kb1[1]!.callback_data);
    const answered = await waitFor(async () => ((await api('GET', `/api/asks/${askId}`)).json.ask as Rec).state === 'answered', 15_000);
    const ans = (await api('GET', `/api/asks/${askId}`)).json.ask as Rec;
    record('button press records the answer once', answered && ans.answer?.label === 'Hold' && ans.answeredBy === USER, JSON.stringify({ state: ans.state, answer: ans.answer, answeredBy: ans.answeredBy, taskDelivery: ans.taskDelivery }));
    const typed = await waitFor(() => read('typed-reply-1.txt').includes('Operator answered ask'), 30_000);
    record('the answer arrives in the task terminal as a normal reply', typed && read('typed-reply-1.txt').trim() === `Operator answered ask ${askId}: Hold`, `agent received: ${JSON.stringify(read('typed-reply-1.txt').trim())}`);
    const edited = fake.outbound.editMessageText.find((e) => e.message_id === messageId);
    record('the Telegram message is edited to show the chosen option', !!edited && edited.text.startsWith('✅ Answered: Hold'), JSON.stringify(edited?.text));
    tap(kb1[0]!.callback_data);
    await waitFor(() => fake.outbound.answerCallbackQuery.some((a) => a.text === 'Already answered.'), 10_000);
    record('a second tap is rejected as already answered', fake.outbound.answerCallbackQuery.some((a) => a.text === 'Already answered.') && ((await api('GET', `/api/asks/${askId}`)).json.ask as Rec).answer.label === 'Hold', 'answer stays "Hold"');

    // 4. --wait prints the label
    const sent2 = await waitFor(() => fake.outbound.sendMessage.some((m) => m.text.includes('Which database?')), 30_000);
    const msg2 = fake.outbound.sendMessage.find((m) => m.text.includes('Which database?'));
    const kb2 = ((msg2?.reply_markup as any)?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data: string }>;
    const list = (await api('GET', `/api/asks?taskId=${taskId}&state=pending`)).json.asks as Rec[];
    const ask2 = list.find((a) => a.question === 'Which database?');
    record('`kookr ask --wait` is blocking: the second ask stays pending until answered', sent2 && !!ask2 && read('ask2-exit.txt') === '', `pending asks for the task: ${list.map((a) => a.question).join(', ')}`);
    if (ask2) tap(kb2[0]!.callback_data, USER, ask2.delivery.messageId);
    const waited = await waitFor(() => read('ask2-exit.txt') !== '', 30_000);
    record('`--wait` printed the chosen label and exited 0', waited && read('ask2-stdout.txt').trim() === 'Postgres' && read('ask2-exit.txt').trim() === '0', `stdout=${JSON.stringify(read('ask2-stdout.txt').trim())} exit=${read('ask2-exit.txt').trim()}`);
    const typed2 = await waitFor(() => read('typed-reply-2.txt').includes('Operator answered ask'), 30_000);
    record('(--wait also types the same answer into the terminal; both carry the same label)', typed2 && read('typed-reply-2.txt').includes(': Postgres'), JSON.stringify(read('typed-reply-2.txt').trim()));

    // 5. expiry
    const expiredExit = await waitFor(() => read('ask3-exit.txt') !== '', 90_000, 1000);
    const msg3 = fake.outbound.sendMessage.find((m) => m.text.includes('Anyone there?'));
    const ask3 = ((await api('GET', '/api/asks?state=expired')).json.asks as Rec[]).find((a) => a.question === 'Anyone there?');
    const exp3 = fake.outbound.editMessageText.find((e) => e.text.startsWith('⌛ Expired'));
    record('an unanswered ask expires: `--wait` exits 5, message edited to "Expired"', expiredExit && read('ask3-exit.txt').trim() === '5' && !!ask3 && !!exp3 && !!msg3,
      `exit=${read('ask3-exit.txt').trim()} state=${ask3?.state}/${ask3?.resolution} edit=${JSON.stringify(exp3?.text)}`);

    // audit
    const auditPath = join(home, `.kookr-${port}`, 'telegram', 'audit.jsonl');
    const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
    const kinds = [...new Set(audit.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind as string).filter((k) => k.startsWith('ask_')))];
    record('every ask event is audited, without question text or button data', ['ask_sent', 'ask_answered', 'ask_rejected', 'ask_finalized'].every((k) => kinds.includes(k))
      && !audit.includes('Deploy build 42') && !audit.includes(kb1[0]!.callback_data.split(':')[3]!), `ask_* kinds: ${kinds.join(', ')}`);
    const dataDir = join(home, `.kookr-${port}`, 'asks');
    record('store and secret are private (0600)', ['secret', 'asks.json'].every((f) => (spawnSync('stat', ['-c', '%a', join(dataDir, f)], { encoding: 'utf8' }).stdout.trim() === '600')), `asks dir: ${dataDir}`);
    await api('DELETE', `/api/tasks/${taskId}`);
  } finally {
    await stopServer();
    await fake.stop();
  }

  // 6. flag-off: Telegram unconfigured
  port = await freePort();
  const up2 = await startServer(serverEnv({}));
  record('flag-off: server boots without Telegram', up2, `port=${port}`);
  if (up2) {
    const r = await api('POST', '/api/asks', { taskId: 'x', question: 'Q?', options: ['a', 'b'] });
    const cli = spawnSync(process.execPath, [join(REPO, 'bin/kookr.js'), 'ask', '--question', 'Q?', '--option', 'a', '--option', 'b', '--task-id', 'x'],
      { env: { PATH: process.env.PATH ?? '', HOME: home, KOOKR_API_BASE_URL: base() }, encoding: 'utf8' });
    const dataDir = join(home, `.kookr-${port}`);
    record('flag-off: POST /api/asks -> 503, `kookr ask` exits 7, nothing written to disk', r.status === 503 && cli.status === 7 && !existsSync(join(dataDir, 'asks')),
      `http=${r.status} ${JSON.stringify(r.json)}\ncli exit=${cli.status} stderr=${JSON.stringify(cli.stderr.trim())}\nasks dir exists: ${existsSync(join(dataDir, 'asks'))}`);
    await stopServer();
  }
}

main()
  .catch((err) => { record('script error', false, String(err?.stack ?? err)); })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    const evidenceIdx = process.argv.indexOf('--evidence');
    if (evidenceIdx > 0 && process.argv[evidenceIdx + 1]) {
      const md = ['# kookr ask — hermetic live proof', '', `Run: ${new Date().toISOString()} · ${results.length - failed.length}/${results.length} checks passed`, '',
        ...results.map((r) => `- **${r.pass ? 'PASS' : 'FAIL'}** ${r.name}\n  \`\`\`\n  ${r.evidence.replace(/\n/g, '\n  ')}\n  \`\`\``)].join('\n');
      writeFileSync(process.argv[evidenceIdx + 1]!, md + '\n');
    }
    // The server's per-port terminal socket dir lives outside the temp dir: remove only the ports this run used.
    const uid = process.getuid?.() ?? 0;
    for (const p of usedPorts) rmSync(join(tmpdir(), 'kookr-dtach', String(uid), `port-${p}`), { recursive: true, force: true });
    if (process.env.E2E_KEEP !== '1') rmSync(work, { recursive: true, force: true }); else console.log(`kept ${work}`);
    process.exit(failed.length ? 1 : 0);
  });
