const RECENT_KEY = 'kookr:recentPlaybooks';
const PINNED_KEY = 'kookr:pinnedPlaybooks';
const PARAM_HISTORY_KEY = 'kookr:playbookParamHistory';
const MAX_RECENT = 5;

/** Composite storage key — same shape as param history (`sourceCwd::playbookId`). */
export function snapshotKey(playbookId: string, sourceCwd: string): string {
  return `${sourceCwd}::${playbookId}`;
}

/**
 * Match a stored pin/recent entry against a playbook.
 * Composite keys are preferred; bare playbookId is accepted for pre-migration data.
 */
export function matchesUsageKey(stored: string, playbookId: string, sourceCwd: string): boolean {
  return stored === snapshotKey(playbookId, sourceCwd) || stored === playbookId;
}

/** Playbook id portion of a stored usage key (`sourceCwd::id` or legacy bare id). */
export function usageKeyPlaybookId(stored: string): string {
  const sep = stored.lastIndexOf('::');
  return sep === -1 ? stored : stored.slice(sep + 2);
}

/**
 * Label for a stored recent/pin key: catalog `name` when a playbook matches
 * (composite or legacy bare id), otherwise the file stem of the stored id.
 */
export function resolveRecentPlaybookLabel(
  stored: string,
  playbooks: readonly { id: string; sourceCwd: string; name: string }[],
): string {
  const match = playbooks.find((pb) => matchesUsageKey(stored, pb.id, pb.sourceCwd));
  if (match?.name) return match.name;
  const id = usageKeyPlaybookId(stored);
  return id.replace(/\.md$/i, '') || stored;
}

export class PlaybookUsageTracker {
  private recent: string[];
  private pinned: Set<string>;

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
    // Best-effort migration on load: keep bare playbookId entries readable via
    // matchesUsageKey. Without sourceCwd context we cannot rewrite them here;
    // recordLaunch / togglePin rewrite to composite keys on next write.
    this.recent = this.loadList(RECENT_KEY);
    this.pinned = new Set(this.loadList(PINNED_KEY));
  }

  private loadList(key: string): string[] {
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      this.storage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]));
    } catch (e) {
      console.warn('PlaybookUsageTracker: failed to save', e);
    }
  }

  recordLaunch(playbookId: string, sourceCwd: string): void {
    const key = snapshotKey(playbookId, sourceCwd);
    // Drop matching composite and any legacy bare id for this playbook (migrates on write)
    this.recent = [key, ...this.recent.filter((id) => id !== key && id !== playbookId)].slice(
      0,
      MAX_RECENT,
    );
    this.save();
  }

  getRecent(): string[] {
    return [...this.recent];
  }

  /** Index in the recent list for this playbook+cwd (composite or legacy bare), or -1. */
  recentIndex(playbookId: string, sourceCwd: string): number {
    return this.recent.findIndex((stored) => matchesUsageKey(stored, playbookId, sourceCwd));
  }

  isPinned(playbookId: string, sourceCwd: string): boolean {
    return (
      this.pinned.has(snapshotKey(playbookId, sourceCwd)) || this.pinned.has(playbookId)
    );
  }

  togglePin(playbookId: string, sourceCwd: string): boolean {
    const key = snapshotKey(playbookId, sourceCwd);
    const hasComposite = this.pinned.has(key);
    const hasLegacy = this.pinned.has(playbookId);
    const wasPinned = hasComposite || hasLegacy;

    this.pinned.delete(key);
    // Consume legacy bare id when this playbook is toggled (best-effort migrate-on-write)
    if (hasLegacy) this.pinned.delete(playbookId);

    if (!wasPinned) {
      this.pinned.add(key);
    }
    this.save();
    return this.pinned.has(key);
  }

  getPinned(): Set<string> {
    return new Set(this.pinned);
  }

  /** Record parameter values for a playbook launch. */
  recordParams(playbookId: string, sourceCwd: string, values: Record<string, string>): void {
    try {
      const all = this.loadParamHistory();
      all[snapshotKey(playbookId, sourceCwd)] = values;
      this.storage.setItem(PARAM_HISTORY_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn('PlaybookUsageTracker: failed to save param history', e);
    }
  }

  /** Get the last-used parameter values for a playbook, or null. Reads fresh from localStorage. */
  getParamSnapshot(playbookId: string, sourceCwd: string): Record<string, string> | null {
    try {
      const all = this.loadParamHistory();
      return all[snapshotKey(playbookId, sourceCwd)] ?? null;
    } catch (e) {
      console.warn('PlaybookUsageTracker: failed to read param history', e);
      return null;
    }
  }

  private loadParamHistory(): Record<string, Record<string, string>> {
    const raw = this.storage.getItem(PARAM_HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    // Validate: each value must be a Record<string, string>
    const result: Record<string, Record<string, string>> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const record: Record<string, string> = {};
        let valid = true;
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          if (typeof v === 'string') {
            record[k] = v;
          } else {
            valid = false;
            break;
          }
        }
        if (valid) result[key] = record;
      }
    }
    return result;
  }
}
