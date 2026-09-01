// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LaunchTaskDialog, SAMPLE_LAUNCH_PROMPTS } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AvailableAgentType, ClientMessage } from '../../shared/protocol.js';

const CWD = '/home/user/proj';
// The prompt-file fallback writes to a freshly mktemp'd file (not a fixed path)
// so a pasted command cannot follow a planted symlink or clobber a concurrent copy.
const MKTEMP_PREFIX = 'prompt_file="$(mktemp)"';
const PROMPT_FILE_FLAG = '--prompt-file "$prompt_file"';

function seedStore(overrides: Record<string, unknown> = {}): void {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  const availableAgentTypes: AvailableAgentType[] = [
    { type: 'claude-code', label: 'Claude Code' },
  ];
  useKookrStore.setState({ ...nextData, availableAgentTypes, serverCwd: CWD, ...overrides });
}

// The pure buildSpawnCommand golden corpus lives in spawn-command.test.ts. The
// tests below verify only that the dialog wires its copy action to that builder.
describe('LaunchTaskDialog copy kookr spawn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;
  let alertSpy: ReturnType<typeof vi.fn>;

  function copyButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Copy kookr spawn' || b.textContent?.trim() === 'Copied',
    ) as HTMLButtonElement | undefined;
  }

  function setClipboard(fn: ReturnType<typeof vi.fn>): void {
    writeText = fn;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  }

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    setClipboard(vi.fn().mockResolvedValue(undefined));
    seedStore();
    alertSpy = vi.fn();
    useKookrStore.setState({ handleAlert: alertSpy });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(props: Partial<React.ComponentProps<typeof LaunchTaskDialog>> = {}): void {
    act(() => {
      root.render(React.createElement(LaunchTaskDialog, {
        send: (() => true) as (msg: ClientMessage) => boolean,
        onClose: vi.fn(),
        defaultAgentType: 'claude-code',
        ...props,
      }));
    });
  }

  async function flush(): Promise<void> {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  test('the copy control is disabled until a prompt is entered', () => {
    render();
    expect(copyButton()?.disabled).toBe(true);
  });

  test('the copy control is disabled when the working directory is blank', () => {
    render({ defaultPrompt: 'review the diff', defaultCwd: '   ' });
    expect(copyButton()?.disabled).toBe(true);
  });

  test('copying a simple launch writes the exact one-liner and toasts what was copied', async () => {
    render({ defaultPrompt: 'review the diff', defaultCwd: CWD, defaultCriteria: 'green CI' });
    const button = copyButton();
    expect(button?.disabled).toBe(false);
    await act(async () => { button!.click(); });
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      "kookr spawn -C /home/user/proj -a claude-code --criteria 'green CI' \"review the diff\"",
    );
    expect(alertSpy).toHaveBeenCalledWith('', expect.stringContaining('Copied kookr spawn command'), 'info');
  });

  test('copying a hook-sensitive prompt uses --prompt-file and says so', async () => {
    render({ defaultPrompt: 'say "hi" and run `ls`', defaultCwd: CWD });
    await act(async () => { copyButton()!.click(); });
    await flush();
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toBe(
      `${MKTEMP_PREFIX}\ncat > "$prompt_file" <<'SPAWN_PROMPT_EOF'\n` +
      'say "hi" and run `ls`\n' +
      'SPAWN_PROMPT_EOF\n' +
      `kookr spawn -C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    );
    expect(alertSpy).toHaveBeenCalledWith('', expect.stringContaining('--prompt-file'), 'info');
  });

  test('a clipboard failure surfaces an error toast', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('clipboard blocked')));
    render({ defaultPrompt: 'review the diff', defaultCwd: CWD });
    await act(async () => { copyButton()!.click(); });
    await flush();
    expect(alertSpy).toHaveBeenCalledWith('', expect.stringContaining('Could not copy'), 'error');
  });
});

describe('LaunchTaskDialog sample prompt chips', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    seedStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(props: Partial<React.ComponentProps<typeof LaunchTaskDialog>> = {}): ReturnType<typeof vi.fn> {
    const send = vi.fn(() => true);
    act(() => {
      root.render(React.createElement(LaunchTaskDialog, {
        send,
        onClose: vi.fn(),
        defaultAgentType: 'claude-code',
        defaultCwd: CWD,
        ...props,
      }));
    });
    return send;
  }

  function chips(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('.sample-prompt-chip')) as HTMLButtonElement[];
  }

  function promptEl(): HTMLTextAreaElement {
    const el = container.querySelector('textarea');
    if (!el) throw new Error('prompt textarea not rendered');
    return el;
  }

  function cwdEl(): HTMLInputElement {
    const el = container.querySelector('.combo-input input[type="text"]');
    if (!el) throw new Error('cwd input not rendered');
    return el as HTMLInputElement;
  }

  test('the Manual tab shows at least two sample prompt chips', () => {
    render();
    expect(chips().length).toBeGreaterThanOrEqual(2);
    expect(chips().length).toBe(SAMPLE_LAUNCH_PROMPTS.length);
    for (const sample of SAMPLE_LAUNCH_PROMPTS) {
      expect(chips().some((chip) => chip.textContent === sample.label)).toBe(true);
    }
  });

  test('clicking a chip fills the prompt only — cwd and submit stay user-controlled', () => {
    const send = render({ defaultPrompt: 'typed by the operator' });
    const cwdBefore = cwdEl().value;
    const sample = SAMPLE_LAUNCH_PROMPTS[0];
    const chip = chips().find((button) => button.textContent === sample.label);
    expect(chip).toBeDefined();

    act(() => { chip!.click(); });

    expect(promptEl().value).toBe(sample.prompt);
    expect(cwdEl().value).toBe(cwdBefore);
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('.launch-copy-spawn')).not.toBeNull();
  });

  test('sample chips are not shown on the Playbooks tab', () => {
    render({ initialTab: 'playbooks' });
    const playbooksTab = Array.from(container.querySelectorAll('.dialog-tab'))
      .find((button) => button.textContent === 'Playbooks');
    expect(playbooksTab?.classList.contains('active')).toBe(true);
    expect(container.querySelector('.playbook-empty, .playbook-list, .playbook-search')).not.toBeNull();
    expect(chips()).toHaveLength(0);
  });
});
