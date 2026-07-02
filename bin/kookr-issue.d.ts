// Type sidecar for bin/kookr-issue.js. The runtime file is plain ESM
// JavaScript (same pattern as bin/kookr-signal.js) — see that file for
// the behavior contract. This sidecar exists so TypeScript tests in
// src/cli/ can import the helpers without // @ts-expect-error.

export const EXIT_CLAIM_HELD: 6;
export const HELP_TEXT: string;

export class UsageError extends Error {}

export type Verb = 'claim' | 'release' | 'owner' | 'list';

export interface ParsedArgs {
  verb: Verb | string | null;
  number: string | null;
  repo: string | null;
  force: boolean;
  taskId: string | null;
  json: boolean;
  help: boolean;
}

export interface ResolveTaskIdInputs {
  args: { taskId: string | null };
  env: Record<string, string | undefined>;
}

/**
 * Mirrors the server's decorated ClaimOwnerRecord
 * (src/core/issue-claim-types.ts + src/server/issue-claim-decorator.ts).
 */
export interface ClaimOwnerRecord {
  taskId?: string;
  sessionId?: string;
  ownerStatus?: string;
  ownerName?: string;
  worktreePath?: string;
  doing?: string | null;
  lastActivityAt?: string | null;
  ageMs?: number | null;
  repo?: string;
  number?: number;
  [k: string]: unknown;
}

export interface RequestJsonArgs {
  baseUrl: string;
  method: 'GET' | 'POST' | 'DELETE';
  query?: string;
  body?: unknown;
  timeoutMs?: number;
}

export interface RequestJsonResult {
  status: number;
  json: unknown;
  text: string;
}

export type AttemptOutcome =
  | { kind: 'invalid_port'; raw: string }
  | { kind: 'unreachable'; error?: string }
  | { kind: 'ok'; result: RequestJsonResult; baseUrl: string };

export interface WithRetriesArgs {
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  maxRetries: number;
  invoke: (baseUrl: string) => Promise<RequestJsonResult>;
}

export interface FormatOwnerBlockArgs {
  repo: string | null;
  number: number;
  owner: ClaimOwnerRecord;
}

export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  err?: { log: (msg: string) => void; error: (msg: string) => void };
  exit?: (code: number) => never | void;
  sleep?: (ms: number) => Promise<void>;
}

export function parseArgs(argv: string[]): ParsedArgs;
export function resolveTaskId(inputs: ResolveTaskIdInputs): string | null;
export function resolveSessionId(env: Record<string, string | undefined>): string | null;
export function parseIssueNumber(raw: string | null | undefined): number | null;
export function requestJson(args: RequestJsonArgs): Promise<RequestJsonResult>;
export function withRetries(args: WithRetriesArgs): Promise<AttemptOutcome>;
export function formatOwnerBlock(args: FormatOwnerBlockArgs): string;
export function formatClaimLine(claim: ClaimOwnerRecord): string;
export function humanizeMs(ms: number): string;
export function main(deps?: MainDeps): Promise<void>;
