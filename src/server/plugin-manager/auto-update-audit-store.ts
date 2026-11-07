/**
 * AutoUpdateAuditStore — the durable auto-update decision log (RFC Layer 4 / R6
 * "Audit state machine: every evaluation writes a durable decision record —
 * INCLUDING skips"). One versioned JSON file under the Kookr data dir, a bounded
 * ring (oldest records pruned past the cap) so the log cannot grow without
 * limit. Malformed-tolerant like the other plugin-manager stores.
 *
 * Decisions are stored oldest-first on disk; {@link recent} returns them
 * newest-first for display.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persistence-utils.js';
import type { AutoUpdateDecision, AutoUpdateEvalState } from '../../shared/contracts/plugins.js';

export const AUTO_UPDATE_AUDIT_FILENAME = 'plugin-auto-update-audit.json';
export const AUTO_UPDATE_AUDIT_VERSION = 1;
export const AUTO_UPDATE_AUDIT_MAX = 200;

interface AuditData {
  version: number;
  decisions: AutoUpdateDecision[];
}

const EVAL_STATES: ReadonlySet<string> = new Set<AutoUpdateEvalState>([
  'skipped',
  'applied',
  'failed',
  'verify-failed',
  'rolled-back',
  'rollback-failed',
]);

function coerceDecision(value: unknown): AutoUpdateDecision | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;
  if (typeof d.pluginId !== 'string' || typeof d.evaluatedAt !== 'string') return null;
  if (typeof d.state !== 'string' || !EVAL_STATES.has(d.state)) return null;
  if (typeof d.policy !== 'string') return null;
  const out: AutoUpdateDecision = {
    pluginId: d.pluginId,
    evaluatedAt: d.evaluatedAt,
    policy: d.policy as AutoUpdateDecision['policy'],
    state: d.state as AutoUpdateEvalState,
  };
  if (typeof d.reason === 'string') out.reason = d.reason as AutoUpdateDecision['reason'];
  if (Array.isArray(d.busyTaskIds)) out.busyTaskIds = d.busyTaskIds.filter((x): x is string => typeof x === 'string');
  if (typeof d.fromVersion === 'string' || d.fromVersion === null) out.fromVersion = d.fromVersion as string | null;
  if (typeof d.toVersion === 'string' || d.toVersion === null) out.toVersion = d.toVersion as string | null;
  if (typeof d.detail === 'string') out.detail = d.detail;
  return out;
}

export class AutoUpdateAuditStore {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly max: number = AUTO_UPDATE_AUDIT_MAX,
    filename: string = AUTO_UPDATE_AUDIT_FILENAME,
  ) {
    this.path = join(dataDir, filename);
  }

  get filePath(): string {
    return this.path;
  }

  /** Read the raw oldest-first log (malformed/missing → empty). */
  async readAll(): Promise<AutoUpdateDecision[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AuditData>;
      if (!Array.isArray(parsed?.decisions)) return [];
      return parsed.decisions.map(coerceDecision).filter((d): d is AutoUpdateDecision => d !== null);
    } catch {
      return [];
    }
  }

  /** Append a decision, pruning oldest past the cap. */
  async append(decision: AutoUpdateDecision): Promise<void> {
    const all = await this.readAll();
    all.push(decision);
    const trimmed = all.length > this.max ? all.slice(all.length - this.max) : all;
    const data: AuditData = { version: AUTO_UPDATE_AUDIT_VERSION, decisions: trimmed };
    await atomicWriteFile(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** The most recent decisions, newest first, capped at `limit`. */
  async recent(limit: number = this.max): Promise<AutoUpdateDecision[]> {
    const all = await this.readAll();
    return all.slice(Math.max(0, all.length - limit)).reverse();
  }

  /** The most recent decision for one plugin, or null. */
  async lastFor(pluginId: string): Promise<AutoUpdateDecision | null> {
    const all = await this.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].pluginId === pluginId) return all[i];
    }
    return null;
  }
}
