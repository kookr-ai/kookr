import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #3764: a hung git call (a stuck lock, a stalled network mount) must
// not hold the Playbooks list past the drift check's 10 s budget. Some
// helpers the check calls use git's longer default timeout, so the deadline
// is enforced around the whole check; this pins it with git that never
// answers.
const { mockRunGitIn, mockGitIn } = vi.hoisted(() => ({
  mockRunGitIn: vi.fn(),
  mockGitIn: vi.fn(),
}));

vi.mock('../core/git-helpers.js', () => ({
  runGitIn: mockRunGitIn,
  gitIn: mockGitIn,
}));

import { findPlaybooksMissingFromCheckout } from './checkout-auto-sync.js';

describe('findPlaybooksMissingFromCheckout deadline (issue #3764)', () => {
  beforeEach(() => {
    // Fake timers first, so the deadline is armed under them.
    vi.useFakeTimers();
    mockRunGitIn.mockImplementation(() => new Promise(() => {}));
    mockGitIn.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('resolves null after 10 s when git never answers', async () => {
    let settled: unknown = 'pending';
    void findPlaybooksMissingFromCheckout('/work/hung').then((value) => { settled = value; });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
    expect(mockRunGitIn).toHaveBeenCalled();
  });

  it('still resolves null at the deadline when only the default-branch lookup hangs', async () => {
    // The inside-work-tree probe answers; resolveDefaultBranch's gitIn hangs.
    mockRunGitIn.mockResolvedValueOnce({ kind: 'ok', stdout: 'true' });
    let settled: unknown = 'pending';
    void findPlaybooksMissingFromCheckout('/work/hung').then((value) => { settled = value; });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBeNull();
    expect(mockGitIn).toHaveBeenCalled();
  });
});
