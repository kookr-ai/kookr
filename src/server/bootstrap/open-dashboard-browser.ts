import { execFile } from 'node:child_process';

import { isLoopbackHost } from '../auth.js';

/**
 * After a successful listen, open the dashboard URL in the operator's
 * browser so they do not have to copy it from the startup log.
 *
 * Skipped unless this looks like an interactive local start: CI, a
 * non-TTY stdin, a non-loopback bind, or `KOOKR_OPEN_BROWSER=0` all
 * stay silent. A missing platform opener logs a warning and never
 * fails startup (issue #2486).
 */

export type OpenDashboardBrowserDecision =
  | { opened: true; command: string; url: string }
  | { opened: false; reason: OpenDashboardBrowserSkipReason };

export type OpenDashboardBrowserSkipReason =
  | 'ci'
  | 'disabled'
  | 'not-a-tty'
  | 'non-loopback'
  | 'no-opener';

export type OpenDashboardUrl = (command: string, url: string) => void;

export interface OpenDashboardBrowserOptions {
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  platform?: NodeJS.Platform;
  /** Test seam. Defaults to `execFile` with no shell. */
  openUrl?: OpenDashboardUrl;
  logWarn?: (message: string) => void;
}

const OPEN_BROWSER_DISABLE = new Set(['0', 'false', 'off', 'no']);
const CI_TRUTHY = new Set(['true', '1', 'yes']);
const OPENER_TIMEOUT_MS = 5_000;

export function dashboardUrl(host: string, port: number): string {
  const needsBrackets = host.includes(':') && !host.startsWith('[');
  return `http://${needsBrackets ? `[${host}]` : host}:${port}`;
}

export function dashboardBrowserCommand(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return undefined;
}

export function shouldOpenDashboardBrowser(opts: {
  host: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}): { open: true } | { open: false; reason: OpenDashboardBrowserSkipReason } {
  const env = opts.env ?? process.env;
  const ci = env.CI?.trim().toLowerCase();
  if (ci !== undefined && CI_TRUTHY.has(ci)) {
    return { open: false, reason: 'ci' };
  }
  // Vitest sets VITEST=true. Skip so unit/e2e helpers that boot a server
  // never spawn xdg-open when a developer runs the suite from a TTY.
  if (env.VITEST) {
    return { open: false, reason: 'ci' };
  }
  const flag = env.KOOKR_OPEN_BROWSER?.trim().toLowerCase();
  if (flag !== undefined && OPEN_BROWSER_DISABLE.has(flag)) {
    return { open: false, reason: 'disabled' };
  }
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    return { open: false, reason: 'not-a-tty' };
  }
  if (!isLoopbackHost(opts.host)) {
    return { open: false, reason: 'non-loopback' };
  }
  return { open: true };
}

function defaultOpenUrl(command: string, url: string, logWarn: (message: string) => void): void {
  execFile(command, [url], { timeout: OPENER_TIMEOUT_MS }, (err) => {
    if (err) {
      logWarn(`Failed to open dashboard in browser (${command}): ${err.message}`);
    }
  });
}

/**
 * Best-effort open of `http://<host>:<port>` after listen. Never throws.
 */
export function maybeOpenDashboardBrowser(
  opts: OpenDashboardBrowserOptions,
): OpenDashboardBrowserDecision {
  const logWarn = opts.logWarn ?? ((message) => console.warn(message));
  const decision = shouldOpenDashboardBrowser({
    host: opts.host,
    env: opts.env,
    isTTY: opts.isTTY,
  });
  if (!decision.open) {
    return { opened: false, reason: decision.reason };
  }

  const platform = opts.platform ?? process.platform;
  const command = dashboardBrowserCommand(platform);
  if (!command) {
    return { opened: false, reason: 'no-opener' };
  }

  const url = dashboardUrl(opts.host, opts.port);
  try {
    if (opts.openUrl) {
      opts.openUrl(command, url);
    } else {
      defaultOpenUrl(command, url, logWarn);
    }
  } catch (err) {
    logWarn(
      `Failed to open dashboard in browser (${command}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { opened: true, command, url };
}
