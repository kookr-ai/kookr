import React from 'react';

/*
 * The "Reflect on this session" prompt (issue #3561 slice 5b). It appears only
 * at a specific moment, never at rest. With the status bar gone it sits at the
 * top of the task list, which stays on screen in terminal focus too.
 */

export interface ReflectionPromptSuggestion {
  sessionLabel: string;
  summary: string;
  totalInterventions: number;
  totalFindings: number;
}

interface Props {
  suggestion: ReflectionPromptSuggestion;
  onReflect?: () => void;
  onDismiss?: () => void;
}

export function ReflectionPrompt({ suggestion, onReflect, onDismiss }: Props) {
  return (
    <div className="reflection-prompt" role="status" aria-live="polite" data-testid="reflection-prompt">
      <span className="reflection-prompt-copy">
        <strong>Reflect on {suggestion.sessionLabel}</strong>
        <span>
          {suggestion.summary} ({suggestion.totalInterventions} interventions, {suggestion.totalFindings} signals)
        </span>
      </span>
      <button type="button" className="btn-reflection" onClick={onReflect}>Reflect</button>
      <button type="button" className="btn-reflection btn-reflection-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
