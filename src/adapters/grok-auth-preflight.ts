import { readFile } from 'node:fs/promises';

/** Minimal filesystem seam for validating the copied launch-scoped auth file. */
export interface GrokAuthPreflightFs {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

const defaultFs: GrokAuthPreflightFs = {
  readFile: (path, encoding) => readFile(path, encoding),
};

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EARLY_INVALIDATION_MS = 5 * 60 * 1000;
const USABLE_AUTH_MODES = new Set(['oidc', 'external', 'api_key']);
const LEGACY_WEB_LOGIN_MODES = new Set(['web_login', 'grok']);
const OPTIONAL_STRING_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'profile_image_asset_id',
  'principal_type',
  'principal_id',
  'team_id',
  'team_name',
  'team_role',
  'organization_id',
  'organization_name',
  'organization_role',
  'user_blocked_reason',
  'refresh_token',
  'oidc_issuer',
  'oidc_client_id',
] as const;
/**
 * Default scope used by the fork's `GrokComConfig` when Kookr's allowlist omits
 * auth overrides. Keep this synchronized with the fork's default client id.
 */
export const GROK_DEFAULT_AUTH_SCOPE =
  'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const GROK_LEGACY_AUTH_SCOPE = 'https://accounts.x.ai/sign-in';

export type GrokUsableAuthMode = 'oidc' | 'external' | 'api_key';

export type GrokAuthPreflightResult =
  | {
      kind: 'ok';
      credentialCount: number;
      authMode: GrokUsableAuthMode;
      expiresAt: string;
    }
  | { kind: 'missing'; reason: 'file_missing' | 'empty' | 'no_usable_credential' }
  | { kind: 'invalid'; reason: 'unreadable' | 'malformed_json' | 'invalid_record' }
  | { kind: 'expired'; expiresAt: string };

interface ValidatedCredential {
  authMode: GrokUsableAuthMode;
  expiresAt: string;
  expiresAtMs: number;
}

export interface InspectGrokAuthFileOptions {
  fs?: Partial<GrokAuthPreflightFs>;
  now?: Date;
}

/**
 * Validate the offline credential cache consumed by the Grok Build fork.
 *
 * This intentionally does not contact xAI or attempt a refresh. It mirrors the
 * fork's disk-cache shape and expiry policy so a launch can fail before a
 * terminal session exists, while keeping the real access and refresh tokens out
 * of all returned diagnostics.
 */
export async function inspectGrokAuthFile(
  path: string,
  options: InspectGrokAuthFileOptions = {},
): Promise<GrokAuthPreflightResult> {
  const fs: GrokAuthPreflightFs = { ...defaultFs, ...options.fs };
  let contents: string;
  try {
    contents = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { kind: 'missing', reason: 'file_missing' };
    }
    return { kind: 'invalid', reason: 'unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'malformed_json' };
  }
  if (!isRecord(parsed)) return { kind: 'invalid', reason: 'invalid_record' };

  const entries = Object.entries(parsed);
  if (entries.length === 0) return { kind: 'missing', reason: 'empty' };

  const validated = new Map<string, ValidatedCredential | undefined>();
  for (const [scope, raw] of entries) {
    const credential = validateCredential(raw);
    if (credential.kind === 'invalid') return credential;
    validated.set(scope, credential.value);
  }

  // Grok looks up the configured scope, then falls back only to its legacy
  // scope. Seeing a valid token under an unrelated scope would otherwise make
  // this preflight pass while AuthManager still reports NotLoggedIn.
  const selectedScope = Object.prototype.hasOwnProperty.call(parsed, GROK_DEFAULT_AUTH_SCOPE)
    ? GROK_DEFAULT_AUTH_SCOPE
    : GROK_LEGACY_AUTH_SCOPE;
  const selected = validated.get(selectedScope);
  const credentials = selected ? [selected] : [];
  if (credentials.length === 0) return { kind: 'missing', reason: 'no_usable_credential' };

  const nowMs = (options.now ?? new Date()).getTime();
  const valid = credentials.filter((credential) => credential.expiresAtMs > nowMs + EARLY_INVALIDATION_MS);
  if (valid.length > 0) {
    const selected = valid[0]!;
    return {
      kind: 'ok',
      credentialCount: valid.length,
      authMode: selected.authMode,
      expiresAt: selected.expiresAt,
    };
  }

  const latest = credentials.reduce((candidate, credential) =>
    credential.expiresAtMs > candidate.expiresAtMs ? credential : candidate,
  );
  return { kind: 'expired', expiresAt: latest.expiresAt };
}

/** Format a safe, actionable launch error. Never append raw parser or auth data. */
export function formatGrokAuthPreflightFailure(
  path: string,
  result: Exclude<GrokAuthPreflightResult, { kind: 'ok' }>,
): string {
  const remediation = 'Run `grok login --device-code` (or `grok login --oauth`) and retry.';
  switch (result.kind) {
    case 'missing':
      if (result.reason === 'file_missing') {
        return `Grok authentication unavailable: no credential file was found at "${path}". ${remediation}`;
      }
      if (result.reason === 'empty') {
        return `Grok authentication unavailable: "${path}" is empty. ${remediation}`;
      }
      return `Grok authentication unavailable: "${path}" contains no usable credential. ${remediation}`;
    case 'invalid':
      if (result.reason === 'malformed_json') {
        return `Grok authentication unavailable: "${path}" could not be parsed safely. ${remediation}`;
      }
      if (result.reason === 'unreadable') {
        return `Grok authentication unavailable: "${path}" could not be read safely. ${remediation}`;
      }
      return `Grok authentication unavailable: "${path}" contains an invalid credential record. ${remediation}`;
    case 'expired':
      return `Grok authentication expired or is too close to expiry at ${result.expiresAt}. ${remediation}`;
  }
}

function validateCredential(
  raw: unknown,
): { kind: 'valid'; value?: ValidatedCredential } | { kind: 'invalid'; reason: 'invalid_record' } {
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'invalid_record' };

  const key = raw.key;
  const authMode = raw.auth_mode;
  const createTime = raw.create_time;
  const userId = raw.user_id;
  if (
    typeof key !== 'string' || key.length === 0 ||
    typeof authMode !== 'string' ||
    typeof createTime !== 'string' || !isDateString(createTime) ||
    typeof userId !== 'string' || userId.length === 0
  ) {
    return { kind: 'invalid', reason: 'invalid_record' };
  }

  let expiresAt = createTime;
  let expiresAtMs: number;
  if (raw.expires_at !== undefined && raw.expires_at !== null) {
    if (typeof raw.expires_at !== 'string' || !isDateString(raw.expires_at)) {
      return { kind: 'invalid', reason: 'invalid_record' };
    }
    expiresAt = raw.expires_at;
    expiresAtMs = Date.parse(expiresAt);
  } else {
    expiresAtMs = Date.parse(createTime) + TOKEN_TTL_MS;
    expiresAt = new Date(expiresAtMs).toISOString();
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = raw[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { kind: 'invalid', reason: 'invalid_record' };
    }
  }
  if (raw.has_grok_code_access !== undefined && raw.has_grok_code_access !== null && typeof raw.has_grok_code_access !== 'boolean') {
    return { kind: 'invalid', reason: 'invalid_record' };
  }
  if (raw.coding_data_retention_opt_out !== undefined && typeof raw.coding_data_retention_opt_out !== 'boolean') {
    return { kind: 'invalid', reason: 'invalid_record' };
  }
  if (
    raw.team_blocked_reasons !== undefined &&
    (!Array.isArray(raw.team_blocked_reasons) || raw.team_blocked_reasons.some((reason) => typeof reason !== 'string'))
  ) {
    return { kind: 'invalid', reason: 'invalid_record' };
  }

  if (LEGACY_WEB_LOGIN_MODES.has(authMode)) return { kind: 'valid' };
  if (!USABLE_AUTH_MODES.has(authMode)) return { kind: 'invalid', reason: 'invalid_record' };

  if (!Number.isFinite(expiresAtMs)) return { kind: 'invalid', reason: 'invalid_record' };

  return {
    kind: 'valid',
    value: { authMode: authMode as GrokUsableAuthMode, expiresAt, expiresAtMs },
  };
}

function isDateString(value: string): boolean {
  // The fork deserializes these fields as chrono::DateTime<Utc>, whose serde
  // implementation requires an RFC 3339 timestamp. Date.parse alone accepts
  // date-only values, whitespace separators, and normalizes invalid calendar
  // dates, which would let a cache pass here and fail only after launch.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
