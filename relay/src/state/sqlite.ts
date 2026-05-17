import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { asNodeId, type NodeId } from '../../../src/remote/ids.js';
import { isInvitationRecord, type InvitationRecord } from '../invitations/store.js';

export interface PersistedNodeRegistration {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  deviceId?: string;
  tokenHash: string;
  createdAt: string;
  lastSeen?: string;
}

export interface RelayStateSnapshot {
  registrations: PersistedNodeRegistration[];
  invitations: InvitationRecord[];
  quarantinedRows: number;
}

interface RegistrationRow {
  node_id: string;
  owner_id: string;
  display_name: string;
  device_id: string | null;
  token_hash: string;
  created_at: string;
  last_seen: string | null;
}

interface InvitationRow {
  invitation_id: string;
  record_json: string;
}

function isNodeRegistration(value: unknown): value is PersistedNodeRegistration {
  const registration = value as Partial<PersistedNodeRegistration>;
  return typeof value === 'object'
    && value !== null
    && typeof registration.nodeId === 'string'
    && typeof registration.ownerId === 'string'
    && typeof registration.displayName === 'string'
    && typeof registration.tokenHash === 'string'
    && typeof registration.createdAt === 'string'
    && (registration.deviceId === undefined || typeof registration.deviceId === 'string')
    && (registration.lastSeen === undefined || typeof registration.lastSeen === 'string');
}

export class RelaySqliteStateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new Database(dbPath);
    } catch (err) {
      throw new Error(`failed to open relay state database at ${dbPath}`, { cause: err });
    }
    this.db.pragma('journal_mode = WAL');
    const journalMode = String((this.db.pragma('journal_mode', { simple: true }) as string | undefined) ?? '').toLowerCase();
    if (dbPath !== ':memory:' && journalMode !== 'wal') {
      throw new Error(`relay state database did not enter WAL mode; journal_mode=${journalMode || 'unknown'}`);
    }
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.assertIntegrity();
  }

  load(): RelayStateSnapshot {
    let quarantinedRows = 0;
    const registrations: PersistedNodeRegistration[] = [];
    for (const row of this.db.prepare('SELECT * FROM relay_registrations').all() as RegistrationRow[]) {
      const registration: PersistedNodeRegistration = {
        nodeId: asNodeId(row.node_id),
        ownerId: row.owner_id,
        displayName: row.display_name,
        ...(row.device_id ? { deviceId: row.device_id } : {}),
        tokenHash: row.token_hash,
        createdAt: row.created_at,
        ...(row.last_seen ? { lastSeen: row.last_seen } : {}),
      };
      if (isNodeRegistration(registration)) {
        registrations.push(registration);
        continue;
      }
      quarantinedRows += 1;
      this.quarantine('relay_registrations', row.node_id, JSON.stringify(row), 'invalid registration row');
      this.db.prepare('DELETE FROM relay_registrations WHERE node_id = ?').run(row.node_id);
    }

    const invitations: InvitationRecord[] = [];
    for (const row of this.db.prepare('SELECT invitation_id, record_json FROM relay_invitations').all() as InvitationRow[]) {
      try {
        const parsed = JSON.parse(row.record_json) as unknown;
        if (!isInvitationRecord(parsed) || parsed.invitationId !== row.invitation_id) {
          throw new Error('invalid invitation row');
        }
        invitations.push(parsed);
      } catch (err) {
        quarantinedRows += 1;
        this.quarantine(
          'relay_invitations',
          row.invitation_id,
          row.record_json,
          err instanceof Error ? err.message : String(err),
        );
        this.db.prepare('DELETE FROM relay_invitations WHERE invitation_id = ?').run(row.invitation_id);
      }
    }
    return { registrations, invitations, quarantinedRows };
  }

  saveRegistration(registration: PersistedNodeRegistration): void {
    this.db.prepare(`
      INSERT INTO relay_registrations (
        node_id, owner_id, display_name, device_id, token_hash, created_at, last_seen
      ) VALUES (
        @nodeId, @ownerId, @displayName, @deviceId, @tokenHash, @createdAt, @lastSeen
      )
      ON CONFLICT(node_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        display_name = excluded.display_name,
        device_id = excluded.device_id,
        token_hash = excluded.token_hash,
        created_at = excluded.created_at,
        last_seen = excluded.last_seen
    `).run({
      nodeId: registration.nodeId,
      ownerId: registration.ownerId,
      displayName: registration.displayName,
      deviceId: registration.deviceId ?? null,
      tokenHash: registration.tokenHash,
      createdAt: registration.createdAt,
      lastSeen: registration.lastSeen ?? null,
    });
  }

  saveInvitation(invitation: InvitationRecord): void {
    this.db.prepare(`
      INSERT INTO relay_invitations (invitation_id, record_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(invitation_id) DO UPDATE SET
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(invitation.invitationId, JSON.stringify(invitation), new Date().toISOString());
  }

  probe(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_registrations (
        node_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        device_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen TEXT
      );
      CREATE TABLE IF NOT EXISTS relay_invitations (
        invitation_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_quarantine (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        error TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
    `);
  }

  private assertIntegrity(): void {
    const result = this.db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`relay state database integrity_check failed: ${String(result)}`);
    }
  }

  private quarantine(tableName: string, rowId: string, payload: string, error: string): void {
    console.warn(JSON.stringify({
      event: 'relay.state.row_quarantined',
      tableName,
      rowId,
      error,
    }));
    this.db.prepare(`
      INSERT INTO relay_quarantine (table_name, row_id, payload, error, quarantined_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tableName, rowId, payload, error, new Date().toISOString());
  }
}
