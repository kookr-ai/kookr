import React from 'react';

function handleRailRowKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  activate: () => void,
) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  activate();
}

export function RailRowSelectionTarget({ label, selected, disabled = false, onActivate }: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onActivate: () => void;
}) {
  return (
    <div
      className="rail-row-selection-target"
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={(event) => handleRailRowKeyDown(event, onActivate)}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      <span className="sr-only">Select {label}</span>
    </div>
  );
}
