import React, { useEffect, useState } from 'react';
import { copyText } from '../clipboard.js';
import { dashboardTaskUrl } from '../../shared/dashboard-task-url.js';

interface Props {
  taskId: string | undefined;
}

function LinkIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
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

function currentDashboardBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const path = window.location.pathname.replace(/\/+$/, '');
  return `${window.location.origin}${path}`;
}

/** Compact control that copies `http(s)://<host>/?task=<id>` for the selected task. */
export function DashboardLinkCopyButton({ taskId }: Props): React.ReactElement | null {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  if (!taskId) return null;

  const href = dashboardTaskUrl(currentDashboardBaseUrl(), taskId);

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`task-id-copy compact${copied ? ' copied' : ''}`}
      aria-label={`Copy dashboard link for task ${taskId}`}
      title={copied ? 'Copied dashboard link' : `Copy dashboard link: ${href}`}
      data-testid="copy-dashboard-link"
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      <span className="task-id-copy-label">{copied ? 'Copied' : 'Link'}</span>
    </button>
  );
}
