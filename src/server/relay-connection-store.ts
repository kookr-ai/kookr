import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredRelayConnectionCredentials {
  schemaVersion: 'relay-connection.v1';
  relayUrl: string;
  nodeId?: string;
  relayToken: string;
  displayName?: string;
  publicBaseUrl?: string;
  updatedAt: string;
}

export interface RelayConnectionCredentials {
  relayUrl: string;
  nodeId?: string;
  relayToken: string;
  displayName?: string;
  publicBaseUrl?: string;
}

export class RelayConnectionCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConnectionCredentialError';
  }
}

export function relayConnectionCredentialsPath(kookrDir: string): string {
  return join(kookrDir, 'relay-connection.json');
}

export function relayNodeIdPath(kookrDir: string): string {
  return join(kookrDir, 'node-id');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeRelayUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('relayUrl must use http or https');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function parseRelayConnectionCredentials(raw: Record<string, unknown>): RelayConnectionCredentials {
  let relayUrl = '';
  try {
    relayUrl = typeof raw.relayUrl === 'string' ? normalizeRelayUrl(raw.relayUrl) : '';
  } catch {
    throw new RelayConnectionCredentialError('Stored relay URL is invalid.');
  }
  const nodeId = optionalString(raw.nodeId);
  const relayToken = typeof raw.relayToken === 'string' ? raw.relayToken.trim() : '';
  if (!relayUrl) throw new RelayConnectionCredentialError('Stored relay URL is missing.');
  if (!relayToken) throw new RelayConnectionCredentialError('Stored relay token is missing.');
  return {
    relayUrl,
    ...(nodeId ? { nodeId } : {}),
    relayToken,
    ...(optionalString(raw.displayName) ? { displayName: optionalString(raw.displayName) } : {}),
    ...(optionalString(raw.publicBaseUrl) ? { publicBaseUrl: optionalString(raw.publicBaseUrl) } : {}),
  };
}

export function envRelayConnectionCredentials(env: NodeJS.ProcessEnv): RelayConnectionCredentials | null {
  const relayUrl = env.KOOKR_RELAY_URL?.trim();
  const relayToken = env.KOOKR_RELAY_TOKEN?.trim();
  if (!relayUrl || !relayToken) return null;
  return {
    relayUrl: normalizeRelayUrl(relayUrl),
    relayToken,
    ...(optionalString(env.KOOKR_RELAY_NODE_ID) ? { nodeId: optionalString(env.KOOKR_RELAY_NODE_ID) } : {}),
    ...(optionalString(env.KOOKR_RELAY_DISPLAY_NAME) ? { displayName: optionalString(env.KOOKR_RELAY_DISPLAY_NAME) } : {}),
    ...(optionalString(env.KOOKR_PUBLIC_BASE_URL) ? { publicBaseUrl: optionalString(env.KOOKR_PUBLIC_BASE_URL) } : {}),
  };
}

export async function loadStoredRelayConnectionCredentials(kookrDir: string): Promise<RelayConnectionCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(relayConnectionCredentialsPath(kookrDir), 'utf8')) as Record<string, unknown>;
    if (parsed.schemaVersion !== 'relay-connection.v1') return null;
    return parseRelayConnectionCredentials(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveStoredRelayConnectionCredentials(
  kookrDir: string,
  credentials: RelayConnectionCredentials,
): Promise<void> {
  const path = relayConnectionCredentialsPath(kookrDir);
  await mkdir(dirname(path), { recursive: true });
  const payload: StoredRelayConnectionCredentials = {
    schemaVersion: 'relay-connection.v1',
    ...credentials,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function deleteStoredRelayConnectionCredentials(kookrDir: string): Promise<void> {
  await rm(relayConnectionCredentialsPath(kookrDir), { force: true });
}

export async function saveRelayNodeId(kookrDir: string, nodeId: string): Promise<void> {
  const path = relayNodeIdPath(kookrDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${nodeId}\n`, { encoding: 'utf8', mode: 0o600 });
}
