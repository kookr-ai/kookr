import React, { useEffect, useId, useRef, useState } from 'react';
import type { AnomalyType } from '../../shared/contracts/anomalies.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

const SUSPECTED_TYPE_OPTIONS: ReadonlyArray<{ value: AnomalyType; label: string }> = [
  { value: 'needs_input', label: 'Waiting for input' },
  { value: 'permission_blocked', label: 'Permission blocked' },
  { value: 'repeated_error', label: 'Repeated error' },
  { value: 'merge_conflict', label: 'Merge conflict' },
  { value: 'stale_agent', label: 'Stale / stuck' },
  { value: 'hook_disconnected', label: 'Hook pipeline broken' },
  { value: 'hook_missing', label: 'Hook missing' },
  { value: 'tmux_unresponsive', label: 'Tmux unresponsive' },
  { value: 'api_error', label: 'API error' },
  { value: 'budget_exceeded', label: 'Budget exceeded' },
];

type Mode = 'false_positive' | 'false_negative';

interface Props {
  mode: Mode;
  agentName: string;
  /** Supervisor's explanation, shown for context in FP mode. */
  supervisorExplanation?: string;
  onSubmit: (payload: { userReason: string; suspectedType?: AnomalyType }) => void;
  onClose: () => void;
}

/**
 * Captures a user's reason when flagging a supervisor finding as a false
 * positive or reporting a missed finding (false negative). For FN the
 * reason is required and the user can hint at which detector should have
 * fired; for FP the reason is optional but encouraged.
 */
export function SupervisorFeedbackDialog({
  mode,
  agentName,
  supervisorExplanation,
  onSubmit,
  onClose,
}: Props) {
  const [reason, setReason] = useState('');
  const [suspectedType, setSuspectedType] = useState<AnomalyType | ''>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEscapeToClose(onClose);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textareaRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  const trimmed = reason.trim();
  const isValid = mode === 'false_negative' ? trimmed.length > 0 : true;
  const title = mode === 'false_positive' ? 'Flag false positive' : 'Flag missed finding';
  const reasonLabel = mode === 'false_positive'
    ? 'What was wrong with this finding? (optional)'
    : 'What should Kookr have flagged? (required)';
  const submitLabel = mode === 'false_positive' ? 'Not a real issue' : 'Missed a real issue';

  function handleSubmit() {
    if (!isValid) return;
    onSubmit({
      userReason: trimmed,
      ...(mode === 'false_negative' && suspectedType ? { suspectedType } : {}),
    });
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="supervisor-feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="supervisor-feedback-dialog-title">
          {title}: <strong>{agentName}</strong>
        </div>
        {mode === 'false_positive' && supervisorExplanation && (
          <div className="supervisor-feedback-dialog-context">
            <em>Kookr said:</em> {supervisorExplanation}
          </div>
        )}
        {mode === 'false_negative' && (
          <div className="supervisor-feedback-dialog-field">
            <label htmlFor={`${titleId}-type`}>Suspected category (optional)</label>
            <select
              id={`${titleId}-type`}
              value={suspectedType}
              onChange={(e) => setSuspectedType((e.target.value || '') as AnomalyType | '')}
            >
              <option value="">— don't know —</option>
              {SUSPECTED_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="supervisor-feedback-dialog-field">
          <label htmlFor={`${titleId}-reason`}>{reasonLabel}</label>
          <textarea
            ref={textareaRef}
            id={`${titleId}-reason`}
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={mode === 'false_positive'
              ? 'e.g. agent emitted a long review report, not a question'
              : 'e.g. agent had been stuck for 10 minutes but no finding appeared'}
          />
        </div>
        <div className="supervisor-feedback-dialog-actions">
          <button className="btn-xs" onClick={onClose}>Cancel</button>
          <button
            className="btn-xs btn-primary"
            onClick={handleSubmit}
            disabled={!isValid}
            aria-disabled={!isValid}
          >
            {submitLabel}
          </button>
        </div>
        <div className="supervisor-feedback-dialog-hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> submit · <kbd>Esc</kbd> cancel
        </div>
      </div>
    </div>
  );
}
