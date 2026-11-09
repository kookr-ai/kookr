import type { A2aClientPort, A2aTaskState } from './ports.js';
import { PROBE_TIMEOUT_MS } from './read-model.js';

export interface ProbeTarget {
  endpoint: string;
  token: string;
}

export interface ProbeOutcome {
  ok: boolean;
  a2aState?: A2aTaskState;
  consecutiveMisses: number;
  at: Date;
}

/** Counts consecutive failed probes per container. A success resets the count; the read-model turns 3 into `unknown`. */
export class ContainerProber {
  private misses = new Map<string, number>();

  constructor(private readonly a2a: A2aClientPort, private readonly now: () => Date = () => new Date()) {}

  async probe(containerName: string, t: ProbeTarget): Promise<ProbeOutcome> {
    const at = this.now();
    try {
      await this.a2a.health(t.endpoint, PROBE_TIMEOUT_MS);
      const a2aState = await this.a2a.taskState(t.endpoint, t.token, PROBE_TIMEOUT_MS);
      this.misses.set(containerName, 0);
      return { ok: true, a2aState, consecutiveMisses: 0, at };
    } catch {
      const n = (this.misses.get(containerName) ?? 0) + 1;
      this.misses.set(containerName, n);
      return { ok: false, consecutiveMisses: n, at };
    }
  }

  forget(containerName: string): void {
    this.misses.delete(containerName);
  }
}
