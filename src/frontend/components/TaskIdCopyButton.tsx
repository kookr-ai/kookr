import React, { useEffect, useState } from 'react';

interface Props {
  taskId: string | undefined;
  compact?: boolean;
  /**
   * Render just a copy glyph (no id text) so the control can sit densely in an
   * icon rail. The full id stays in the aria-label / tooltip. Composes with the
   * shared `.btn-icon` styling.
   */
  iconOnly?: boolean;
}

function ClipboardIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

export function TaskIdCopyButton({ taskId, compact = false, iconOnly = false }: Props): React.ReactElement | null {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  if (!taskId) return null;

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(taskId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        className={`task-id-copy icon-only btn-icon${copied ? ' copied' : ''}`}
        aria-label={`Copy task ID ${taskId}`}
        title={copied ? 'Copied task ID' : `Copy task ID: ${taskId}`}
        onClick={handleCopy}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </button>
    );
  }

  const label = copied ? 'Copied' : compact ? shortTaskId(taskId) : `ID ${shortTaskId(taskId)}`;

  return (
    <button
      type="button"
      className={`task-id-copy${compact ? ' compact' : ''}${copied ? ' copied' : ''}`}
      aria-label={`Copy task ID ${taskId}`}
      title={copied ? 'Copied task ID' : `Copy task ID: ${taskId}`}
      onClick={handleCopy}
    >
      <span className="task-id-copy-icon" aria-hidden="true">#</span>
      <span className="task-id-copy-label">{label}</span>
    </button>
  );
}
