import React from 'react';

export const LAUNCH_QUOTA_BANNER_ID = 'launch-quota-banner';

interface Props {
  message: string;
  id?: string;
}

/** Non-blocking Launch-dialog notice when the Claude quota gate would rotate or deny. */
export function LaunchQuotaBanner({ message, id = LAUNCH_QUOTA_BANNER_ID }: Props) {
  return (
    <div
      id={id}
      className="launch-quota-banner"
      role="status"
      aria-live="polite"
      data-testid="launch-quota-banner"
    >
      {message}
    </div>
  );
}
