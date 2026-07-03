import { describe, expect, test, vi } from 'vitest';
import { installTerminalRenderer } from './terminal-renderer.js';

function fakeDocumentWithWebgl2(enabled: boolean): Pick<Document, 'createElement'> {
  return {
    createElement: vi.fn(() => ({
      getContext: vi.fn((kind: string) => (enabled && kind === 'webgl2' ? {} : null)),
    } as unknown as HTMLCanvasElement)),
  };
}

function fakeWebglAddon() {
  let contextLossHandler: (() => void) | null = null;
  const disposeContextLoss = vi.fn();
  const addon = {
    activate: vi.fn(),
    dispose: vi.fn(),
    onContextLoss: vi.fn((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: disposeContextLoss };
    }),
  };
  return {
    addon,
    disposeContextLoss,
    loseContext: () => contextLossHandler?.(),
  };
}

describe('installTerminalRenderer', () => {
  test('keeps the DOM renderer when WebGL2 is unavailable', () => {
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    };
    const webgl = fakeWebglAddon();

    const installed = installTerminalRenderer(terminal, {
      document: fakeDocumentWithWebgl2(false),
      createWebglAddon: () => webgl.addon,
    });

    expect(installed.renderer).toBe('dom');
    expect(terminal.loadAddon).not.toHaveBeenCalled();
    expect(webgl.addon.onContextLoss).not.toHaveBeenCalled();
  });

  test('loads WebGL when WebGL2 is available', () => {
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    };
    const webgl = fakeWebglAddon();

    const installed = installTerminalRenderer(terminal, {
      document: fakeDocumentWithWebgl2(true),
      createWebglAddon: () => webgl.addon,
    });

    expect(installed.renderer).toBe('webgl');
    expect(terminal.loadAddon).toHaveBeenCalledWith(webgl.addon);
    expect(webgl.addon.onContextLoss).toHaveBeenCalledOnce();

    installed.dispose();

    expect(webgl.disposeContextLoss).toHaveBeenCalledOnce();
    expect(webgl.addon.dispose).toHaveBeenCalledOnce();
  });

  test('disposes WebGL and refreshes the terminal on context loss', () => {
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    };
    const webgl = fakeWebglAddon();

    installTerminalRenderer(terminal, {
      document: fakeDocumentWithWebgl2(true),
      createWebglAddon: () => webgl.addon,
    });

    webgl.loseContext();

    expect(webgl.addon.dispose).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  test('falls back to the DOM renderer when WebGL loading throws', () => {
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(() => {
        throw new Error('webgl unavailable');
      }),
      refresh: vi.fn(),
    };
    const webgl = fakeWebglAddon();

    const installed = installTerminalRenderer(terminal, {
      document: fakeDocumentWithWebgl2(true),
      createWebglAddon: () => webgl.addon,
    });

    expect(installed.renderer).toBe('dom');
    expect(webgl.disposeContextLoss).toHaveBeenCalledOnce();
    expect(webgl.addon.dispose).toHaveBeenCalledOnce();
  });

  test('falls back to the DOM renderer when WebGL addon creation throws', () => {
    const terminal = {
      rows: 24,
      loadAddon: vi.fn(),
      refresh: vi.fn(),
    };

    const installed = installTerminalRenderer(terminal, {
      document: fakeDocumentWithWebgl2(true),
      createWebglAddon: () => {
        throw new Error('webgl constructor unavailable');
      },
    });

    expect(installed.renderer).toBe('dom');
    expect(terminal.loadAddon).not.toHaveBeenCalled();
  });
});
