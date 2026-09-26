// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

describe('dictation text recovery storage', () => {
  let store: typeof import('./dictation-recovery.js');
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    store = await import('./dictation-recovery.js');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  test('retains the original capture time, latest nonempty text, and owner across reload', async () => {
    vi.useFakeTimers();
    const draft = store.beginDictationRecovery('task-a:prompt')!;
    store.saveDictationPartial(draft, 'First words');
    vi.advanceTimersByTime(10_000);
    store.saveDictationPartial(draft, 'First words and latest words');
    store.saveDictationPartial(draft, '  ');
    vi.resetModules();
    const reloaded = await import('./dictation-recovery.js');
    expect(reloaded.loadDictationRecovery('task-a:prompt')).toMatchObject({
      id: draft.id, capturedAt: draft.capturedAt, text: 'First words and latest words', persisted: true,
    });
    expect(reloaded.loadDictationRecovery('task-a:criteria')).toBeNull();
    expect(reloaded.loadDictationRecovery('task-b:prompt')).toBeNull();
  });

  test('can identify ordinary launch forms on LAN pages without randomUUID', () => {
    vi.stubGlobal('crypto', {});
    expect(store.createDictationId()).toMatch(/^dictation-/);
  });

  test('does not save or manufacture text for empty recognition and releases interrupted reservations', async () => {
    const draft = store.beginDictationRecovery('empty')!;
    expect(store.loadDictationRecovery('empty')).toBeNull();
    expect(localStorage.getItem(store.DICTATION_RECOVERY_KEY)).toBeNull();
    store.saveDictationPartial(draft, '  ');
    store.releaseDictationReservation(draft.id);
    expect(store.beginDictationRecovery('empty')).not.toBeNull();
    vi.resetModules();
    const reloaded = await import('./dictation-recovery.js');
    expect(reloaded.beginDictationRecovery('empty')).not.toBeNull();
  });

  test('refuses replacement and capacity overflow without evicting unresolved recordings', () => {
    for (let index = 0; index < store.MAX_DICTATION_RECOVERIES; index += 1) {
      const draft = store.beginDictationRecovery(`input-${index}`)!;
      store.saveDictationPartial(draft, `Unresolved ${index}`);
      store.releaseDictationReservation(draft.id);
    }
    expect(store.beginDictationRecovery('input-0')).toBeNull();
    expect(store.beginDictationRecovery('overflow')).toBeNull();
    expect(store.loadDictationRecovery('input-0')?.text).toBe('Unresolved 0');
    const removed = store.loadDictationRecovery('input-1')!;
    store.discardDictationRecovery(removed.owner, removed.id);
    expect(store.beginDictationRecovery('overflow')).not.toBeNull();
  });

  test('bounds retained text and explicitly records truncation', () => {
    const draft = store.beginDictationRecovery('long')!;
    const saved = store.saveDictationPartial(draft, 'x'.repeat(store.MAX_DICTATION_RECOVERY_CHARS + 1))!;
    expect(saved.text).toHaveLength(store.MAX_DICTATION_RECOVERY_CHARS);
    expect(saved.truncated).toBe(true);
  });

  test('expires after 24 hours without extending retention when partials arrive', () => {
    vi.useFakeTimers();
    const draft = store.beginDictationRecovery('old')!;
    store.saveDictationPartial(draft, 'first');
    vi.advanceTimersByTime(store.DICTATION_RECOVERY_TTL_MS - 1);
    store.saveDictationPartial(draft, 'latest');
    expect(store.loadDictationRecovery('old')?.text).toBe('latest');
    vi.advanceTimersByTime(1);
    expect(store.loadDictationRecovery('old')).toBeNull();
    expect(JSON.parse(localStorage.getItem(store.DICTATION_RECOVERY_KEY)!)).toEqual([]);
  });

  test('keeps storage failures recoverable in memory and never resurrects a consumed disk copy', () => {
    const draft = store.beginDictationRecovery('quota')!;
    store.saveDictationPartial(draft, 'old text');
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
    expect(store.saveDictationPartial(draft, 'new words')).toMatchObject({ text: 'new words', persisted: false });
    expect(store.loadDictationRecovery('quota')?.text).toBe('new words');
    store.discardDictationRecovery(draft.owner, draft.id);
    expect(store.loadDictationRecovery('quota')).toBeNull();
    write.mockRestore();
    expect(store.loadDictationRecovery('quota')).toBeNull();
    const next = store.beginDictationRecovery('quota')!;
    store.saveDictationPartial(next, 'second recording');
    expect(store.loadDictationRecovery('quota')).toMatchObject({ text: 'second recording', persisted: true });
  });

  test('retains speech when storage reads and writes both throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Security'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Security'); });
    const draft = store.beginDictationRecovery('private-mode')!;
    expect(store.saveDictationPartial(draft, 'Still available')).toMatchObject({ text: 'Still available', persisted: false });
    store.releaseDictationReservation(draft.id);
    expect(store.loadDictationRecovery(draft.owner)?.text).toBe('Still available');
  });

  test('late saves and cleanup cannot replace or delete a newer recording', () => {
    const old = store.beginDictationRecovery('same-input')!;
    store.saveDictationPartial(old, 'first');
    store.discardDictationRecovery(old.owner, old.id);
    const next = store.beginDictationRecovery('same-input')!;
    store.saveDictationPartial(next, 'second');
    expect(store.saveDictationPartial(old, 'late words')).toBeNull();
    store.discardDictationRecovery(old.owner, old.id);
    expect(store.loadDictationRecovery(next.owner)?.text).toBe('second');
  });

  test.each(['bad JSON', '{}', '[null,{}, {"owner":"bad","text":"invalid"}]'])('ignores malformed storage %s', (raw) => {
    localStorage.setItem(store.DICTATION_RECOVERY_KEY, raw);
    expect(store.loadDictationRecovery('bad')).toBeNull();
    const draft = store.beginDictationRecovery('usable')!;
    expect(store.saveDictationPartial(draft, 'Usable text')?.text).toBe('Usable text');
  });
});
