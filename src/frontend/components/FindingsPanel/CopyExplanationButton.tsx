import React, { useEffect, useState } from 'react';
import { copyText } from '../../clipboard.js';

interface Props {
  /** The supervisor explanation text to copy. */
  text: string;
}

function ClipboardIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Small icon-button that copies a finding's supervisor explanation to the
 * clipboard, with the same brief "Copied" feedback as {@link TaskIdCopyButton}.
 * Reuses the shared {@link copyText} helper (async Clipboard API + fallback).
 */
export function CopyExplanationButton({ text }: Props): React.ReactElement | null {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  if (!text) return null;

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    // Don't let the click bubble to the card's select handler.
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`copy-explanation btn-icon${copied ? ' copied' : ''}`}
      aria-label="Copy explanation"
      title={copied ? 'Copied explanation' : 'Copy explanation'}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
    </button>
  );
}
