import React from 'react';

interface Props {
  message: string;
  id?: string;
}

export const GROK_AUTH_BANNER_ID = 'grok-auth-preflight-banner';

/** Non-blocking Launch-dialog notice with the same login command the server already returns. */
export function GrokAuthPreflightBanner({ message, id = GROK_AUTH_BANNER_ID }: Props) {
  return (
    <div
      id={id}
      className="grok-auth-banner"
      role="status"
      aria-live="polite"
      data-testid="grok-auth-banner"
    >
      {message}
    </div>
  );
}
