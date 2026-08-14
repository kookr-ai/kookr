import { describe, expect, test, vi } from 'vitest';

import {
  maybeOpenDashboardBrowser,
  shouldOpenDashboardBrowser,
} from './open-dashboard-browser.js';

describe('maybeOpenDashboardBrowser', () => {
  const interactive = {
    env: {} as NodeJS.ProcessEnv,
    isTTY: true,
    platform: 'linux' as NodeJS.Platform,
    execArgv: [] as string[],
  };

  test('opens the dashboard once on an interactive loopback start', () => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      openUrl,
    });
    expect(result).toEqual({
      opened: true,
      command: 'xdg-open',
      url: 'http://127.0.0.1:4800',
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('xdg-open', 'http://127.0.0.1:4800');
  });

  test('uses `open` on macOS', () => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: 'localhost',
      port: 4801,
      ...interactive,
      platform: 'darwin',
      openUrl,
    });
    expect(result).toEqual({
      opened: true,
      command: 'open',
      url: 'http://localhost:4801',
    });
    expect(openUrl).toHaveBeenCalledWith('open', 'http://localhost:4801');
  });

  test('brackets IPv6 loopback in the opened URL', () => {
    const openUrl = vi.fn();
    maybeOpenDashboardBrowser({
      host: '::1',
      port: 4800,
      ...interactive,
      openUrl,
    });
    expect(openUrl).toHaveBeenCalledWith('xdg-open', 'http://[::1]:4800');
  });

  test.each([
    { label: 'CI=true', env: { CI: 'true' } as NodeJS.ProcessEnv, reason: 'ci' as const },
    { label: 'CI=1', env: { CI: '1' } as NodeJS.ProcessEnv, reason: 'ci' as const },
    { label: 'CI=yes', env: { CI: 'yes' } as NodeJS.ProcessEnv, reason: 'ci' as const },
    { label: 'VITEST', env: { VITEST: 'true' } as NodeJS.ProcessEnv, reason: 'ci' as const },
    { label: 'KOOKR_OPEN_BROWSER=0', env: { KOOKR_OPEN_BROWSER: '0' } as NodeJS.ProcessEnv, reason: 'disabled' as const },
    { label: 'KOOKR_OPEN_BROWSER=false', env: { KOOKR_OPEN_BROWSER: 'false' } as NodeJS.ProcessEnv, reason: 'disabled' as const },
    { label: 'KOOKR_OPEN_BROWSER=off', env: { KOOKR_OPEN_BROWSER: 'off' } as NodeJS.ProcessEnv, reason: 'disabled' as const },
    { label: 'KOOKR_OPEN_BROWSER=no', env: { KOOKR_OPEN_BROWSER: 'no' } as NodeJS.ProcessEnv, reason: 'disabled' as const },
  ])('skips when $label', ({ env, reason }) => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      env,
      openUrl,
    });
    expect(result).toEqual({ opened: false, reason });
    expect(openUrl).not.toHaveBeenCalled();
  });

  test('skips when stdin is not a TTY', () => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      isTTY: false,
      openUrl,
    });
    expect(result).toEqual({ opened: false, reason: 'not-a-tty' });
    expect(openUrl).not.toHaveBeenCalled();
  });

  test('skips when the bind host is not loopback', () => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '0.0.0.0',
      port: 4800,
      ...interactive,
      openUrl,
    });
    expect(result).toEqual({ opened: false, reason: 'non-loopback' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(shouldOpenDashboardBrowser({ host: '10.0.0.5', env: {}, isTTY: true, execArgv: [] })).toEqual({
      open: false,
      reason: 'non-loopback',
    });
  });

  test('skips under Node --watch so pnpm dev does not reopen a tab on every respawn', () => {
    const openUrl = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      execArgv: ['--watch-path=src/server'],
      openUrl,
    });
    expect(result).toEqual({ opened: false, reason: 'watch' });
    expect(openUrl).not.toHaveBeenCalled();
  });

  test('a missing platform opener warns and does not call openUrl', () => {
    const openUrl = vi.fn();
    const logWarn = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      platform: 'win32',
      openUrl,
      logWarn,
    });
    expect(result).toEqual({ opened: false, reason: 'no-opener' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toMatch(/no platform opener/i);
  });

  test('a throwing opener warns and reports not opened', () => {
    const logWarn = vi.fn();
    const result = maybeOpenDashboardBrowser({
      host: '127.0.0.1',
      port: 4800,
      ...interactive,
      openUrl: () => {
        throw new Error('ENOENT: xdg-open');
      },
      logWarn,
    });
    expect(result).toEqual({ opened: false, reason: 'no-opener' });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toMatch(/xdg-open/);
  });
});
