import React, { useEffect } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { open as openOnboardingTour } from '../store/onboarding-store.js';

interface Shortcut {
  keys: string[];
  description: string;
  context?: string;
}

const SHORTCUT_GROUPS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['Alt', 'N'], description: 'Jump to next finding by severity' },
      { keys: ['Alt', 'J'], description: 'Next task (findings + healthy)' },
      { keys: ['Alt', 'K'], description: 'Previous task' },
      { keys: ['Esc'], description: 'Deselect current task', context: 'when no dialog is open' },
    ],
  },
  {
    title: 'Responding to findings',
    shortcuts: [
      { keys: ['Enter'], description: 'Send response and move to next finding' },
      { keys: ['1'], description: 'Trigger quick action by number', context: 'when response input is empty' },
      { keys: ['Alt', 'M'], description: 'Toggle voice input (speech-to-text)', context: 'when STT is enabled' },
    ],
  },
  {
    title: 'Task management',
    shortcuts: [
      { keys: ['Alt', 'L'], description: 'Open quick launch bar to create a new task' },
      { keys: ['Alt', 'S'], description: 'Snooze selected task (opens duration picker)' },
      { keys: ['Alt', 'Z'], description: 'Quick snooze selected task (5 minutes)' },
      { keys: ['Alt', 'End'], description: 'Complete selected task (with confirmation)' },
      { keys: ['Alt', 'Del'], description: 'Cancel selected task (with confirmation)' },
    ],
  },
  {
    title: 'Terminal',
    shortcuts: [
      { keys: ['Alt', '1-3'], description: 'Send number to terminal and skip to next task' },
    ],
  },
  {
    title: 'Detail panel',
    shortcuts: [
      { keys: ['Alt', 'R'], description: 'Focus reply input for current finding' },
    ],
  },
  {
    title: 'Dialogs',
    shortcuts: [
      { keys: ['Alt', 'A'], description: 'Toggle achievements panel' },
      { keys: ['Esc'], description: 'Close current dialog or cancel editing' },
      { keys: ['Enter'], description: 'Confirm / submit in dialogs and inline edits' },
    ],
  },
];

interface Props {
  onClose: () => void;
}

export function ShortcutsHelp({ onClose }: Props) {
  useEscapeToClose(onClose);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  function handleReplayTour() {
    openOnboardingTour();
    onClose();
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="shortcuts-help" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <h3>Help &amp; Shortcuts</h3>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="shortcuts-body">
          <div className="shortcuts-group">
            <button
              type="button"
              className="shortcuts-tour-cta"
              onClick={handleReplayTour}
            >
              Take the product tour <span aria-hidden="true">{'→'}</span>
            </button>
          </div>
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <h4>{group.title}</h4>
              <div className="shortcuts-list">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys.join('+')} className="shortcut-row">
                    <span className="shortcut-keys">
                      {shortcut.keys.map((key, i) => (
                        <React.Fragment key={key}>
                          {i > 0 && <span className="shortcut-plus">+</span>}
                          <kbd>{key}</kbd>
                        </React.Fragment>
                      ))}
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
