const STORAGE_KEY = 'kookr:recentPaths';
const DEFAULT_MAX = 10;

export class RecentPaths {
  private paths: string[];

  constructor(
    private storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    private max: number = DEFAULT_MAX,
  ) {
    this.paths = this.load();
  }

  getAll(): string[] {
    return [...this.paths];
  }

  filter(query: string): string[] {
    if (!query) return this.getAll();
    const lower = query.toLowerCase();
    return this.paths.filter((p) => p.toLowerCase().includes(lower));
  }

  add(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;

    // Remove if already present, then prepend
    this.paths = [trimmed, ...this.paths.filter((p) => p !== trimmed)].slice(0, this.max);
    this.save();
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

  private save(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.paths));
  }
}
