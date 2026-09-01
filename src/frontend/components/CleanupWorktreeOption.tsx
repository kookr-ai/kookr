import React, { useEffect, useId, useRef, useState } from 'react';
import type { WorktreeCleanupVerdict } from '../../shared/contracts/worktree-cleanup-verdict.js';
import {
  describeVerdictOutcome,
  isAlreadyGoneBlocker,
  isPermanentBlocker,
} from '../../shared/contracts/worktree-cleanup-verdict.js';
import { WorktreeCleanupVerdictRow } from './WorktreeCleanupVerdictRow.js';

interface Props {
  cleanupWorktree: boolean;
  /** undefined while the probe is in flight. */
  verdicts: WorktreeCleanupVerdict[] | undefined;
  /** The inspection itself errored — removability is unknown, not "no". */
  inspectFailed: boolean;
  /** An agent is still driving the worktree; blocks cleanup client-side. */
  ralphActive: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onChange: (cleanupWorktree: boolean) => void;
}

/** "checked just now" / "checked 4m ago" — the cue that motivates a re-check. */
function formatAge(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 45_000) return 'checked just now';
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `checked ${minutes}m ago`;
  return `checked ${Math.round(minutes / 60)}h ago`;
}

/**
 * What the option is currently saying, in priority order.
 *
 * Mirrors `resolveCleanupOverride`'s order exactly, and both the visible rows
 * and the spoken summary derive from it. The bug this shape prevents: applying
 * `ralphActive` by mapping over the verdicts silently dropped the veto whenever
 * the list was empty (a failed inspection), leaving a live checked box while the
 * wire still said "don't remove".
 */
type CleanupMode =
  | { kind: 'ralph-blocked'; verdicts: WorktreeCleanupVerdict[] }
  | { kind: 'checking' }
  | { kind: 'inspect-failed' }
  | { kind: 'verdicts'; verdicts: WorktreeCleanupVerdict[] };

function cleanupMode(
  verdicts: WorktreeCleanupVerdict[] | undefined,
  inspectFailed: boolean,
  ralphActive: boolean,
): CleanupMode {
  // Known client-side, so it outranks the probe — exactly as on the wire.
  if (ralphActive) {
    return {
      kind: 'ralph-blocked',
      // Only override verdicts that would otherwise go ahead. A worktree the
      // server already refused has a more specific — and possibly permanent —
      // reason; overwriting "primary working tree" with "Ralph loop active"
      // would both misreport it and offer a re-check that can never succeed.
      verdicts: (verdicts ?? []).map((v) => (
        v.removable ? { ...v, removable: false, blocker: 'ralph-loop-active' as const } : v
      )),
    };
  }
  if (verdicts === undefined) return { kind: 'checking' };
  if (inspectFailed) return { kind: 'inspect-failed' };
  return { kind: 'verdicts', verdicts };
}

/**
 * One-line spoken summary for the checkbox's description.
 *
 * `aria-describedby` deliberately points here rather than at the visible status
 * container: that container also holds the `why?` toggle and, when open, the
 * whole evidence dump — focusing the checkbox would otherwise read out a
 * paragraph with a control label embedded in it.
 *
 * Derived from the same mode the rows render, so the spoken and visible
 * verdicts cannot disagree.
 */
function describeMode(mode: CleanupMode): string {
  switch (mode.kind) {
    case 'checking':
      return 'Checking whether the worktree can be removed.';
    case 'inspect-failed':
      return 'Could not check whether the worktree can be removed.';
    case 'ralph-blocked':
      if (mode.verdicts.length === 0) return 'Kept, Ralph loop still active.';
    // falls through — named verdicts read the same either way
    case 'verdicts':
      return mode.verdicts
        .map((v) => `${v.worktreeName}: ${describeVerdictOutcome(v, ', ')}`)
        .join('. ');
  }
}

/**
 * The worktree-cleanup checkbox, with the server's own removal verdict.
 *
 * The verdict comes from the same inspection the cleanup runs, so a checked box
 * means the worktree really will be removed and a disabled one means it really
 * won't. When nothing is removable the box is unchecked AND disabled — an
 * enabled checkbox that silently does nothing is worse than no checkbox.
 *
 * The verdict is a snapshot: a PR merged in another window won't be reflected
 * until re-checked, which is what the age line and refresh control are for.
 * Cleanup re-inspects at execution regardless, so a stale display can only
 * under-promise, never over-promise.
 */
export function CleanupWorktreeOption({
  cleanupWorktree,
  verdicts,
  inspectFailed,
  ralphActive,
  refreshing,
  onRefresh,
  onChange,
}: Props): JSX.Element | null {
  // The single source of truth for what this option is saying. Everything below
  // — including the hooks — reads `mode`, never the raw props: deriving state
  // twice is what previously let the checkbox and the wire disagree.
  const mode = cleanupMode(verdicts, inspectFailed, ralphActive);

  // --- Every hook must run before the early return below: this component goes
  // from "checking" to "no worktrees" on a perfectly ordinary completion, and a
  // conditional hook would make that transition throw. ---

  // Re-render periodically so the age line advances while the dialog sits open;
  // a frozen "checked just now" would defeat the point of showing it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const summaryId = useId();

  // Indeterminate means "we don't know yet", and it must be shown exactly when
  // the wire also declines to claim — i.e. only in `checking`. A live loop
  // decides without the probe, so it is NOT unknown even while one is running.
  const isUnknown = mode.kind === 'checking';
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = isUnknown;
  }, [isUnknown]);

  // Nothing to offer — don't render a dead checkbox. A *failed* inspection also
  // yields no verdicts, but there the option must stay: the server will still
  // apply its own setting, so the user needs the choice.
  if (mode.kind === 'verdicts' && mode.verdicts.length === 0) return null;
  if (mode.kind === 'ralph-blocked' && mode.verdicts.length === 0 && !inspectFailed && verdicts !== undefined) {
    // A loop over a task that owns no worktree: still nothing to remove.
    return null;
  }

  const rows = mode.kind === 'ralph-blocked' || mode.kind === 'verdicts' ? mode.verdicts : [];

  const anyRemovable = rows.some((v) => v.removable);
  // A live loop blocks regardless of what the probe found — or whether it
  // finished. On a failed inspection removability is unknown, so the checkbox
  // stays live and the server decides unless the user says otherwise.
  const disabled = mode.kind === 'ralph-blocked'
    || mode.kind === 'checking'
    || (mode.kind === 'verdicts' && !anyRemovable);
  // Re-checking a settled fact (a primary working tree will never become
  // removable, a deleted directory will not come back) would imply a
  // possibility that doesn't exist.
  const allPermanentlyBlocked = rows.length > 0
    && rows.every((v) => v.blocker !== undefined && isPermanentBlocker(v.blocker));
  // ...but "already gone" is the outcome removal was after, not a refusal.
  // Warning that Kookr cannot remove it reads as if completion were stuck on a
  // worktree that no longer exists — which is exactly what the user just saw
  // their task clean up. Nothing is refused and no re-check is on offer, so the
  // whole stamp line goes: an age is only there to prompt a re-check.
  const allAlreadyGone = rows.length > 0
    && rows.every((v) => v.blocker !== undefined && isAlreadyGoneBlocker(v.blocker));
  // Withheld while the first probe is in flight — one is already running, and an
  // idle-looking button that silently does nothing is worse than no button.
  const showRefresh = verdicts !== undefined && !allPermanentlyBlocked;

  const checkedAt = rows[0]?.checkedAt;

  return (
    <div className="complete-cleanup-option">
      <label className={`complete-cleanup-checkbox${disabled ? ' is-disabled' : ''}`}>
        <input
          ref={inputRef}
          type="checkbox"
          checked={cleanupWorktree && !disabled}
          disabled={disabled}
          aria-label="Remove task worktree and branch"
          aria-describedby={summaryId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Remove task worktree and branch</span>
      </label>
      <span id={summaryId} className="sr-only">{describeMode(mode)}</span>

      {showRefresh && (
        <button
          type="button"
          className="complete-cleanup-refresh"
          // aria-disabled rather than disabled: a real `disabled` blurs the
          // button mid-refresh, dropping keyboard focus to the document body.
          aria-disabled={refreshing}
          onClick={() => { if (!refreshing) onRefresh(); }}
          aria-label="Re-check whether the worktree can be removed"
        >
          <span className={refreshing ? 'complete-cleanup-spin' : undefined} aria-hidden="true">↻</span>
        </button>
      )}

      {/* Live so a re-check that flips the verdict is announced — otherwise
          pressing refresh silently rewrites the text and enables the box. */}
      <div role="status" aria-live="polite">
        {mode.kind === 'checking' && (
          <div className="complete-cleanup-line complete-cleanup-line-reserve">
            <span className="complete-cleanup-spinner" aria-hidden="true" />
            <span style={{ color: 'var(--text-muted)' }}>Checking whether it&apos;s safe to remove…</span>
          </div>
        )}
        {mode.kind === 'inspect-failed' && (
          <div className="complete-cleanup-line complete-cleanup-line-reserve">
            <span aria-hidden="true" style={{ color: 'var(--amber)' }}>!</span>
            <span className="complete-cleanup-line-text" style={{ color: 'var(--amber)' }}>
              Couldn&apos;t check this worktree — Kookr will apply its usual safety rules on completion.
            </span>
          </div>
        )}
        {/* A loop can be known to block before — or without — a verdict naming
            the worktree, so the reason still has to be stated. */}
        {mode.kind === 'ralph-blocked' && mode.verdicts.length === 0 && (
          <div className="complete-cleanup-line complete-cleanup-line-reserve">
            <span aria-hidden="true" style={{ color: 'var(--amber)' }}>✕</span>
            <span className="complete-cleanup-line-text" style={{ color: 'var(--amber)' }}>
              kept — Ralph loop still active
            </span>
          </div>
        )}
        {rows.map((verdict) => (
          <WorktreeCleanupVerdictRow
            key={verdict.worktreePath}
            verdict={verdict}
            tone={
              verdict.removable
                ? 'safe'
                : verdict.blocker === 'ralph-loop-active'
                  ? 'pending'
                  : verdict.blocker !== undefined && isAlreadyGoneBlocker(verdict.blocker)
                    ? 'gone'
                    : 'blocked'
            }
          />
        ))}
      </div>

      {checkedAt !== undefined && !allAlreadyGone && (
        <div className="complete-cleanup-line complete-cleanup-stamp">
          {allPermanentlyBlocked ? 'this cannot be removed by Kookr' : formatAge(checkedAt, now)}
        </div>
      )}
    </div>
  );
}
