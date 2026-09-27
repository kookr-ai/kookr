import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect } from './dictation-corpus-fixtures.js';
import { getTasks, resetServer } from './battle-helpers.js';

interface Annotation {
  kind: 'submission' | 'task' | 'review';
  submittedText?: string;
  beforeText?: string;
  deliveredText?: string;
  recordingIds?: string[];
  unavailableRecordings?: Array<{ recordingId: string; position: number; reason: string }>;
  taskId?: string;
  correction?: string;
  status?: string;
  field?: string;
}
interface Recording {
  id: string;
  reference: { text: string; reviewRevision: number; confirmedAt: string } | null;
  owner: { draftId: string; field: string } | null;
  metadata: { transcript: string; model: unknown };
  archive: { status: string; complete: boolean };
  audio: { sha256: string; filename: string } | null;
  annotations: Annotation[];
}
interface Manifest { schemaVersion: number; verifiedPairs: Recording[]; candidates: Recording[] }

test.setTimeout(45_000);
test.use({ permissions: ['microphone'], launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

async function recordings(request: APIRequestContext): Promise<Recording[]> {
  const response = await request.get('/api/stt/corpus/records');
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { records: Recording[] }).records;
}

async function deliveredRecordingId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('kookr:dictationCorpus:v1:link:'));
    if (!key) throw new Error('No retained recording link');
    return (JSON.parse(localStorage.getItem(key)!) as { recordingId: string }).recordingId;
  });
}

async function microphone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      tone.frequency.value = 440;
      gain.gain.value = 0.1;
      tone.connect(gain).connect(destination);
      tone.start();
      await context.resume();
      return destination.stream;
    };
  });
}

async function home(page: Page) {
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
}

async function dictate(field: Locator, prediction: string) {
  await field.locator('.btn-voice').click();
  await expect(field.locator('.voice-preview')).toContainText(prediction);
  await field.locator('.btn-voice.recording').click();
  await expect(field.locator('.voice-preview')).toHaveCount(0);
}

async function review(page: Page, id: string) {
  await page.getByTestId('command-trigger').click();
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-action"][data-action-id="settings"]').click();
  await page.getByRole('tab', { name: 'Dictation corpus' }).click();
  await page.getByRole('combobox', { name: 'Recording', exact: true }).selectOption(id);
  const article = page.getByTestId(`corpus-record-${id}`);
  await expect(article).toBeVisible();
  return article;
}

test.beforeEach(async ({ page, request, corpus }) => {
  await resetServer(request);
  await corpus.control('release');
  corpus.prediction = 'Bonjour, ceci est la prédiction originale.';
  const existing = await request.get('/api/stt/corpus/records');
  if (existing.ok()) {
    for (const record of (await existing.json() as { records: Recording[] }).records) {
      expect((await request.delete(`/api/stt/corpus/records/${record.id}`)).ok()).toBeTruthy();
    }
  }
  await microphone(page);
});

test('quick launch keeps edits during slow storage, reloads, reviews one clip and exports verified pairs', async ({ page, request, corpus }, testInfo) => {
  await corpus.control('hold');
  await home(page);
  await page.keyboard.press('Alt+l');
  const input = page.locator('.quick-launch-input');
  await input.fill('Ajout tapé avant la dictée.');
  await dictate(page.locator('.quick-launch-draft'), corpus.prediction);
  const pendingId = await deliveredRecordingId(page);
  await expect(input).toHaveValue(`Ajout tapé avant la dictée. ${corpus.prediction}`);
  const submitted = 'Ajout tapé avant la dictée. Bonjour, voici la correction.\nUne instruction ajoutée.';
  // Quick launch is a single-line input, so the exact authored field has spaces.
  await input.fill(submitted.replace('\n', ' '));
  await input.press('Escape');
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  await expect(input).toHaveValue(submitted.replace('\n', ' '));
  expect(await deliveredRecordingId(page)).toBe(pendingId);
  await input.press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  const task = (await getTasks(request))[0];
  const pending = await (await request.get(`/api/stt/corpus/records/${pendingId}`)).json() as Recording;
  expect(pending.archive.status).toBe('pending');
  expect(pending.annotations).toEqual([]);
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await corpus.control('release');
  await expect.poll(async () => (await recordings(request))[0]?.annotations.filter(a => a.kind === 'task').length).toBe(1);
  const [saved] = await recordings(request);
  expect(saved.metadata.transcript).toBe(corpus.prediction);
  expect(saved.audio?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const audioResponse = await request.get(`/api/stt/corpus/records/${saved.id}/audio`);
  expect(audioResponse.ok()).toBeTruthy();
  const wav = await audioResponse.body();
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.length).toBeGreaterThanOrEqual(44 + 16_000 * 2);
  expect(createHash('sha256').update(wav).digest('hex')).toBe(saved.audio!.sha256);
  expect(saved.reference).toBeNull();
  expect(saved.annotations).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'submission', beforeText: 'Ajout tapé avant la dictée.', deliveredText: corpus.prediction, submittedText: submitted.replace('\n', ' '), recordingIds: [saved.id] }),
    expect.objectContaining({ kind: 'task', taskId: task.id }),
  ]));
  const article = await review(page, saved.id);
  await expect(article).toContainText(corpus.prediction);
  await expect(article).toContainText(submitted.replace('\n', ' '));
  await expect(article).toContainText(task.id);
  const correction = article.getByRole('textbox', { name: 'Correction for this recording' });
  await expect(correction).toHaveValue(corpus.prediction);
  await correction.fill('Bonjour, voici la correction.');
  const listened = article.getByRole('checkbox', { name: 'I listened to this recording and confirm the correction faithfully transcribes it' });
  await expect(listened).toBeDisabled();
  await article.locator('audio').evaluate(async (audio: HTMLAudioElement) => { await audio.play(); });
  await expect(listened).toBeEnabled();
  await article.getByRole('combobox', { name: 'Review status' }).selectOption('faithful');
  await listened.check();
  await article.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect.poll(async () => (await recordings(request))[0]?.annotations.filter(a => a.kind === 'review').length).toBe(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export manifest', exact: true }).click();
  const downloaded = await download;
  const downloadPath = await downloaded.path();
  expect(downloadPath).not.toBeNull();
  const manifest = JSON.parse(await readFile(downloadPath!, 'utf8')) as Manifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.verifiedPairs).toHaveLength(1);
  expect(manifest.verifiedPairs[0]).toMatchObject({ id: saved.id, reference: { text: 'Bonjour, voici la correction.', reviewRevision: 1 }, metadata: { transcript: corpus.prediction }, audio: { sha256: saved.audio!.sha256 } });
  expect(manifest.candidates).toEqual([]);
  const artifacts = join(__dirname, '..', 'runs', 'dictation-corpus-browser');
  await mkdir(artifacts, { recursive: true });
  const screenshot = join(artifacts, 'reviewed-recording.png');
  // Expand the viewport and return the modal's scroll area to its top so the
  // inspection artifact contains audio, both texts and the saved review.
  await page.setViewportSize({ width: 1440, height: 1800 });
  await page.locator('.settings-dialog-body').evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('dialog', { name: 'Settings', exact: true }).screenshot({ path: screenshot });
  await testInfo.attach('Reviewed controlled recording', { path: screenshot, contentType: 'image/png' });
  await downloaded.saveAs(join(artifacts, 'verified-manifest.json'));
});

test('dialog preserves prompt and criteria clips across close, reload and directory switches without copying the whole prompt into references', async ({ page, request, corpus }) => {
  await home(page);
  await page.locator('.btn-launch').click();
  const prompt = page.locator('#launch-task-description');
  await prompt.fill('Instructions tapées.');
  await dictate(prompt.locator('..'), corpus.prediction);
  corpus.prediction = 'La deuxième dictée appartient au même champ.';
  await dictate(prompt.locator('..'), corpus.prediction);
  const criteria = page.getByLabel('Completion criteria (optional)');
  corpus.prediction = 'Les critères dictés restent séparés.';
  await dictate(criteria.locator('..'), corpus.prediction);
  const authoredPrompt = 'Instructions tapées. Première correction. Deuxième correction. Autre ajout.';
  const authoredCriteria = 'Critères corrigés, avec une précision tapée.';
  await prompt.fill(authoredPrompt);
  await criteria.fill(authoredCriteria);
  const cwd = page.locator('#launch-task-cwd');
  const originalCwd = await cwd.inputValue();
  await cwd.fill('/tmp/another-corpus-draft');
  await cwd.fill(originalCwd);
  await page.getByRole('dialog', { name: 'Launch New Task' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.locator('.btn-launch').click();
  await expect(prompt).toHaveValue(authoredPrompt);
  await expect(criteria).toHaveValue(authoredCriteria);
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  await expect.poll(async () => (await recordings(request)).filter(r => r.annotations.some(a => a.kind === 'task')).length).toBe(3);
  const records = await recordings(request);
  const promptRecords = records.filter(r => r.owner?.field === 'prompt');
  const criteriaRecord = records.find(r => r.owner?.field === 'criteria')!;
  expect(promptRecords).toHaveLength(2);
  for (const record of promptRecords) {
    expect(record.annotations.find(a => a.kind === 'submission')).toMatchObject({ submittedText: authoredPrompt, recordingIds: expect.arrayContaining(promptRecords.map(r => r.id)) });
    expect(record.reference).toBeNull();
  }
  expect(criteriaRecord.annotations.find(a => a.kind === 'submission')).toMatchObject({ submittedText: authoredCriteria, recordingIds: [criteriaRecord.id] });
  const response = await request.get('/api/stt/corpus/export');
  const manifest = await response.json() as Manifest;
  expect(manifest.verifiedPairs).toEqual([]);
  expect(manifest.candidates).toHaveLength(3);
});

test('concurrent tabs retain separate recording owners and associate only their acknowledged tasks', async ({ page, context, request, corpus }) => {
  const second = await context.newPage();
  await microphone(second);
  // Both tabs stay open together; localStorage retry events must not retarget
  // the other tab's field or turn a retry into another annotation revision.
  for (const [index, tab] of [page, second].entries()) {
    await home(tab);
    await tab.keyboard.press('Alt+l');
    await dictate(tab.locator('.quick-launch-draft'), corpus.prediction);
    await tab.locator('.quick-launch-input').fill(`Texte soumis dans l’onglet ${index + 1}.`);
  }
  await page.locator('.quick-launch-input').press('Enter');
  await second.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(2);
  await expect.poll(async () => (await recordings(request)).filter(r => r.annotations.some(a => a.kind === 'task')).length).toBe(2);
  const records = await recordings(request);
  expect(new Set(records.map(r => r.owner?.draftId)).size).toBe(2);
  const tasks = await getTasks(request);
  for (const record of records) {
    const submission = record.annotations.filter(a => a.kind === 'submission');
    const acknowledgement = record.annotations.filter(a => a.kind === 'task');
    expect(submission).toHaveLength(1);
    expect(acknowledgement).toHaveLength(1);
    const task = tasks.find(t => t.id === acknowledgement[0].taskId)!;
    expect(task.prompt).toContain(submission[0].submittedText!);
    expect(submission[0].recordingIds).toEqual([record.id]);
  }
  await second.close();
});

test('a failed archive never blocks launch or exports an audio/reference pair', async ({ page, request, corpus }) => {
  await corpus.control('fail');
  await home(page);
  await page.keyboard.press('Alt+l');
  await dictate(page.locator('.quick-launch-draft'), corpus.prediction);
  const failedId = await deliveredRecordingId(page);
  await page.locator('.quick-launch-input').fill('La tâche reste lançable malgré l’échec du disque.');
  await page.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  await expect.poll(async () => (await (await request.get(`/api/stt/corpus/records/${failedId}`)).json() as Recording).archive.status).toBe('failed');
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.getByTestId('command-trigger').click();
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-action"][data-action-id="settings"]').click();
  await page.getByRole('tab', { name: 'Dictation corpus' }).click();
  await expect(page.getByLabel('Dictation archive status')).toContainText(/failed/i);
  await expect(page.locator('audio')).toHaveCount(0);
  const manifest = await (await request.get('/api/stt/corpus/export')).json() as Manifest;
  expect(manifest.verifiedPairs).toEqual([]);
});

for (const restart of [false, true]) {
  test(`a failed first clip cannot suppress a saved sibling's submission${restart ? ' after the archive service restarts' : ''}`, async ({ page, request, corpus }) => {
    await corpus.control('fail');
    await home(page);
    await page.keyboard.press('Alt+l');
    const field = page.locator('.quick-launch-draft');
    await dictate(field, corpus.prediction);
    const failedId = await deliveredRecordingId(page);
    await expect.poll(async () => (await (await request.get(`/api/stt/corpus/records/${failedId}`)).json() as Recording).archive.status).toBe('failed');

    await corpus.control('release');
    corpus.prediction = 'Cette deuxième dictée possède un audio conservé.';
    await dictate(field, corpus.prediction);
    await expect.poll(async () => (await recordings(request)).length).toBe(1);
    const [sibling] = await recordings(request);
    expect(sibling.archive.status).toBe('saved');
    expect(sibling.id).not.toBe(failedId);
    if (restart) {
      await corpus.restart();
      expect((await request.get(`/api/stt/corpus/records/${failedId}`)).status()).toBe(404);
    }

    const submitted = 'Première dictée corrigée. Deuxième dictée corrigée. Instruction tapée supplémentaire.';
    const input = page.locator('.quick-launch-input');
    await input.fill(submitted);
    await input.press('Enter');
    await expect.poll(async () => (await getTasks(request)).length).toBe(1);
    const [task] = await getTasks(request);
    await expect.poll(async () => (await recordings(request))[0]?.annotations.some(annotation => annotation.kind === 'task')).toBe(true);
    const [retained] = await recordings(request);
    const omission = { recordingId: failedId, position: 0, reason: restart ? 'corpus_not_found' : 'corpus_archive_failed' };
    expect(retained.annotations.filter(annotation => annotation.kind === 'submission')).toEqual([
      expect.objectContaining({ submittedText: submitted, deliveredText: corpus.prediction, recordingIds: [sibling.id], unavailableRecordings: [omission] }),
    ]);
    expect(retained.annotations.filter(annotation => annotation.kind === 'task')).toEqual([
      expect.objectContaining({ taskId: task.id }),
    ]);
    expect(retained.reference).toBeNull();

    await page.reload();
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    const article = await review(page, sibling.id);
    await expect(article).toContainText(submitted);
    await expect(article).toContainText(task.id);
    await expect(article).toContainText('1 unavailable recording(s).');
    await expect(article).toContainText(restart
      ? 'The recording is no longer available; its audio may not have saved or may have been deleted.'
      : 'This recording could not be saved in the archive.');
    const manifest = await (await request.get('/api/stt/corpus/export')).json() as Manifest;
    expect(manifest.verifiedPairs).toEqual([]);
    expect(manifest.candidates).toHaveLength(1);
    expect(manifest.candidates[0].annotations.find(annotation => annotation.kind === 'submission')).toMatchObject({ unavailableRecordings: [omission] });
  });
}

test('an external service without recording identity keeps dictation usable and reports unsupported capture', async ({ page, request, corpus }) => {
  await page.routeWebSocket(corpus.url, socket => {
    socket.onMessage(data => {
      if (typeof data !== 'string') {
        socket.send(JSON.stringify({ type: 'progressive', activeText: 'Ancien service sans corpus.' }));
        return;
      }
      const message = JSON.parse(data) as { type: string };
      if (message.type === 'config') socket.send(JSON.stringify({ type: 'config_ack', language: 'auto' }));
      if (message.type === 'stop') socket.send(JSON.stringify({ type: 'transcription', text: 'Ancien service sans corpus.', is_final: true }));
    });
  });
  await home(page);
  await page.keyboard.press('Alt+l');
  await dictate(page.locator('.quick-launch-draft'), 'Ancien service sans corpus.');
  await expect(page.locator('.quick-launch-bar')).toContainText('This speech service does not provide corpus capture.');
  await page.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  expect(await recordings(request)).toEqual([]);
});

test('restoring interrupted text remains incomplete and never creates a verified recording', async ({ page, request, corpus }) => {
  await page.routeWebSocket(corpus.url, socket => {
    socket.onMessage(data => {
      if (typeof data !== 'string') {
        socket.send(JSON.stringify({ type: 'progressive', activeText: 'Ces mots sont incomplets.' }));
        return;
      }
      const message = JSON.parse(data) as { type: string };
      if (message.type === 'config') socket.send(JSON.stringify({ type: 'config_ack', language: 'auto' }));
      if (message.type === 'stop') socket.send(JSON.stringify({ type: 'error', error: 'Controlled interruption', code: 'inference_failed', partial_text: 'Ces mots sont incomplets.' }));
    });
  });
  await home(page);
  await page.keyboard.press('Alt+l');
  const field = page.locator('.quick-launch-draft');
  await field.locator('.btn-voice').click();
  await expect(field.locator('.voice-preview')).toContainText('Ces mots sont incomplets.');
  await field.locator('.btn-voice.recording').click();
  await page.getByRole('button', { name: 'Restore to quick launch prompt', exact: true }).click();
  await expect(page.locator('.quick-launch-input')).toHaveValue('Ces mots sont incomplets.');
  await expect(page.locator('.quick-launch-bar')).toContainText(/incomplete|partial/i);
  await page.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  expect(await recordings(request)).toEqual([]);
});

test('later reformulation review stays a candidate and deletion removes only this test example', async ({ page, request, corpus }) => {
  await home(page);
  await page.keyboard.press('Alt+l');
  await dictate(page.locator('.quick-launch-draft'), corpus.prediction);
  await page.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await recordings(request))[0]?.annotations.some(a => a.kind === 'task')).toBe(true);
  const [record] = await recordings(request);
  const article = await review(page, record.id);
  await article.getByRole('textbox', { name: 'Correction for this recording' }).fill('Une reformulation utile, qui ajoute des détails.');
  await article.getByRole('combobox', { name: 'Review status' }).selectOption('reformulation');
  await article.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect.poll(async () => (await recordings(request))[0]?.annotations.some(a => a.status === 'reformulation')).toBe(true);
  const manifest = await (await request.get('/api/stt/corpus/export')).json() as Manifest;
  expect(manifest.verifiedPairs).toEqual([]);
  expect(manifest.candidates).toHaveLength(1);
  expect(manifest.candidates[0].reference).toBeNull();
  await page.getByRole('combobox', { name: 'Export selection' }).selectOption('all');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export manifest', exact: true }).click();
  const candidatePath = await (await download).path();
  const candidateManifest = JSON.parse(await readFile(candidatePath!, 'utf8')) as Manifest;
  expect(candidateManifest.verifiedPairs).toEqual([]);
  expect(candidateManifest.candidates).toHaveLength(1);
  await article.getByRole('combobox', { name: 'Review status' }).selectOption('excluded');
  await article.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect.poll(async () => (await recordings(request))[0]?.annotations.filter(a => a.kind === 'review').length).toBe(2);
  const excludedManifest = await (await request.get('/api/stt/corpus/export')).json() as Manifest;
  expect(excludedManifest.verifiedPairs).toEqual([]);
  expect(excludedManifest.candidates).toEqual([]);
  await article.getByRole('button', { name: 'Delete example', exact: true }).click();
  await page.getByRole('button', { name: 'Delete this recording permanently', exact: true }).click();
  await expect(article).toHaveCount(0);
  expect(await recordings(request)).toEqual([]);
  expect((await request.get(`/api/stt/corpus/records/${record.id}/audio`)).status()).toBe(404);
  expect((await request.get(`/api/stt/corpus/records/${record.id}`)).status()).toBe(404);
});
