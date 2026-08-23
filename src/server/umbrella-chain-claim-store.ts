import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from '../core/persistence-utils.js';
import { withCrossProcessLock } from './cross-process-lock.js';

export const UMBRELLA_CHAIN_CLAIMS_FILE = 'umbrella-chain-claims.json';
const SCHEMA_VERSION = 2;
const DEFAULT_STALE_CLAIM_MS = 30 * 60_000;

export interface UmbrellaChainClaim {
  key: string;
  ownerToken: string;
  claimedAt: string;
  taskId?: string;
}

export type ClaimAttempt =
  | { kind: 'claimed'; claim: UmbrellaChainClaim }
  | { kind: 'busy'; claim: UmbrellaChainClaim }
  | { kind: 'error'; message: string };

interface ClaimsFile {
  version: typeof SCHEMA_VERSION;
  claims: Record<string, UmbrellaChainClaim>;
}

function isClaim(value: unknown): value is UmbrellaChainClaim {
  if (!value || typeof value !== 'object') return false;
  const claim = value as Partial<UmbrellaChainClaim>;
  return typeof claim.key === 'string'
    && typeof claim.ownerToken === 'string'
    && claim.ownerToken.length > 0
    && typeof claim.claimedAt === 'string'
    && Number.isFinite(Date.parse(claim.claimedAt))
    && (claim.taskId === undefined || typeof claim.taskId === 'string');
}

function emptyFile(): ClaimsFile {
  return { version: SCHEMA_VERSION, claims: {} };
}

export class UmbrellaChainClaimStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly staleClaimMs: number;
  private readonly now: () => Date;

  constructor(
    kookrDir: string,
    options: { staleClaimMs?: number; now?: () => Date } = {},
  ) {
    this.filePath = join(kookrDir, UMBRELLA_CHAIN_CLAIMS_FILE);
    this.lockPath = `${this.filePath}.lock`;
    this.staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Claim is durable before the caller is allowed to POST a new task. */
  async claim(key: string): Promise<ClaimAttempt> {
    try {
      const result = await withCrossProcessLock(this.lockPath, async () => {
        const file = await this.load();
        const existing = file.claims[key];
        const nowMs = this.now().getTime();
        if (existing && nowMs - Date.parse(existing.claimedAt) < this.staleClaimMs) {
          return { kind: 'busy', claim: existing } as const;
        }
        const claim: UmbrellaChainClaim = {
          key,
          ownerToken: randomUUID(),
          claimedAt: this.now().toISOString(),
        };
        file.claims[key] = claim;
        await this.persist(file);
        return {
          kind: 'claimed',
          claim,
        } as const;
      });
      if (result.kind === 'busy') {
        return {
          kind: 'busy',
          claim: {
            key,
            ownerToken: `lock:${result.holderPid ?? 'unknown'}`,
            claimedAt: result.heldSince ?? this.now().toISOString(),
          },
        };
      }
      return result.value;
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async finalize(key: string, taskId: string, ownerToken: string): Promise<void> {
    await this.mutate((file) => {
      const claim = file.claims[key];
      if (!claim || claim.ownerToken !== ownerToken) throw new Error(`claim ownership lost for ${key}`);
      claim.taskId = taskId;
    });
  }

  async release(key: string, ownerToken: string): Promise<void> {
    await this.mutate((file) => {
      const claim = file.claims[key];
      if (!claim || claim.ownerToken !== ownerToken) throw new Error(`claim ownership lost for ${key}`);
      delete file.claims[key];
    });
  }

  async get(key: string): Promise<UmbrellaChainClaim | undefined> {
    const file = await this.load();
    return file.claims[key];
  }

  private async mutate(mutator: (file: ClaimsFile) => void): Promise<void> {
    const result = await withCrossProcessLock(this.lockPath, async () => {
      const file = await this.load();
      mutator(file);
      await this.persist(file);
      return undefined;
    });
    if (result.kind === 'busy') throw new Error(`umbrella-chain claim lock is held by process ${result.holderPid ?? 'unknown'}`);
  }

  private async load(): Promise<ClaimsFile> {
    const loaded = await readJsonFile<ClaimsFile>(this.filePath, emptyFile(), {
      quarantineCorrupt: true,
      warningPrefix: 'umbrella-chain-claims',
    });
    if (!loaded || loaded.version !== SCHEMA_VERSION || !loaded.claims || typeof loaded.claims !== 'object') {
      return emptyFile();
    }
    const claims: Record<string, UmbrellaChainClaim> = {};
    for (const [key, value] of Object.entries(loaded.claims)) {
      if (isClaim(value) && value.key === key) claims[key] = value;
    }
    return { version: SCHEMA_VERSION, claims };
  }

  private async persist(file: ClaimsFile): Promise<void> {
    await atomicWriteFile(this.filePath, JSON.stringify(file));
  }
}
