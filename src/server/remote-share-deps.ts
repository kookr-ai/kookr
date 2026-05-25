import type { RelayShareClient } from './relay-share-client.js';
import type { TaskShareService } from './task-share-service.js';

/**
 * Phase A0 easy connection sharing config. The server always provides it;
 * `client` is `null` in local-only mode (no relay configured), which makes
 * share routes answer `409 relay-not-configured`.
 */
export interface RemoteShareDeps {
  /** Per-process CSRF nonce for share-mutation endpoints. */
  csrfToken: string;
  /** Relay client, or `null` when no relay is configured. */
  client: RelayShareClient | null;
  /** Local owner of A0 projection publication/revoke overlay state. */
  service?: TaskShareService;
  /** Relay-advertised task-share max TTL from the node handshake, when connected. */
  getShareMaxTtlMs?: () => number | null;
}
