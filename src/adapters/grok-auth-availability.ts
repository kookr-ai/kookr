/**
 * Grok session-auth readiness for schedule/launch *selection* (issue #2194).
 *
 * Binary registration (`grok-build-preflight`) only checks that the `grok`
 * binary exists. Session/OIDC freshness is checked at launch time inside
 * {@link inspectGrokAuthFile}. Before #2194, that meant every schedule whose
 * resolved agent was (or defaulted to) `grok-build` failed closed with
 * `dispatch_failed` when auth expired — even when claude-code / codex-cli were
 * healthy substitutes — because availability was "registered", not "launchable".
 *
 * This cache lets the schedule runner and round-robin resolver treat
 * expired/missing Grok credentials as *not launchable*, so:
 * - non-Grok (or fallback-to-non-Grok) fires proceed;
 * - Grok-only fires classify as `auth_expired` instead of a generic thrash.
 *
 * Never introduces API-key (`XAI_API_KEY`) auth — session/OIDC path only.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentType } from '../shared/contracts/agent-types.js';
import {
  inspectGrokAuthFile,
  type GrokAuthPreflightResult,
} from './grok-auth-preflight.js';
import { sharedGrokAuthPath } from './grok-home-composer.js';

/** Default cache TTL — short enough that a re-login is picked up within a tick. */
export const GROK_AUTH_AVAILABILITY_TTL_MS = 30_000;

export type GrokAuthUsability =
  | { usable: true; expiresAt: string; checkedAtMs: number }
  | {
      usable: false;
      reason: 'expired' | 'missing' | 'invalid';
      detail?: string;
      checkedAtMs: number;
    };

export interface GrokAuthAvailabilityOptions {
  /** Path to the shared `~/.grok/auth.json` (or test double). */
  resolveAuthPath?: () => string;
  /** Injected inspect (tests). Defaults to {@link inspectGrokAuthFile}. */
  inspect?: (path: string) => Promise<GrokAuthPreflightResult>;
  /** Cache TTL in ms. Default {@link GROK_AUTH_AVAILABILITY_TTL_MS}. */
  ttlMs?: number;
  /** Injected clock (ms epoch). */
  now?: () => number;
}

/**
 * Remove `grok-build` from a registered-agent list when Grok session auth is
 * known unusable. Pure — safe for unit tests and both schedule + launch paths.
 *
 * When `grokAuthUsable` is `true` or omitted, returns a copy of `registered`
 * unchanged (fail-open: do not strip Grok without a negative signal).
 */
export function filterLaunchableAgentTypes(
  registered: readonly AgentType[],
  opts: { grokAuthUsable?: boolean } = {},
): AgentType[] {
  if (opts.grokAuthUsable === false) {
    return registered.filter((type) => type !== 'grok-build');
  }
  return [...registered];
}

/** Default operator auth path — same home the GrokBuildAdapter seeds from. */
export function defaultGrokAuthPath(sourceGrokHome?: string): string {
  return sharedGrokAuthPath(sourceGrokHome ?? join(homedir(), '.grok'));
}

/**
 * Re-project a cached usability verdict back into the {@link inspectGrokAuthFile}
 * result shape so a caller can build the same DTO from the cached verdict the
 * launch path reads, instead of re-inspecting disk (issue #2537). The cache
 * stores `reason` + `detail` (which mirrors the source `result.reason` /
 * `result.expiresAt`), so this reconstruction is lossless for every field the
 * Launch-dialog DTO surfaces; token-bearing fields were never cached.
 *
 * The `ok` branch fills placeholder `credentialCount` / `authMode` values the
 * status DTO discards — they are never real credential material.
 */
export function grokAuthUsabilityToPreflightResult(
  verdict: GrokAuthUsability,
): GrokAuthPreflightResult {
  if (verdict.usable) {
    return { kind: 'ok', credentialCount: 1, authMode: 'oidc', expiresAt: verdict.expiresAt };
  }
  switch (verdict.reason) {
    case 'expired':
      return { kind: 'expired', expiresAt: verdict.detail ?? '' };
    case 'missing':
      return {
        kind: 'missing',
        reason: (verdict.detail as 'file_missing' | 'empty' | 'no_usable_credential' | undefined)
          ?? 'no_usable_credential',
      };
    case 'invalid':
      return {
        kind: 'invalid',
        reason: (verdict.detail as 'unreadable' | 'malformed_json' | 'invalid_record' | undefined)
          ?? 'invalid_record',
      };
  }
}

/**
 * TTL-cached Grok session-auth usability. Sync readers use the last known
 * verdict; {@link refresh} / {@link ensureFresh} update it from disk.
 *
 * Fail-open when never checked (`isUsable() === true`) so a missing cache
 * never blocks non-Grok work. After a negative inspect, fail-closed until a
 * later refresh finds credentials usable again.
 */
export class GrokAuthAvailabilityCache {
  private readonly resolveAuthPath: () => string;
  private readonly inspect: (path: string) => Promise<GrokAuthPreflightResult>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private state: GrokAuthUsability | null = null;
  private inflight: Promise<GrokAuthUsability> | null = null;

  constructor(options: GrokAuthAvailabilityOptions = {}) {
    this.resolveAuthPath = options.resolveAuthPath ?? (() => defaultGrokAuthPath());
    this.inspect = options.inspect ?? ((path) => inspectGrokAuthFile(path));
    this.ttlMs = options.ttlMs ?? GROK_AUTH_AVAILABILITY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Last known usability. Fail-open when never checked. */
  isUsable(): boolean {
    if (this.state === null) return true;
    return this.state.usable;
  }

  /** True only after a completed inspect that found auth unusable. */
  isKnownUnusable(): boolean {
    return this.state !== null && !this.state.usable;
  }

  /** Diagnostic snapshot (null until first refresh). */
  snapshot(): GrokAuthUsability | null {
    return this.state;
  }

  /**
   * Force a negative verdict without re-reading disk — used when a launch
   * already observed {@link GrokAuthPreflightError} so the next schedule
   * resolution substitutes immediately.
   */
  markUnusable(reason: 'expired' | 'missing' | 'invalid' = 'expired', detail?: string): void {
    this.state = {
      usable: false,
      reason,
      ...(detail ? { detail } : {}),
      checkedAtMs: this.now(),
    };
  }

  /** Refresh when stale (or never checked). Coalesces concurrent callers. */
  async ensureFresh(): Promise<GrokAuthUsability> {
    const now = this.now();
    if (this.state && now - this.state.checkedAtMs < this.ttlMs) {
      return this.state;
    }
    return this.refresh();
  }

  /** Always re-inspect the auth file and update the cache. */
  async refresh(): Promise<GrokAuthUsability> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<GrokAuthUsability> {
    const checkedAtMs = this.now();
    let result: GrokAuthPreflightResult;
    try {
      result = await this.inspect(this.resolveAuthPath());
    } catch (err) {
      // Inspect itself should not throw; if a test double / FS fault does,
      // fail-open so we do not couple every schedule fire to a probe crash.
      console.warn(
        '[grok-auth-availability] inspect failed; treating Grok auth as usable (fail-open):',
        err instanceof Error ? err.message : err,
      );
      this.state = {
        usable: true,
        expiresAt: new Date(checkedAtMs).toISOString(),
        checkedAtMs,
      };
      return this.state;
    }

    if (result.kind === 'ok') {
      this.state = {
        usable: true,
        expiresAt: result.expiresAt,
        checkedAtMs,
      };
      return this.state;
    }

    const reason: 'expired' | 'missing' | 'invalid' =
      result.kind === 'expired' ? 'expired' : result.kind === 'missing' ? 'missing' : 'invalid';
    this.state = {
      usable: false,
      reason,
      detail: result.kind === 'expired' ? result.expiresAt : result.reason,
      checkedAtMs,
    };
    return this.state;
  }
}
