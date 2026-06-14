// --- Viewer grant store (RFC: rfc-shared-view-readonly.md §Viewer grant store) ---
//
// Persisted store of read-only viewer grants, separate from the owner token.
// Each grant carries a sha-256 token *hash* (never the raw token), a label, and
// a {@link Scope}. The raw token is generated and returned exactly once at
// creation (`create`); it is never persisted and never logged, so a leaked
// `share-grants.json` cannot be replayed.
//
// `resolve(token)` is the seam consumed by `ApiAuthConfig.resolveViewer`
// (`src/server/auth.ts`, #802): it hashes the presented token, constant-time
// compares against every stored hash, and reports whether the credential is a
// valid / revoked / expired / unknown viewer. It is synchronous and operates
// purely on the in-memory grant set — callers must `await load()` once at
// startup before serving traffic.
//
// Revocation is the primary control (RFC R10); expiry defaults to never. There
// is intentionally no persisted `lastSeenAt` — live presence comes from the
// in-memory connection registry (#805), so the hot path takes no disk write.
//
// Per-port isolation (RFC §Port-instance isolation): the file lives under the
// resolved per-port `KOOKR_DIR` passed to the constructor, never a hard-coded
// `~/.kookr`. Two instances on different ports therefore use different files
// and cannot collide.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';
import { canonicalizeScope, type Scope } from '../server/viewer-data-policy.js';
import type { ViewerTokenResolution } from '../server/auth.js';

/**
 * Liveness of a grant by id, the return of {@link ViewerGrantStore.liveness}.
 * Structurally identical to the connection registry's `GrantLiveness` (the
 * registry injects `liveness` as its `resolveGrantLiveness` sweep callback), but
 * declared here so this `core/` module does not import a type *down* from
 * `server/` — the dependency only flows the other way (the server registry
 * consumes this store), keeping the layer direction intact.
 */
export type ViewerGrantLiveness = 'active' | 'revoked' | 'expired' | 'not-found';

/** Persisted viewer grant. The raw token is never stored — only its hash. */
export interface ViewerGrant {
  /** Stable opaque grant id (audit + registry key). Not a secret. */
  id: string;
  /** sha-256(token) as lowercase hex. The raw token is shown once at creation. */
  tokenHash: string;
  /** Human label shown in the owner's Share UI. */
  label: string;
  /** What the grant may reach. Canonicalized (sorted+deduped) on create. */
  scope: Scope;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry; absent ⇒ never expires (revocation is the primary control). */
  expiresAt?: string;
  /** ISO-8601 revocation timestamp; present ⇒ the grant no longer resolves. */
  revokedAt?: string;
}

/**
 * A grant as exposed to owner-facing surfaces (Share UI, list/create routes).
 * The token hash is omitted so it never crosses the API boundary — owners act
 * on grants by `id`, and the raw token is only ever the once-returned value of
 * {@link ViewerGrantStore.create}.
 */
export type ViewerGrantSummary = Omit<ViewerGrant, 'tokenHash'>;

/** Input for {@link ViewerGrantStore.create}. `scope` is canonicalized on store. */
export interface CreateGrantInput {
  label: string;
  scope: Scope;
  /** Optional ISO-8601 expiry. Omit for a non-expiring grant. */
  expiresAt?: string;
}

/** Result of {@link ViewerGrantStore.create} — the raw token is shown ONCE here. */
export interface CreatedGrant {
  grant: ViewerGrantSummary;
  /** Raw secret token. Returned exactly once; never persisted or logged. */
  token: string;
}

const SHARE_GRANTS_FILE = 'share-grants.json';
const SCHEMA_VERSION = 1;

interface ShareGrantsFile {
  schemaVersion: number;
  grants: ViewerGrant[];
}

/** sha-256 of a token as a raw Buffer (for constant-time compare). */
function hashTokenBuffer(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function toSummary(grant: ViewerGrant): ViewerGrantSummary {
  const { tokenHash: _tokenHash, ...summary } = grant;
  return summary;
}

function isValidScope(value: unknown): value is Scope {
  if (!value || typeof value !== 'object') return false;
  const s = value as { kind?: unknown; projectIds?: unknown };
  if (s.kind === 'all') return true;
  if (s.kind === 'projects') {
    return Array.isArray(s.projectIds) && s.projectIds.every((p) => typeof p === 'string');
  }
  return false;
}

/**
 * A non-empty, parseable ISO-8601 timestamp. Timestamps are security-relevant
 * (`expiresAt` gates resolution, `revokedAt` blocks it), so a present-but-empty
 * or unparseable value must NOT be trusted — it is treated as a corrupt record
 * and the grant is dropped on load (fail-closed), rather than silently failing
 * open to a never-expiring / never-revoked grant.
 */
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidGrant(value: unknown): value is ViewerGrant {
  if (!value || typeof value !== 'object') return false;
  const g = value as Partial<ViewerGrant>;
  return (
    typeof g.id === 'string'
    && typeof g.tokenHash === 'string'
    && /^[0-9a-f]{64}$/.test(g.tokenHash)
    && typeof g.label === 'string'
    && isValidScope(g.scope)
    && isIsoTimestamp(g.createdAt)
    && (g.expiresAt === undefined || isIsoTimestamp(g.expiresAt))
    && (g.revokedAt === undefined || isIsoTimestamp(g.revokedAt))
  );
}

/**
 * File-backed viewer-grant store. Construct with the resolved per-port
 * `KOOKR_DIR`, `await load()` once, then `create` / `list` / `revoke` /
 * `resolve`. Writes are atomic (write-temp + fsync + rename, via
 * {@link atomicWriteFile}) and serialized through an async write lock so
 * concurrent create/revoke calls cannot interleave a torn `grants` array.
 */
export class ViewerGrantStore {
  private readonly filePath: string;
  private grants: ViewerGrant[] = [];
  /** Async write mutex — serializes persist() across concurrent callers. */
  private writeLock: Promise<void> = Promise.resolve();
  /**
   * Whether the last durable write succeeded. Surfaced via {@link isWritable}
   * for the owner `/api/health` `viewerBroadcaster.grantStoreWritable` signal
   * (#808 / R10) so a store whose disk has gone read-only is visible to the
   * operator. Starts `true`: a fresh store with no writes yet is presumed
   * writable until proven otherwise.
   */
  private lastWriteOk = true;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, SHARE_GRANTS_FILE);
  }

  /**
   * Whether the last persist succeeded (health observability, R10). A `false`
   * here means a create/revoke failed to reach disk — grants may be lost on
   * restart — so the owner health block can flag it.
   */
  isWritable(): boolean {
    return this.lastWriteOk;
  }

  /**
   * Current liveness of a grant by id, for the connection-registry revocation
   * sweep (#805/#808). Mirrors {@link resolve}'s revoked-before-expiry ordering
   * and fail-closed expiry parsing, but keys on the opaque grant id (which the
   * registry holds per socket) rather than the secret token. Unknown id ⇒
   * `not-found` (the sweep evicts it — a deleted grant must not keep a socket).
   */
  liveness(grantId: string): ViewerGrantLiveness {
    const grant = this.grants.find((g) => g.id === grantId);
    if (!grant) return 'not-found';
    if (grant.revokedAt) return 'revoked';
    if (grant.expiresAt) {
      const expiresMs = Date.parse(grant.expiresAt);
      if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) return 'expired';
    }
    return 'active';
  }

  /** Load grants from disk into memory. Missing/corrupt file ⇒ empty store. */
  async load(): Promise<void> {
    const fallback: ShareGrantsFile = { schemaVersion: SCHEMA_VERSION, grants: [] };
    const loaded = await readJsonFile<ShareGrantsFile>(this.filePath, fallback, {
      quarantineCorrupt: true,
      warningPrefix: 'viewer-grants',
    });
    // `readJsonFile` only falls back on a missing/unparseable file; valid JSON
    // that is `null` or a non-object (e.g. a truncated write) still reaches
    // here, so guard before touching `.schemaVersion` (corrupt ⇒ empty store).
    if (!loaded || typeof loaded !== 'object') {
      console.warn('[viewer-grants] Malformed share-grants file (not an object), starting empty');
      this.grants = [];
      return;
    }
    if (loaded.schemaVersion !== SCHEMA_VERSION) {
      console.warn(
        `[viewer-grants] Unknown schemaVersion ${loaded.schemaVersion}, starting empty`,
      );
      this.grants = [];
      return;
    }
    const valid: ViewerGrant[] = [];
    for (const g of Array.isArray(loaded.grants) ? loaded.grants : []) {
      if (isValidGrant(g)) {
        valid.push({ ...g, scope: canonicalizeScope(g.scope) });
      } else {
        console.warn('[viewer-grants] Skipping invalid grant record');
      }
    }
    this.grants = valid;
  }

  /**
   * Create a grant. Generates a fresh 32-byte hex token, persists only its
   * sha-256 hash, and returns the raw token EXACTLY once (it is unrecoverable
   * thereafter). The scope is canonicalized so downstream comparisons are
   * stable.
   */
  async create(input: CreateGrantInput): Promise<CreatedGrant> {
    const token = randomBytes(32).toString('hex');
    const grant: ViewerGrant = {
      id: randomUUID(),
      tokenHash: hashTokenBuffer(token).toString('hex'),
      label: input.label,
      scope: canonicalizeScope(input.scope),
      createdAt: new Date().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    await this.commit((current) => [...current, grant]);
    return { grant: toSummary(grant), token };
  }

  /** All grants (active and revoked) as owner-facing summaries (no token hash). */
  list(): ViewerGrantSummary[] {
    return this.grants.map(toSummary);
  }

  /**
   * Revoke a grant by id. Idempotent: revoking an already-revoked grant keeps
   * the original `revokedAt`. Returns `false` if no grant with that id exists.
   */
  async revoke(id: string): Promise<boolean> {
    if (!this.grants.some((g) => g.id === id)) return false;
    const revokedAt = new Date().toISOString();
    await this.commit((current) =>
      current.map((g) => (g.id === id && !g.revokedAt ? { ...g, revokedAt } : g)),
    );
    return true;
  }

  /**
   * Resolve a presented credential against the stored grants. Synchronous. The
   * token is hashed once, then compared against EVERY stored hash with
   * `timingSafeEqual` and no early break, so the *match position* among the
   * grants does not leak via timing. (Total loop time still scales with the
   * grant count, and the post-match revoked/expired branch is data-dependent —
   * neither reveals the secret, which is the per-hash compare; for a LAN
   * read-only threat model that residual is acceptable.) Revocation is checked
   * before expiry; an unparseable `expiresAt` fails closed (treated as expired).
   *
   * Shape matches {@link ViewerTokenResolution} so it plugs straight into
   * `ApiAuthConfig.resolveViewer`.
   */
  resolve(token: string): ViewerTokenResolution {
    const presented = hashTokenBuffer(token);
    let matched: ViewerGrant | undefined;
    for (const grant of this.grants) {
      const stored = Buffer.from(grant.tokenHash, 'hex');
      // sha-256 ⇒ both are always 32 bytes, so timingSafeEqual never throws on
      // length and the presented-token length cannot leak via an early reject.
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        matched = grant;
      }
    }
    if (!matched) return { kind: 'not-found' };
    if (matched.revokedAt) return { kind: 'revoked', grantId: matched.id };
    if (matched.expiresAt) {
      const expiresMs = Date.parse(matched.expiresAt);
      if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
        return { kind: 'expired', grantId: matched.id };
      }
    }
    return { kind: 'valid', grantId: matched.id, scope: matched.scope };
  }

  /**
   * Apply `mutate` to the grant set and atomically persist the result,
   * serialized via the async write lock. `mutate` runs *inside* the lock (so it
   * reads the latest committed grants — concurrent create/revoke cannot lose a
   * write), and the in-memory `grants` is only swapped to the new array *after*
   * the durable write succeeds. A failed write therefore leaves both disk and
   * memory at the prior state and rejects the caller (no fail-open: a revoke
   * whose persist fails does not leave the grant looking revoked in memory while
   * a restart would resurrect it).
   */
  private async commit(mutate: (current: readonly ViewerGrant[]) => ViewerGrant[]): Promise<void> {
    const run = this.writeLock.then(async () => {
      const next = mutate(this.grants);
      const snapshot: ShareGrantsFile = { schemaVersion: SCHEMA_VERSION, grants: next };
      try {
        await atomicWriteFile(this.filePath, JSON.stringify(snapshot, null, 2));
      } catch (err) {
        // Record the failure for the health signal, then rethrow so the caller
        // still sees the rejection (no fail-open: memory stays at the prior
        // state because we have not swapped `this.grants`).
        this.lastWriteOk = false;
        throw err;
      }
      this.lastWriteOk = true;
      this.grants = next;
    });
    // Keep the lock chain alive even if this write rejects, so a single failure
    // does not wedge all later writes.
    this.writeLock = run.then(() => {}, () => {});
    await run;
  }
}
