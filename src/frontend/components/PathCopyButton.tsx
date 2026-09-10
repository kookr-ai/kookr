import React, { useEffect, useState } from 'react';
import { copyText } from '../clipboard.js';

interface Props {
  /** Absolute working directory (`agent.cwd`) to copy. */
  cwd: string | undefined;
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

/**
 * Icon-only control that copies an agent's working directory to the clipboard.
 *
 * Modeled on `TaskIdCopyButton`: reuses the shared `copyText` helper, the
 * transient "copied" state, the clipboard/check glyphs, and the compact
 * `.task-id-copy.icon-only.btn-icon` affordance so it sits densely beside the
 * Project/Branch meta rows. The full path stays in the aria-label / tooltip.
 * Renders nothing when `cwd` is absent.
 */
export function PathCopyButton({ cwd }: Props): React.ReactElement | null {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  if (!cwd) return null;

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(cwd);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`task-id-copy icon-only btn-icon${copied ? ' copied' : ''}`}
      aria-label={`Copy working directory ${cwd}`}
      title={copied ? 'Copied working directory' : `Copy working directory: ${cwd}`}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
    </button>
  );
}
