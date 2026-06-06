// Type sidecar for bin/kookr.js so TypeScript tests can import the dispatcher.

export const HELP_TEXT: string;

export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  err?: { error: (msg: string) => void };
  exit?: (code: number) => never | void;
}

export function main(deps?: MainDeps): Promise<never | void>;
