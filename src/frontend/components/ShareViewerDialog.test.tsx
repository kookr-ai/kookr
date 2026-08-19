// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ViewerLinksResponse } from '../viewer-share-api.js';

// The dialog fetches grants + roster on mount; stub the client so the render is
// driven by a fixed roster we control (no network, no CSRF wrapper).
const listViewerLinks = vi.fn<[], Promise<ViewerLinksResponse>>();
vi.mock('../viewer-share-api.js', () => ({
  listViewerLinks: () => listViewerLinks(),
  createViewerLink: vi.fn(),
  revokeViewerLink: vi.fn(),
}));

import { ShareViewerDialog, watchingCount, watchingLabel } from './ShareViewerDialog.js';

function conn(grantId: string): ViewerLinksResponse['roster'][number] {
  return {
    grantId,
    kind: 'dashboard',
    connectedAt: new Date().toISOString(),
    scopeEffective: { kind: 'all' },
  };
}

function grant(id: string, over: Partial<ViewerLinksResponse['grants'][number]> = {}): ViewerLinksResponse['grants'][number] {
  return {
    id,
    label: `link-${id}`,
    scope: { kind: 'all' },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('watchingLabel / watchingCount', () => {
  const roster: ViewerLinksResponse['roster'] = [conn('a'), conn('a'), conn('b')];

  test('counts only connections for the given grant', () => {
    expect(watchingCount(roster, 'a')).toBe(2);
    expect(watchingCount(roster, 'b')).toBe(1);
    expect(watchingCount(roster, 'c')).toBe(0);
  });

  test('label is singular / plural / null-at-zero', () => {
    expect(watchingLabel(roster, 'a')).toBe('2 watching');
    expect(watchingLabel(roster, 'b')).toBe('1 watching');
    expect(watchingLabel(roster, 'c')).toBeNull();
  });
});

describe('ShareViewerDialog live viewer count', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderWith(data: ViewerLinksResponse) {
    listViewerLinks.mockResolvedValue(data);
    await act(async () => {
      root.render(React.createElement(ShareViewerDialog, { onClose: vi.fn() }));
    });
    // flush the mount-time refresh() promise
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function statusText(): string[] {
    return Array.from(container.querySelectorAll('.share-viewer-dialog__item-status')).map(
      (el) => el.textContent ?? '',
    );
  }

  /** Extract the exact "N watching" label from a status line, or null when absent. */
  function watchingSegment(text: string): string | null {
    return text.match(/\d+ watching/)?.[0] ?? null;
  }

  test('reports each grant independently with correct singular/plural', async () => {
    await renderWith({
      grants: [grant('a'), grant('b'), grant('c')],
      roster: [conn('a'), conn('a'), conn('b')],
    });
    const texts = statusText();
    // Exact-match the segment so a superset digit string ("12 watching") can't pass.
    expect(watchingSegment(texts[0])).toBe('2 watching');
    expect(watchingSegment(texts[1])).toBe('1 watching');
    // grant c has no viewers → nothing shown
    expect(watchingSegment(texts[2])).toBeNull();
  });

  test('composes with the connected and expires segments in order', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await renderWith({
      grants: [grant('a', { expiresAt: future })],
      roster: [conn('a'), conn('a')],
    });
    const text = statusText()[0];
    // status · connected … · N watching · expires …  (watching after connected, before expires)
    expect(text).toMatch(/connected .* · 2 watching · expires /);
  });

  test('omits the count entirely when nobody is watching', async () => {
    await renderWith({ grants: [grant('a')], roster: [] });
    expect(statusText()[0]).not.toContain('watching');
  });

  test('revoked and expired grants show no watching count', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await renderWith({
      grants: [
        grant('r', { revokedAt: new Date().toISOString() }),
        grant('e', { expiresAt: past }),
      ],
      // stale roster entries must not leak onto non-active grants
      roster: [conn('r'), conn('e')],
    });
    for (const text of statusText()) {
      expect(text).not.toContain('watching');
    }
  });
});
