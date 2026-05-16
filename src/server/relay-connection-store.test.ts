import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deleteStoredRelayConnectionCredentials,
  envRelayConnectionCredentials,
  loadStoredRelayConnectionCredentials,
  relayConnectionCredentialsPath,
  saveStoredRelayConnectionCredentials,
} from './relay-connection-store.js';

describe('relay connection credential store', () => {
  it('round-trips stored credentials without exposing them through status helpers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-store-'));
    await saveStoredRelayConnectionCredentials(dir, {
      relayUrl: 'http://relay.test/',
      nodeId: 'node-1',
      relayToken: 'secret-token',
      displayName: 'Desk',
    });

    await expect(loadStoredRelayConnectionCredentials(dir)).resolves.toEqual({
      relayUrl: 'http://relay.test',
      nodeId: 'node-1',
      relayToken: 'secret-token',
      displayName: 'Desk',
    });
    await expect(readFile(relayConnectionCredentialsPath(dir), 'utf8')).resolves.toContain('secret-token');

    await deleteStoredRelayConnectionCredentials(dir);
    await expect(loadStoredRelayConnectionCredentials(dir)).resolves.toBeNull();
  });

  it('uses env credentials only when both relay URL and token are present', () => {
    expect(envRelayConnectionCredentials({
      KOOKR_RELAY_URL: 'http://relay.test',
      KOOKR_RELAY_NODE_ID: 'node-env',
      KOOKR_RELAY_TOKEN: 'tok',
      KOOKR_RELAY_DISPLAY_NAME: 'Env desk',
    } as NodeJS.ProcessEnv)).toEqual({
      relayUrl: 'http://relay.test',
      nodeId: 'node-env',
      relayToken: 'tok',
      displayName: 'Env desk',
    });
    expect(envRelayConnectionCredentials({ KOOKR_RELAY_URL: 'http://relay.test' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
