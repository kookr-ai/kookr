// --- Read-only viewer banner (#811, RFC §"Phase 3 UX") ---
//
// A persistent banner shown only to scoped read-only viewers: "Viewing <scope> —
// read-only". Renders nothing for the owner. The scope label maps project ids to
// their display names via the project summaries already in the store.

import React, { useMemo } from 'react';

import { useKookrStore } from '../store/useStore.js';
import { formatViewerScope, useViewerSession } from '../viewer-session.js';

export function ReadOnlyBanner() {
  const { isViewer, scope } = useViewerSession();
  const projectSummaries = useKookrStore((s) => s.projectSummaries);

  const scopeLabel = useMemo(() => {
    const nameById = new Map(projectSummaries.map((p) => [p.project, p.displayName] as const));
    return formatViewerScope(scope, (id) => nameById.get(id) ?? id);
  }, [scope, projectSummaries]);

  if (!isViewer) return null;

  return (
    <div className="read-only-banner" role="status" aria-live="polite" data-testid="read-only-banner">
      <span className="read-only-banner__badge">Read-only</span>
      <span className="read-only-banner__text">
        Viewing <strong>{scopeLabel}</strong> — you can watch but not change anything.
      </span>
    </div>
  );
}
