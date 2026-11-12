/**
 * Hermetic browser proof that Lucy asks `kookr ask` questions in the dashboard
 * and stays in step with Telegram (NOT part of `pnpm test`).
 *
 *   pnpm build:frontend
 *   node --import tsx scripts/ask-lucy-browser-proof.ts [--out <dir>] [--tts-url http://127.0.0.1:8004]
 *
 * Companion to `ask-live-proof.ts`, which proves the same record is shared by
 * both channels at the API level. This one looks at what the operator sees: a
 * real Kookr server from this checkout (temp HOME, free loopback port, Telegram
 * pointed at the in-process fake server), the built dashboard in headless
 * Chromium with the avatar panel switched on, and a real task whose stand-in
 * agent records what is typed into its terminal. It checks, with screenshots
 * written to `--out`:
 *   1. a question appears as a card in Lucy's panel the moment it is asked;
 *      with `--tts-url` (a running Kookr speech service) she also reads it out;
 *   2. pressing a choice there types the answer into the task and edits the
 *      Telegram message to "Already answered in Kookr";
 *   3. a question answered on Telegram turns its card into "Answered on
 *      Telegram" without a reload;
 *   4. minimised, the bubble counts the waiting question;
 *   5. a reload shows the same cards and does not make her ask again.
 * Never touches ~/.kookr or port 4800; only kills the server PID it spawned.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startFakeTelegram } from '../src/integrations/telegram/fake-telegram-server.js';
import { AVATAR_PANEL_KEY } from '../src/frontend/store/avatar-panel-prefs.js';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from '../src/frontend/store/onboarding-status.js';

const REPO = resolve(__dirname, '..');
const DTACH = join(REPO, 'vendor/dtach/dtach');
const USER = 4242;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Rec = Record<string, any>;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ttsUrl = arg('--tts-url');

const results: Array<{ name: string; pass: boolean; evidence: string }> = [];
function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}\n     ${evidence.replace(/\n/g, '\n     ')}`);
}

if (!existsSync(DTACH)) { console.log(`SKIP: no vendored dtach at ${DTACH} (pnpm build:dtach)`); process.exit(0); }
if (!existsSync(join(REPO, 'dist', 'frontend', 'index.html'))) { console.log('SKIP: no built dashboard (pnpm build:frontend)'); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'ask-lucy-proof-'));
const home = join(work, 'home');
const proof = join(work, 'proof');
const out = resolve(arg('--out') ?? join(work, 'screenshots'));
for (const dir of [home, proof, out]) mkdirSync(dir, { recursive: true });

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, step = 200): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
}
const typed = (): string => { try { return readFileSync(join(proof, 'typed.txt'), 'utf8'); } catch { return ''; } };

// A stand-in for `claude`: enough lifecycle for Kookr to treat it as a live session, then it records every line typed into it.
const fakeAgent = join(work, 'fake-claude');
writeFileSync(fakeAgent, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2.0.0 (fake)"; exit 0; fi
P="${proof}"
SETTINGS=""
while [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then SETTINGS="$2"; fi; shift; done
hookcmd() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const h=(d.hooks||{})[process.argv[2]];process.stdout.write((h&&h[0]&&h[0].hooks[0].command)||"")' "$SETTINGS" "$1"; }
fire() { C=$(hookcmd "$1"); [ -n "$C" ] || return 0; node -e 'process.stdout.write(JSON.stringify({hook_event_name:process.argv[1],session_id:"fake-session",cwd:process.cwd(),prompt:process.argv[2]||""}))' "$1" "$2" | sh -c "$C" >/dev/null 2>&1; }
echo "task=$KOOKR_TASK_ID" > "$P/agent-started.txt"
fire SessionStart ""
# the initial prompt is multi-line: read until the terminal goes quiet, like an agent TUI would
read -r -t 120 INITIAL
while IFS= read -r -t 2 MORE; do INITIAL="$INITIAL"$'\\n'"$MORE"; done
fire UserPromptSubmit "$INITIAL"
fire Stop ""
while IFS= read -r L; do
  L=$(printf '%s' "$L" | sed -e 's/\\x1b\\\\[20[01]~//g' -e 's/\\r$//')
  if [ -n "$L" ]; then printf '%s\\n' "$L" >> "$P/typed.txt"; fire UserPromptSubmit "$L"; fire Stop ""; fi
done
`);
chmodSync(fakeAgent, 0o755);

const repo = join(work, 'repo');
mkdirSync(repo, { recursive: true });
for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'proof@example.invalid'], ['config', 'user.name', 'proof'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
  execFileSync('git', ['-C', repo, ...args]);
}

let server: ChildProcess | undefined;
let serverLog = '';
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base()}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

async function shot(page: Page, name: string): Promise<string> {
  const file = join(out, name);
  // The panel floats in the bottom-right corner; clip to it (and the bubble) so the card is legible.
  const target = page.locator('[data-testid="avatar-dock"], [data-testid="avatar-bubble"]').first();
  const box = await target.boundingBox();
  if (box) {
    await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 48 } });
  } else {
    await page.screenshot({ path: file });
  }
  return file;
}

async function main(): Promise<void> {
  port = await freePort();
  const fake = await startFakeTelegram();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  try {
    // Hermetic: nothing from the operator's shell (telegram, relay, KOOKR_TASK_ID, ...) leaks in.
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${join(REPO, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
        KOOKR_PORT: String(port), KOOKR_HOST: '127.0.0.1', KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '1',
        KOOKR_AGENT_BIN: fakeAgent, KOOKR_PLUGIN_DIR: '',
        KOOKR_TELEGRAM_BOT_TOKEN: 'fake-bot-token', KOOKR_TELEGRAM_ALLOWED_USERS: String(USER),
        KOOKR_REMOTE_CHAT_PROJECTS: repo, KOOKR_TELEGRAM_API_URL: fake.baseUrl,
        ...(ttsUrl ? { KOOKR_TTS_URL: ttsUrl } : {}),
      },
    });
    server.stdout!.on('data', (d) => { serverLog += d; });
    server.stderr!.on('data', (d) => { serverLog += d; });
    const up = await waitFor(async () => { try { return (await fetch(`${base()}/api/health`)).ok; } catch { return false; } }, 90_000, 1000);
    record('server boots (isolated, Telegram -> fake server)', up, `port=${port} speech=${ttsUrl ?? 'none'}`);
    if (!up) { console.log(serverLog.slice(-1500)); return; }

    const launched = await api('POST', '/api/tasks', { prompt: 'lucy-ask-proof', cwd: repo, agentType: 'claude-code' });
    const taskId: string | undefined = launched.json?.task?.id ?? launched.json?.id ?? launched.json?.taskId;
    const started = !!taskId && await waitFor(() => existsSync(join(proof, 'agent-started.txt')), 30_000);
    record('a real task is running', started, `taskId=${taskId} status=${launched.status} ${taskId ? '' : JSON.stringify(launched.json).slice(0, 300)}`);
    // A short title, so the card and Lucy can say which task is asking.
    if (taskId) await api('PATCH', `/api/tasks/${taskId}/name`, { name: 'Billing migration' });
    if (!taskId || !started) return;

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The avatar panel switched on, and the first-run tour marked as seen so its overlay does not cover the page.
    await context.addInitScript(([avatarKey, onboardingKey]) => {
      localStorage.setItem(avatarKey, JSON.stringify({ enabled: true, minimized: false, position: null }));
      localStorage.setItem(onboardingKey, 'true');
    }, [AVATAR_PANEL_KEY, ONBOARDING_STORAGE_KEY]);
    const page = await context.newPage();
    let speakRequests = 0;
    const speakStatuses: number[] = [];
    page.on('response', (response) => {
      if (/\/api\/asks\/[0-9a-f]{12}\/speak$/.test(response.url())) { speakRequests += 1; speakStatuses.push(response.status()); }
    });
    await page.goto(base());
    const dock = page.getByTestId('avatar-dock');
    await dock.waitFor({ state: 'visible', timeout: 30_000 });
    record('the dashboard shows Lucy with no question yet', (await page.getByTestId('avatar-ask').count()) === 0, 'avatar panel open, no cards');

    const ask = async (question: string, options: string[], extra: Rec = {}): Promise<Rec> => {
      const r = await api('POST', '/api/asks', { taskId, question, options, ...extra });
      if (r.status !== 201) throw new Error(`POST /api/asks -> ${r.status} ${JSON.stringify(r.json)}`);
      return r.json.ask as Rec;
    };
    const card = (id: string) => page.locator(`[data-testid="avatar-ask"][data-ask-id="${id}"]`);

    // 1. a question appears, and she reads it out
    const q1 = await ask('The migration renames two billing tables. Run it on production now?', ['Run it now', 'Run it tonight', 'Do not run it'],
      { context: 'Staging ran clean in 40 seconds. Production has about 3 million rows, so expect a short write lock on invoices.' });
    await card(q1.id).waitFor({ state: 'visible', timeout: 15_000 });
    const cardText = (await card(q1.id).innerText()).replace(/\s+/g, ' ');
    record('the question appears as a card in Lucy\'s panel, with one button per choice', /asks/.test(cardText) && (await card(q1.id).getByTestId('avatar-ask-option').count()) === 3, cardText);
    if (ttsUrl) {
      const spoke = await waitFor(async () => (await dock.getAttribute('data-avatar-state')) === 'speaking', 30_000, 100);
      const said = (await page.getByTestId('avatar-message').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      record('Lucy reads the question out by herself (real speech service)', spoke && speakStatuses[0] === 200 && /needs your input/.test(said) && /Run it now, Run it tonight, or Do not run it/.test(said),
        `speak route -> ${speakStatuses.join(',')}; panel state went to "speaking"; she said: ${JSON.stringify(said.slice(0, 220))}`);
    } else {
      await waitFor(() => speakRequests > 0, 10_000);
      record('without a speech service the card is shown and nothing is played', speakStatuses[0] === 503, `speak route -> ${speakStatuses.join(',')}`);
    }
    await card(q1.id).locator('summary').click();
    console.log(`     screenshot: ${await shot(page, '01-question-asked.png')}`);

    // 2. answer it in her panel
    await card(q1.id).getByTestId('avatar-ask-option').nth(1).click();
    const answeredHere = await waitFor(async () => (await card(q1.id).getAttribute('data-ask-state')) === 'answered', 15_000);
    const outcome1 = await card(q1.id).getByTestId('avatar-ask-outcome').innerText().catch(() => '');
    record('pressing a choice in her panel closes the card as "You answered"', answeredHere && outcome1 === 'You answered: Run it tonight', outcome1);
    const typedOk = await waitFor(() => typed().includes(`Operator answered ask ${q1.id}: Run it tonight`), 30_000);
    record('the answer is typed into the task', typedOk, JSON.stringify(typed().trim()));
    const edited = await waitFor(() => fake.outbound.editMessageText.some((e) => e.message_id === q1.delivery.messageId), 10_000);
    const edit1 = fake.outbound.editMessageText.find((e) => e.message_id === q1.delivery.messageId);
    record('Telegram shows the question as already answered in Kookr', edited && !!edit1 && edit1.text.startsWith('✅ Already answered in Kookr: Run it tonight'), JSON.stringify(edit1?.text));
    if (ttsUrl) {
      const quiet = await waitFor(async () => (await dock.getAttribute('data-avatar-state')) === 'idle', 5_000, 100);
      record('she stops reading the question once it is answered', quiet, `panel state: ${await dock.getAttribute('data-avatar-state')}`);
    }
    console.log(`     screenshot: ${await shot(page, '02-answered-in-kookr.png')}`);

    // 3. a question answered on Telegram
    const q2 = await ask('Squash the three fixup commits before merging?', ['Squash', 'Keep them']);
    await card(q2.id).waitFor({ state: 'visible', timeout: 15_000 });
    const msg2 = fake.outbound.sendMessage.find((m) => m.text.includes('Squash the three fixup commits'));
    const kb2 = ((msg2?.reply_markup as any)?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data: string }>;
    fake.queueUpdates([{ update_id: 9001, callback_query: { id: 'cb-9001', from: { id: USER }, data: kb2[0]!.callback_data, message: { message_id: q2.delivery.messageId, chat: { id: USER, type: 'private' } } } } as any]);
    const answeredThere = await waitFor(async () => (await card(q2.id).getAttribute('data-ask-state')) === 'answered', 15_000);
    const outcome2 = await card(q2.id).getByTestId('avatar-ask-outcome').innerText().catch(() => '');
    record('an answer given on Telegram turns the card into "Answered on Telegram", with no reload', answeredThere && outcome2 === 'Answered on Telegram: Squash', outcome2);
    console.log(`     screenshot: ${await shot(page, '03-answered-on-telegram.png')}`);

    // 4. minimised: the bubble counts the waiting question
    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    const q3 = await ask('Delete the old feature flag as well?', ['Delete it', 'Leave it'], { allowText: false });
    const bubble = page.getByTestId('avatar-bubble');
    const badged = await waitFor(async () => (await bubble.locator('.avatar-bubble-badge').innerText().catch(() => '')) === '1', 15_000);
    record('minimised, the bubble counts the waiting question', badged && /1 question is waiting for your answer/.test((await bubble.getAttribute('aria-label')) ?? ''), (await bubble.getAttribute('aria-label')) ?? '');
    console.log(`     screenshot: ${await shot(page, '04-bubble.png')}`);

    // 5. reload: same cards, and she does not ask again
    await waitFor(() => speakRequests >= 3, 20_000);
    const before = speakRequests;
    await page.reload(); // the init script above opens the panel again on every load
    await card(q3.id).waitFor({ state: 'visible', timeout: 30_000 });
    await sleep(2500);
    const states = await Promise.all([q1.id, q2.id, q3.id].map(async (id) => `${await card(id).getAttribute('data-ask-state').catch(() => 'missing')}`));
    record('after a reload the same cards are shown and she does not ask again', states.join(',') === 'answered,answered,pending' && speakRequests === before,
      `card states: ${states.join(', ')}; speak requests before/after reload: ${before}/${speakRequests}`);
    console.log(`     screenshot: ${await shot(page, '05-after-reload.png')}`);
    await api('DELETE', `/api/tasks/${taskId}`);
  } finally {
    await browser.close().catch(() => undefined);
    if (server?.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ } await sleep(1500); }
    await fake.stop();
  }
}

main()
  .catch((err) => { record('script error', false, String(err?.stack ?? err)); })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
    if (failed.length) console.log(`server log (asks, speech):\n${serverLog.split('\n').filter((l) => /\[asks\]|tts|speak/i.test(l)).slice(-12).join('\n')}`);
    const uid = process.getuid?.() ?? 0;
    rmSync(join(tmpdir(), 'kookr-dtach', String(uid), `port-${port}`), { recursive: true, force: true });
    if (!arg('--out')) console.log(`(pass --out <dir> to keep the screenshots somewhere permanent; temp dir: ${work})`);
    else rmSync(join(work, 'home'), { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
