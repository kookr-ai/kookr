import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

type RendererTerminal = Pick<Terminal, 'loadAddon' | 'refresh' | 'rows'>;

interface WebglRendererAddon extends ITerminalAddon {
  onContextLoss(listener: () => void): IDisposable;
}

interface InstallTerminalRendererOptions {
  document?: Pick<Document, 'createElement'>;
  navigator?: Partial<Pick<Navigator, 'userAgent' | 'webdriver'>>;
  createWebglAddon?: () => WebglRendererAddon;
  onChange?: (status: Pick<InstalledTerminalRenderer, 'renderer' | 'fallbackReason'>) => void;
}

export interface InstalledTerminalRenderer {
  readonly renderer: 'webgl' | 'dom';
  readonly fallbackReason: 'automation' | 'webgl2-unavailable' | 'initialization-failed' | 'context-lost' | null;
  dispose(): void;
}

function hasWebgl2(documentLike: Pick<Document, 'createElement'>): boolean {
  try {
    const canvas = documentLike.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch {
    return false;
  }
}

export function installTerminalRenderer(
  terminal: RendererTerminal,
  options: InstallTerminalRendererOptions = {},
): InstalledTerminalRenderer {
  const documentLike = options.document ?? globalThis.document;
  const navigatorLike = options.navigator ?? globalThis.navigator;
  function report<T extends InstalledTerminalRenderer>(installed: T): T {
    options.onChange?.({ renderer: installed.renderer, fallbackReason: installed.fallbackReason });
    return installed;
  }
  // WebDriver-controlled browsers and older GPU stacks should keep xterm's
  // default DOM renderer so E2E can inspect terminal text and flaky WebGL
  // stacks never block terminal startup.
  if (navigatorLike?.webdriver || navigatorLike?.userAgent?.includes('HeadlessChrome')) {
    return report({ renderer: 'dom', fallbackReason: 'automation', dispose() {} });
  }
  if (!options.document && typeof globalThis.WebGL2RenderingContext === 'undefined') {
    return report({ renderer: 'dom', fallbackReason: 'webgl2-unavailable', dispose() {} });
  }
  if (!documentLike || !hasWebgl2(documentLike)) {
    return report({ renderer: 'dom', fallbackReason: 'webgl2-unavailable', dispose() {} });
  }

  let disposed = false;
  let contextLost = false;
  let addon: WebglRendererAddon | null = null;
  let contextLossDisposable: IDisposable | null = null;

  function disposeWebgl() {
    if (disposed) return;
    disposed = true;
    contextLossDisposable?.dispose();
    addon?.dispose();
  }

  try {
    addon = options.createWebglAddon?.() ?? new WebglAddon();
    contextLossDisposable = addon.onContextLoss(() => {
      if (disposed) return;
      contextLost = true;
      disposeWebgl();
      options.onChange?.({ renderer: 'dom', fallbackReason: 'context-lost' });
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    });
    terminal.loadAddon(addon);
    return report({
      get renderer() { return contextLost ? 'dom' : 'webgl'; },
      get fallbackReason() { return contextLost ? 'context-lost' : null; },
      dispose: disposeWebgl,
    });
  } catch {
    disposeWebgl();
    return report({ renderer: 'dom', fallbackReason: 'initialization-failed', dispose() {} });
  }
}
