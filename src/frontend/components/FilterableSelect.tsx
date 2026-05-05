import React, { useState, useRef, useEffect } from 'react';
import type { PlaybookParameterOption } from '../../core/playbook.js';

interface Props {
  options: PlaybookParameterOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Filterable dropdown for select parameters with many options.
 * Text input filters the option list; only valid option values can be selected.
 */
export function FilterableSelect({ options, value, onChange, placeholder }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Display the selected option's label in the input when not filtering
  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';
  const displayValue = open ? filter : selectedLabel;

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(filter.toLowerCase()),
  );

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIdx(-1);
  }, [filter]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('li');
      items[highlightIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIdx]);

  function handleSelect(opt: PlaybookParameterOption) {
    onChange(opt.value);
    setFilter('');
    setOpen(false);
    setHighlightIdx(-1);
  }

  function handleFocus() {
    setOpen(true);
    setFilter('');
  }

  function handleBlur() {
    // Delay to allow click on dropdown item
    setTimeout(() => {
      setOpen(false);
      setFilter('');
      setHighlightIdx(-1);
    }, 150);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) {
        handleSelect(filtered[highlightIdx]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setFilter('');
      setHighlightIdx(-1);
    }
  }

  return (
    <div className="filterable-select">
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={(e) => setFilter(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Search...'}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <ul ref={listRef} className="combo-dropdown" role="listbox">
          {filtered.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={i === highlightIdx ? 'highlighted' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(opt);
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && filter && (
        <ul className="combo-dropdown" role="listbox">
          <li className="filterable-select-empty">No matches</li>
        </ul>
      )}
    </div>
  );
}
