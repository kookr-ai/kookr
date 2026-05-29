// Type sidecar for bin/kookr-spawn.js. The runtime file is plain ESM
// JavaScript (same pattern as bin/kookr-status.js) — see that file for
// the behavior contract. This sidecar exists so TypeScript tests in
// src/cli/ can import the helpers without // @ts-expect-error.

export const CLI_VERSION: string;
export const EXIT_OK: 0;
export const EXIT_USER_ERROR: 2;
export const EXIT_NO_SERVER: 3;
export const EXIT_SERVER_ERROR: 4;
export const EXIT_DUPLICATE_BLOCKED: 5;
export const HELP_TEXT: string;

export class UsageError extends Error {}

export interface ParsedArgs {
  prompt: string | null;
  positional: string[];
  cwd: string | null;
  agent: 'claude-code' | 'codex-cli' | null;
  effort: string | null;
  criteria: string | null;
  dedupe: 'warn' | 'block' | 'skip';
  promptFile: string | null;
  parentTaskId: string | null;
  noParentTask: boolean;
  help: boolean;
}

export interface ResolveParentTaskIdInputs {
  args: ParsedArgs;
  env: Record<string, string | undefined>;
}

export interface ResolvePromptInputs {
  args: ParsedArgs;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

export type PortEnvParse =
  | { kind: 'unset' }
  | { kind: 'valid'; port: number }
  | { kind: 'invalid'; raw: string };

export type BaseUrlResolution =
  | { kind: 'explicit'; baseUrl: string }
  | { kind: 'auto'; baseUrl: string; port: number }
  | { kind: 'ambiguous'; ports: number[] }
  | { kind: 'none'; ports: number[]; attempts: number }
  | { kind: 'invalid_port'; raw: string };

export interface ResolveBaseUrlDeps {
  env: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

export interface PostTaskArgs {
  baseUrl: string;
  prompt: string;
  cwd: string;
  agent: 'claude-code' | 'codex-cli' | null;
  effort?: string | null;
  criteria: string | null;
  disableDedup?: boolean;
  metadataIntent?: 'keep_as_duplicate' | null;
  parentTaskId?: string | null;
}

export interface TaskPayload {
  id?: string;
  agentType?: string;
  cwd?: string;
  queued?: boolean;
  [k: string]: unknown;
}

export type PostTaskResult =
  | { kind: 'created'; task: TaskPayload; queued: boolean }
  | { kind: 'duplicate'; task: TaskPayload }
  | { kind: 'server_error'; status: number; message: string };

export interface FormatSuccessArgs {
  task: TaskPayload;
  baseUrl: string;
  queued: boolean;
}

export interface FormatDedupArgs {
  task: TaskPayload;
  baseUrl: string;
}

export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd?: string;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  err?: { log: (msg: string) => void; error: (msg: string) => void };
  exit?: (code: number) => never | void;
  sleep?: (ms: number) => Promise<void>;
}

export function parseArgs(argv: string[]): ParsedArgs;
export function parseMaxBytes(raw: string | undefined): number;
export function parsePortEnv(raw: string | undefined): PortEnvParse;
export function parseRetries(raw: string | undefined): number;
export function resolvePrompt(inputs: ResolvePromptInputs): Promise<string>;
export function resolveCwd(explicit: string | null, pwd: string): string;
export function probeHealth(baseUrl: string, timeoutMs: number): Promise<boolean>;
export function resolveBaseUrl(deps: ResolveBaseUrlDeps): Promise<BaseUrlResolution>;
export function resolveParentTaskId(inputs: ResolveParentTaskIdInputs): string | null;
export function postTask(args: PostTaskArgs): Promise<PostTaskResult>;
export function formatSuccess(args: FormatSuccessArgs): string;
export function formatDedup(args: FormatDedupArgs): string;
export function main(deps?: MainDeps): Promise<void>;
