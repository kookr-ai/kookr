import React from 'react';

export function SectionToggleButton({
  collapsed,
  label,
  count,
  labelClassName,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  count: number;
  labelClassName: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="section-header findings-section-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <span className="section-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      <span className={labelClassName}>{label} ({count})</span>
    </button>
  );
}
