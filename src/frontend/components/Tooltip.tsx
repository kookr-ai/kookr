import React, { useState, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';

type TooltipChildProps = React.HTMLAttributes<HTMLElement> & {
  'aria-describedby'?: string;
};

interface TooltipProps {
  text: string | undefined;
  children: React.ReactElement<TooltipChildProps>;
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
  const tooltipId = useId();
  const displayText = text ? compactTooltipText(text) : undefined;
  const childProps = children.props;
  const describedBy = [childProps['aria-describedby'], displayText ? tooltipId : undefined]
    .filter(Boolean)
    .join(' ') || undefined;

  const show = useCallback((e: React.SyntheticEvent<HTMLElement>) => {
    if (!text) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const rect = e.currentTarget.getBoundingClientRect();
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
        'aria-describedby': describedBy,
        onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
          childProps.onMouseEnter?.(event);
          show(event);
        },
        onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
          childProps.onMouseLeave?.(event);
          hide();
        },
        onFocus: (event: React.FocusEvent<HTMLElement>) => {
          childProps.onFocus?.(event);
          show(event);
        },
        onBlur: (event: React.FocusEvent<HTMLElement>) => {
          childProps.onBlur?.(event);
          hide();
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
          childProps.onKeyDown?.(event);
          if (event.key === 'Escape') hide();
        },
      })}
      {displayText && visible && createPortal(
        <div
          id={tooltipId}
          role="tooltip"
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
