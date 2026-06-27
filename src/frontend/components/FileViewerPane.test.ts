// @vitest-environment jsdom

import React from 'react';
import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileViewerPane } from './FileViewerPane.js';

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

function mount(props: Partial<Parameters<typeof FileViewerPane>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      React.createElement(FileViewerPane, {
        filePath: '/work/root/doc.md',
        openedAt: '2026-04-21T00:00:00.000Z',
        onClose,
        ...props,
      }),
    );
  });
  return container;
}

async function flush() {
  // Let microtasks + the useEffect fetch (two awaited .json() hops) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mockFetchOnce(response: unknown, { status = 200 } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(response),
      } as unknown as Response),
    ),
  );
}

beforeEach(() => {
  onClose.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('FileViewerPane rendering', () => {
  test('renders loading state initially', () => {
    mockFetchOnce({}, { status: 200 }); // not resolved before we assert
    const el = mount();
    expect(el.querySelector('.file-pane-loading')?.textContent).toMatch(/loading/i);
  });

  test('renders markdown text in the markdown body', async () => {
    mockFetchOnce({
      kind: 'text',
      filePath: '/work/root/doc.md',
      language: 'markdown',
      content: '# Hello\n\nworld',
      truncated: false,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    const md = el.querySelector('.file-pane-md');
    expect(md).not.toBeNull();
    expect(md?.textContent).toContain('Hello');
    expect(el.querySelector('.file-pane-code')).toBeNull();
  });

  test('renders non-markdown text in a <pre> code body', async () => {
    mockFetchOnce({
      kind: 'text',
      filePath: '/work/root/app.ts',
      language: 'typescript',
      content: 'const x = 1;',
      truncated: false,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/app.ts' });
    await flush();

    const pre = el.querySelector('pre.file-pane-code');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const x = 1;');
  });

  test('appends a truncation marker when truncated', async () => {
    mockFetchOnce({
      kind: 'text',
      filePath: '/work/root/app.ts',
      language: 'typescript',
      content: 'partial',
      truncated: true,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/app.ts' });
    await flush();

    expect(el.querySelector('pre.file-pane-code')?.textContent).toMatch(/truncated/i);
  });

  test('renders HTML inside a fully sandboxed iframe pointing at /raw', async () => {
    mockFetchOnce({
      kind: 'html',
      filePath: '/work/root/page.html',
      size: 42,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/page.html' });
    await flush();

    const frame = el.querySelector('iframe.file-pane-frame');
    expect(frame).not.toBeNull();
    // Non-negotiable: empty sandbox => no scripts, no same-origin.
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('src')).toContain('/api/files/raw?path=');
    expect(frame?.getAttribute('src')).toContain(encodeURIComponent('/work/root/page.html'));
  });

  test('renders an <img> for image kind', async () => {
    mockFetchOnce({
      kind: 'image',
      filePath: '/work/root/pic.png',
      mime: 'image/png',
      size: 100,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/pic.png' });
    await flush();

    const img = el.querySelector('img.file-pane-img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('/api/files/raw?path=');
  });

  test('offers a download link for binary kind', async () => {
    mockFetchOnce({
      kind: 'binary',
      filePath: '/work/root/blob.bin',
      size: 2048,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/blob.bin' });
    await flush();

    const dl = el.querySelector('.file-pane-download a[download]');
    expect(dl).not.toBeNull();
    expect(dl?.getAttribute('href')).toContain('disposition=attachment');
    expect(el.querySelector('.file-pane-download')?.textContent).toMatch(/preview not available/i);
  });

  test('shows a too-large message with a download fallback', async () => {
    mockFetchOnce({
      kind: 'too_large',
      filePath: '/work/root/big.txt',
      size: 9_000_000,
      serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount({ filePath: '/work/root/big.txt' });
    await flush();

    expect(el.querySelector('.file-pane-download')?.textContent).toMatch(/too large/i);
    expect(el.querySelector('.file-pane-download a[download]')).not.toBeNull();
  });
});

describe('FileViewerPane — miss handling', () => {
  test('forbidden → "outside the workspace" message', async () => {
    mockFetchOnce({ error: 'forbidden', reason: 'outside_roots' }, { status: 403 });
    const el = mount();
    await flush();

    expect(el.querySelector('.file-pane-error')?.textContent).toMatch(/outside the workspace/i);
  });

  test('not_found → "File not found." message', async () => {
    mockFetchOnce({ error: 'not_found' }, { status: 404 });
    const el = mount();
    await flush();

    expect(el.querySelector('.file-pane-error')?.textContent).toMatch(/not found/i);
  });
});

describe('FileViewerPane — close', () => {
  // Escape-to-close is owned by DetailPanel's capture-phase window listener
  // (see src/frontend/components/DetailPanel.tsx), mirroring DiffPane.
  test('close button calls onClose', async () => {
    mockFetchOnce({
      kind: 'text', filePath: '/work/root/doc.md', language: 'markdown',
      content: 'x', truncated: false, serverStartedAt: '2026-04-21T00:00:00.000Z',
    });
    const el = mount();
    await flush();

    const btn = el.querySelector<HTMLButtonElement>('.file-pane-close');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
