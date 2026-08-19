import React, { useEffect, useState } from 'react';
import { copyText } from '../clipboard.js';

interface Props {
  /** The exact fenced-block text to copy. Rendered verbatim as the block body,
   *  so the copied payload always matches what the user sees. */
  code: string;
}

/**
 * A fenced code block with a one-click copy affordance. Renders the same
 * `pre.md-pre > code.md-code-block` structure the markdown renderer used
 * before, wrapped so a corner "Copy" button can float over the (independently
 * scrolling) `<pre>`. The button copies `code` exactly — no trimming or
 * annotation — and flips to a transient "Copied" state.
 */
export function CopyableCodeBlock({ code }: Props): React.ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await copyText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="md-pre-wrap">
      <button
        type="button"
        className={`md-copy-btn${copied ? ' copied' : ''}`}
        aria-label={copied ? 'Copied code' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        onClick={handleCopy}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="md-pre">
        <code className="md-code-block">{code}</code>
      </pre>
    </div>
  );
}
