import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { resetServer, getTasks } from './battle-helpers.js';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

/** Exercise real browser capture and UI; inference text is deterministic here. */
async function speechService(page: Page) {
  const languages: string[] = [];
  await page.routeWebSocket(/^ws:\/\/localhost:9999/, (socket) => {
    let previewSent = false;
    socket.onMessage((data) => {
      if (typeof data !== 'string') {
        if (!previewSent) {
          previewSent = true;
          socket.send(JSON.stringify({ type: 'progressive', activeText: 'Texte provisoire' }));
        }
        return;
      }
      const message = JSON.parse(data) as { type: string; language: string };
      if (message.type === 'config') {
        languages.push(message.language);
        socket.send(JSON.stringify({ type: 'config_ack', language: message.language }));
      } else if (message.type === 'stop') {
        socket.send(JSON.stringify({ type: 'transcription', text: 'Bonjour, voici ma demande.', is_final: true }));
      }
    });
  });
  return languages;
}

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test('French dictation preserves concurrent typing, appends once, and waits for explicit launch', async ({ page, request }) => {
  const languages = await speechService(page);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  const input = page.locator('.quick-launch-input');
  const language = page.getByRole('combobox', { name: 'Dictation language' });
  await expect(language).toHaveValue('auto');
  await language.selectOption('fr');
  await input.fill('Brouillon.');
  await page.locator('.btn-voice').click();
  await expect(page.locator('.voice-preview')).toHaveText('Texte provisoire');
  await expect(input).toHaveValue('Brouillon.');
  await input.fill('Brouillon. Ajout tapé.');
  await page.locator('.btn-voice.recording').click();
  await expect(input).toHaveValue('Brouillon. Ajout tapé. Bonjour, voici ma demande.');
  expect(languages).toEqual(['fr']);
  await expect(page.locator('.voice-preview')).toHaveCount(0);
  expect(await getTasks(request)).toHaveLength(0);
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  await expect(language).toHaveValue('fr');
});

test('microphone meter follows browser audio, silence, and an ended capture track', async ({ page }) => {
  await speechService(page);
  await page.addInitScript(() => {
    // This Chromium check must exercise AudioWorklet capture, rather than pass
    // through the deprecated fallback when the worklet fails to load.
    AudioContext.prototype.createScriptProcessor = () => { throw new Error('Expected AudioWorklet capture'); };
    // A controllable browser audio source exercises the real PCM worklet and
    // React UI without depending on the host's microphone or ambient noise.
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      gain.gain.value = 0.15;
      oscillator.start();
      await context.resume();
      Object.assign(window, { testMicrophone: { context, gain, track: destination.stream.getAudioTracks()[0] } });
      return destination.stream;
    };
  });
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  await page.locator('.btn-voice').click();
  const signal = page.locator('.voice-signal');
  const tallestBar = () => page.locator('.voice-meter-bar').evaluateAll((bars) =>
    Math.max(...bars.map(bar => bar.getBoundingClientRect().height)));
  await expect(signal).toHaveText('Sound detected');
  await expect.poll(tallestBar).toBeGreaterThan(10);
  type AudioWindow = Window & { testMicrophone: { context: AudioContext; gain: GainNode; track: MediaStreamTrack } };
  await page.evaluate(() => { (window as unknown as AudioWindow).testMicrophone.gain.gain.value = 0; });
  await expect(signal).toHaveText('No sound detected');
  await expect.poll(tallestBar).toBe(2);
  await page.evaluate(() => { (window as unknown as AudioWindow).testMicrophone.gain.gain.value = 0.15; });
  await expect(signal).toHaveText('Sound detected');
  await expect.poll(tallestBar).toBeGreaterThan(10);
  await page.evaluate(() => { (window as unknown as AudioWindow).testMicrophone.track.stop(); });
  await expect(signal).toHaveText('No audio received');
  await expect.poll(tallestBar).toBe(2);
  await page.locator('.btn-voice.recording').click();
  await expect(page.locator('.voice-meter')).toHaveCount(0);
  await expect(signal).toHaveCount(0);
  await page.evaluate(() => (window as unknown as AudioWindow).testMicrophone.context.close());
});

for (const width of [1440, 390]) {
  test(`dictation controls fit quick launch at ${width}px`, async ({ page }) => {
    await speechService(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    await page.keyboard.press('Alt+l');
    await expect(page.getByRole('combobox', { name: 'Dictation language' })).toBeVisible();
    await page.locator('.btn-voice').click();
    await expect(page.locator('.voice-meter')).toBeVisible();
    const bounds = await page.locator('.quick-launch-bar').evaluate((bar) => {
      const parent = bar.getBoundingClientRect();
      return Array.from(bar.querySelectorAll('.quick-launch-input, .voice-input-controls')).map((element) => {
        const child = element.getBoundingClientRect();
        return { left: child.left - parent.left, right: parent.right - child.right, width: child.width };
      });
    });
    expect(bounds).toHaveLength(2);
    for (const bound of bounds) {
      expect(bound.left).toBeGreaterThanOrEqual(0);
      expect(bound.right).toBeGreaterThanOrEqual(0);
    }
    expect(bounds[0].width).toBeGreaterThan(200);
  });
}
