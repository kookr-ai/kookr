// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LaunchTaskDialog, SAMPLE_LAUNCH_PROMPTS, buildSpawnCommand } from './LaunchTaskDialog.js';
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

describe('buildSpawnCommand', () => {
  test('simple prompt yields a runnable quoted one-liner', () => {
    const built = buildSpawnCommand({
      prompt: 'review the diff since origin/main',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      'kookr spawn -C /home/user/proj -a claude-code "review the diff since origin/main"',
    );
  });

  test('criteria is appended as a quoted --criteria flag', () => {
    const built = buildSpawnCommand({
      prompt: 'fix the auth bug',
      cwd: CWD,
      agentType: 'codex-cli',
      criteria: 'tests pass and PR created',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C /home/user/proj -a codex-cli --criteria 'tests pass and PR created' \"fix the auth bug\"",
    );
  });

  test('a cwd with spaces is single-quoted', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: '/home/user/my project',
      agentType: 'claude-code',
    });
    expect(built.command).toBe(
      "kookr spawn -C '/home/user/my project' -a claude-code \"do the thing\"",
    );
  });

  test('a single quote in the prompt stays on the quoted one-liner path', () => {
    // A single quote is safe inside double quotes and is NOT hook-sensitive, so
    // it must not trip the prompt-file fallback.
    const built = buildSpawnCommand({
      prompt: "it's working now",
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code "it\'s working now"');
  });

  test('a bang in criteria is single-quoted so history expansion cannot fire', () => {
    // `!` cannot be neutralized inside bash double quotes; single quotes make it
    // literal. criteria has no --prompt-file escape hatch, so quoting must be safe.
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'claude-code',
      criteria: 'must be !important',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C /home/user/proj -a claude-code --criteria 'must be !important' \"do the thing\"",
    );
  });

  test('round-robin omits -a so the server default applies', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'round-robin',
    });
    expect(built.command).toBe('kookr spawn -C /home/user/proj "do the thing"');
  });

  test('a prompt with double quotes falls back to an exact --prompt-file heredoc', () => {
    const built = buildSpawnCommand({
      prompt: 'say "hello" to the world',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(
      `${MKTEMP_PREFIX}\ncat > "$prompt_file" <<'SPAWN_PROMPT_EOF'\n` +
      'say "hello" to the world\n' +
      'SPAWN_PROMPT_EOF\n' +
      `kookr spawn -C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    );
  });

  test.each([
    ['backtick', 'run `whoami` now'],
    ['dollar', 'echo $HOME please'],
    ['bang', 'do it now!'],
    ['backslash', 'path C:\\temp'],
    ['newline', 'line one\nline two'],
  ])('a prompt with a %s token uses the prompt-file form', (_label, prompt) => {
    const built = buildSpawnCommand({ prompt, cwd: CWD, agentType: 'claude-code' });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toContain(PROMPT_FILE_FLAG);
    expect(built.command.startsWith(`${MKTEMP_PREFIX}\n`)).toBe(true);
    // The raw prompt body is preserved verbatim between the heredoc delimiters.
    expect(built.command).toContain(`<<'SPAWN_PROMPT_EOF'\n${prompt}\nSPAWN_PROMPT_EOF\n`);
  });

  test('a prompt line equal to the delimiter extends the delimiter (no early terminate)', () => {
    const built = buildSpawnCommand({
      prompt: 'first line has a "quote"\nSPAWN_PROMPT_EOF\nlast line',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    // The extended delimiter must not appear as a standalone line inside the body.
    expect(built.command).toBe(
      `${MKTEMP_PREFIX}\ncat > "$prompt_file" <<'SPAWN_PROMPT_EOF_'\n` +
      'first line has a "quote"\nSPAWN_PROMPT_EOF\nlast line\n' +
      'SPAWN_PROMPT_EOF_\n' +
      `kookr spawn -C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    );
  });

  test('prompt-file fallback still carries criteria', () => {
    const built = buildSpawnCommand({
      prompt: 'say "hi"',
      cwd: CWD,
      agentType: 'claude-code',
      criteria: 'green CI',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toContain("--criteria 'green CI'");
  });
});

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
