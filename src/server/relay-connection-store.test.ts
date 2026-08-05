import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deleteStoredRelayConnectionCredentials,
  envRelayConnectionCredentials,
  loadStoredRelayConnectionCredentials,
  normalizeRelayUrl,
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
    if (process.platform !== 'win32') {
      await expect(stat(relayConnectionCredentialsPath(dir)).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
    }

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

  it('rejects cloud-metadata and credentialed relay URLs during normalize (#2107)', () => {
    expect(() => normalizeRelayUrl('http://169.254.169.254/')).toThrow(/address is not allowed/);
    expect(() => normalizeRelayUrl('http://metadata.google.internal/')).toThrow(/host is not allowed/);
    expect(() => normalizeRelayUrl('http://user:pass@127.0.0.1:4800')).toThrow(/credentials/);
    expect(normalizeRelayUrl('http://192.168.1.50:4800/')).toBe('http://192.168.1.50:4800');
    expect(normalizeRelayUrl('http://127.0.0.1:4800')).toBe('http://127.0.0.1:4800');
  });
});
