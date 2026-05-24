import React from 'react';
import { formatShortcutBinding, type ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';

interface Props {
  binding?: ShortcutBinding;
  keys?: readonly string[];
  plusClassName?: string;
}

export function ShortcutKeys({ binding, keys, plusClassName }: Props) {
  const parts = keys ?? (binding ? formatShortcutBinding(binding).split('+') : []);
  return (
    <>
      {parts.map((part, index) => (
        <React.Fragment key={`${part}-${index}`}>
          {index > 0 && (plusClassName ? <span className={plusClassName}>+</span> : '+')}
          <kbd>{part}</kbd>
        </React.Fragment>
      ))}
    </>
  );
}
