// Type sidecar for bin/kookr-self-report.js so TypeScript tests can import its
// entry point without a // @ts-expect-error suppression. The runtime file is
// plain ESM JavaScript (no build step, no deps) — see bin/kookr-self-report.js.

export interface RunSelfReportCliOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  out?: (msg: string) => void;
  err?: (msg: string) => void;
}

/**
 * @returns process exit code: 0 recorded, 1 the server was unreachable or
 * refused the report, 2 bad usage or not running inside a Kookr session.
 */
export function runSelfReportCli(options?: RunSelfReportCliOptions): Promise<number>;
