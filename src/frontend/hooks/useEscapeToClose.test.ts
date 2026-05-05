// @vitest-environment jsdom

import React, { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEscapeToClose } from './useEscapeToClose.js';

function fireEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function fireKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

let root: Root;
let container: HTMLDivElement;

function mount(cb: () => void) {
  function Wrapper() {
    useEscapeToClose(cb);
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Wrapper));
  });
}

describe('useEscapeToClose', () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  test('calls onClose when Escape is pressed', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const onClose = vi.fn();
    mount(onClose);

    act(() => fireEscape());
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('does not call onClose for other keys', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const onClose = vi.fn();
    mount(onClose);

    act(() => {
      fireKey('Enter');
      fireKey('Tab');
      fireKey('a');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('removes listener on unmount', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const onClose = vi.fn();
    mount(onClose);

    act(() => root.unmount());
    fireEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('uses latest callback via ref without re-registering', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const first = vi.fn();
    const second = vi.fn();

    let setCb: (cb: () => void) => void;
    function Wrapper() {
      const [cb, _setCb] = useState<() => void>(() => first);
      setCb = (fn: () => void) => _setCb(() => fn);
      useEscapeToClose(cb);
      return null;
    }
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Wrapper));
    });

    act(() => setCb(second));
    act(() => fireEscape());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
