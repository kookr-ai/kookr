import React from 'react';

export function FindingGroupRenderCap({
  visibleCount,
  totalCount,
  label,
  onShowAll,
}: {
  visibleCount: number;
  totalCount: number;
  label: string;
  onShowAll: () => void;
}): React.ReactElement | null {
  if (visibleCount >= totalCount) return null;
  return (
    <button
      type="button"
      className="btn-xs finding-group-show-all"
      aria-label={`Show all ${totalCount} ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onShowAll();
      }}
    >
      Showing {visibleCount} of {totalCount} - show all
    </button>
  );
}
