import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string | undefined;
  children: React.ReactElement;
}

const MAX_TOOLTIP_CHARS = 600;

function compactTooltipText(text: string): string {
  if (text.length <= MAX_TOOLTIP_CHARS) return text;
  return `${text.slice(0, MAX_TOOLTIP_CHARS).trimEnd()}...`;
}

export function Tooltip({ text, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const displayText = text ? compactTooltipText(text) : undefined;

  const show = useCallback((e: React.MouseEvent) => {
    if (!text) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({
      top: rect.top - 8,
      left: rect.right + 8,
    });
    timerRef.current = setTimeout(() => setVisible(true), 400);
  }, [text]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  return (
    <>
      {React.cloneElement(children, {
        onMouseEnter: show,
        onMouseLeave: hide,
      })}
      {displayText && visible && createPortal(
        <div
          className="tooltip-portal visible"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          {displayText}
        </div>,
        document.body,
      )}
    </>
  );
}
