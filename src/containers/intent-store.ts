import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LaunchIntent {
  taskId: string;
  launchToken: string;
  instanceId: string;
  createdAt: string;
  closedAt?: string;
}

/** An intent older than this is treated as abandoned (the launch crashed), so it cannot protect a container forever. */
export const INTENT_MAX_OPEN_MS = 10 * 60_000;

const TOKEN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Durable "a launch is about to run docker" record, written before `docker run`. The reconciler never quarantines a
 * container whose launch token has an open (and not abandoned) intent, which closes the window where the container
 * exists but the task record does not yet say so.
 */
export class IntentStore {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private path(token: string): string {
    if (!TOKEN.test(token)) throw new Error(`invalid launch token ${JSON.stringify(token)}`);
    return join(this.dir, `${token}.json`);
  }

  private async write(intent: LaunchIntent): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(intent.launchToken);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(intent), { mode: 0o600 });
    await rename(tmp, file);
  }

  async open(taskId: string, launchToken: string, instanceId: string): Promise<void> {
    await this.write({ taskId, launchToken, instanceId, createdAt: this.now().toISOString() });
  }

  async close(launchToken: string): Promise<void> {
    const cur = await this.read(launchToken);
    if (!cur) return;
    await this.write({ ...cur, closedAt: this.now().toISOString() });
  }

  async read(launchToken: string): Promise<LaunchIntent | undefined> {
    try {
      return JSON.parse(await readFile(this.path(launchToken), 'utf8')) as LaunchIntent;
    } catch {
      return undefined;
    }
  }

  /** True while the launch is in flight: opened, not closed, and not older than {@link INTENT_MAX_OPEN_MS}. */
  async isOpen(launchToken: string): Promise<boolean> {
    const i = await this.read(launchToken);
    if (!i || i.closedAt) return false;
    return this.now().getTime() - Date.parse(i.createdAt) < INTENT_MAX_OPEN_MS;
  }

  /** Remove closed or abandoned intents older than `olderThanMs`. Only `<token>.json` files in this dir are touched. */
  async prune(olderThanMs: number): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const n of names) {
      if (!n.endsWith('.json') || !TOKEN.test(n.slice(0, -5))) continue;
      const i = await this.read(n.slice(0, -5));
      const age = i ? this.now().getTime() - Date.parse(i.closedAt ?? i.createdAt) : Infinity;
      if (age >= olderThanMs && !(await this.isOpen(n.slice(0, -5)))) {
        await rm(join(this.dir, n), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
