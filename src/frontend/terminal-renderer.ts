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
}

interface InstalledTerminalRenderer {
  renderer: 'webgl' | 'dom';
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
  // WebDriver-controlled browsers and older GPU stacks should keep xterm's
  // default DOM renderer so E2E can inspect terminal text and flaky WebGL
  // stacks never block terminal startup.
  if (navigatorLike?.webdriver || navigatorLike?.userAgent?.includes('HeadlessChrome')) {
    return { renderer: 'dom', dispose() {} };
  }
  if (!options.document && typeof globalThis.WebGL2RenderingContext === 'undefined') {
    return { renderer: 'dom', dispose() {} };
  }
  if (!documentLike || !hasWebgl2(documentLike)) {
    return { renderer: 'dom', dispose() {} };
  }

  let disposed = false;
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
      disposeWebgl();
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    });
    terminal.loadAddon(addon);
    return { renderer: 'webgl', dispose: disposeWebgl };
  } catch {
    disposeWebgl();
    return { renderer: 'dom', dispose() {} };
  }
}
