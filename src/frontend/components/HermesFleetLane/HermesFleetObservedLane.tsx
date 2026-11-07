import React, { useCallback, useState } from 'react';
import { useKookrStore } from '../../store/useStore.js';
import { agentProviderPresentation } from '../../presentation.js';
import { loadHermesLaneOpen, saveHermesLaneOpen } from '../../store/hermes-lane-open.js';
import type {
  ObservedActivitySnapshot,
  ObservedSessionView,
} from '../../../shared/contracts/observed-activity.js';

/**
 * Hermes observed-activity lane (jeanibarz/hermes-fleet#15, slice 2).
 *
 * A self-contained, operator-global surface: an always-visible header **pill**
 * (count + bridge health) that toggles a fuller **sidebar lane** of the external
 * Hermes fleet's observed sessions. It is deliberately NOT part of the task
 * grid — the task grid is `taskId`-keyed and sweeps task-less state as ghost
 * agents, so this lane rides its own `observed.snapshot` wire frame and renders
 * as an isolated overlay. Never bound to a Task (R5/R6).
 *
 * Renders nothing until an `observed.snapshot` frame has arrived. Because the
 * server only broadcasts that frame when `KOOKR_HERMES_FLEET` is on, "snapshot
 * present" is the frontend's proxy for "lane enabled". When enabled but empty,
 * it shows one of three DISTINCT states (never a blank lane that reads "fleet
 * died"): awaiting-first-pulse-since-boot, idle/finished, or bridge-error.
 */

const HEX_PATH = agentProviderPresentation('hermes-fleet').iconPath;
/** A reject is "recent" (⇒ surface the bridge-error state) within this window. */
const RECENT_REJECT_WINDOW_MS = 60_000;

type EmptyKind = 'awaiting' | 'idle' | 'bridge-error';

function isActive(s: ObservedSessionView): boolean {
  return s.effectiveState === 'working' || s.effectiveState === 'stale';
}

/** Server-clock-relative bridge-error test (uses snapshot `now`, not client clock). */
function bridgeRejectingRecently(snap: ObservedActivitySnapshot): boolean {
  const { lastRejectAt } = snap.counters;
  return lastRejectAt != null && snap.now - lastRejectAt <= RECENT_REJECT_WINDOW_MS;
}

/** Which empty state to show when there are no active sessions. */
function emptyKind(snap: ObservedActivitySnapshot): EmptyKind {
  // Bridge error wins: a rejecting bridge (e.g. bad/absent token) must not be
  // mistaken for "awaiting" or "idle" — the operator has to know ingest is down.
  if (bridgeRejectingRecently(snap)) return 'bridge-error';
  // Never accepted anything ⇒ just booted / never heard from Hermes (R7).
  if (snap.counters.lastAcceptedAt == null) return 'awaiting';
  // Heard from Hermes before; nothing active now ⇒ genuinely idle/finished.
  return 'idle';
}

function formatAge(ms: number): string {
  if (ms < 1_000) return 'now';
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function formatClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function topRejectReason(rejected: Record<string, number>): string | null {
  const entries = Object.entries(rejected);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? null;
}

function HermesMark({ live }: { live: boolean }): React.ReactElement {
  // Neutral hexagon (operator's choice): no `--hermes-fleet` color rule exists,
  // so the mark falls through to the neutral provider-mark color. `--running`
  // adds the subtle live ring when the fleet is actively working.
  return (
    <span
      className={`agent-provider-mark agent-provider-mark--hermes-fleet${live ? ' agent-provider-mark--running' : ''}`}
      aria-hidden="true"
    >
      <svg className="agent-provider-mark-icon" viewBox="0 0 24 24">
        <path d={HEX_PATH} />
      </svg>
    </span>
  );
}

function StatePill({ state }: { state: ObservedSessionView['effectiveState'] }): React.ReactElement {
  return <span className={`hermes-state hermes-state--${state}`}>{state}</span>;
}

function SessionRow({ session }: { session: ObservedSessionView }): React.ReactElement {
  return (
    <div className="hermes-srow" data-testid="hermes-session-row">
      <StatePill state={session.effectiveState} />
      <span className="hermes-srow-label" title={session.label ?? session.sessionId}>
        {session.label ?? session.sessionId}
      </span>
      <span className="hermes-srow-when">
        {formatAge(session.ageMs)}
        {session.pulseCount > 0 ? ` · ${session.pulseCount} pulses` : ''}
      </span>
    </div>
  );
}

function EmptyState({ snap, kind }: { snap: ObservedActivitySnapshot; kind: EmptyKind }): React.ReactElement {
  if (kind === 'bridge-error') {
    const reason = topRejectReason(snap.counters.rejected);
    const total = Object.values(snap.counters.rejected).reduce((a, b) => a + b, 0);
    return (
      <div className="hermes-empty hermes-empty--error" data-testid="hermes-empty-bridge-error">
        <div className="hermes-empty-lead">
          <HermesMark live={false} /> Bridge error
        </div>
        <div className="hermes-empty-detail">
          {total} reject{total === 1 ? '' : 's'}
          {reason ? ` · ${reason}` : ''}
        </div>
        {snap.counters.lastRejectAt != null && (
          <div className="hermes-empty-sub">last {formatAge(snap.now - snap.counters.lastRejectAt)} ago</div>
        )}
      </div>
    );
  }
  if (kind === 'awaiting') {
    return (
      <div className="hermes-empty" data-testid="hermes-empty-awaiting">
        <div className="hermes-empty-lead">
          <HermesMark live={false} /> Awaiting first pulse
        </div>
        <div className="hermes-empty-detail">since boot at {formatClock(snap.counters.startedAt)}</div>
        <div className="hermes-empty-sub">no activity reported yet</div>
      </div>
    );
  }
  return (
    <div className="hermes-empty" data-testid="hermes-empty-idle">
      <div className="hermes-empty-lead">
        <HermesMark live={false} /> Idle / finished
      </div>
      <div className="hermes-empty-detail">Hermes reported idle</div>
      {snap.counters.lastAcceptedAt != null && (
        <div className="hermes-empty-sub">last active {formatAge(snap.now - snap.counters.lastAcceptedAt)} ago</div>
      )}
    </div>
  );
}

export function HermesFleetObservedLane(): React.ReactElement | null {
  const snap = useKookrStore((s) => s.observedActivity);
  const [open, setOpen] = useState<boolean>(() => loadHermesLaneOpen());

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      saveHermesLaneOpen(next);
      return next;
    });
  }, []);

  // No frame yet ⇒ flag off (or not yet received) ⇒ render nothing.
  if (!snap) return null;

  const active = snap.sessions.filter(isActive);
  const working = active.filter((s) => s.effectiveState === 'working');
  const stale = active.filter((s) => s.effectiveState === 'stale');
  const bridgeErr = bridgeRejectingRecently(snap);
  const kind = emptyKind(snap);

  // Pill summary: prefer a live count; otherwise the empty-state word.
  let summary: string;
  if (working.length > 0) summary = `${working.length} working`;
  else if (stale.length > 0) summary = `${stale.length} stale`;
  else if (kind === 'bridge-error') summary = 'bridge error';
  else if (kind === 'awaiting') summary = 'awaiting';
  else summary = 'idle';

  // Sort for display: working, then stale, then the rest; freshest first.
  const sorted = [...snap.sessions].sort((a, b) => {
    const rank = (s: ObservedSessionView) =>
      s.effectiveState === 'working' ? 0 : s.effectiveState === 'stale' ? 1 : 2;
    return rank(a) - rank(b) || a.ageMs - b.ageMs;
  });

  return (
    <div className="hermes-lane-root" data-testid="hermes-observed-lane">
      <button
        type="button"
        className={`hermes-pill${open ? ' hermes-pill--open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={`Hermes Fleet observed activity: ${summary}. ${open ? 'Collapse' : 'Expand'} lane.`}
        data-testid="hermes-pill"
      >
        <HermesMark live={working.length > 0} />
        <span className="hermes-pill-summary">{summary}</span>
        <span
          className={`hermes-bridge-dot${bridgeErr ? ' hermes-bridge-dot--error' : ''}`}
          title={bridgeErr ? 'bridge rejecting' : 'bridge ok'}
        />
      </button>

      {open && (
        <section className="hermes-lane" aria-label="Hermes Fleet observed sessions" data-testid="hermes-lane-panel">
          <header className="hermes-lane-header">
            <HermesMark live={working.length > 0} />
            <span className="hermes-lane-title">Hermes Fleet</span>
            <span className="hermes-lane-count">
              {active.length > 0 ? `${active.length} active` : 'not task-bound'}
            </span>
            <button
              type="button"
              className="hermes-lane-close"
              onClick={toggle}
              aria-label="Collapse Hermes lane"
              data-testid="hermes-lane-close"
            >
              ×
            </button>
          </header>

          <div className="hermes-lane-body">
            {active.length > 0 ? (
              sorted.map((s) => <SessionRow key={s.sessionId} session={s} />)
            ) : (
              <EmptyState snap={snap} kind={kind} />
            )}
          </div>

          <footer className={`hermes-lane-foot${bridgeErr ? ' hermes-lane-foot--error' : ''}`}>
            <span className={`hermes-bridge-dot${bridgeErr ? ' hermes-bridge-dot--error' : ''}`} />
            <span className="hermes-lane-foot-text">
              {bridgeErr ? 'bridge rejecting' : 'bridge ok'} · {snap.counters.accepted} accepted
            </span>
          </footer>
        </section>
      )}
    </div>
  );
}
