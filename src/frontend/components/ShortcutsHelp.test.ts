// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { close as closeOnboardingTour, getSnapshot } from '../store/onboarding-store.js';
import { getDefaultShortcutBindings, resolveShortcutBindings } from '../../shared/contracts/shortcut-bindings.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';

describe('ShortcutsHelp', () => {
  let container: HTMLDivElement;
  let root: Root;
  const bindings = getDefaultShortcutBindings('default');

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    closeOnboardingTour();
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  test('renders the full shortcut overlay as an accessible dialog', () => {
    const previousFocus = document.createElement('button');
    previousFocus.textContent = 'Before';
    document.body.appendChild(previousFocus);
    previousFocus.focus();

    act(() => {
      root.render(React.createElement(ShortcutsHelp, { bindings, onClose: () => root.render(React.createElement(React.Fragment)) }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('shortcuts-help-title');
    expect(container.querySelector('#shortcuts-help-title')?.textContent).toBe('Help & Shortcuts');
    expect(container.textContent).toContain('Jump to next finding by severity');
    expect(container.textContent).toContain('Show all projects');
    expect(container.textContent).toContain('Select first visible project');
    expect(document.activeElement).toBe(container.querySelector<HTMLButtonElement>('.shortcuts-close'));
  });

  test('closes with question mark and traps Tab within the dialog', () => {
    let open = true;
    function render() {
      root.render(open ? React.createElement(ShortcutsHelp, { bindings, onClose: () => {
        open = false;
        render();
      } }) : React.createElement(React.Fragment));
    }

    act(render);
    const close = container.querySelector<HTMLButtonElement>('.shortcuts-close')!;
    const tour = container.querySelector<HTMLButtonElement>('.shortcuts-tour-cta')!;
    close.focus();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(tour);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '?',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(container.querySelector('.shortcuts-help')).toBeNull();
  });

  test('opens the onboarding tour from the overlay CTA', () => {
    act(() => {
      root.render(React.createElement(ShortcutsHelp, { bindings, onClose: () => root.render(React.createElement(React.Fragment)) }));
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('.shortcuts-tour-cta')?.click();
    });

    expect(getSnapshot()).toBe(true);
  });

  test('renders active custom bindings from the resolved shortcut map', () => {
    act(() => {
      root.render(React.createElement(ShortcutsHelp, {
        bindings: resolveShortcutBindings('mac', {
          mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
        }),
        onClose: () => root.render(React.createElement(React.Fragment)),
      }));
    });

    expect(container.textContent).toContain('Jump to next finding by severity');
    expect(container.textContent).toContain('Cmd');
    expect(container.textContent).toContain('Ctrl');
    expect(container.textContent).toContain('Space');
    expect(container.textContent).not.toContain('Alt+N');
  });
});
