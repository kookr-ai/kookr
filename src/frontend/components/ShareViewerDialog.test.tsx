// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ViewerLinksResponse } from '../viewer-share-api.js';

// The dialog fetches grants + roster on mount; stub the client so the render is
// driven by a fixed roster we control (no network, no CSRF wrapper).
const listViewerLinks = vi.fn<[], Promise<ViewerLinksResponse>>();
const createViewerLink = vi.fn();
vi.mock('../viewer-share-api.js', () => ({
  listViewerLinks: () => listViewerLinks(),
  createViewerLink: (...args: unknown[]) => createViewerLink(...args),
  revokeViewerLink: vi.fn(),
}));

import {
  ShareViewerDialog,
  describeExpiry,
  describeScope,
  watchingCount,
  watchingLabel,
} from './ShareViewerDialog.js';

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

describe('describeScope (created-link confirmation)', () => {
  const names = new Map([['proj-api', 'API']]);

  test('whole-dashboard scope', () => {
    expect(describeScope({ kind: 'all' }, names)).toBe('Whole dashboard');
  });

  test('project scope resolves the display name, falling back to the id', () => {
    expect(describeScope({ kind: 'projects', projectIds: ['proj-api'] }, names)).toBe('Project: API');
    expect(describeScope({ kind: 'projects', projectIds: ['proj-x'] }, names)).toBe('Project: proj-x');
  });

  test('project scope with no project ids reads "No projects"', () => {
    expect(describeScope({ kind: 'projects', projectIds: [] }, names)).toBe('No projects');
  });
});

describe('describeExpiry (created-link confirmation)', () => {
  test('never-expire link reads unambiguously', () => {
    expect(describeExpiry(grant('a'))).toBe('Never expires');
  });

  test('present-but-unparseable expiry reads "Expiry unknown", not "Invalid Date" or a false "Never expires"', () => {
    expect(describeExpiry(grant('a', { expiresAt: 'not-a-date' }))).toBe('Expiry unknown');
  });

  test('finite expiry pairs a coarse lifetime with an absolute instant', () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const text = describeExpiry(grant('a', { expiresAt }));
    expect(text).toMatch(/^Expires in 24 hours \(.+\)$/);
    expect(text).toContain(new Date(expiresAt).toLocaleString());
  });

  test('single-hour expiry is reported in the singular', () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(describeExpiry(grant('a', { expiresAt }))).toMatch(/^Expires in 1 hour \(/);
  });

  test('multi-day expiry is reported in days', () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(describeExpiry(grant('a', { expiresAt }))).toMatch(/^Expires in 7 days \(/);
  });

  test('sub-hour expiry is reported in minutes (singular at one)', () => {
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
    expect(describeExpiry(grant('a', { expiresAt }))).toMatch(/^Expires in 1 minute \(/);
  });

  test('already-elapsed expiry reads as expired', () => {
    const expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
    expect(describeExpiry(grant('a', { expiresAt }))).toMatch(/^Expired \(/);
  });
});

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

describe('ShareViewerDialog created-link confirmation (#2785)', () => {
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

  async function createShowing(created: ViewerLinksResponse['grants'][number] & { handoffUrl?: string }) {
    listViewerLinks.mockResolvedValue({ grants: [], roster: [] });
    createViewerLink.mockResolvedValue({
      grant: created,
      token: 'raw-token-value',
      handoffUrl: created.handoffUrl ?? 'https://host/viewer#t=raw-token-value',
    });
    await act(async () => {
      root.render(React.createElement(ShareViewerDialog, { onClose: vi.fn() }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const form = container.querySelector('form.share-viewer-dialog__form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function summaryText(): string {
    return container.querySelector('.share-viewer-dialog__created-summary')?.textContent ?? '';
  }

  test('whole-dashboard, never-expire link shows scope and lifetime', async () => {
    await createShowing(grant('a', { scope: { kind: 'all' } }));
    expect(summaryText()).toBe('Whole dashboard · Never expires');
  });

  test('project-scoped, finite-expiry link shows both scope and lifetime', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await createShowing(grant('a', { scope: { kind: 'projects', projectIds: ['proj-x'] }, expiresAt }));
    expect(summaryText()).toMatch(/^Project: proj-x · Expires in 24 hours \(/);
  });

  test('the one-time handoff URL — the only token surface — is unchanged by the summary', async () => {
    // Bait the summary with grant fields that carry the token: if a regression
    // ever renders the label (or stringifies the whole grant) into the summary,
    // this catches it. The summary must stay {scope} · {expiry} only.
    await createShowing(grant('a', { scope: { kind: 'all' }, label: 'raw-token-value' }));
    const url = container.querySelector<HTMLInputElement>('.share-viewer-dialog__url-row input');
    expect(url?.value).toBe('https://host/viewer#t=raw-token-value');
    expect(summaryText()).toBe('Whole dashboard · Never expires');
    expect(summaryText()).not.toContain('raw-token-value');
  });
});
