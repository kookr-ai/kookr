import { describe, expect, it } from 'vitest';
import { aSession } from '../core/__fixtures__/task-builders.js';
import { OperatorDraftRegistry, OPERATOR_DRAFT_VETO_MAX_IDLE_MS } from './operator-draft-registry.js';

const T0 = 1_000_000;

function taskWith(...sessions: Array<{ id: string; ended?: boolean }>) {
  return {
    sessions: sessions.map((s) =>
      aSession({ tmuxSession: s.id, lastStatus: s.ended ? 'completed' : 'inProgress' })),
  };
}

describe('OperatorDraftRegistry', () => {
  it('reports an unsent draft on a live session of the task', () => {
    const registry = new OperatorDraftRegistry();
    registry.record('kookr-a', { text: 'je tape' }, T0);

    expect(registry.hasUnsentDraft(taskWith({ id: 'kookr-a' }), T0)).toBe(true);
    expect(registry.get('kookr-a')).toEqual({ text: 'je tape', lastInputAtMs: T0 });
  });

  it('forgets the draft once submitted', () => {
    const registry = new OperatorDraftRegistry();
    registry.record('kookr-a', { text: 'je tape' }, T0);
    registry.record('kookr-a', { text: '\r' }, T0 + 1);

    expect(registry.get('kookr-a')).toBeUndefined();
    expect(registry.hasUnsentDraft(taskWith({ id: 'kookr-a' }), T0 + 1)).toBe(false);
  });

  it('ignores whitespace-only drafts, menu answers and drafts on ended sessions', () => {
    const registry = new OperatorDraftRegistry();
    registry.record('kookr-a', { text: '   ' }, T0);
    registry.record('kookr-menu', { text: '1' }, T0);
    expect(registry.hasUnsentDraft(taskWith({ id: 'kookr-menu' }), T0)).toBe(false);
    registry.record('kookr-old', { text: 'texte' }, T0);

    expect(registry.hasUnsentDraft(taskWith({ id: 'kookr-a' }), T0)).toBe(false);
    expect(registry.hasUnsentDraft(taskWith({ id: 'kookr-old', ended: true }), T0)).toBe(false);
  });

  it('holds through long pauses, up to the idle bound, then lets go', () => {
    const registry = new OperatorDraftRegistry();
    registry.record('kookr-a', { text: 'je réfléchis' }, T0);
    const task = taskWith({ id: 'kookr-a' });

    expect(registry.hasUnsentDraft(task, T0 + OPERATOR_DRAFT_VETO_MAX_IDLE_MS)).toBe(true);
    expect(registry.hasUnsentDraft(task, T0 + OPERATOR_DRAFT_VETO_MAX_IDLE_MS + 1)).toBe(false);

    // A new keystroke refreshes the bound.
    registry.record('kookr-a', { text: '.' }, T0 + OPERATOR_DRAFT_VETO_MAX_IDLE_MS + 1);
    expect(registry.hasUnsentDraft(task, T0 + OPERATOR_DRAFT_VETO_MAX_IDLE_MS + 2)).toBe(true);
  });

  it('a reply-box draft reported by the dashboard protects the task, until cleared or idle', () => {
    const registry = new OperatorDraftRegistry();
    const task = { id: 'task-1', ...taskWith({ id: 'kookr-a' }) };

    registry.recordComposerDraft('task-1', true, T0);
    expect(registry.hasUnsentDraft(task, T0 + 10 * 60_000)).toBe(true);
    expect(registry.hasUnsentDraft({ id: 'task-2', ...taskWith({ id: 'kookr-b' }) }, T0)).toBe(false);
    expect(registry.hasUnsentDraft(task, T0 + OPERATOR_DRAFT_VETO_MAX_IDLE_MS + 1)).toBe(false);

    registry.recordComposerDraft('task-1', false, T0 + 1);
    expect(registry.hasUnsentDraft(task, T0 + 2)).toBe(false);
  });

  it('clear() drops a session draft', () => {
    const registry = new OperatorDraftRegistry();
    registry.record('kookr-a', { text: 'x' }, T0);
    registry.clear('kookr-a');
    expect(registry.get('kookr-a')).toBeUndefined();
  });
});
