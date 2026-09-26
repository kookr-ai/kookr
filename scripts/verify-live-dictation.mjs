/**
 * Replay a known recording through the actual browser capture path at its
 * natural pace. Outputs contain private recognition text; keep them local.
 * Start an isolated Kookr E2E server and STT service first (see the STT skill).
 */
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'app-url': { type: 'string' },
  'stt-url': { type: 'string' },
  audio: { type: 'string' },
  output: { type: 'string' },
  browser: { type: 'string' },
  label: { type: 'string', default: 'dictation' },
} });
if (!values['app-url'] || !values['stt-url'] || !values.audio || !values.output) {
  throw new Error('Required: --app-url URL --stt-url URL --audio FILE --output DIRECTORY [--browser FILE] [--label NAME]');
}
const appURL = new URL(values['app-url']);
const sttURL = new URL(values['stt-url']).href;
const output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 0o700 });
const audio = await readFile(values.audio);
const browser = await chromium.launch({
  ...(values.browser ? { executablePath: values.browser } : {}),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] });
const page = await context.newPage();
const messages = [];
const errors = [];
let firstPartialAt = null;
let stopAt = null;
let terminal = null;
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => {
  if (new URL(socket.url()).href !== sttURL) return;
  socket.on('framesent', ({ payload }) => {
    try { if (JSON.parse(payload.toString()).type === 'stop') stopAt = Date.now(); } catch { /* Binary PCM. */ }
  });
  socket.on('framereceived', ({ payload }) => {
    let message;
    try { message = JSON.parse(payload.toString()); } catch { return; }
    const at = Date.now();
    messages.push({ at, ...message });
    if (firstPartialAt === null && message.is_final !== true && message.isFinal !== true && message.type !== 'error'
      && (message.activeText || message.fixedText || message.text)) firstPartialAt = at;
    if (message.type === 'error' || message.is_final === true) terminal = { at, ...message };
  });
});
await page.route('**/reliability-fixture.wav', route => route.fulfill({ body: audio, contentType: 'audio/wav' }));
await page.addInitScript(({ sttURL }) => {
  localStorage.setItem('kookr:onboarding:seen-v2', 'true');
  window.dictationFixture = { sentSamples: 0, firstSendAt: null, endedAt: null };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (new URL(this.url).href === sttURL && data instanceof ArrayBuffer) {
      window.dictationFixture.sentSamples += data.byteLength / 2;
      window.dictationFixture.firstSendAt ??= Date.now();
    }
    return send.call(this, data);
  };
  AudioContext.prototype.createScriptProcessor = () => { throw new Error('This check requires AudioWorklet capture'); };
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = await context.decodeAudioData(await (await fetch('/reliability-fixture.wav')).arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    await context.resume();
    // Leave time for the app to attach its worklet and open the speech socket.
    source.start(context.currentTime + 0.5);
    Object.assign(window.dictationFixture, { startedAt: Date.now() + 500, durationSeconds: buffer.duration });
    source.onended = () => { window.dictationFixture.endedAt = Date.now(); };
    return destination.stream;
  };
}, { sttURL });
let result;
try {
  await page.goto(appURL.href);
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  const input = page.locator('.quick-launch-input');
  await input.fill('Existing typed draft.');
  await page.getByRole('combobox', { name: 'Dictation language' }).selectOption('fr');
  await page.locator('.btn-voice').click();
  await expect(page.locator('.btn-voice.recording')).toBeVisible();
  const duration = await page.evaluate(() => window.dictationFixture.durationSeconds);
  const startedAt = Date.now();
  console.log(JSON.stringify({ event: 'recording', label: values.label, durationSeconds: duration }));
  while (!terminal && !(await page.evaluate(() => Boolean(window.dictationFixture.endedAt)))) {
    await page.waitForTimeout(1000);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed % 30 === 0) console.log(JSON.stringify({ event: 'progress', elapsedSeconds: elapsed, partialReceived: firstPartialAt !== null }));
    if (elapsed > duration + 15) throw new Error('Browser audio source did not end within its expected duration');
  }
  if (await page.locator('.btn-voice.recording').count()) await page.locator('.btn-voice.recording').click();
  await expect(page.locator('.btn-voice.processing')).toHaveCount(0, { timeout: 130_000 });
  const capture = await page.evaluate(() => window.dictationFixture);
  const text = await input.inputValue();
  result = {
    label: values.label,
    fixture: resolve(values.audio),
    pace: 'real time: WebAudio -> AudioWorklet -> browser WebSocket -> speech service',
    durationSeconds: duration,
    firstPartialMs: firstPartialAt === null ? null : firstPartialAt - capture.firstSendAt,
    stopToFinalMs: terminal && stopAt !== null ? terminal.at - stopAt : null,
    negotiatedDeadlineMs: messages.find(message => message.type === 'config_ack')?.finalization_timeout_ms ?? 15_000,
    outcome: terminal?.type ?? 'no-final', terminal, text, capture, errors, messages,
  };
  await page.screenshot({ path: join(output, 'browser.png'), fullPage: true });
  console.log(JSON.stringify({ event: 'done', durationSeconds: duration, firstPartialMs: result.firstPartialMs, stopToFinalMs: result.stopToFinalMs, outcome: result.outcome }));
} catch (error) {
  result = { label: values.label, harnessError: String(error), messages, errors };
  await page.screenshot({ path: join(output, 'browser-error.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  await context.close();
  await browser.close();
}
