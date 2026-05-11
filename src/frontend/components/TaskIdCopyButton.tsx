import React, { useEffect, useState } from 'react';

interface Props {
  taskId: string | undefined;
  compact?: boolean;
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

export function TaskIdCopyButton({ taskId, compact = false }: Props): React.ReactElement | null {
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
