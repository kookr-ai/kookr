export const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  merged: { label: 'Merged', color: 'var(--color-success, #4caf50)' },
  patch_equivalent: { label: 'Patch eq.', color: 'var(--color-info, #2196f3)' },
  unique_commits: { label: 'Unique', color: 'var(--color-warning, #ff9800)' },
  generated_only: { label: 'Generated', color: 'var(--color-info, #2196f3)' },
  dirty: { label: 'Dirty', color: 'var(--color-error, #f44336)' },
  checked_out_elsewhere: { label: 'Elsewhere', color: 'var(--color-warning, #ff9800)' },
  stale_worktree: { label: 'Stale', color: 'var(--color-muted, #9e9e9e)' },
  busy: { label: 'Busy', color: 'var(--color-info, #2196f3)' },
  protected: { label: 'Protected', color: 'var(--color-warning, #ff9800)' },
  unknown: { label: 'Unknown', color: 'var(--color-muted, #9e9e9e)' },
};

export function ClassificationBadge({ classification }: { classification: string }) {
  const info = CLASSIFICATION_LABELS[classification] ?? { label: classification, color: '#9e9e9e' };
  return (
    <span
      className="cleanup-classification-badge"
      style={{ borderColor: info.color, color: info.color }}
    >
      {info.label}
    </span>
  );
}
