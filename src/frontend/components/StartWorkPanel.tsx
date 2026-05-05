import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientMessage } from '../../shared/protocol.js';

interface Props {
  send: (msg: ClientMessage) => void;
  projectId: string;
  repoPath?: string;
}

export function StartWorkPanel({ send, projectId, repoPath }: Props) {
  const [prompt, setPrompt] = useState('');
  const [issueRef, setIssueRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    promptRef.current?.focus();
    return () => { clearTimeout(timerRef.current); };
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || submitting) return;

    setSubmitting(true);
    send({
      type: 'workspace:startWork',
      projectId,
      cwd: repoPath ?? '',
      prompt: prompt.trim(),
      issueRef: issueRef.trim() || undefined,
    });

    // Reset after brief delay (ack will come via WebSocket)
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSubmitting(false), 2000);
  }, [prompt, issueRef, submitting, send, projectId, repoPath]);

  return (
    <form className="start-work-form" onSubmit={handleSubmit}>
      <div className="start-work-field">
        <label htmlFor="sw-prompt">What needs to be done?</label>
        <textarea
          ref={promptRef}
          id="sw-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the work..."
          rows={4}
          disabled={submitting}
        />
      </div>

      <div className="start-work-field">
        <label htmlFor="sw-issue">Issue reference (optional)</label>
        <input
          id="sw-issue"
          type="text"
          value={issueRef}
          onChange={(e) => setIssueRef(e.target.value)}
          placeholder="e.g. #123 or https://github.com/..."
          disabled={submitting}
        />
      </div>

      <div className="start-work-repo">
        <span>Repository root</span>
        <code>{repoPath ?? 'Resolving repository root...'}</code>
      </div>

      <div className="start-work-actions">
        <button
          type="submit"
          className="start-work-submit"
          disabled={!prompt.trim() || submitting}
          title={!repoPath ? 'Repository root unavailable' : undefined}
        >
          {submitting ? 'Launching...' : 'Start Work'}
        </button>
      </div>
    </form>
  );
}
