import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { close, getSnapshot, subscribe } from '../store/onboarding-store.js';
import { OnboardingLayoutDiagram } from './OnboardingLayoutDiagram.js';
import type { TourTargetClass } from './onboarding-tour-targets.js';

export { TOUR_TARGET_CLASSES } from './onboarding-tour-targets.js';

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
          The <strong>+ Launch</strong> button (or <kbd>Alt</kbd>+<kbd>L</kbd>) spawns a Claude Code or Codex CLI session
          inside a managed dtach terminal. Kookr watches its output stream and surfaces anomalies as findings.
        </p>
      </>
    ),
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

export function OnboardingTour() {
  const open = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const [index, setIndex] = useState(0);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  const handleClose = useCallback(() => { close(); }, []);

  // Reset to first card when the modal closes so a replay starts at card 1.
  useEffect(() => {
    if (!open) setIndex(0);
  }, [open]);

  // Sync body class with the active card's targetClass. useLayoutEffect to
  // ensure the class is applied before paint and removed before the modal's
  // DOM is unmounted (no frame-flash with an outline ring on a naked UI).
  useLayoutEffect(() => {
    if (!open) {
      removeAllTourClasses();
      return;
    }
    const target = ONBOARDING_CARDS[index]?.targetClass;
    setTourClass(target ?? null);
    return () => { removeAllTourClasses(); };
  }, [open, index]);

  // Autofocus the primary advance button on open + each slide change.
  useEffect(() => {
    if (open) primaryButtonRef.current?.focus();
  }, [open, index]);

  // Single capture-phase keydown listener bound only while open. Capture
  // phase + stopPropagation matches the convention used by useEscapeToClose
  // (the project's standard dialog hook) and pre-empts App.tsx's bubble-phase
  // global Escape and `?` handlers. Enter is deliberately NOT handled — the
  // focused primary button absorbs it via implicit click activation, which
  // keeps card advance to a single dispatch.
  useEffect(() => {
    if (!open) return;
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
  }, [open, handleClose]);

  if (!open) return null;

  const card = ONBOARDING_CARDS[index];
  const isLast = index === ONBOARDING_CARDS.length - 1;
  const isFirst = index === 0;

  return (
    <div
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
