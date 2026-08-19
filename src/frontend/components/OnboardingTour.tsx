import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  detectShortcutPlatform,
  getDefaultShortcutBindings,
  getFeaturedShortcuts,
  type ShortcutDisplay,
} from '../../shared/contracts/shortcut-bindings.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { close, getSnapshot, subscribe } from '../store/onboarding-store.js';
import { OnboardingLayoutDiagram } from './OnboardingLayoutDiagram.js';
import { ShortcutKeys } from './ShortcutKeys.js';
import type { TourTargetClass } from './onboarding-tour-targets.js';

export { TOUR_TARGET_CLASSES } from './onboarding-tour-targets.js';

/** Same published YouTube URL as the README hero and Getting Started. Update all three if the video is replaced. */
export const NARRATED_DEMO_YOUTUBE_URL = 'https://youtu.be/DHZrO8T_6Xg';

interface Card {
  title: string;
  /** Body content. Renders inside `.onboarding-card-body`. */
  body: React.ReactNode;
  /**
   * Optional tour-target class suffix. While this card is active, the global
   * `body` element gains `kookr-tour-active-<targetClass>`, and any element
   * with className `kookr-tour-target-<targetClass>` shows a pulsing ring.
   * Values must be drawn from `TOUR_TARGET_CLASSES` so the Playwright
   * contract test stays exhaustive.
   */
  targetClass?: TourTargetClass;
}

export const ONBOARDING_CARDS: Card[] = [
  {
    title: 'Welcome to Kookr',
    body: (
      <>
        <p>
          Kookr is a smart attention router for developers running multiple AI coding agents.
          It does not write code — it watches your agents and tells you which one needs you next.
        </p>
        <p>
          <a
            className="onboarding-demo-link"
            href={NARRATED_DEMO_YOUTUBE_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="onboarding-welcome-demo"
          >
            Watch the 2-minute demo
          </a>
        </p>
        <p className="onboarding-card-footer-hint">
          You can re-open this tour from the <strong>?</strong> Help button at the top right anytime.
        </p>
      </>
    ),
  },
  {
    title: 'The four panes',
    targetClass: 'layout',
    body: (
      <>
        <p>
          Kookr's dashboard has four areas: a <strong>top bar</strong> with status and shortcuts,
          a <strong>project sidebar</strong>, a <strong>findings panel</strong> in the middle,
          and a <strong>detail panel</strong> on the right that splits an <strong>Activity</strong> feed
          alongside a <strong>Terminal</strong> / <strong>Diff</strong> toggle, with a reply input below.
        </p>
        <OnboardingLayoutDiagram />
      </>
    ),
  },
  {
    title: 'Launching an agent',
    targetClass: 'launch',
    body: (
      <>
        <p>
          The <strong>+ Launch</strong> button (or <QuickLaunchShortcutHint />) spawns a Claude Code or Codex CLI session
          inside a managed dtach terminal. Kookr watches its output stream and surfaces anomalies as findings.
        </p>
      </>
    ),
  },
  {
    title: 'First-launch readiness',
    body: (
      <>
        <p>
          Before your first agent launch, run <code className="onboarding-command">pnpm run doctor</code> from
          the Kookr checkout. It checks the local pieces that most often block startup: Node, pnpm,
          build tools, dtach, optional Docker/GPU support, and port conflicts.
        </p>
        <ul className="onboarding-readiness-list" aria-label="First-launch recovery checks">
          <li>Missing agent binary or auth: install/sign in to Claude Code or Codex, then retry.</li>
          <li>
            Port conflict: free the reported port, use <code className="onboarding-command">pnpm dev</code> on
            4801, or keep daily use on 4800.
          </li>
          <li>Native build or dtach issue: follow the doctor output before launching more tasks.</li>
        </ul>
      </>
    ),
  },
  {
    title: 'Shortcuts that save clicks',
    body: <ShortcutCheatsheetCard />,
  },
  {
    title: 'Findings and routing',
    targetClass: 'findings',
    body: (
      <>
        <p>
          When the supervisor detects a stuck loop, repeated error, permission block, or budget burn,
          it surfaces a <strong>finding</strong>. The dashboard routes you to the most urgent one so
          you don't have to keep tabs on every agent yourself.
        </p>
      </>
    ),
  },
];

function ShortcutCheatsheetCard() {
  const shortcuts = getFeaturedShortcuts(detectShortcutPlatform());

  return (
    <>
      <p>
        Use these bindings to move through agent work without hunting through panels. Press <kbd>?</kbd> anytime
        for the complete shortcut list.
      </p>
      <ul className="onboarding-shortcut-grid" aria-label="Shortcut cheatsheet">
        {shortcuts.map((shortcut) => (
          <ShortcutCheatsheetRow key={shortcut.id} shortcut={shortcut} />
        ))}
      </ul>
    </>
  );
}

function QuickLaunchShortcutHint() {
  const bindings = getDefaultShortcutBindings(detectShortcutPlatform());
  return <ShortcutKeys binding={bindings.quick_launch} />;
}

function ShortcutCheatsheetRow({ shortcut }: { shortcut: ShortcutDisplay }) {
  return (
    <li className="onboarding-shortcut-row">
      <span className="onboarding-shortcut-keys">
        <ShortcutKeys keys={shortcut.keys} plusClassName="onboarding-shortcut-plus" />
      </span>
      <span className="onboarding-shortcut-desc">{shortcut.description}</span>
    </li>
  );
}

export interface OnboardingTourProps {
  /**
   * Invoked from the final card's primary "Launch your first agent" action.
   * The tour closes itself before calling this so the Launch dialog it opens
   * owns focus / aria-modal cleanly (the tour dialog is unmounted in the same
   * commit). When omitted, the final card keeps its plain "Done" dismissal and
   * shows no launch affordance.
   */
  onLaunchFirstTask?: () => void;
}

/**
 * Shell that only mounts the dialog while the tour is open so useDialogFocus
 * can install the Tab trap, initial focus, and focus-restore lifecycle against
 * a real dialog DOM (matches ConfirmDialog / SnoozeDialog pattern).
 */
export function OnboardingTour({ onLaunchFirstTask }: OnboardingTourProps = {}) {
  const open = useSyncExternalStore(subscribe, getSnapshot, () => false);
  if (!open) return null;
  return <OnboardingTourDialog onLaunchFirstTask={onLaunchFirstTask} />;
}

function OnboardingTourDialog({ onLaunchFirstTask }: OnboardingTourProps) {
  // Fresh mount on each open resets to card 0 (replays start at the welcome step).
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  const handleClose = useCallback(() => { close(); }, []);

  const handleLaunchFirstTask = useCallback(() => {
    // Close the tour first so its dialog is torn down in the same commit that
    // the Launch dialog mounts — no focus-trap / aria-modal collision.
    close();
    onLaunchFirstTask?.();
  }, [onLaunchFirstTask]);

  useDialogFocus({ dialogRef, initialFocusRef: primaryButtonRef });

  // Sync body class with the active card's targetClass. useLayoutEffect to
  // ensure the class is applied before paint and removed before the modal's
  // DOM is unmounted (no frame-flash with an outline ring on a naked UI).
  useLayoutEffect(() => {
    const target = ONBOARDING_CARDS[index]?.targetClass;
    setTourClass(target ?? null);
    return () => { removeAllTourClasses(); };
  }, [index]);

  // Autofocus the primary advance button on each slide change. Open-time
  // focus is owned by useDialogFocus via initialFocusRef.
  useEffect(() => {
    primaryButtonRef.current?.focus();
  }, [index]);

  // Single capture-phase keydown listener. Capture phase + stopPropagation
  // matches useEscapeToClose and pre-empts App.tsx's bubble-phase global
  // Escape and `?` handlers. Enter is deliberately NOT handled — the focused
  // primary button absorbs it via implicit click activation. Tab is owned by
  // useDialogFocus (sibling capture listener; keys do not collide).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
        return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Suppress `?` while the tour is open so ShortcutsHelp does not
        // stack on top of it. (Closing the tour first is the intended path.)
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => i >= ONBOARDING_CARDS.length - 1 ? i : i + 1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleClose]);

  const card = ONBOARDING_CARDS[index];
  const isLast = index === ONBOARDING_CARDS.length - 1;
  const isFirst = index === 0;
  // On the final card, when a launch callback is wired, convert the terminal
  // "Done" into a primary launch action with a secondary dismiss beside it.
  const showLaunchCta = isLast && Boolean(onLaunchFirstTask);

  return (
    <div
      ref={dialogRef}
      className="dialog-overlay onboarding-overlay"
      data-testid="onboarding-overlay"
      onClick={(e) => {
        // Backdrop click closes without falling through to underlying affordances.
        if (e.target === e.currentTarget) {
          e.stopPropagation();
          handleClose();
        }
      }}
      role="dialog"
      aria-labelledby="onboarding-card-title"
      aria-modal="true"
    >
      <div className="onboarding-tour" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-header">
          <h3 id="onboarding-card-title">{card.title}</h3>
          <button
            type="button"
            className="onboarding-skip"
            data-testid="onboarding-skip"
            onClick={handleClose}
            aria-label={isLast ? 'Close tour' : 'Skip tour'}
          >
            {isLast ? 'Close' : 'Skip'}
          </button>
        </div>
        <div className="onboarding-card-body">{card.body}</div>
        <div className="onboarding-footer">
          <div className="onboarding-dots" role="group" aria-label="Tour progress">
            {ONBOARDING_CARDS.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`onboarding-dot${i === index ? ' active' : ''}`}
                aria-label={`Step ${i + 1} of ${ONBOARDING_CARDS.length}`}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <div className="onboarding-nav">
            <button
              type="button"
              className="onboarding-btn"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={isFirst}
            >
              Back
            </button>
            {showLaunchCta && (
              <button
                type="button"
                className="onboarding-btn"
                data-testid="onboarding-done"
                onClick={handleClose}
              >
                Done
              </button>
            )}
            {showLaunchCta ? (
              <button
                ref={primaryButtonRef}
                type="button"
                className="onboarding-btn primary"
                data-testid="onboarding-launch-first-task"
                onClick={handleLaunchFirstTask}
              >
                Launch your first agent
              </button>
            ) : (
              <button
                ref={primaryButtonRef}
                type="button"
                className="onboarding-btn primary"
                onClick={() => {
                  if (isLast) handleClose();
                  else setIndex((i) => Math.min(ONBOARDING_CARDS.length - 1, i + 1));
                }}
              >
                {isLast ? 'Done' : 'Next'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function setTourClass(targetClass: string | null): void {
  removeAllTourClasses();
  if (targetClass) {
    document.body.classList.add(`kookr-tour-active-${targetClass}`);
  }
}

function removeAllTourClasses(): void {
  const toRemove: string[] = [];
  document.body.classList.forEach((cls) => {
    if (cls.startsWith('kookr-tour-active-')) toRemove.push(cls);
  });
  for (const cls of toRemove) document.body.classList.remove(cls);
}
