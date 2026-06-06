// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clearDetailReplyDraft,
  detailReplyDraftKey,
  loadDetailReplyDraft,
  saveDetailReplyDraft,
} from './detail-reply-draft.js';

describe('detail-reply-draft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('keys drafts by task id before agent id', () => {
    expect(detailReplyDraftKey({ taskId: 'task-1', agentId: 'agent-1' })).toBe('kookr:detailReplyDraft:task:task-1');
    expect(detailReplyDraftKey({ taskId: null, agentId: 'agent-1' })).toBe('kookr:detailReplyDraft:agent:agent-1');
    expect(detailReplyDraftKey({ taskId: '', agentId: '' })).toBeNull();
  });

  test('save then load round-trips the input', () => {
    saveDetailReplyDraft({ taskId: 'task-1', agentId: 'agent-1' }, 'try pnpm test');

    expect(loadDetailReplyDraft({ taskId: 'task-1', agentId: 'agent-1' })).toBe('try pnpm test');
  });

  test('drafts scoped to different tasks do not bleed into each other', () => {
    saveDetailReplyDraft({ taskId: 'task-1' }, 'first');
    saveDetailReplyDraft({ taskId: 'task-2' }, 'second');

    expect(loadDetailReplyDraft({ taskId: 'task-1' })).toBe('first');
    expect(loadDetailReplyDraft({ taskId: 'task-2' })).toBe('second');
  });

  test('save with empty or whitespace input clears the scoped key', () => {
    const scope = { taskId: 'task-1' };
    saveDetailReplyDraft(scope, 'old');

    saveDetailReplyDraft(scope, '   ');

    expect(loadDetailReplyDraft(scope)).toBe('');
    expect(localStorage.getItem(detailReplyDraftKey(scope)!)).toBeNull();
  });

  test('clear removes only the scoped key', () => {
    saveDetailReplyDraft({ taskId: 'task-1' }, 'first');
    saveDetailReplyDraft({ taskId: 'task-2' }, 'second');

    clearDetailReplyDraft({ taskId: 'task-1' });

    expect(loadDetailReplyDraft({ taskId: 'task-1' })).toBe('');
    expect(loadDetailReplyDraft({ taskId: 'task-2' })).toBe('second');
  });

  test('load returns empty string on corrupted JSON or invalid shape', () => {
    localStorage.setItem(detailReplyDraftKey({ taskId: 'bad-json' })!, 'not-json');
    localStorage.setItem(detailReplyDraftKey({ taskId: 'bad-shape' })!, JSON.stringify({ input: 42 }));

    expect(loadDetailReplyDraft({ taskId: 'bad-json' })).toBe('');
    expect(loadDetailReplyDraft({ taskId: 'bad-shape' })).toBe('');
  });

  test('storage failures do not throw', () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    Storage.prototype.removeItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(loadDetailReplyDraft({ taskId: 'task-1' })).toBe('');
      expect(() => saveDetailReplyDraft({ taskId: 'task-1' }, 'draft')).not.toThrow();
      expect(() => clearDetailReplyDraft({ taskId: 'task-1' })).not.toThrow();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
      Storage.prototype.removeItem = removeItem;
    }
  });
});
