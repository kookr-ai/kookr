import React from 'react';

interface Props {
  message: string;
}

/** Non-blocking Launch-dialog notice with the same login command the server already returns. */
export function GrokAuthPreflightBanner({ message }: Props) {
  return (
    <div className="grok-auth-banner" role="status" aria-live="polite" data-testid="grok-auth-banner">
      {message}
    </div>
  );
}
