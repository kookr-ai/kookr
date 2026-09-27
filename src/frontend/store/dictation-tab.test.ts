// @vitest-environment jsdom
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

function navigation(type: string) {
  Object.defineProperty(performance, 'getEntriesByType', { configurable: true, value: vi.fn(() => [{ type }]) });
}

test('reload retains a tab identity while a copied navigation gets a new owner', async () => {
  sessionStorage.setItem('kookr:dictationTab:v1', 'original-tab');
  navigation('reload');
  expect((await import('./dictation-tab.js')).dictationTabId()).toBe('original-tab');
  vi.resetModules();
  navigation('navigate');
  const next = (await import('./dictation-tab.js')).dictationTabId();
  expect(next).not.toBe('original-tab');
  expect(sessionStorage.getItem('kookr:dictationTab:v1')).toBe(next);
});

test('independent tab drafts never load the other tab recording identity', async () => {
  navigation('reload');
  sessionStorage.setItem('kookr:dictationTab:v1', 'first-tab');
  const first = await import('./launch-task-dialog-draft.js');
  first.saveLaunchTaskDialogDraft({ dictationId: 'first-recording-draft', prompt: 'first words', cwd: '/tmp/first', criteria: '' });
  vi.resetModules();
  sessionStorage.setItem('kookr:dictationTab:v1', 'second-tab');
  const second = await import('./launch-task-dialog-draft.js');
  expect(second.loadLaunchTaskDialogDraft()).toBeNull();
  second.saveLaunchTaskDialogDraft({ dictationId: 'second-recording-draft', prompt: 'second words', cwd: '/tmp/second', criteria: '' });
  vi.resetModules();
  sessionStorage.setItem('kookr:dictationTab:v1', 'first-tab');
  expect((await import('./launch-task-dialog-draft.js')).loadLaunchTaskDialogDraft()).toMatchObject({ dictationId: 'first-recording-draft', prompt: 'first words' });
});

test('relaunch drafts keep edits and recording identity without replacing the manual draft', async () => {
  const store = await import('./launch-task-dialog-draft.js');
  store.saveLaunchTaskDialogDraft({ prompt: 'manual', criteria: '', cwd: '/tmp', dictationId: 'manual-id' });
  store.saveRelaunchDictationDraft('task-one', { prompt: 'edited dictation', criteria: 'criteria', cwd: '/tmp/one', dictationId: 'relaunch-id' });
  expect(store.loadRelaunchDictationDraft('task-one')).toMatchObject({ prompt: 'edited dictation', dictationId: 'relaunch-id' });
  expect(store.loadRelaunchDictationDraft('task-two')).toBeNull();
  expect(store.loadLaunchTaskDialogDraft()).toMatchObject({ prompt: 'manual', dictationId: 'manual-id' });
});
