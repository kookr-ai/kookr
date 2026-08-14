// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import {
  AVAILABLE_AGENT_TYPES,
  buildAgentSelectionOptions,
  type AvailableAgentSelection,
} from '../../shared/protocol.js';

const options = buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES);

function renderSelector(props: {
  value: 'round-robin' | 'claude-code' | 'codex-cli';
  nextAgentType?: 'claude-code' | 'codex-cli' | 'grok-build';
  roundRobinIndex?: number;
  options?: AvailableAgentSelection[];
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

  test('preview updates when availableAgentTypes change', () => {
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
