/**
 * Hermetic browser proof that Lucy speaks up when a task has waited on a permission prompt
 * (issue #3932). NOT part of `pnpm test`.
 *
 *   pnpm build:frontend
 *   node --import tsx scripts/lucy-permission-browser-proof.ts [--out <dir>] [--tts-url http://127.0.0.1:8004] [--after-seconds N]
 *
 * `--after-seconds N` writes `lucyPermissionNoticeAfterSeconds: N` to the temp settings (a quicker run; the
 * "nothing before 60 s" check is then skipped).
 *
 * A real Kookr server from this checkout (temp HOME, free loopback port, no Telegram), the built
 * dashboard in headless Chromium with the avatar panel on, and real tasks whose stand-in agent fires
 * the hook events of a Claude Code permission prompt, draws the prompt's menu in its terminal and
 * records the key pressed. It checks, with screenshots (and, with `--tts-url`, her clips as WAV) in `--out`:
 *   1. no card before 60 s; at 60 s one card with the whole command and one spoken sentence that
 *      holds no command text;
 *   2. two more tasks blocked within the minute: three cards, still one sentence;
 *   3. after the 2-minute gap, one grouped sentence ("Two more tasks are waiting for you.");
 *   4. a reload shows the same cards and she says nothing again;
 *   5. Approve once on one card presses the prompt's "Yes" key, Deny on another its "No" key,
 *      and each card goes;
 *   6. each spoken notice is one `said` line in lucy-interactions.jsonl.
 * Never touches ~/.kookr or port 4800; only kills the server PID it spawned. Runs about 4 minutes.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { AVATAR_PANEL_KEY, AVATAR_TRAY_EXPANDED_KEY } from '../src/frontend/store/avatar-panel-prefs.js';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from '../src/frontend/store/onboarding-status.js';

const REPO = resolve(__dirname, '..');
const DTACH = join(REPO, 'vendor/dtach/dtach');
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

const work = mkdtempSync(join(tmpdir(), 'lucy-permission-proof-'));
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
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
}
const readProof = (name: string): string => { try { return readFileSync(join(proof, name), 'utf8'); } catch { return ''; } };

// A stand-in for `claude`: it takes the prompt's "RUN: " line as the Bash command it wants to run, fires the
// hook events Claude Code fires for a permission prompt, draws the prompt's menu, and records the key pressed.
const fakeAgent = join(work, 'fake-claude');
writeFileSync(fakeAgent, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2.0.0 (fake)"; exit 0; fi
P="${proof}"
SETTINGS=""
while [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then SETTINGS="$2"; fi; shift; done
hookcmd() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const hs=d.hooks||{};const h=hs[process.argv[2]]||hs.SessionStart;process.stdout.write((h&&h[0]&&h[0].hooks[0].command)||"")' "$SETTINGS" "$1"; }
# fire EVENT JSON-FIELDS
fire() { C=$(hookcmd "$1"); [ -n "$C" ] || return 0; node -e 'process.stdout.write(JSON.stringify({hook_event_name:process.argv[1],session_id:"fake-"+process.env.KOOKR_TASK_ID,cwd:process.cwd(),...JSON.parse(process.argv[2]||"{}")}))' "$1" "$2" | sh -c "$C" >/dev/null 2>&1; }
fire SessionStart '{}'
read -r -t 120 INITIAL
while IFS= read -r -t 2 MORE; do INITIAL="$INITIAL"$'\\n'"$MORE"; done
# Kookr puts its own instructions before the prompt: the command is on the line that starts with "RUN: ".
CMD=$(printf '%s' "$INITIAL" | sed -e 's/\\x1b\\[20[01]~//g' -e 's/\\r//g' | sed -n 's/^RUN: //p' | tail -n 1)
fire UserPromptSubmit "$(node -e 'process.stdout.write(JSON.stringify({prompt:process.argv[1]}))' "$INITIAL")"
INPUT=$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$CMD")
fire PreToolUse "$(node -e 'const o=JSON.parse(process.argv[1]);o.tool_use_id="toolu_1";process.stdout.write(JSON.stringify(o))' "$INPUT")"
fire PermissionRequest "$INPUT"
printf '\\n● Bash(%s)\\n\\n Bash command\\n\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. Yes, and don'"'"'t ask again for this command\\n   3. No, and tell Claude what to do differently (esc)\\n' "$(printf '%s' "$CMD" | head -n 1)"
fire Notification '{"message":"Claude needs your permission to use Bash","notification_type":"permission_prompt"}'
echo "$KOOKR_TASK_ID" >> "$P/blocked.txt"
# Only a menu digit answers the prompt: the Enter Kookr may send after the initial prompt is not an answer.
while IFS= read -rsn1 KEY; do case "$KEY" in [1-9]) break ;; esac; done
echo "$KOOKR_TASK_ID=$KEY" >> "$P/answers.txt"
fire PostToolUse "$(node -e 'const o=JSON.parse(process.argv[1]);o.tool_use_id="toolu_1";o.tool_response={stdout:""};process.stdout.write(JSON.stringify(o))' "$INPUT")"
fire Stop '{}'
while IFS= read -r L; do :; done
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
  const target = page.getByTestId('avatar-dock');
  const box = await target.boundingBox();
  if (box) await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 48 } });
  else await page.screenshot({ path: file });
  return file;
}

const COMMAND_A = 'git push --force-with-lease origin feat-login-redirect';
const COMMAND_B = 'rm -rf node_modules/.cache dist/frontend';
const COMMAND_C = 'curl -fsS https://registry.npmjs.org/vite/latest';

async function main(): Promise<void> {
  port = await freePort();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-software-rasterizer'] });
  try {
    const afterSeconds = arg('--after-seconds');
    if (afterSeconds) {
      mkdirSync(join(home, `.kookr-${port}`), { recursive: true });
      writeFileSync(join(home, `.kookr-${port}`, 'settings.json'), JSON.stringify({ lucyPermissionNoticeAfterSeconds: Number(afterSeconds) }));
    }
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server/start.ts'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${join(REPO, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
        KOOKR_PORT: String(port), KOOKR_HOST: '127.0.0.1', KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '1',
        KOOKR_AGENT_BIN: fakeAgent, KOOKR_PLUGIN_DIR: '',
        ...(ttsUrl ? { KOOKR_TTS_URL: ttsUrl } : {}),
      },
    });
    server.stdout!.on('data', (d) => { serverLog += d; });
    server.stderr!.on('data', (d) => { serverLog += d; });
    const up = await waitFor(async () => { try { return (await fetch(`${base()}/api/health`)).ok; } catch { return false; } }, 90_000, 1000);
    record('server boots (isolated, no Telegram)', up, `port=${port} speech=${ttsUrl ?? 'none'}`);
    if (!up) { console.log(serverLog.slice(-1500)); return; }

    const launch = async (command: string, name: string): Promise<string> => {
      const launched = await api('POST', '/api/tasks', { prompt: `RUN: ${command}`, cwd: repo, agentType: 'claude-code' });
      const taskId: string | undefined = launched.json?.task?.id ?? launched.json?.id ?? launched.json?.taskId;
      if (!taskId) throw new Error(`launch failed: ${launched.status} ${JSON.stringify(launched.json).slice(0, 300)}`);
      await api('PATCH', `/api/tasks/${taskId}/name`, { name });
      if (!(await waitFor(() => readProof('blocked.txt').includes(taskId), 90_000))) throw new Error(`task ${name} never reached its prompt`);
      return taskId;
    };

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(([avatarKey, onboardingKey, trayKey]) => {
      localStorage.setItem(avatarKey, JSON.stringify({ enabled: true, minimized: false, position: null }));
      localStorage.setItem(onboardingKey, 'true');
      // The "Waiting on you" strip starts folded; this proof is about what is in it, so it starts unfolded.
      sessionStorage.setItem(trayKey, '1');
    }, [AVATAR_PANEL_KEY, ONBOARDING_STORAGE_KEY, AVATAR_TRAY_EXPANDED_KEY]);
    const page = await context.newPage();
    const speaks: Array<{ status: number; text?: string }> = [];
    page.on('response', async (response) => {
      if (!response.url().endsWith('/api/lucy/permission-notice/speak')) return;
      const entry: { status: number; text?: string } = { status: response.status() };
      speaks.push(entry);
      if (response.ok()) {
        const body = await response.json().catch(() => null) as { text?: string; audioBase64?: string } | null;
        if (body?.text) entry.text = body.text;
        if (body?.audioBase64) writeFileSync(join(out, `notice-${speaks.length}.wav`), Buffer.from(body.audioBase64, 'base64'));
      }
    });
    await page.goto(base());
    await page.getByTestId('avatar-dock').waitFor({ state: 'visible', timeout: 30_000 });
    // One click in the page, as an operator at the dashboard has made: the browser then lets her speak.
    await page.mouse.click(400, 300);
    const cards = page.getByTestId('avatar-permission');

    // 1. the first task: nothing before 60 s, then one card and one sentence
    const taskA = await launch(COMMAND_A, 'Fix the login redirect');
    const blockedAt = Date.now();
    // The other two are started now, so that all three are blocked within about a minute of the first.
    const laterTasks = sleep(10_000).then(() => Promise.all([
      launch(COMMAND_B, 'Clear the build cache'),
      launch(COMMAND_C, 'Check the vite release'),
    ]));
    laterTasks.catch(() => undefined);
    await sleep(afterSeconds ? 0 : 40_000);
    if (!afterSeconds) record('no card and no sentence 40 s into the wait', (await cards.count()) === 0 && speaks.length === 0, `cards=${await cards.count()} speak requests=${speaks.length}`);
    const carded = await waitFor(async () => (await cards.count()) >= 1, 40_000);
    const cardSeconds = Math.round((Date.now() - blockedAt) / 1000);
    const command = await page.getByTestId('avatar-permission-command').first().innerText().catch(() => '');
    record('at about 60 s her panel shows one card with the whole command and both buttons', carded && command === COMMAND_A
      && (await page.getByTestId('avatar-permission-approve').count()) === 1 && (await page.getByTestId('avatar-permission-deny').count()) === 1,
    `card after ~${cardSeconds} s; command on card: ${JSON.stringify(command)}`);
    await waitFor(() => speaks.length > 0 && (speaks[0]!.status !== 200 || speaks[0]!.text !== undefined), 75_000);
    const first = speaks[0];
    if (ttsUrl) {
      const expected = 'The task "Fix the login redirect" is waiting for your permission to use Bash. The command is on my card.';
      const spoke = await waitFor(async () => (await page.getByTestId('avatar-dock').getAttribute('data-avatar-state')) === 'speaking', 20_000, 100);
      record('she says one sentence, written by the server, with no command text', first?.status === 200 && first.text === expected && spoke
        && !/git|push|force|login-redirect/.test(first.text.replace('Fix the login redirect', '')),
      `speak -> ${first?.status}; she said: ${JSON.stringify(first?.text)}; panel went to "speaking": ${spoke}; clip saved as notice-1.wav`);
    } else {
      record('without a speech service the card is shown and nothing is played', first?.status === 503, `speak -> ${first?.status}`);
    }
    console.log(`     screenshot: ${await shot(page, '01-first-card.png')}`);

    // 2. two more tasks blocked within the minute: three cards, still one sentence
    const [taskB, taskC] = await laterTasks;
    const lastBlockedSeconds = Math.round((Date.now() - blockedAt) / 1000);
    const three = await waitFor(async () => (await cards.count()) === 3, 80_000);
    record('three tasks blocked within a minute give three cards, and still one sentence', three && speaks.length === 1,
      `cards=${await cards.count()} speak requests=${speaks.length}; the last two blocked within ${lastBlockedSeconds} s of the first`);
    console.log(`     screenshot: ${await shot(page, '02-three-cards.png')}`);

    // 3. after the gap, one grouped sentence
    const grouped = await waitFor(() => speaks.length >= 2 && (speaks[1]!.status !== 200 || speaks[1]!.text !== undefined), 150_000);
    const second = speaks[1];
    const gapSeconds = Math.round((Date.now() - blockedAt) / 1000);
    record('after the 2-minute gap she says one grouped sentence', grouped && (ttsUrl ? second?.text === 'Two more tasks are waiting for you.' : second?.status === 503),
      `second notice ~${gapSeconds} s after the first prompt; speak -> ${second?.status}; she said: ${JSON.stringify(second?.text)}`);
    await sleep(ttsUrl ? 4000 : 500);

    // 4. reload: same cards, nothing said again
    const before = speaks.length;
    await page.reload();
    await page.getByTestId('avatar-dock').waitFor({ state: 'visible', timeout: 30_000 });
    const back = await waitFor(async () => (await cards.count()) === 3, 15_000);
    await sleep(5000);
    record('after a reload the three cards are back and she says nothing again', back && speaks.length === before,
      `cards=${await cards.count()} speak requests before/after reload: ${before}/${speaks.length}`);
    console.log(`     screenshot: ${await shot(page, '03-after-reload.png')}`);

    // 5. Approve once on A, Deny on B
    const cardOf = (taskId: string) => cards.filter({ has: page.locator(`[data-testid="avatar-permission-ask"]`) }).filter({ hasText: taskId === taskA ? 'Fix the login redirect' : taskId === taskB ? 'Clear the build cache' : 'Check the vite release' });
    await page.mouse.click(400, 300);
    await cardOf(taskA).getByTestId('avatar-permission-approve').click();
    const approved = await waitFor(() => readProof('answers.txt').includes(`${taskA}=1`), 15_000);
    const goneA = await waitFor(async () => (await cards.count()) === 2, 20_000);
    record('Approve once presses the prompt\'s one-time "Yes" (1) and the card goes', approved && goneA, `answers: ${JSON.stringify(readProof('answers.txt').trim())}; cards=${await cards.count()}`);
    await cardOf(taskB).getByTestId('avatar-permission-deny').click();
    const denied = await waitFor(() => readProof('answers.txt').includes(`${taskB}=3`), 15_000);
    const goneB = await waitFor(async () => (await cards.count()) === 1, 20_000);
    record('Deny presses the prompt\'s "No" (3) and the card goes', denied && goneB, `answers: ${JSON.stringify(readProof('answers.txt').trim())}; cards=${await cards.count()}`);
    console.log(`     screenshot: ${await shot(page, '04-after-approve-and-deny.png')}`);

    // 6. the interaction log
    if (ttsUrl) {
      const said = (() => {
        try {
          return readFileSync(join(home, `.kookr-${port}`, 'lucy-interactions.jsonl'), 'utf8').split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as Rec).filter((l) => l.kind === 'said' && l.source === 'permission_notice');
        } catch { return []; }
      })();
      record('each spoken notice is one line in lucy-interactions.jsonl', said.length === 2, said.map((l) => JSON.stringify({ source: l.source, text: l.text })).join('\n'));
    }
    for (const id of [taskA, taskB, taskC]) await api('DELETE', `/api/tasks/${id}`);
  } finally {
    await browser.close().catch(() => undefined);
    if (server?.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ } await sleep(1500); }
  }
}

main()
  .catch((err) => { record('script error', false, String(err?.stack ?? err)); })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    writeFileSync(join(out, 'server.log'), serverLog);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
    if (failed.length) console.log(`server log:\n${serverLog.split('\n').filter((l) => /lucy-permission|tts|speak|permission/i.test(l)).slice(-15).join('\n')}`);
    const uid = process.getuid?.() ?? 0;
    rmSync(join(tmpdir(), 'kookr-dtach', String(uid), `port-${port}`), { recursive: true, force: true });
    if (!arg('--out')) console.log(`(pass --out <dir> to keep the screenshots somewhere permanent; temp dir: ${work})`);
    else rmSync(join(work, 'home'), { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
