import React from 'react';

import { useKookrStore } from '../store/useStore.js';

export function PermissionBypassBanner() {
  const bypassAllPermissions = useKookrStore((state) => state.bypassAllPermissions);
  if (!bypassAllPermissions) return null;

  return (
    <div className="permission-bypass-banner" role="status" aria-live="polite" data-testid="permission-bypass-banner">
      <span className="permission-bypass-banner__badge">Permissions bypassed</span>
      <span className="permission-bypass-banner__text">
        New agent launches are running without permission prompts.
      </span>
    </div>
  );
}
