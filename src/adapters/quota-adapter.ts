import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { QuotaStatus, QuotaWindow } from '../core/quota-types.js';

/** Poller status for diagnostics. */
export type PollerState = 'idle' | 'polling' | 'healthy' | 'backoff' | 'auth_failed' | 'disabled';

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

// OAuth usage endpoint (undocumented but functional)
const USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

/**
 * QuotaAdapter polls the Anthropic OAuth usage endpoint for quota utilization.
 * Read-only credential access — never attempts token refresh.
 */
export class QuotaAdapter {
  private latest: QuotaStatus | null = null;
  private state: PollerState = 'idle';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private baseIntervalMs: number;
  private currentIntervalMs: number;
  private maxBackoffMs = 1_800_000; // 30 minutes — the usage endpoint can stay 429'd for a long time
  private lastError: string | null = null;
  private credentialsMtimeMs: number | null = null;
  private lastAttemptedToken: string | null = null;

  constructor(intervalMs = 120_000) {
    this.baseIntervalMs = intervalMs;
    this.currentIntervalMs = intervalMs;
  }

  /** Get the latest quota snapshot (may be null if never polled or all polls failed). */
  getLatest(): QuotaStatus | null {
    return this.latest;
  }

  /** Get the current poller state for diagnostics. */
  getState(): PollerState {
    return this.state;
  }

  /** Get the last error message. */
  getLastError(): string | null {
    return this.lastError;
  }

  /** Get the current effective polling interval in ms. */
  getCurrentIntervalMs(): number {
    return this.currentIntervalMs;
  }

  /**
   * Poll the OAuth usage endpoint once. Call this from a lifecycle timer.
   * Returns true if quota data was updated.
   */
  async poll(): Promise<boolean> {
    let token: string | null;
    try {
      if (this.state === 'disabled' || this.state === 'auth_failed') {
        const recoveredToken = await this.readChangedAccessToken();
        // Stay dormant until the credentials file contains a genuinely new token.
        if (!recoveredToken || recoveredToken === this.lastAttemptedToken) return false;
        token = recoveredToken;
      } else {
        token = await this.readAccessToken();
      }
    } catch (err) {
      this.state = 'disabled';
      this.lastError = `Cannot read credentials: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[quota] ${this.lastError}`);
      return false;
    }

    if (!token) {
      this.state = 'disabled';
      this.lastError = 'No OAuth access token found in credentials file';
      console.warn(`[quota] ${this.lastError}`);
      return false;
    }

    this.state = 'polling';

    try {
      this.lastAttemptedToken = token;
      const response = await fetch(USAGE_API, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': BETA_HEADER,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 401) {
        // Token expired — try re-reading (Claude Code may have refreshed it)
        const refreshedToken = await this.readAccessToken();
        if (refreshedToken && refreshedToken !== token) {
          // Token was refreshed, retry once
          this.lastAttemptedToken = refreshedToken;
          const retryResponse = await fetch(USAGE_API, {
            headers: {
              'Authorization': `Bearer ${refreshedToken}`,
              'anthropic-beta': BETA_HEADER,
              'Content-Type': 'application/json',
            },
          });
          if (retryResponse.status === 401) {
            return this.handleAuthFailure('OAuth token expired and re-read failed');
          }
          return this.handleResponse(retryResponse);
        }
        return this.handleAuthFailure('OAuth token expired');
      }

      if (response.status === 429) {
        this.consecutiveFailures++;
        this.consecutiveSuccesses = 0;
        // Respect retry-after header if present, otherwise double the interval
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter, 10);
          if (!isNaN(retrySeconds) && retrySeconds > 0) {
            this.currentIntervalMs = Math.max(retrySeconds * 1000, this.currentIntervalMs);
          }
        } else {
          this.currentIntervalMs = Math.min(
            this.currentIntervalMs * 2,
            this.maxBackoffMs,
          );
        }
        this.state = 'backoff';
        this.lastError = `Rate limited (429). Next retry in ${Math.round(this.currentIntervalMs / 1000)}s`;
        console.warn(`[quota] ${this.lastError}`);
        return false;
      }

      return this.handleResponse(response);
    } catch (err) {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      this.currentIntervalMs = Math.min(
        this.currentIntervalMs * 2,
        this.maxBackoffMs,
      );
      this.state = 'backoff';
      this.lastError = `Network error: ${err instanceof Error ? err.message : String(err)}. Next retry in ${Math.round(this.currentIntervalMs / 1000)}s`;
      console.warn(`[quota] ${this.lastError}`);
      return false;
    }
  }

  private async handleResponse(response: Response): Promise<boolean> {
    if (!response.ok) {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      this.state = 'backoff';
      this.lastError = `HTTP ${response.status}`;
      console.warn(`[quota] Unexpected response: ${response.status}`);
      return false;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.consecutiveFailures++;
      this.state = 'backoff';
      this.lastError = 'Invalid JSON response';
      console.warn('[quota] Invalid JSON in usage response');
      return false;
    }

    // Schema validation: expect an object with five_hour and/or seven_day
    if (!body || typeof body !== 'object') {
      this.consecutiveFailures++;
      this.state = 'backoff';
      this.lastError = 'Unexpected response shape';
      console.warn('[quota] Unexpected response shape');
      return false;
    }

    const data = body as Record<string, unknown>;

    const fiveHour = this.parseWindow(data['five_hour']);
    const sevenDay = this.parseWindow(data['seven_day']);

    this.latest = {
      fiveHour,
      sevenDay,
      updatedAt: Date.now(),
    };

    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.state = 'healthy';
    this.lastError = null;

    // Decay backoff after 3 consecutive successes
    if (this.consecutiveSuccesses >= 3 && this.currentIntervalMs > this.baseIntervalMs) {
      this.currentIntervalMs = this.baseIntervalMs;
    }

    return true;
  }

  private parseWindow(raw: unknown): QuotaWindow | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const utilization = obj['utilization'];
    const resetsAt = obj['resets_at'];
    if (typeof utilization !== 'number' || typeof resetsAt !== 'string') return null;
    return { utilization, resetsAt };
  }

  private handleAuthFailure(message: string): false {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.currentIntervalMs = Math.min(
      this.currentIntervalMs * 2,
      this.maxBackoffMs,
    );
    this.state = 'auth_failed';
    this.lastError = message;
    console.warn(`[quota] ${this.lastError}`);
    return false;
  }

  private async readChangedAccessToken(): Promise<string | null> {
    const credentialsStat = await stat(CREDENTIALS_PATH);
    if (credentialsStat.mtimeMs === this.credentialsMtimeMs) return null;
    return this.readAccessToken(credentialsStat.mtimeMs);
  }

  private async readAccessToken(knownMtimeMs?: number): Promise<string | null> {
    const mtimeMs = knownMtimeMs ?? (await stat(CREDENTIALS_PATH)).mtimeMs;
    const content = await readFile(CREDENTIALS_PATH, 'utf-8');
    this.credentialsMtimeMs = mtimeMs;
    const creds = JSON.parse(content) as CredentialsFile;
    return creds.claudeAiOauth?.accessToken ?? null;
  }
}
