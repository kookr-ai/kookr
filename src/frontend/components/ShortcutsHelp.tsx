import React, { useEffect, useRef } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { open as openOnboardingTour } from '../store/onboarding-store.js';
import {
  getShortcutHelpGroups,
  matchesShortcutAction,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import { ShortcutKeys } from './ShortcutKeys.js';

interface Props {
  bindings: ShortcutBindingMap;
  onClose: () => void;
  /** Opens the read-only Share view. When omitted, the Share CTA is hidden. */
  onShareView?: () => void;
}

const CONTEXTUAL_SHORTCUTS = [
  {
    title: 'Responding to findings',
    shortcuts: [
      { keys: ['Enter'], description: 'Send response; when empty, advance to next item' },
      { keys: ['1'], description: 'Trigger quick action by number', context: 'when response input is empty' },
    ],
  },
  {
    title: 'Dialogs',
    shortcuts: [
      { keys: ['Esc'], description: 'Close current dialog or cancel editing' },
      { keys: ['Enter'], description: 'Confirm / submit in dialogs and inline edits' },
    ],
  },
];

export function ShortcutsHelp({ bindings, onClose, onShareView }: Props) {
  useEscapeToClose(onClose);
  const shortcutGroups = getShortcutHelpGroups(bindings);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchesShortcutAction(e, bindings, 'toggle_shortcuts_help')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        keepFocusInDialog(e, dialogRef.current);
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [bindings, onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function handleReplayTour() {
    openOnboardingTour();
    onClose();
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="shortcuts-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-header">
          <h3 id="shortcuts-help-title">Help &amp; Shortcuts</h3>
          <button ref={closeButtonRef} className="shortcuts-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="shortcuts-body">
          <div className="shortcuts-group shortcuts-cta-row">
            <button
              type="button"
              className="shortcuts-tour-cta"
              onClick={handleReplayTour}
            >
              Take the product tour <span aria-hidden="true">{'->'}</span>
            </button>
            {onShareView && (
              <button
                type="button"
                className="shortcuts-tour-cta"
                onClick={onShareView}
              >
                Share read-only view <span aria-hidden="true">{'->'}</span>
              </button>
            )}
          </div>
          {shortcutGroups.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <h4>{group.title}</h4>
              <div className="shortcuts-list">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.id} className="shortcut-row">
                    <span className="shortcut-keys">
                      <ShortcutKeys binding={shortcut.binding} plusClassName="shortcut-plus" />
                    </span>
                    <span className="shortcut-desc">
                      {shortcut.description}
                      {shortcut.context && (
                        <span className="shortcut-context"> ({shortcut.context})</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {CONTEXTUAL_SHORTCUTS.map((group) => (
            <div key={`contextual-${group.title}`} className="shortcuts-group">
              <h4>{group.title}</h4>
              <div className="shortcuts-list">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys.join('+')} className="shortcut-row">
                    <span className="shortcut-keys">
                      <ShortcutKeys keys={shortcut.keys} plusClassName="shortcut-plus" />
                    </span>
                    <span className="shortcut-desc">
                      {shortcut.description}
                      {shortcut.context && (
                        <span className="shortcut-context"> ({shortcut.context})</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="shortcuts-footer">
          Press <kbd>?</kbd> or <kbd>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}

function keepFocusInDialog(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));

  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
