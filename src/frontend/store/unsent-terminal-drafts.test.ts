// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNSENT_DRAFT_RETENTION_MS,
  discardRecoverableTerminalDrafts,
  findRecoverableTerminalDraft,
  saveUnsentTerminalDraft,
} from './unsent-terminal-drafts.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('unsent terminal drafts', () => {
  it('offers back a draft typed in an earlier session of the task (the task was closed, then reopened)', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-old', 'Peux-tu aussi ajouter', 1_000);

    expect(findRecoverableTerminalDraft('task-1', 'kookr-new')).toMatchObject({
      taskId: 'task-1',
      sessionName: 'kookr-old',
      text: 'Peux-tu aussi ajouter',
    });
  });

  it('does not offer the draft of the session still on screen (its text is still in the prompt)', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-live', 'en cours', 1_000);
    expect(findRecoverableTerminalDraft('task-1', 'kookr-live')).toBeNull();
  });

  it('typing in the new session never overwrites the draft waiting to be recovered', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-old', 'le long prompt perdu', 1_000);
    saveUnsentTerminalDraft('task-1', 'kookr-new', 'autre chose', 2_000);

    expect(findRecoverableTerminalDraft('task-1', 'kookr-new')?.text).toBe('le long prompt perdu');
  });

  it('forgets a session draft once it is submitted or erased', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-old', 'brouillon', 1_000);
    saveUnsentTerminalDraft('task-1', 'kookr-old', '', 2_000);
    expect(findRecoverableTerminalDraft('task-1', 'kookr-new')).toBeNull();
  });

  it('returns the most recent of several earlier sessions, and never another task\'s draft', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-a', 'ancien', 1_000);
    saveUnsentTerminalDraft('task-1', 'kookr-b', 'récent', 2_000);
    saveUnsentTerminalDraft('task-2', 'kookr-c', 'autre tâche', 3_000);

    expect(findRecoverableTerminalDraft('task-1', 'kookr-d')?.text).toBe('récent');
    expect(findRecoverableTerminalDraft('task-3', 'kookr-d')).toBeNull();
  });

  it('restore/dismiss clears every earlier-session draft but keeps the current session one', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-a', 'ancien', 1_000);
    saveUnsentTerminalDraft('task-1', 'kookr-b', 'récent', 2_000);
    saveUnsentTerminalDraft('task-1', 'kookr-now', 'actuel', 3_000);

    discardRecoverableTerminalDrafts('task-1', 'kookr-now');

    expect(findRecoverableTerminalDraft('task-1', 'kookr-now')).toBeNull();
    expect(findRecoverableTerminalDraft('task-1', 'kookr-later')?.text).toBe('actuel');
  });

  it('drops entries past the retention window on the next save', () => {
    saveUnsentTerminalDraft('task-1', 'kookr-old', 'très vieux', 0);
    saveUnsentTerminalDraft('task-2', 'kookr-x', 'neuf', UNSENT_DRAFT_RETENTION_MS + 1);

    expect(findRecoverableTerminalDraft('task-1', 'kookr-new')).toBeNull();
  });

  it('works without storage: saving and reading never throw', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });

    expect(() => saveUnsentTerminalDraft('task-1', 'kookr-old', 'x')).not.toThrow();
    expect(findRecoverableTerminalDraft('task-1', 'kookr-new')).toBeNull();
    expect(() => discardRecoverableTerminalDrafts('task-1', 'kookr-new')).not.toThrow();
  });

  it('a failing write (quota) is swallowed', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveUnsentTerminalDraft('task-1', 'kookr-old', 'x')).not.toThrow();
  });
});
