const STORAGE_KEY = 'kookr:recentPaths';
const DEFAULT_MAX = 10;

/**
 * MRU list of launch working directories, backed by localStorage. Storage is
 * the source of truth on every read (not cached at construction) so all
 * instances — and tests seeding localStorage — observe the same list.
 */
export class RecentPaths {
  constructor(
    private storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    private max: number = DEFAULT_MAX,
  ) {}

  getAll(): string[] {
    return this.load();
  }

  filter(query: string): string[] {
    if (!query) return this.getAll();
    const lower = query.toLowerCase();
    return this.load().filter((p) => p.toLowerCase().includes(lower));
  }

  add(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;

    // Remove if already present, then prepend
    const paths = [trimmed, ...this.load().filter((p) => p !== trimmed)].slice(0, this.max);
    this.save(paths);
  }

  private load(): string[] {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string');
      return [];
    } catch {
      return [];
    }
  }

  private save(paths: string[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(paths));
  }
}
