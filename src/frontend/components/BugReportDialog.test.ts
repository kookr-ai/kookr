// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BugReportDialog } from './BugReportDialog.js';
import type { BugReportBundle } from '../bug-report-bundle.js';

function bundle(): BugReportBundle {
  return {
    schemaVersion: 'kookr-bug-report.v1',
    generatedAt: '2026-05-24T10:00:00.000Z',
    triage: {
      trigger: 'manual',
      suspectedArea: 'unknown',
      firstSeenAt: null,
      lastSeenAt: null,
      summary: 'Manual bug report without a captured alert.',
    },
    source: {
      appVersion: null,
      commit: null,
      branch: null,
      buildTimestamp: null,
      versionUnavailableReason: 'build_commit_missing',
      serverStartedAt: null,
      location: { originKind: 'localhost', protocol: 'http:', route: '/' },
      browser: { family: 'Chrome', platform: 'MacIntel', language: 'en-US', viewportBucket: 'desktop-tall' },
    },
    redaction: { policy: 'strict-v1', applied: [] },
    selection: { selectedAgentId: null, selectedProjectPresent: false },
    selectedAgent: null,
    fleetSummary: { totalAgents: 0, byTaskStatus: {}, byAnomalySeverity: {} },
    alerts: [],
    wireObservations: [],
    debugTimeline: [],
    captureDiagnostics: {
      warnings: [],
      omittedSections: [],
      failures: [],
      bundleSizeBytes: 10,
      sizeLimitBytes: 1_000_000,
      truncationApplied: false,
    },
  };
}

describe('BugReportDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('downloads the exact JSON string shown in the preview', async () => {
    const serialized = JSON.stringify({ ok: true, note: 'hello' }, null, 2);
    let downloadedBlob: Blob | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return 'blob:test';
      }),
      revokeObjectURL: vi.fn(),
    });

    await act(async () => {
      root.render(React.createElement(BugReportDialog, {
        bundle: bundle(),
        serialized,
        note: 'hello',
        onNoteChange: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    const preview = container.querySelector<HTMLTextAreaElement>('#bug-report-preview');
    expect(preview?.value).toBe(serialized);

    const download = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Download JSON');
    expect(download).toBeDefined();

    await act(async () => {
      download!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(downloadedBlob).not.toBeNull();
    await expect(downloadedBlob!.text()).resolves.toBe(serialized);
    expect(clickSpy).toHaveBeenCalled();
  });

  test('downloads user-redacted preview content', async () => {
    const serialized = JSON.stringify({ ok: true, secret: 'remove me' }, null, 2);
    let downloadedBlob: Blob | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return 'blob:test';
      }),
      revokeObjectURL: vi.fn(),
    });

    await act(async () => {
      root.render(React.createElement(BugReportDialog, {
        bundle: bundle(),
        serialized,
        note: '',
        onNoteChange: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    const preview = container.querySelector<HTMLTextAreaElement>('#bug-report-preview');
    expect(preview).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(preview, '{"ok":true}');
    await act(async () => {
      preview!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const download = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Download JSON');
    await act(async () => {
      download!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await expect(downloadedBlob!.text()).resolves.toBe('{"ok":true}');
  });

  test('does not overwrite manual preview redactions when regenerated props arrive', async () => {
    const close = vi.fn();
    const noteChange = vi.fn();

    await act(async () => {
      root.render(React.createElement(BugReportDialog, {
        bundle: bundle(),
        serialized: JSON.stringify({ ok: true, secret: 'remove me' }, null, 2),
        note: '',
        onNoteChange: noteChange,
        onClose: close,
      }));
    });

    const preview = container.querySelector<HTMLTextAreaElement>('#bug-report-preview');
    expect(preview).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(preview, '{"ok":true}');
    await act(async () => {
      preview!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      root.render(React.createElement(BugReportDialog, {
        bundle: bundle(),
        serialized: JSON.stringify({ ok: true, note: 'new generated value' }, null, 2),
        note: 'new generated value',
        onNoteChange: noteChange,
        onClose: close,
      }));
    });

    expect(container.querySelector<HTMLTextAreaElement>('#bug-report-preview')?.value).toBe('{"ok":true}');
  });
});
