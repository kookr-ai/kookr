// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The real stage needs WebGL, which jsdom does not have. The dock only talks to it through this small surface.
const stages = vi.hoisted(() => [] as Array<{
  options: { onReady?: () => void; onError?: (reason: string) => void };
  setState: ReturnType<typeof vi.fn>;
  setAnalyser: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock('./avatar-stage.js', () => ({
  AvatarStage: class {
    options: { onReady?: () => void; onError?: (reason: string) => void };
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => 'data:image/png;base64,AAAA');
    dispose = vi.fn();
    constructor(options: { onReady?: () => void; onError?: (reason: string) => void }) {
      this.options = options;
      stages.push(this);
    }
  },
}));
vi.mock('./assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));

import { AvatarDock } from './AvatarDock.js';
import {
  __resetSpeechBusForTests,
  emitSpeechGenerating,
  emitSpeechIdle,
  emitSpeechPlaying,
} from '../audio/speech-bus.js';
import {
  AVATAR_PANEL_HEIGHT,
  AVATAR_PANEL_KEY,
  AVATAR_PANEL_MARGIN,
  AVATAR_PANEL_WIDTH,
  __resetAvatarPanelPrefsForTests,
  defaultAvatarPanelPosition,
} from '../store/avatar-panel-prefs.js';

// Stands in for the speaker button that is talking.
const SPEAKER = { name: 'a speaker button' };
const VIEWPORT = { width: 1024, height: 768 };
const FAR_X = VIEWPORT.width - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN;
const FAR_Y = VIEWPORT.height - AVATAR_PANEL_HEIGHT - AVATAR_PANEL_MARGIN;

function savedPrefs(): { enabled: boolean; minimized: boolean; position: { x: number; y: number } | null } {
  return JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY) ?? 'null');
}

function pointer(type: string, init: { clientX: number; clientY: number; button?: number }): Event {
  // jsdom's PointerEvent support varies by version; a MouseEvent carrying a pointerId is all the dock reads.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

describe('AvatarDock', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const realSetPointerCapture = HTMLElement.prototype.setPointerCapture;

  const dock = () => container.querySelector<HTMLElement>('[data-testid="avatar-dock"]');
  const bubble = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-bubble"]');
  const caption = () => container.querySelector<HTMLElement>('[data-testid="avatar-caption"]');
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  function render(attentionCount = 0): void {
    root = createRoot(container);
    act(() => {
      root!.render(<AvatarDock attentionCount={attentionCount} />);
    });
  }

  function startWith(prefs: { minimized?: boolean; position?: { x: number; y: number } | null }): void {
    localStorage.setItem(
      AVATAR_PANEL_KEY,
      JSON.stringify({ enabled: true, minimized: false, position: null, ...prefs }),
    );
    __resetAvatarPanelPrefsForTests();
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    stages.length = 0;
    __resetSpeechBusForTests();
    __resetAvatarPanelPrefsForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    localStorage.clear();
    __resetSpeechBusForTests();
    __resetAvatarPanelPrefsForTests();
    HTMLElement.prototype.setPointerCapture = realSetPointerCapture;
    document.body.innerHTML = '';
  });

  test('opens in the bottom-right corner with one 3D view and an idle hint', () => {
    startWith({});
    render();

    const corner = defaultAvatarPanelPosition(VIEWPORT);
    // Its right and bottom edges sit in the last tenth of the screen.
    expect(corner.x + AVATAR_PANEL_WIDTH).toBeGreaterThan(VIEWPORT.width * 0.9);
    expect(corner.y + AVATAR_PANEL_HEIGHT).toBeGreaterThan(VIEWPORT.height * 0.9);
    expect(dock()!.style.left).toBe(`${corner.x}px`);
    expect(dock()!.style.top).toBe(`${corner.y}px`);
    expect(dock()!.getAttribute('data-avatar-state')).toBe('idle');
    expect(caption()!.textContent).toContain('speaker button');
    expect(stages).toHaveLength(1);
    expect(stages[0].setState).toHaveBeenLastCalledWith('idle');
  });

  test('follows a spoken summary: preparing, then speaking with its text and loudness tap, then ready', () => {
    startWith({});
    render();
    const stage = stages[0];
    const analyser = { fftSize: 0, smoothingTimeConstant: 0 } as unknown as AnalyserNode;

    act(() => emitSpeechGenerating(SPEAKER));
    expect(dock()!.getAttribute('data-avatar-state')).toBe('thinking');
    expect(stage.setState).toHaveBeenLastCalledWith('thinking');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(null);

    act(() => {
      emitSpeechPlaying(
        SPEAKER,
        { createAnalyser: () => analyser },
        { connect: vi.fn() } as unknown as AudioNode,
        'Two tasks need you.',
      );
    });
    expect(dock()!.getAttribute('data-avatar-state')).toBe('speaking');
    expect(caption()!.textContent).toBe('Two tasks need you.');
    expect(stage.setState).toHaveBeenLastCalledWith('speaking');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(analyser);

    act(() => emitSpeechIdle(SPEAKER));
    expect(dock()!.getAttribute('data-avatar-state')).toBe('idle');
    expect(stage.setState).toHaveBeenLastCalledWith('idle');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(null);
    // The last thing she said stays readable after the clip ends...
    expect(caption()!.textContent).toBe('Two tasks need you.');

    // ...and is cleared as soon as the next clip is being prepared, so old text is never shown as the new one.
    act(() => emitSpeechGenerating(SPEAKER));
    expect(caption()!.textContent).toContain('speaker button');
  });

  test('minimising shuts the 3D view down, shows a still on the bubble and keeps keyboard focus', () => {
    startWith({});
    render();
    const stage = stages[0];

    act(() => button('Minimise Lucy')!.click());

    expect(dock()).toBeNull();
    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(bubble()!.style.backgroundImage).toContain('data:image/png;base64,AAAA');
    expect(document.activeElement).toBe(bubble());
    expect(savedPrefs().minimized).toBe(true);

    act(() => bubble()!.click());

    expect(bubble()).toBeNull();
    expect(stages).toHaveLength(2);
    expect(stages[1].dispose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Minimise Lucy'));
    expect(savedPrefs().minimized).toBe(false);
  });

  test('a panel that starts minimised creates no 3D view and does not take focus', () => {
    startWith({ minimized: true });
    render();

    expect(bubble()).not.toBeNull();
    expect(stages).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  test('a view reopened in the middle of a clip is told straight away that she is speaking', () => {
    startWith({ minimized: true });
    render();
    const analyser = {} as AnalyserNode;
    act(() => {
      emitSpeechPlaying(SPEAKER, { createAnalyser: () => analyser }, { connect: vi.fn() } as unknown as AudioNode, 'hi');
    });

    act(() => bubble()!.click());

    expect(stages[0].setState).toHaveBeenLastCalledWith('speaking');
    expect(stages[0].setAnalyser).toHaveBeenLastCalledWith(analyser);
  });

  test.each([
    [0, 'Open Lucy', null],
    [1, 'Open Lucy. 1 item needs your attention.', '1'],
    [7, 'Open Lucy. 7 items need your attention.', '7'],
    [120, 'Open Lucy. 120 items need your attention.', '99+'],
  ])('the bubble for %i waiting items is labelled "%s"', (count, label, badge) => {
    startWith({ minimized: true });
    render(count);

    expect(bubble()!.getAttribute('aria-label')).toBe(label);
    expect(container.querySelector('.avatar-bubble-badge')?.textContent ?? null).toBe(badge);
  });

  test('the bubble label says so while she is speaking', () => {
    startWith({ minimized: true });
    render();

    act(() => emitSpeechGenerating(SPEAKER));
    expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, preparing');
    act(() => {
      emitSpeechPlaying(SPEAKER, { createAnalyser: () => ({}) as AnalyserNode }, { connect: vi.fn() } as unknown as AudioNode);
    });
    expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, speaking');
  });

  test('dragging the title bar moves the window and the drop position is remembered', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 350, clientY: 260 }));
    });
    expect(dock()!.style.left).toBe('300px');
    expect(dock()!.style.top).toBe('250px');
    // Nothing is saved until the drop.
    expect(savedPrefs().position).toEqual({ x: 100, y: 100 });

    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 350, clientY: 260 }));
    });
    expect(savedPrefs().position).toEqual({ x: 300, y: 250 });
    expect(dock()!.style.left).toBe('300px');
  });

  test('pressing and releasing the title bar without moving saves nothing', () => {
    startWith({});
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 800, clientY: 400 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 800, clientY: 400 }));
    });

    // Still "never moved", so the window keeps following its default corner when the browser is resized.
    expect(savedPrefs().position).toBeNull();
  });

  test('a drag past the edge of the screen stops at the margin', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 5000, clientY: -5000 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 5000, clientY: -5000 }));
    });

    expect(savedPrefs().position).toEqual({ x: FAR_X, y: AVATAR_PANEL_MARGIN });
  });

  test('the right mouse button does not start a drag', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110, button: 2 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 400 }));
    });

    expect(dock()!.style.left).toBe('100px');
  });

  test('pressing a title-bar button does not start a drag', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();

    act(() => {
      button('Minimise Lucy')!.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      container
        .querySelector('.avatar-dock-header')!
        .dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 400 }));
    });

    expect(dock()!.style.left).toBe('100px');
  });

  test('the move button sends the window round the four corners without dragging', () => {
    startWith({});
    render();
    const seen: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i < 4; i += 1) {
      act(() => button('Move Lucy to the next corner')!.click());
      seen.push(savedPrefs().position);
    }

    expect(seen).toEqual([
      { x: AVATAR_PANEL_MARGIN, y: FAR_Y },
      { x: AVATAR_PANEL_MARGIN, y: AVATAR_PANEL_MARGIN },
      { x: FAR_X, y: AVATAR_PANEL_MARGIN },
      { x: FAR_X, y: FAR_Y },
    ]);
    expect(dock()!.style.left).toBe(`${FAR_X}px`);
  });

  test('a window saved on a bigger screen is pulled back in when the browser shrinks', () => {
    startWith({ position: { x: 700, y: 400 } });
    render();
    expect(dock()!.style.left).toBe('700px');

    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      window.dispatchEvent(new Event('resize'));
    });

    expect(dock()!.style.left).toBe(`${600 - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN}px`);
  });

  test('minimising in another browser tab is followed here', () => {
    startWith({});
    render();

    act(() => {
      // The same payload under a different key belongs to some other feature and must be ignored.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some-other-key',
          newValue: JSON.stringify({ enabled: true, minimized: true, position: null }),
        }),
      );
    });
    expect(dock()).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AVATAR_PANEL_KEY,
          newValue: JSON.stringify({ enabled: true, minimized: true, position: null }),
        }),
      );
    });

    expect(dock()).toBeNull();
    expect(bubble()).not.toBeNull();
    // The change came from elsewhere, so this tab must not steal keyboard focus for it.
    expect(document.activeElement).toBe(document.body);
  });

  test('shows a loading note until the 3D view is ready, and a plain message if it cannot start', () => {
    startWith({});
    render();
    const status = () => container.querySelector<HTMLElement>('[role="status"]')!;

    expect(status().textContent).toBe('Loading…');

    act(() => stages[0].options.onReady?.());
    expect(dock()!.getAttribute('data-avatar-loaded')).toBe('true');
    // Emptied, not hidden: a hidden live region would not announce the failure below.
    expect(status().textContent).toBe('');
    expect(status().hidden).toBe(false);

    act(() => stages[0].options.onError?.('WebGL is not available'));
    expect(status().textContent).toContain('WebGL is not available');
    expect(status().textContent).toContain('Spoken summaries still play');
  });

  test('the spoken text can be reached and scrolled from the keyboard', () => {
    startWith({});
    render();

    expect(caption()!.tabIndex).toBe(0);
    expect(caption()!.getAttribute('aria-label')).toBe('Spoken text');
  });
});
