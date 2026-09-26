// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { STT_LANGUAGE_KEY } from '../store/stt-language.js';
import { DICTATION_RECOVERY_KEY, loadDictationRecovery } from '../store/dictation-recovery.js';
import { clearLaunchTaskDialogDraft } from '../store/launch-task-dialog-draft.js';
import { appendDictation } from '../append-dictation.js';
import { VoiceInputButton } from './VoiceInputButton.js';
import { QuickLaunch } from './QuickLaunch.js';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { DetailPanel } from './DetailPanel.js';
import type { AgentState } from '../../shared/protocol.js';

vi.mock('../telemetry.js', () => ({
  track: vi.fn(),
  trackClick: vi.fn(),
}));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => null }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => null }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => null }));

function createFakeMediaStream(): MediaStream {
  const track = { stop: vi.fn(), getSettings: () => ({ sampleRate: 16_000 }) };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

class FakeSTTWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSTTWebSocket[] = [];

  readyState = FakeSTTWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    FakeSTTWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeSTTWebSocket.CLOSED;
    this.onclose?.();
  }
}

const PROCESSING_TIMEOUT_MS = 15_000;

let captureProcessor: {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};

function installAudioCaptureStubs(): void {
  captureProcessor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  vi.stubGlobal('WebSocket', FakeSTTWebSocket);
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(createFakeMediaStream()),
    },
  });
  vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function () {
    return {
      sampleRate: 16_000,
      destination: {},
      close: vi.fn().mockResolvedValue(undefined),
      createMediaStreamSource: () => ({ connect: vi.fn() }),
      createScriptProcessor: () => captureProcessor,
    };
  }));
}

function deferredResponse(body: unknown) {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () => resolve(new Response(JSON.stringify(body), { status: 200 })),
  };
}

describe('VoiceInputButton STT health gating', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sttUrl: string;
  let testIndex = 0;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeSTTWebSocket.instances = [];
    sttUrl = `ws://stt.example.test/${testIndex++}`;
    localStorage.clear();
    useKookrStore.setState({ sttUrl, activeSTTInputId: null, sttLanguage: 'auto' });
    installAudioCaptureStubs();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useKookrStore.setState({ sttUrl: '', activeSTTInputId: null, sttLanguage: 'auto' });
    localStorage.clear();
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderButton(onTranscript = vi.fn()): Promise<HTMLButtonElement> {
    const buttons = await renderButtons(1, onTranscript);
    return buttons[0];
  }

  async function renderButtons(count: number, onTranscript = vi.fn()): Promise<HTMLButtonElement[]> {
    await act(async () => {
      root.render(
        <>
          {Array.from({ length: count }, (_, index) => (
            <VoiceInputButton
              key={index}
              inputId={`voice-test-${index}`}
              onTranscript={onTranscript}
            />
          ))}
        </>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(count);
    return buttons as HTMLButtonElement[];
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function startAndFailSTT(button: HTMLButtonElement): Promise<void> {
    await click(button);
    expect(FakeSTTWebSocket.instances).toHaveLength(1);
    await act(async () => {
      FakeSTTWebSocket.instances[0].onerror?.();
    });
  }

  function deliver(ws: FakeSTTWebSocket, message: unknown): void {
    act(() => ws.onmessage?.({ data: JSON.stringify(message) }));
  }

  function capture(samples: Float32Array, milliseconds = 100): void {
    act(() => {
      captureProcessor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      vi.advanceTimersByTime(milliseconds);
    });
  }

  test('keeps timed-out partial text visible and recoverable after unmount', async () => {
    vi.useFakeTimers();
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Texte provisoire conservé' });
    await click(button);
    act(() => vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS));
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Texte provisoire conservé');
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Incomplete dictation');
    act(() => root.render(null));
    await act(async () => root.render(<VoiceInputButton inputId="voice-test-0" onTranscript={onTranscript} />));
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Texte provisoire conservé');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  test.each([15_000, 125_000])('retains provisional words when the %s ms deadline expires and rejects late finals', async (timeout) => {
    vi.useFakeTimers();
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'config_ack', language: 'auto', ...(timeout === 125_000 ? { finalization_timeout_ms: timeout } : {}) });
    deliver(ws, { type: 'progressive', fixedText: 'Début', activeText: 'suite' });
    const queued = ws.onmessage;
    await click(button);
    act(() => vi.advanceTimersByTime(timeout - 1));
    expect(container.querySelector('.voice-recovery')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Début suite');
    act(() => queued?.({ data: JSON.stringify({ type: 'transcription', is_final: true, text: 'Too late' }) }));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(loadDictationRecovery('voice-test-0')?.text).toBe('Début suite');
  });

  test('restores once by appending to current typing, copies without consuming, and never submits', async () => {
    const onSubmit = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    function DraftForm() {
      const [draft, setDraft] = React.useState('Typed');
      return <form onSubmit={onSubmit}>
        <input value={draft} onChange={event => setDraft(event.target.value)} />
        <VoiceInputButton inputId="append-recovery" recoveryLabel="prompt" onTranscript={text => setDraft(current => appendDictation(current, text))} />
      </form>;
    }
    await act(async () => root.render(<DraftForm />));
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'incomplete words' });
    act(() => FakeSTTWebSocket.instances[0].close());
    typeDraft(container.querySelector('input')!, 'Edited typing');
    const actions = container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button');
    await click(actions[1]);
    expect(copy).toHaveBeenCalledExactlyOnceWith('incomplete words');
    expect(container.querySelector('.voice-recovery')).not.toBeNull();
    act(() => { actions[0].click(); actions[0].click(); });
    expect(container.querySelector('input')?.value).toBe('Edited typing incomplete words');
    expect(container.querySelector('.voice-recovery')).toBeNull();
    expect(loadDictationRecovery('append-recovery')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('copies incomplete speech with the shared fallback when the Clipboard API is unavailable', async () => {
    seedDraftSurfaces();
    const onClose = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const copy = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    await act(async () => root.render(<QuickLaunch send={vi.fn(() => true)} onClose={onClose} />));
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Words to copy' });
    act(() => FakeSTTWebSocket.instances[0].close());
    const copyButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button')).find(item => item.textContent === 'Copy')!;
    await click(copyButton);
    expect(copy).toHaveBeenCalledExactlyOnceWith('copy');
    expect(document.activeElement).toBe(copyButton);
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Copied');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('requires explicit discard or restore before a second recording, even after health retry', async () => {
    const button = await renderButton();
    await click(button);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'first recording' });
    act(() => FakeSTTWebSocket.instances[0].close());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }))));
    await click(button);
    expect(button.disabled).toBe(true);
    await click(button);
    expect(FakeSTTWebSocket.instances).toHaveLength(1);
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button')).find(item => item.textContent === 'Discard')!;
    await click(discard);
    expect(button.disabled).toBe(false);
    await click(button);
    expect(FakeSTTWebSocket.instances).toHaveLength(2);
    deliver(FakeSTTWebSocket.instances[1], { type: 'progressive', activeText: 'Second provisional' });
    expect(loadDictationRecovery('voice-test-0')?.text).toBe('Second provisional');
    deliver(FakeSTTWebSocket.instances[1], { type: 'transcription', is_final: true, text: 'Second final' });
    expect(loadDictationRecovery('voice-test-0')).toBeNull();
    act(() => root.render(null));
    await renderButton();
    expect(container.querySelector('.voice-recovery')).toBeNull();
  });

  test('keeps an earlier nonempty partial if the service sends an empty final', async () => {
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'last known words' });
    deliver(FakeSTTWebSocket.instances[0], { type: 'transcription', is_final: true, text: '  ' });
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('last known words');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  test('preserves the service failure payload as incomplete text without treating it as a final result', async () => {
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'earlier words' });
    deliver(FakeSTTWebSocket.instances[0], { type: 'error', error: 'Finalization failed', partial_text: 'earlier words and last known words' });
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('earlier words and last known words');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  test('keeps QuickLaunch recovery through reopening and requires resolution before launching', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const renderQuick = async () => act(async () => root.render(<QuickLaunch send={send} onClose={vi.fn()} />));
    await renderQuick();
    const input = () => container.querySelector<HTMLInputElement>('.quick-launch-input')!;
    typeDraft(input(), 'Launch the typed task');
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'unfinished prior speech' });
    act(() => root.render(null));
    await renderQuick();
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('unfinished prior speech');
    typeDraft(input(), 'Launch a typed task');
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('Launch a typed task');
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button')).find(item => item.textContent === 'Discard')!);
    expect(document.activeElement).toBe(input());
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    await renderQuick();
    expect(container.querySelector('.voice-recovery')).toBeNull();
  });

  test.each(['new task', 'relaunch'] as const)('requires resolution of active and hidden criteria dictation before submitting a %s', async (mode) => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const dialog = () => <LaunchTaskDialog send={send} onClose={vi.fn()} {...(mode === 'relaunch' ? { defaultPrompt: 'Parent task', defaultCwd: '/tmp/work', relaunchParentTaskId: 'original-parent' } : {})} />;
    await act(async () => root.render(dialog()));
    const prompt = () => container.querySelector<HTMLTextAreaElement>('#launch-task-description')!;
    const cwd = () => container.querySelector<HTMLInputElement>('#launch-task-cwd')!;
    const submit = () => act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    typeDraft(prompt(), 'Typed task stays');
    await click(container.querySelectorAll<HTMLButtonElement>('.btn-voice')[1]);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(container.querySelector('.voice-launch-pending')?.textContent).toContain('Finish dictation');
    submit();
    expect(send).not.toHaveBeenCalled();
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Unfinished criteria' });
    act(() => FakeSTTWebSocket.instances[0].close());
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    const originalCwd = cwd().value;
    typeDraft(cwd(), '/other-context');
    expect(container.querySelector('.voice-recovery')).toBeNull();
    submit();
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('.voice-launch-pending')?.textContent).toContain('original directory');
    typeDraft(cwd(), originalCwd);
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Unfinished criteria');
    await click(container.querySelector('.voice-recovery-actions button')!);
    const criteria = container.querySelector<HTMLInputElement>('.input-with-voice input')!;
    expect(document.activeElement).toBe(criteria);
    expect(criteria.value).toBe('Unfinished criteria');
    expect(prompt().value).toBe('Typed task stays');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(container.querySelector('.voice-launch-pending')).toBeNull();
    submit();
    expect(send).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    await act(async () => root.render(dialog()));
    expect(container.querySelector('.voice-recovery')).toBeNull();
  });

  test('blocks a submit in the same event turn as microphone startup before React rerenders', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    await act(async () => root.render(<LaunchTaskDialog send={send} onClose={vi.fn()} />));
    typeDraft(container.querySelector('#launch-task-description')!, 'Typed task');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.btn-voice')!.click();
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('.voice-launch-pending')?.textContent).toContain('Finish dictation');
  });

  test('thirteen explicitly resolved QuickLaunch drafts do not exhaust recovery capacity', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    for (let index = 0; index < 13; index += 1) {
      await act(async () => root.render(<QuickLaunch send={send} onClose={vi.fn()} />));
      const input = () => container.querySelector<HTMLInputElement>('.quick-launch-input')!;
      typeDraft(input(), `Task ${index}`);
      await click(container.querySelector('.btn-voice')!);
      expect(FakeSTTWebSocket.instances).toHaveLength(index + 1);
      deliver(FakeSTTWebSocket.instances[index], { type: 'progressive', activeText: `Partial ${index}` });
      act(() => root.render(null));
      await act(async () => root.render(<QuickLaunch send={send} onClose={vi.fn()} />));
      typeDraft(input(), `Task ${index}`);
      act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(send).toHaveBeenCalledTimes(index);
      await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button')).find(item => item.textContent === 'Discard')!);
      act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(send).toHaveBeenCalledTimes(index + 1);
      act(() => root.render(null));
    }
    expect(JSON.parse(localStorage.getItem(DICTATION_RECOVERY_KEY)!)).toEqual([]);
  });

  test('explicit whole-draft discard removes partials in a previously selected directory', async () => {
    seedDraftSurfaces();
    const dialog = () => <LaunchTaskDialog send={vi.fn(() => true)} onClose={vi.fn()} />;
    await act(async () => root.render(dialog()));
    typeDraft(container.querySelector('#launch-task-description')!, 'Typed draft');
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Old directory partial' });
    act(() => root.render(null));
    await act(async () => root.render(dialog()));
    typeDraft(container.querySelector('#launch-task-cwd')!, '/new-context');
    expect(container.querySelector('.voice-recovery')).toBeNull();
    await click(container.querySelector('[aria-label="Discard restored draft"]')!);
    expect(JSON.parse(localStorage.getItem(DICTATION_RECOVERY_KEY)!)).toEqual([]);
    expect(container.querySelector('.voice-launch-pending')).toBeNull();
  });

  test('does not offer recovery for empty recognition', async () => {
    const button = await renderButton();
    await click(button);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: ' ' });
    act(() => FakeSTTWebSocket.instances[0].close());
    expect(container.querySelector('.voice-recovery')).toBeNull();
    expect(loadDictationRecovery('voice-test-0')).toBeNull();
  });

  test('retains an empty launch form identity across closing and reopening with partial-only dictation', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const renderDialog = async () => act(async () => root.render(<LaunchTaskDialog send={send} onClose={vi.fn()} />));
    await renderDialog();
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'dictated before typing' });
    act(() => root.render(null));
    await renderDialog();
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('dictated before typing');
    const prompt = container.querySelector<HTMLTextAreaElement>('.input-with-voice textarea')!;
    expect(prompt.value).toBe('');
    typeDraft(prompt, 'Typed after reopening');
    await click(container.querySelector('.voice-recovery-actions button')!);
    expect(prompt.value).toBe('Typed after reopening dictated before typing');
    expect(document.activeElement).toBe(prompt);
    expect(send).not.toHaveBeenCalled();
  });

  test('keeps launch criteria recovery separate from the prompt and another working directory', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const dialog = (cwd: string) => <LaunchTaskDialog send={send} onClose={vi.fn()} projectCwd={cwd} />;
    await act(async () => root.render(dialog('/original')));
    await click(container.querySelectorAll<HTMLButtonElement>('.btn-voice')[1]);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'critères incomplets' });
    act(() => root.render(null));
    await act(async () => root.render(dialog('/another')));
    expect(container.querySelector('.voice-recovery')).toBeNull();
    act(() => root.render(null));
    await act(async () => root.render(dialog('/original')));
    expect(container.querySelector('.voice-recovery')?.getAttribute('aria-label')).toBe('Incomplete dictation for criteria');
    await click(container.querySelector('.voice-recovery-actions button')!);
    expect(container.querySelector<HTMLTextAreaElement>('.input-with-voice textarea')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('.input-with-voice input')?.value).toBe('critères incomplets');
  });

  test('keeps recovery in the same tab if local storage fails, including reopening the launch form', async () => {
    seedDraftSurfaces();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
    const dialog = () => <LaunchTaskDialog send={vi.fn(() => true)} onClose={vi.fn()} />;
    await act(async () => root.render(dialog()));
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Words retained in this tab' });
    act(() => root.render(null));
    await act(async () => root.render(dialog()));
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Words retained in this tab');
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Browser storage is unavailable');
    storage.mockRestore();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.voice-recovery-actions button')).find(item => item.textContent === 'Discard')!);
    clearLaunchTaskDialogDraft();
  });

  test('meter follows captured audio, distinguishes silence from missing frames, and recovers', async () => {
    vi.useFakeTimers();
    const button = await renderButton();
    expect(container.querySelector('.voice-meter')).toBeNull();
    await click(button);
    const bars = () => Array.from(container.querySelectorAll<HTMLElement>('.voice-meter-bar'));
    const heights = () => bars().map(bar => Number.parseFloat(bar.style.height));
    expect(bars()).toHaveLength(7);

    capture(new Float32Array(4096).fill(0.1));
    expect(Math.max(...heights())).toBeGreaterThan(10);
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Sound detected');
    const liveHeights = heights();
    capture(new Float32Array(4096).fill(0.003));
    expect(Math.max(...heights())).toBeLessThan(Math.max(...liveHeights));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Low input');

    capture(new Float32Array(4096));
    expect(heights().every(height => height === 2)).toBe(true);
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Low input');
    for (let i = 0; i < 7; i++) capture(new Float32Array(4096));
    expect(heights().every(height => height === 2)).toBe(true);
    expect(container.querySelector('.voice-signal')?.textContent).toBe('No sound detected');
    expect(button.title).toContain('Recording');

    capture(new Float32Array(4096).fill(0.2));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Sound detected');
    act(() => vi.advanceTimersByTime(800));
    expect(heights().every(height => height === 2)).toBe(true);
    expect(container.querySelector('.voice-signal')?.textContent).toBe('No audio received');
    const status = container.querySelector('.voice-signal');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBe(status?.id);

    capture(new Float32Array(4096).fill(1));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Input too loud');
    capture(new Float32Array(4096).fill(0.1));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Sound detected');
    await click(button);
    expect(container.querySelector('.voice-meter')).toBeNull();
    expect(container.querySelector('.voice-signal')).toBeNull();
  });

  test.each(['muted track', 'suspended context'])('meter clears immediately for a %s and recovers', async (interruption) => {
    vi.useFakeTimers();
    const button = await renderButton();
    await click(button);
    capture(new Float32Array(4096).fill(0.1));
    const stream = await vi.mocked(navigator.mediaDevices.getUserMedia).mock.results[0].value as MediaStream;
    const context = vi.mocked(AudioContext).mock.results[0].value as AudioContext;
    const target = interruption === 'muted track' ? stream.getAudioTracks()[0] : context;
    const property = interruption === 'muted track' ? 'muted' : 'state';
    Object.defineProperty(target, property, { configurable: true, value: interruption === 'muted track' ? true : 'suspended' });
    act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('No audio received');
    expect(Array.from(container.querySelectorAll<HTMLElement>('.voice-meter-bar')).every(bar => bar.style.height === '2px')).toBe(true);
    Object.defineProperty(target, property, { value: interruption === 'muted track' ? false : 'running' });
    capture(new Float32Array(4096).fill(0.1));
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Sound detected');
  });

  test('meter cannot retain or revive levels from a cancelled recording', async () => {
    vi.useFakeTimers();
    const button = await renderButton();
    await click(button);
    capture(new Float32Array(4096).fill(0.3));
    const oldCallback = captureProcessor.onaudioprocess;
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    const nextButton = await renderButton();
    await click(nextButton);
    act(() => {
      oldCallback?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(1) } });
      vi.advanceTimersByTime(100);
    });
    expect(container.querySelector('.voice-signal')?.textContent).toBe('Waiting for audio');
    expect(Array.from(container.querySelectorAll<HTMLElement>('.voice-meter-bar')).every(bar => bar.style.height === '2px')).toBe(true);
  });

  function typeDraft(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    act(() => {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function seedDraftSurfaces(): void {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network in test')));
    useKookrStore.setState({
      serverCwd: '/tmp/work', availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }],
      defaultAgentType: 'claude-code', selectedAgentId: null, agents: [],
    });
  }

  test('appends final dictation to the QuickLaunch draft without launching', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    await act(async () => root.render(<QuickLaunch send={send} onClose={vi.fn()} />));
    const input = container.querySelector<HTMLInputElement>('.quick-launch-input')!;
    const mic = container.querySelector<HTMLButtonElement>('.btn-voice')!;
    typeDraft(input, 'Existing task');
    await click(mic);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'progressive', activeText: 'puis ajoute des tests' });
    expect(input.value).toBe('Existing task');
    typeDraft(input, 'Existing task edited');
    await click(mic);
    deliver(ws, { type: 'transcription', text: 'puis ajoute des tests.', is_final: true });
    expect(input.value).toBe('Existing task edited puis ajoute des tests.');
    expect(send).not.toHaveBeenCalled();
  });

  test('keeps prompt and criteria drafts separate and never submits the launch dialog', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    await act(async () => root.render(<LaunchTaskDialog send={send} onClose={vi.fn()} defaultPrompt="Typed prompt" defaultCriteria="Typed criteria" />));
    const prompt = container.querySelector<HTMLTextAreaElement>('.input-with-voice textarea')!;
    const criteria = container.querySelector<HTMLInputElement>('.input-with-voice input')!;
    const microphones = container.querySelectorAll<HTMLButtonElement>('.btn-voice');
    expect(microphones).toHaveLength(2);
    await click(microphones[0]);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'corrige le problème' });
    typeDraft(prompt, 'Edited prompt');
    await click(microphones[0]);
    deliver(FakeSTTWebSocket.instances[0], { type: 'transcription', text: 'corrige le problème.', is_final: true });
    expect(prompt.value).toBe('Edited prompt corrige le problème.');
    expect(criteria.value).toBe('Typed criteria');
    await click(microphones[1]);
    typeDraft(criteria, 'Edited criteria');
    await click(microphones[1]);
    deliver(FakeSTTWebSocket.instances[1], { type: 'transcription', text: 'les tests passent.', is_final: true });
    expect(criteria.value).toBe('Edited criteria les tests passent.');
    expect(prompt.value).toBe('Edited prompt corrige le problème.');
    expect(send).not.toHaveBeenCalled();
  });

  test('cancels DetailPanel dictation on task switch and preserves both reply drafts', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const makeAgent = (agentId: string): AgentState => ({
      agentId, taskId: `task-${agentId}`, taskName: agentId, events: [], anomaly: null,
      cwd: '/tmp/work', startedAt: '2026-09-25T10:00:00.000Z', taskStatus: 'inProgress',
    });
    const first = makeAgent('first');
    const second = makeAgent('second');
    const panel = (agent: AgentState) => <DetailPanel agent={agent} send={send} onLaunch={vi.fn()} onRequestComplete={vi.fn()} />;
    await act(async () => root.render(panel(first)));
    const reply = () => container.querySelector<HTMLTextAreaElement>('.response-row textarea')!;
    const mic = () => container.querySelector<HTMLButtonElement>('.btn-voice')!;
    typeDraft(reply(), 'First draft');
    await click(mic());
    const ws = FakeSTTWebSocket.instances[0];
    const queuedMessage = ws.onmessage;
    await click(mic());
    await act(async () => root.render(panel(second)));
    typeDraft(reply(), 'Second draft');
    act(() => queuedMessage?.({ data: JSON.stringify({ type: 'transcription', text: 'Old task speech', is_final: true }) }));
    expect(reply().value).toBe('Second draft');
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
    await act(async () => root.render(panel(first)));
    expect(reply().value).toBe('First draft');
    await click(mic());
    await click(mic());
    deliver(FakeSTTWebSocket.instances[1], { type: 'transcription', text: 'vérifie les tests.', is_final: true });
    expect(reply().value).toBe('First draft vérifie les tests.');
    expect(send).not.toHaveBeenCalled();
  });

  test('offers interrupted reply speech only when returning to its original task', async () => {
    seedDraftSurfaces();
    const send = vi.fn(() => true);
    const agent = (id: string): AgentState => ({
      agentId: id, taskId: `task-${id}`, taskName: id, events: [], anomaly: null,
      cwd: '/tmp/work', startedAt: '2026-09-25T10:00:00.000Z', taskStatus: 'inProgress',
    });
    const panel = (id: string) => <DetailPanel agent={agent(id)} send={send} onLaunch={vi.fn()} onRequestComplete={vi.fn()} />;
    await act(async () => root.render(panel('original')));
    typeDraft(container.querySelector('.response-row textarea')!, 'Original typed reply');
    await click(container.querySelector('.btn-voice')!);
    deliver(FakeSTTWebSocket.instances[0], { type: 'progressive', activeText: 'Unfinished original reply' });
    await act(async () => root.render(panel('different')));
    expect(container.querySelector('.voice-recovery')).toBeNull();
    typeDraft(container.querySelector('.response-row textarea')!, 'Other task');
    await act(async () => root.render(panel('original')));
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Unfinished original reply');
    await click(container.querySelector('.voice-recovery-actions button')!);
    expect(container.querySelector<HTMLTextAreaElement>('.response-row textarea')?.value).toBe('Original typed reply Unfinished original reply');
    expect(send).not.toHaveBeenCalled();
  });

  test.each(['auto', 'fr', 'en'] as const)('sends the selected %s language in the session config', async (language) => {
    useKookrStore.getState().setSTTLanguage(language);
    const button = await renderButton();
    await click(button);
    act(() => FakeSTTWebSocket.instances[0].onopen?.());
    expect(FakeSTTWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({
      type: 'config', language, progressive: true,
    }));
  });

  test('shares and persists the language choice across controls and browser reloads', async () => {
    const [button] = await renderButtons(2);
    const selectors = Array.from(container.querySelectorAll('select'));
    expect(selectors.map((select) => select.value)).toEqual(['auto', 'auto']);
    act(() => {
      selectors[0].value = 'fr';
      selectors[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(selectors.map((select) => select.value)).toEqual(['fr', 'fr']);
    expect(localStorage.getItem(STT_LANGUAGE_KEY)).toBe('fr');
    expect(createKookrStore().getState().sttLanguage).toBe('fr');
    await click(button);
    expect(selectors.every((select) => select.disabled)).toBe(true);
  });

  test('rejects a service that silently changes the selected dictation language', async () => {
    useKookrStore.getState().setSTTLanguage('fr');
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    const queuedMessage = ws.onmessage;
    deliver(ws, { type: 'config_ack', language: 'en', progressive: true });
    act(() => queuedMessage?.({ data: JSON.stringify({ type: 'transcription', text: 'English translation', is_final: true }) }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Selected dictation language is unavailable');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Update the STT service');
    expect(onTranscript).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });

  test('previews partial speech and commits a final result once, then closes the socket', async () => {
    const onTranscript = vi.fn();
    const stream = createFakeMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
    const button = await renderButton(onTranscript);
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    const queuedMessage = ws.onmessage;
    deliver(ws, { type: 'progressive', fixedText: 'Corrige', activeText: 'le problème' });
    expect(container.querySelector('.voice-preview[role="status"]')?.textContent).toBe('Corrige le problème');
    expect(onTranscript).not.toHaveBeenCalled();
    deliver(ws, { type: 'transcription', text: 'Corrige le problème de connexion', is_final: false });
    expect(container.querySelector('.voice-preview[role="status"]')?.textContent).toBe('Corrige le problème de connexion');
    expect(onTranscript).not.toHaveBeenCalled();
    await click(button);
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(FakeSTTWebSocket.OPEN);
    deliver(ws, { type: 'transcription', text: 'Corrige le problème.', is_final: true });
    act(() => queuedMessage?.({ data: JSON.stringify({ type: 'transcription', text: 'Duplicate', is_final: true }) }));
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('Corrige le problème.');
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });

  test('preserves typing during dictation and never submits its containing form', async () => {
    const onSubmit = vi.fn();
    function DraftForm() {
      const [draft, setDraft] = React.useState('Typed draft');
      return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        <VoiceInputButton inputId="form-draft" onTranscript={(text) => setDraft((current) => appendDictation(current, text))} />
      </form>;
    }
    await act(async () => root.render(<DraftForm />));
    const button = container.querySelector('button')!;
    const input = container.querySelector('input')!;
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'progressive', activeText: 'Ajoute des tests' });
    expect(input.value).toBe('Typed draft');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Typed draft with extra typing');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button);
    deliver(ws, { type: 'transcription', text: 'Ajoute des tests.', is_final: true });
    expect(input.value).toBe('Typed draft with extra typing Ajoute des tests.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('drops a pending final result when the task-scoped control is replaced', async () => {
    vi.useFakeTimers();
    const firstTranscript = vi.fn();
    const secondTranscript = vi.fn();
    const stream = createFakeMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
    await act(async () => root.render(<VoiceInputButton key="task-1" inputId="response-input" onTranscript={firstTranscript} />));
    await click(container.querySelector('button')!);
    const ws = FakeSTTWebSocket.instances[0];
    const queuedMessage = ws.onmessage;
    deliver(ws, { type: 'config_ack', language: 'auto', finalization_timeout_ms: 125_000 });
    await click(container.querySelector('button')!);
    await act(async () => { vi.advanceTimersByTime(31_000); });
    await act(async () => root.render(<VoiceInputButton key="task-2" inputId="response-input" onTranscript={secondTranscript} />));
    act(() => queuedMessage?.({ data: JSON.stringify({ type: 'transcription', text: 'Old task speech', is_final: true }) }));
    expect(firstTranscript).not.toHaveBeenCalled();
    expect(secondTranscript).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });

  test('accepts a final Qwen result after the legacy timeout and before the negotiated deadline', async () => {
    vi.useFakeTimers();
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'config_ack', language: 'auto', finalization_timeout_ms: 125_000 });
    await click(button);
    await act(async () => { vi.advanceTimersByTime(119_000); });
    expect(ws.readyState).toBe(FakeSTTWebSocket.OPEN);
    expect(button.className).toContain('processing');
    deliver(ws, { type: 'transcription', text: 'Réponse finale.', is_final: true });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('Réponse finale.');
    expect(button.className).toContain('idle');
  });

  test.each([undefined, -1, 1_000, 125_001, '125000', null, 30_000.5])('uses the bounded legacy fallback for invalid timeout %s', async (timeout) => {
    vi.useFakeTimers();
    const button = await renderButton();
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'config_ack', language: 'auto', finalization_timeout_ms: timeout });
    await click(button);
    await act(async () => { vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS); });
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(button.title).toContain('Transcription timed out');
  });

  test('still ends a negotiated Qwen wait if no final response arrives', async () => {
    vi.useFakeTimers();
    const button = await renderButton();
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'config_ack', language: 'auto', finalization_timeout_ms: 125_000 });
    await click(button);
    await act(async () => { vi.advanceTimersByTime(125_000); });
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    expect(button.title).toContain('Transcription timed out');
  });

  function installWorkletCapture() {
    const port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
    const disconnect = vi.fn();
    vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function () {
      return {
        sampleRate: 16_000, destination: {}, close: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: () => ({ connect: vi.fn() }),
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      };
    }));
    vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(function () {
      return { port, connect: vi.fn(), disconnect };
    }));
    return { port, disconnect };
  }

  test('drains trailing worklet samples before sending stop once and starts the final deadline after the drain', async () => {
    vi.useFakeTimers();
    const { port, disconnect } = installWorkletCapture();
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    await click(button);
    await click(button);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'flush' });
    expect(ws.send).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(900);
      port.onmessage?.({ data: new Float32Array([0.25, -0.25, 0.5]) });
      port.onmessage?.({ data: { type: 'flushed' } });
      port.onmessage?.({ data: { type: 'flushed' } });
    });
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(Array.from(new Int16Array(ws.send.mock.calls[0][0]))).toEqual([8192, -8192, 16384]);
    expect(ws.send.mock.calls[1][0]).toBe(JSON.stringify({ type: 'stop' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(14_999));
    expect(ws.readyState).toBe(FakeSTTWebSocket.OPEN);
    deliver(ws, { type: 'transcription', is_final: true, text: 'All captured words' });
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('All captured words');
  });

  test('fails truthfully when worklet flushing hangs and rejects stale flush messages after unmount', async () => {
    vi.useFakeTimers();
    const { port } = installWorkletCapture();
    const button = await renderButton();
    await click(button);
    const ws = FakeSTTWebSocket.instances[0];
    deliver(ws, { type: 'progressive', activeText: 'Recoverable beginning' });
    await click(button);
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('.voice-error')?.textContent).toContain('Microphone audio could not be finalized');
    expect(container.querySelector('.voice-recovery')?.textContent).toContain('Recoverable beginning');
    expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'stop' }));
    expect(ws.readyState).toBe(FakeSTTWebSocket.CLOSED);
    act(() => root.render(null));
    act(() => {
      port.onmessage?.({ data: new Float32Array([0.5]) });
      port.onmessage?.({ data: { type: 'flushed' } });
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('releases a microphone acquired after its control has unmounted', async () => {
    const stream = createFakeMediaStream();
    let resolveMicrophone!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise((resolve) => { resolveMicrophone = resolve; }));
    const [firstButton, secondButton] = await renderButtons(2);
    await act(async () => {
      firstButton.click();
      secondButton.click();
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(useKookrStore.getState().activeSTTInputId).toBe('voice-test-0');
    await act(async () => root.render(null));
    await act(async () => resolveMicrophone(stream));
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(FakeSTTWebSocket.instances).toHaveLength(0);
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });

  test('does not reconnect audio after unmount while its worklet is loading', async () => {
    let resolveWorklet!: () => void;
    const disconnect = vi.fn();
    const createProcessor = vi.fn();
    const closeContext = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function () {
      return {
        sampleRate: 16_000, destination: {}, close: closeContext,
        createMediaStreamSource: () => ({ connect: vi.fn() }),
        audioWorklet: { addModule: () => new Promise<void>((resolve) => { resolveWorklet = resolve; }) },
        createScriptProcessor: createProcessor,
      };
    }));
    vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(function () {
      return { port: {}, connect: vi.fn(), disconnect };
    }));
    const button = await renderButton();
    await click(button);
    await act(async () => root.render(null));
    await act(async () => resolveWorklet());
    expect(AudioWorkletNode).not.toHaveBeenCalled();
    expect(createProcessor).not.toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(FakeSTTWebSocket.instances[0].readyState).toBe(FakeSTTWebSocket.CLOSED);
  });

  test('reports disconnects immediately while waiting for a final transcript', async () => {
    const onTranscript = vi.fn();
    const button = await renderButton(onTranscript);
    await click(button);
    await click(button);
    act(() => FakeSTTWebSocket.instances[0].close());
    expect(button.title).toContain('STT service disconnected');
    expect(onTranscript).not.toHaveBeenCalled();
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });

  test('starts recording while STT is healthy', async () => {
    const button = await renderButton();

    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Click to start voice input');

    await click(button);

    expect(FakeSTTWebSocket.instances.map((ws) => ws.url)).toEqual([sttUrl]);
    expect(button.className).toContain('recording');
    expect(button.title).toBe('Recording... click to stop');
    expect(useKookrStore.getState().activeSTTInputId).toBe('voice-test-0');
  });

  test('shows a degraded retry affordance after an STT service failure', async () => {
    const button = await renderButton();

    await startAndFailSTT(button);

    expect(button.disabled).toBe(false);
    expect(button.className).toContain('error');
    expect(button.title).toContain('Speech-to-text unavailable: STT service connection failed');
    expect(button.title).toContain('Click to retry.');
  });

  test('shares degraded state across voice input controls for the same STT endpoint', async () => {
    const [firstButton, secondButton] = await renderButtons(2);

    await startAndFailSTT(firstButton);

    expect(firstButton.className).toContain('error');
    expect(secondButton.className).toContain('error');
    expect(secondButton.title).toContain('Speech-to-text unavailable: STT service connection failed');
  });

  test('clears degraded state when retry health returns ok', async () => {
    const button = await renderButton();
    await startAndFailSTT(button);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(button);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(button.className).toContain('idle');
    expect(button.title).toBe('Click to start voice input');
  });

  test('clears the original failed control when another control retry succeeds', async () => {
    const [firstButton, secondButton] = await renderButtons(2);
    await startAndFailSTT(firstButton);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(secondButton);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(firstButton.className).toContain('idle');
    expect(firstButton.title).toBe('Click to start voice input');
    expect(secondButton.className).toContain('idle');
    expect(secondButton.title).toBe('Click to start voice input');
  });

  test('clears the original timed-out control when another control retry succeeds', async () => {
    vi.useFakeTimers();
    const [firstButton, secondButton] = await renderButtons(2);
    await click(firstButton);
    await act(async () => {
      FakeSTTWebSocket.instances[0].onopen?.();
    });
    await click(firstButton);
    await act(async () => {
      vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(secondButton);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(firstButton.className).toContain('idle');
    expect(firstButton.title).toBe('Click to start voice input');
    expect(secondButton.className).toContain('idle');
    expect(secondButton.title).toBe('Click to start voice input');
  });

  test('keeps degraded state and debounces retry while STT remains unavailable', async () => {
    const button = await renderButton();
    await startAndFailSTT(button);
    const deferred = deferredResponse({ status: 'unavailable' });
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Checking speech-to-text health...');

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(button.disabled).toBe(false);
    expect(button.className).toContain('error');
    expect(button.title).toContain('Speech-to-text unavailable: STT service unavailable');
  });
});
