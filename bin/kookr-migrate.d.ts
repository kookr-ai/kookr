// Type sidecar for bin/kookr-migrate.js so TypeScript tests can import its
// helpers without a // @ts-expect-error suppression. The runtime file is plain
// ESM JavaScript (no build step) — see bin/kookr-migrate.js.

export const EXIT_OK: number;
export const EXIT_CANCELLED: number;
export const EXIT_USER_ERROR: number;
export const EXIT_NO_SERVER: number;
export const EXIT_SERVER_ERROR: number;
export const EXIT_ALL_BLOCKED: number;

export interface MigrateArgs {
  to: string | null;
  from: string | null;
  all: boolean;
  taskIds: string[];
  includeCancelled: boolean;
  setDefault: boolean;
  onlyIsolated: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  effort: string | null;
  help: boolean;
}

export interface MigrateConsole {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

export interface MigrateMainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdin?: unknown;
  out?: MigrateConsole;
  err?: MigrateConsole;
  exit?: (code: number) => number;
}

export function parseArgs(argv: string[]): MigrateArgs;
export function main(deps?: MigrateMainDeps): Promise<number>;
