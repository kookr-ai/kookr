const RECENT_KEY = 'kookr:recentPlaybooks';
const PINNED_KEY = 'kookr:pinnedPlaybooks';
const PARAM_HISTORY_KEY = 'kookr:playbookParamHistory';
const MAX_RECENT = 5;

// TODO: recordLaunch, isPinned, and togglePin use bare playbookId without sourceCwd.
// New methods (recordParams, getParamSnapshot) use a composite key to avoid cross-project
// collisions. When the older methods are refactored, they should adopt the composite key too.

export class PlaybookUsageTracker {
  private recent: string[];
  private pinned: Set<string>;

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
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

  recordLaunch(playbookId: string): void {
    this.recent = [playbookId, ...this.recent.filter((id) => id !== playbookId)].slice(0, MAX_RECENT);
    this.save();
  }

  getRecent(): string[] {
    return [...this.recent];
  }

  isPinned(playbookId: string): boolean {
    return this.pinned.has(playbookId);
  }

  togglePin(playbookId: string): boolean {
    if (this.pinned.has(playbookId)) {
      this.pinned.delete(playbookId);
    } else {
      this.pinned.add(playbookId);
    }
    this.save();
    return this.pinned.has(playbookId);
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

function snapshotKey(playbookId: string, sourceCwd: string): string {
  return `${sourceCwd}::${playbookId}`;
}
