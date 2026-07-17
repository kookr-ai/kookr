// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CleanupWorktreeOption } from './CleanupWorktreeOption.js';
import type { WorktreeCleanupVerdict } from '../../shared/contracts/worktree-cleanup-verdict.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function flush() {
  return act(async () => {
    await Promise.resolve();
  });
}

function verdict(overrides: Partial<WorktreeCleanupVerdict> = {}): WorktreeCleanupVerdict {
  return {
    worktreePath: '/repos/kookr-arch-478-remote-handler',
    worktreeName: 'kookr-arch-478-remote-handler',
    branch: 'arch/issue-478-remote-handler',
    removable: true,
    evidence: { dirty: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 }, aheadCount: 0 },
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface RenderOptions {
  cleanupWorktree?: boolean;
  verdicts?: WorktreeCleanupVerdict[] | undefined;
  inspectFailed?: boolean;
  ralphActive?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onChange?: (v: boolean) => void;
}

async function render(opts: RenderOptions = {}) {
  await act(async () => {
    root.render(
      <CleanupWorktreeOption
        cleanupWorktree={opts.cleanupWorktree ?? true}
        verdicts={'verdicts' in opts ? opts.verdicts : [verdict()]}
        inspectFailed={opts.inspectFailed ?? false}
        ralphActive={opts.ralphActive ?? false}
        refreshing={opts.refreshing ?? false}
        onRefresh={opts.onRefresh ?? (() => {})}
        onChange={opts.onChange ?? (() => {})}
      />,
    );
  });
  await flush();
}

function checkbox(): HTMLInputElement | null {
  return container.querySelector('input[type="checkbox"]');
}

function refreshButton(): HTMLButtonElement | null {
  return container.querySelector('.complete-cleanup-refresh');
}

describe('CleanupWorktreeOption — safe worktree', () => {
  test('checkbox is enabled and reflects the caller default', async () => {
    await render({ verdicts: [verdict()], cleanupWorktree: true });

    expect(checkbox()!.disabled).toBe(false);
    expect(checkbox()!.checked).toBe(true);
    expect(container.textContent).toContain('safe to remove');
  });

  test('an unchecked default stays unchecked even though removal is possible', async () => {
    await render({ verdicts: [verdict()], cleanupWorktree: false });

    expect(checkbox()!.disabled).toBe(false);
    expect(checkbox()!.checked).toBe(false);
  });

  test('shows the worktree name, with the full path available on hover', async () => {
    await render({ verdicts: [verdict()] });

    const name = container.querySelector('.complete-cleanup-name')!;
    expect(name.textContent).toBe('kookr-arch-478-remote-handler');
    expect(name.getAttribute('title')).toBe('/repos/kookr-arch-478-remote-handler');
  });
});

describe('CleanupWorktreeOption — blocked worktree', () => {
  test('checkbox is unchecked AND disabled, with the reason stated', async () => {
    // The core contract: a box that cannot act must not look like it will.
    await render({
      cleanupWorktree: true,
      verdicts: [verdict({ removable: false, blocker: 'uncommitted-changes' })],
    });

    expect(checkbox()!.disabled).toBe(true);
    expect(checkbox()!.checked).toBe(false);
    expect(container.textContent).toContain('kept — uncommitted changes');
  });

  test('stays disabled even when the caller default is "clean up"', async () => {
    await render({
      cleanupWorktree: true,
      verdicts: [verdict({ removable: false, blocker: 'unmerged-commits' })],
    });

    expect(checkbox()!.checked).toBe(false);
    expect(checkbox()!.disabled).toBe(true);
  });

  test('evidence is disclosed without a click when blocked', async () => {
    await render({
      verdicts: [verdict({
        removable: false,
        blocker: 'uncommitted-changes',
        evidence: { dirty: { modified: 3, added: 0, deleted: 0, renamed: 0, untracked: 2 }, aheadCount: 2 },
      })],
    });

    expect(container.textContent).toContain('3 modified · 2 untracked');
    expect(container.textContent).toContain('2 commits');
  });

  test('a re-check that flips safe to blocked opens the drawer', async () => {
    // Rows are keyed by the stable worktree path and a refresh keeps them
    // mounted, so an initialise-once drawer would leave the refusal unexplained.
    await render({ verdicts: [verdict()] });
    expect(container.querySelector('.complete-cleanup-details')).toBeNull();

    await render({ verdicts: [verdict({ removable: false, blocker: 'uncommitted-changes' })] });

    expect(container.querySelector('.complete-cleanup-details')).not.toBeNull();
  });

  test('dismissing a safe row\'s detail does not suppress a later refusal', async () => {
    await render({ verdicts: [verdict()] });
    const why = container.querySelector<HTMLButtonElement>('.complete-cleanup-why')!;
    await act(async () => { why.click(); });   // open
    await act(async () => { container.querySelector<HTMLButtonElement>('.complete-cleanup-why')!.click(); }); // hide
    expect(container.querySelector('.complete-cleanup-details')).toBeNull();

    // A re-check now reports it dirty — the refusal must explain itself.
    await render({ verdicts: [verdict({ removable: false, blocker: 'uncommitted-changes' })] });

    expect(container.querySelector('.complete-cleanup-details')).not.toBeNull();
  });

  test('safe verdict keeps its evidence collapsed behind why?', async () => {
    await render({ verdicts: [verdict()] });

    expect(container.textContent).not.toContain('clean (0 changes)');
    const why = container.querySelector<HTMLButtonElement>('.complete-cleanup-why')!;
    await act(async () => { why.click(); });
    expect(container.textContent).toContain('clean (0 changes)');
  });
});

describe('CleanupWorktreeOption — refresh affordance', () => {
  test('offered for a blocker the user can resolve', async () => {
    await render({ verdicts: [verdict({ removable: false, blocker: 'unmerged-commits' })] });

    expect(refreshButton()).not.toBeNull();
  });

  test('withheld when every blocker is permanent', async () => {
    // Re-checking a primary working tree can never change the answer; offering
    // it would imply a possibility that does not exist.
    await render({ verdicts: [verdict({ removable: false, blocker: 'primary-working-tree' })] });

    expect(refreshButton()).toBeNull();
    expect(container.textContent).toContain('cannot be removed by Kookr');
  });

  test('clicking it asks for a re-check', async () => {
    const onRefresh = vi.fn();
    await render({ verdicts: [verdict({ removable: false, blocker: 'unmerged-commits' })], onRefresh });

    await act(async () => { refreshButton()!.click(); });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test('marked busy while a re-check is in flight, without dropping focus', async () => {
    // A real `disabled` would blur the button mid-refresh and drop keyboard
    // focus to the document body.
    await render({ verdicts: [verdict()], refreshing: true });

    expect(refreshButton()!.getAttribute('aria-disabled')).toBe('true');
    expect(refreshButton()!.disabled).toBe(false);
  });

  test('does not re-fire while a re-check is already in flight', async () => {
    const onRefresh = vi.fn();
    await render({ verdicts: [verdict()], refreshing: true, onRefresh });

    await act(async () => { refreshButton()!.click(); });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('CleanupWorktreeOption — probe in flight', () => {
  test('checkbox is indeterminate, not unchecked, while the answer is unknown', async () => {
    await render({ verdicts: undefined });

    expect(checkbox()!.disabled).toBe(true);
    expect(checkbox()!.indeterminate).toBe(true);
    expect(container.textContent).toContain('Checking whether');
  });

  test('no refresh button until there is a verdict to refresh', async () => {
    await render({ verdicts: undefined });

    expect(refreshButton()).toBeNull();
  });
});

describe('CleanupWorktreeOption — Ralph loop', () => {
  test('blocks a worktree the server would otherwise call removable', async () => {
    // Server-side inspection cannot see the loop; the client must veto.
    await render({ verdicts: [verdict({ removable: true })], ralphActive: true });

    expect(checkbox()!.disabled).toBe(true);
    expect(checkbox()!.checked).toBe(false);
    expect(container.textContent).toContain('Ralph loop still active');
  });

  test('still offers a re-check, since a loop can finish', async () => {
    await render({ verdicts: [verdict({ removable: true })], ralphActive: true });

    expect(refreshButton()).not.toBeNull();
  });
});

describe('CleanupWorktreeOption — inspection failed', () => {
  test('keeps the option live rather than hiding it', async () => {
    // A failed probe also yields no verdicts, but "unknown" is not "no": the
    // server still applies its own setting, so the user needs the choice.
    await render({ verdicts: [], inspectFailed: true, cleanupWorktree: true });

    expect(container.querySelector('.complete-cleanup-option')).not.toBeNull();
    expect(checkbox()!.disabled).toBe(false);
    expect(checkbox()!.checked).toBe(true);
  });

  test('says it could not check, instead of claiming the worktree is kept', async () => {
    await render({ verdicts: [], inspectFailed: true });

    expect(container.textContent).toContain("Couldn't check this worktree");
    expect(container.textContent).not.toContain('kept —');
  });
});

describe('CleanupWorktreeOption — indeterminate means unknown, and only that', () => {
  test('a loop blocking during an in-flight probe is not "unknown"', async () => {
    // The dash claims "we don't know yet", but a live loop decides without the
    // probe and the wire sends false. Painting unknown here contradicts both
    // the row text and the wire.
    await render({ verdicts: undefined, ralphActive: true });

    expect(checkbox()!.indeterminate).toBe(false);
    expect(checkbox()!.disabled).toBe(true);
    expect(checkbox()!.checked).toBe(false);
  });

  test('a plain in-flight probe is still "unknown"', async () => {
    await render({ verdicts: undefined });

    expect(checkbox()!.indeterminate).toBe(true);
  });

  test('a settled verdict is never "unknown"', async () => {
    await render({ verdicts: [verdict()] });

    expect(checkbox()!.indeterminate).toBe(false);
  });
});

describe('CleanupWorktreeOption — refresh during the first probe', () => {
  test('withheld while the initial probe is in flight', async () => {
    // A probe is already running; an idle-looking button that does nothing
    // visible is worse than no button.
    await render({ verdicts: undefined });

    expect(refreshButton()).toBeNull();
  });

  test('withheld during an in-flight probe even when a loop blocks', async () => {
    await render({ verdicts: undefined, ralphActive: true });

    expect(refreshButton()).toBeNull();
  });
});

describe('CleanupWorktreeOption — a loop does not mask a more specific reason', () => {
  test('a permanently blocked worktree keeps its own reason during a loop', async () => {
    // Overwriting "primary working tree" with "Ralph loop active" would both
    // misreport it and offer a re-check that can never succeed.
    await render({
      verdicts: [verdict({ removable: false, blocker: 'primary-working-tree', evidence: {} })],
      ralphActive: true,
    });

    expect(container.textContent).toContain('primary working tree');
    expect(container.textContent).not.toContain('Ralph loop still active');
    expect(refreshButton()).toBeNull();
  });

  test('a removable worktree is still vetoed by the loop', async () => {
    await render({ verdicts: [verdict({ removable: true })], ralphActive: true });

    expect(container.textContent).toContain('Ralph loop still active');
  });
});

describe('CleanupWorktreeOption — verdict age', () => {
  // The age line is what makes the refresh control discoverable — a refresh
  // button with no staleness cue is a button nobody presses. It was previously
  // unpinned: hardcoding it to "just now" or deleting the interval broke nothing.
  test('a fresh verdict reads as just now', async () => {
    await render({ verdicts: [verdict({ checkedAt: new Date().toISOString() })] });

    expect(container.textContent).toContain('checked just now');
  });

  test('minutes are reported in minutes', async () => {
    await render({ verdicts: [verdict({ checkedAt: new Date(Date.now() - 4 * 60_000).toISOString() })] });

    expect(container.textContent).toContain('checked 4m ago');
  });

  test('an hour or more is reported in hours', async () => {
    await render({ verdicts: [verdict({ checkedAt: new Date(Date.now() - 150 * 60_000).toISOString() })] });

    expect(container.textContent).toContain('checked 3h ago');
  });

  test('an unparseable timestamp degrades to just now rather than NaN', async () => {
    await render({ verdicts: [verdict({ checkedAt: 'not-a-date' })] });

    expect(container.textContent).toContain('checked just now');
    expect(container.textContent).not.toContain('NaN');
  });

  test('the age advances while the dialog sits open', async () => {
    // Without the interval the line would freeze at "just now" for as long as
    // the dialog is up, which is exactly when it matters.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render({ verdicts: [verdict({ checkedAt: new Date().toISOString() })] });
      expect(container.textContent).toContain('checked just now');

      await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000); });

      expect(container.textContent).toContain('checked 3m ago');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CleanupWorktreeOption — accessibility', () => {
  test('the verdict region is live, so a re-check that flips it is announced', async () => {
    await render({ verdicts: [verdict()] });

    const live = container.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
  });

  test('the checkbox description is a summary, not the whole evidence dump', async () => {
    await render({
      verdicts: [verdict({
        removable: false,
        blocker: 'uncommitted-changes',
        evidence: { dirty: { modified: 3, added: 0, deleted: 0, renamed: 0, untracked: 2 }, aheadCount: 2 },
      })],
    });

    const describedBy = checkbox()!.getAttribute('aria-describedby');
    const summary = document.getElementById(describedBy!)!;
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain('kept, uncommitted changes');
    // The `why?` control label must not leak into the checkbox's description.
    expect(summary.textContent).not.toContain('hide');
    expect(summary.textContent).not.toContain('3 modified');
  });

  test('why? buttons are distinguishable when a task owns several worktrees', async () => {
    await render({
      verdicts: [
        verdict({ worktreePath: '/wt/one', worktreeName: 'one' }),
        verdict({ worktreePath: '/wt/two', worktreeName: 'two' }),
      ],
    });

    const labels = [...container.querySelectorAll('.complete-cleanup-why')]
      .map((b) => b.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('one');
    expect(labels[1]).toContain('two');
  });

  test('the full path is reachable without hovering', async () => {
    await render({ verdicts: [verdict({ removable: false, blocker: 'uncommitted-changes' })] });

    // Drawer is open (blocked), so the path is in the DOM text — not only in a
    // `title`, which keyboard and touch users never see.
    expect(container.querySelector('.complete-cleanup-details')!.textContent)
      .toContain('/repos/kookr-arch-478-remote-handler');
  });
});

describe('CleanupWorktreeOption — Ralph loop with no verdicts to map over', () => {
  test('a failed inspection during a live loop still blocks, and says why', async () => {
    // The veto used to be applied by mapping over the verdicts, so an empty
    // list (failed probe) silently dropped it — leaving a live checked box
    // while the wire still said "don't remove".
    await render({ verdicts: [], inspectFailed: true, ralphActive: true, cleanupWorktree: true });

    expect(checkbox()!.disabled).toBe(true);
    expect(checkbox()!.checked).toBe(false);
    expect(container.textContent).toContain('Ralph loop still active');
  });

  test('the spoken summary agrees with the visible verdict during a loop', async () => {
    // describeVerdicts read the raw prop, so a screen reader heard
    // "safe to remove" on a row that visibly said "kept — Ralph loop active".
    await render({ verdicts: [verdict({ removable: true })], ralphActive: true });

    const summary = document.getElementById(checkbox()!.getAttribute('aria-describedby')!)!;
    expect(summary.textContent).toContain('Ralph loop still active');
    expect(summary.textContent).not.toContain('safe to remove');
  });

  test('a loop blocks even before the first verdict arrives', async () => {
    await render({ verdicts: undefined, ralphActive: true });

    expect(checkbox()!.disabled).toBe(true);
    expect(container.textContent).toContain('Ralph loop still active');
  });

  test('a task with no worktree stays silent even during a loop', async () => {
    // Nothing to clean up: no dead checkbox, loop or not.
    await render({ verdicts: [], ralphActive: true });

    expect(container.querySelector('.complete-cleanup-option')).toBeNull();
  });
});

describe('CleanupWorktreeOption — task with no worktrees', () => {
  test('renders nothing rather than a dead checkbox', async () => {
    await render({ verdicts: [] });

    expect(container.querySelector('.complete-cleanup-option')).toBeNull();
  });

  test('going from "checking" to "no worktrees" does not break the hook order', async () => {
    // The ordinary path for a task without a worktree: the dialog opens
    // probing, then the reply empties it and the component early-returns. A
    // hook below that return makes the second render throw
    // ("Rendered fewer hooks than expected") from inside act() — so reaching
    // the assertion at all is most of what this test proves.
    await render({ verdicts: undefined });
    await render({ verdicts: [] });

    expect(container.querySelector('.complete-cleanup-option')).toBeNull();
  });
});

describe('CleanupWorktreeOption — task with several worktrees', () => {
  test('shows a row per worktree', async () => {
    await render({
      verdicts: [
        verdict({ worktreePath: '/wt/one', worktreeName: 'one' }),
        verdict({ worktreePath: '/wt/two', worktreeName: 'two', removable: false, blocker: 'uncommitted-changes' }),
      ],
    });

    const names = [...container.querySelectorAll('.complete-cleanup-name')].map((n) => n.textContent);
    expect(names).toEqual(['one', 'two']);
  });

  test('stays enabled while any worktree is removable', async () => {
    await render({
      verdicts: [
        verdict({ worktreePath: '/wt/one', worktreeName: 'one' }),
        verdict({ worktreePath: '/wt/two', worktreeName: 'two', removable: false, blocker: 'uncommitted-changes' }),
      ],
    });

    expect(checkbox()!.disabled).toBe(false);
  });

  test('disabled only when nothing is removable', async () => {
    await render({
      verdicts: [
        verdict({ worktreePath: '/wt/one', worktreeName: 'one', removable: false, blocker: 'unmerged-commits' }),
        verdict({ worktreePath: '/wt/two', worktreeName: 'two', removable: false, blocker: 'uncommitted-changes' }),
      ],
    });

    expect(checkbox()!.disabled).toBe(true);
  });
});
