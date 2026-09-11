import React from 'react';

export const CLI_INSTALL_BANNER_ID = 'cli-install-guidance-banner';

// Stable public getting-started guide, deep-linked to the Prerequisites
// section that carries the three CLI install commands — this banner exists to
// prompt an install, so it lands the reader on the commands rather than the
// intro. Exported so tests assert against one source of truth. Kept local
// rather than importing the plain guide URL from OverviewEmptyState.tsx (a much
// larger component) to keep this banner's blast radius to itself.
export const GETTING_STARTED_GUIDE_URL =
  'https://github.com/kookr-ai/kookr/blob/main/docs/getting-started.md#prerequisites';

interface Props {
  id?: string;
}

/**
 * Additive, non-blocking Launch-surface notice shown when the server advertises
 * zero installed agent CLIs (`availableAgentTypes === []`), so a brand-new user
 * with no Claude Code / Codex / Grok Build installed gets a clear "install a
 * CLI" nudge instead of a silent downstream launch failure (issue #3142).
 *
 * Informational only: it neither disables Launch nor hides the picker, so a
 * provider that exists but is undetected is never locked out.
 */
export function CliInstallGuidanceBanner({ id = CLI_INSTALL_BANNER_ID }: Props) {
  return (
    <div
      id={id}
      className="cli-install-banner"
      role="status"
      aria-live="polite"
      data-testid="cli-install-guidance-banner"
    >
      No coding-agent CLI detected — install Claude Code, Codex, or Grok Build to
      launch an agent.{' '}
      <a
        className="cli-install-banner__learn-more"
        href={GETTING_STARTED_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Getting Started
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </div>
  );
}
