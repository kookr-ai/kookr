// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import {
  AGENT_SELECTION_HINTS,
  AGENT_TYPES,
  AVAILABLE_AGENT_TYPES,
  ROUND_ROBIN_AGENT_TYPE,
  buildAgentSelectionOptions,
  type AvailableAgentSelection,
} from '../../shared/protocol.js';

const options = buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES);

function renderSelector(props: {
  value: 'round-robin' | 'claude-code' | 'codex-cli' | 'grok-build' | '';
  nextAgentType?: 'claude-code' | 'codex-cli' | 'grok-build';
  roundRobinIndex?: number;
  options?: AvailableAgentSelection[];
  defaultOptionLabel?: string;
  compact?: boolean;
}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(AgentTypeSelector, {
        value: props.value,
        onChange: () => {},
        options: props.options ?? options,
        nextAgentType: props.nextAgentType,
        roundRobinIndex: props.roundRobinIndex,
        defaultOptionLabel: props.defaultOptionLabel,
        compact: props.compact,
      }),
    );
  });
  return { container, root };
}

describe('AgentTypeSelector round-robin preview', () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      rendered?.root.unmount();
    });
    rendered = undefined;
    document.body.innerHTML = '';
  });

  test('round-robin shows a Next: line for the resolved agent', () => {
    rendered = renderSelector({ value: 'round-robin', nextAgentType: 'codex-cli' });
    const preview = rendered.container.querySelector('.agent-type-select-next');
    expect(preview?.textContent).toBe('Next: Codex CLI');
  });

  test('round-robin preview follows the rotation cursor when no next is advertised', () => {
    rendered = renderSelector({ value: 'round-robin', roundRobinIndex: 2 });
    const preview = rendered.container.querySelector('.agent-type-select-next');
    expect(preview?.textContent).toBe('Next: Grok Build');
  });

  test('concrete types do not show a Next: line', () => {
    rendered = renderSelector({ value: 'claude-code', nextAgentType: 'codex-cli' });
    expect(rendered.container.querySelector('.agent-type-select-next')).toBeNull();
  });

  test('ignores an advertised next agent that is no longer in the rotation', () => {
    rendered = renderSelector({
      value: 'round-robin',
      nextAgentType: 'grok-build',
      options: buildAgentSelectionOptions(
        AVAILABLE_AGENT_TYPES.filter((entry) => entry.type !== 'grok-build'),
      ),
    });
    expect(rendered.container.querySelector('.agent-type-select-next')?.textContent).toBe('Next: Claude Code');
  });
});

describe('AgentTypeSelector runtime identity hint', () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      rendered?.root.unmount();
    });
    rendered = undefined;
    document.body.innerHTML = '';
  });

  test.each([...AGENT_TYPES])('%s shows its identity hint', (value) => {
    rendered = renderSelector({ value });
    const select = rendered.container.querySelector('select');
    const hint = rendered.container.querySelector('.agent-type-select-hint');
    expect(hint?.textContent).toBe(AGENT_SELECTION_HINTS[value]);
    expect(rendered.container.querySelector('.agent-type-select-next')).toBeNull();
    expect(select?.getAttribute('aria-describedby')).toBe(hint?.id);
    expect(rendered.container.querySelector('label')?.textContent).toBe('Agent');
  });

  test('round-robin shows its identity hint and keeps the Next: preview', () => {
    rendered = renderSelector({ value: 'round-robin', nextAgentType: 'codex-cli' });
    const select = rendered.container.querySelector('select');
    const hint = rendered.container.querySelector('.agent-type-select-hint');
    const preview = rendered.container.querySelector('.agent-type-select-next');
    expect(hint?.textContent).toBe(AGENT_SELECTION_HINTS[ROUND_ROBIN_AGENT_TYPE]);
    expect(preview?.textContent).toBe('Next: Codex CLI');
    expect(select?.getAttribute('aria-describedby')?.split(' ').sort()).toEqual(
      [hint?.id, preview?.id].sort(),
    );
    expect(rendered.container.querySelector('label')?.textContent).toBe('Agent');
  });

  test('empty server-default choice shows no identity hint', () => {
    rendered = renderSelector({ value: '', defaultOptionLabel: 'Server default' });
    expect(rendered.container.querySelector('.agent-type-select-hint')).toBeNull();
    expect(rendered.container.querySelector('.agent-type-select-next')).toBeNull();
    expect(rendered.container.querySelector('select')?.getAttribute('aria-describedby')).toBeNull();
  });

  test('compact picker keeps Next: but omits the long identity hint', () => {
    rendered = renderSelector({ value: 'round-robin', nextAgentType: 'codex-cli', compact: true });
    expect(rendered.container.querySelector('.agent-type-select-hint')).toBeNull();
    expect(rendered.container.querySelector('.agent-type-select-next')?.textContent).toBe('Next: Codex CLI');
  });
});
