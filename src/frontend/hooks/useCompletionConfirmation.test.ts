// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  useCompletionConfirmation,
  type CompletionConfirmationState,
  type PendingCompleteConfirmation,
} from './useCompletionConfirmation.js';

interface HarnessProps {
  cleanupWorktreeOnComplete: boolean | undefined;
  isOpen: boolean;
  onBegin: (taskId: string) => void;
}

function mount(initial: HarnessProps): {
  root: Root;
  captured: { current: CompletionConfirmationState };
  rerender: (next: HarnessProps) => void;
} {
  const captured = { current: null as unknown as CompletionConfirmationState };

  function Probe(props: HarnessProps) {
    captured.current = useCompletionConfirmation(props);
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Probe, initial));
  });
  const rerender = (next: HarnessProps) => {
    act(() => {
      root.render(React.createElement(Probe, next));
    });
  };
  return { root, captured, rerender };
}

const target: PendingCompleteConfirmation = {
  taskId: 'task-1',
  agentId: 'agent-1',
  label: 'Example task',
  method: 'button',
};

describe('useCompletionConfirmation', () => {
  let roots: Root[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    roots = [];
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => root.unmount());
    }
    document.body.innerHTML = '';
  });

  test('starts idle', () => {
    const { root, captured } = mount({ cleanupWorktreeOnComplete: undefined, isOpen: false, onBegin: vi.fn() });
    roots.push(root);
    expect(captured.current.pending).toBeNull();
    expect(captured.current.cleanupWorktree).toBe(true);
    expect(captured.current.cleanupWorktreeTouched).toBe(false);
  });

  test('begin seeds the pending task, the cleanup default, and calls onBegin', () => {
    const onBegin = vi.fn();
    const { root, captured } = mount({ cleanupWorktreeOnComplete: false, isOpen: false, onBegin });
    roots.push(root);
    act(() => captured.current.begin(target));
    expect(captured.current.pending).toEqual(target);
    expect(captured.current.cleanupWorktree).toBe(false);
    expect(captured.current.cleanupWorktreeTouched).toBe(false);
    expect(onBegin).toHaveBeenCalledWith('task-1');
  });

  test('begin defaults cleanup to true when no saved preference exists', () => {
    const { root, captured } = mount({ cleanupWorktreeOnComplete: undefined, isOpen: false, onBegin: vi.fn() });
    roots.push(root);
    act(() => captured.current.begin(target));
    expect(captured.current.cleanupWorktree).toBe(true);
  });

  test('setCleanupWorktree marks the checkbox user-touched', () => {
    const { root, captured } = mount({ cleanupWorktreeOnComplete: true, isOpen: true, onBegin: vi.fn() });
    roots.push(root);
    act(() => captured.current.setCleanupWorktree(false));
    expect(captured.current.cleanupWorktree).toBe(false);
    expect(captured.current.cleanupWorktreeTouched).toBe(true);
  });

  test('syncs to a saved default that resolves after the dialog opened, unless touched', () => {
    const { root, captured, rerender } = mount({ cleanupWorktreeOnComplete: undefined, isOpen: true, onBegin: vi.fn() });
    roots.push(root);
    // Setting resolves late -> checkbox follows it.
    rerender({ cleanupWorktreeOnComplete: false, isOpen: true, onBegin: vi.fn() });
    expect(captured.current.cleanupWorktree).toBe(false);
    // Once the user touches it, a later default change must not override.
    act(() => captured.current.setCleanupWorktree(true));
    rerender({ cleanupWorktreeOnComplete: false, isOpen: true, onBegin: vi.fn() });
    expect(captured.current.cleanupWorktree).toBe(true);
  });

  test('does not sync the default while the dialog is closed', () => {
    const { root, captured, rerender } = mount({ cleanupWorktreeOnComplete: undefined, isOpen: false, onBegin: vi.fn() });
    roots.push(root);
    rerender({ cleanupWorktreeOnComplete: false, isOpen: false, onBegin: vi.fn() });
    expect(captured.current.cleanupWorktree).toBe(true);
  });

  test('reset clears every field back to idle defaults', () => {
    const { root, captured } = mount({ cleanupWorktreeOnComplete: true, isOpen: true, onBegin: vi.fn() });
    roots.push(root);
    act(() => {
      captured.current.begin(target);
      captured.current.setFeedback({ rating: 'up' });
      captured.current.setRequestReflect(true);
      captured.current.setCleanupWorktree(false);
    });
    act(() => captured.current.reset());
    expect(captured.current.pending).toBeNull();
    expect(captured.current.feedback).toBeUndefined();
    expect(captured.current.requestReflect).toBe(false);
    expect(captured.current.cleanupWorktree).toBe(true);
    expect(captured.current.cleanupWorktreeTouched).toBe(false);
  });
});
