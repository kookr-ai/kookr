// Type sidecar for bin/kookr-schedule.js. The runtime file is plain ESM
// JavaScript (same pattern as bin/kookr-issue.js) — see that file for the
// behavior contract. This sidecar exists so TypeScript tests in src/cli/ can
// import the helpers without // @ts-expect-error.

export const HELP_TEXT: string;

export class UsageError extends Error {}

export type Verb = 'list' | 'run' | 'enable' | 'disable';

export interface ParsedArgs {
  verb: Verb | string | null;
  id: string | null;
  json: boolean;
  help: boolean;
  /** Bulk-recovery selector for `enable` (issue #2520). */
  stopReason: string | null;
  /** Optional ISO watermark for bulk recovery (issue #2520). */
  heldBefore: string | null;
}

export interface RequestJsonArgs {
  baseUrl: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

export interface RequestJsonResult {
  status: number;
  json: unknown;
  text: string;
}

/** Mirrors the API's ScheduleResponse (src/core/schedule.ts) — partial. */
export interface ScheduleLike {
  id?: string;
  name?: string;
  enabled?: boolean;
  cron?: string;
  nextRunAt?: string | null;
  maxTriggers?: number;
  remainingTriggers?: number;
  [k: string]: unknown;
}

export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  err?: { log: (msg: string) => void; error: (msg: string) => void };
  exit?: (code: number) => never | void;
}

export function parseArgs(argv: string[]): ParsedArgs;
export function resolveId(raw: string | null | undefined): string | null;
export function requestJson(args: RequestJsonArgs): Promise<RequestJsonResult>;
export function formatScheduleLine(schedule: ScheduleLike): string;
export function main(deps?: MainDeps): Promise<void>;
