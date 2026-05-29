// Type sidecar for bin/kookr-drain.js so TypeScript tests can import its
// helpers without a // @ts-expect-error suppression. The runtime file is plain
// ESM JavaScript (no build step, no deps) — see bin/kookr-drain.js.

export interface DrainStatusBody {
  accepting?: boolean;
  draining?: boolean;
  since?: string;
  runningTasks?: number;
  changed?: boolean;
}

export interface RunDrainCliDeps {
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  fetchImpl?: typeof fetch;
}

export function formatStatus(body: DrainStatusBody): string;
export function runDrainCli(argv: string[], deps?: RunDrainCliDeps): Promise<number>;
