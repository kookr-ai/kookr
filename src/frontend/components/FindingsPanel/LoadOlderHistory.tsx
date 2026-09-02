import React from 'react';

/**
 * Explicit older-history control for the Completed section (issue #2760).
 *
 * The archive is not fetched until the user clicks. Loading, empty, and
 * archive-error states render here so they stay visible without blocking
 * the live findings list.
 */
export function LoadOlderHistoryControl({
  canLoad,
  loading,
  error,
  empty,
  onLoad,
}: {
  canLoad: boolean;
  loading: boolean;
  error: string | null;
  empty: boolean;
  onLoad: () => void;
}): React.ReactElement | null {
  if (!canLoad && !loading && !error && !empty) return null;

  return (
    <div className="completed-history-control" data-testid="completed-history-control" aria-busy={loading || undefined}>
      {loading && (
        <span data-testid="completed-history-loading" role="status" aria-live="polite">
          Loading older history…
        </span>
      )}
      {error && (
        <span
          className="completed-history-error"
          data-testid="completed-history-error"
          role="alert"
        >
          Couldn’t load older history: {error}
        </span>
      )}
      {empty && !loading && !error && (
        <span data-testid="completed-history-empty" role="status" aria-live="polite">
          No older history
        </span>
      )}
      {(canLoad || Boolean(error)) && (
        <button
          type="button"
          className="btn-load-older-history"
          data-testid="load-older-history"
          disabled={loading}
          onClick={(event) => {
            event.stopPropagation();
            onLoad();
          }}
        >
          {loading ? 'Loading older history…' : error ? 'Retry older history' : 'Load older history'}
        </button>
      )}
    </div>
  );
}
