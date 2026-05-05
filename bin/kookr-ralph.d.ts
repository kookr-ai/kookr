export const EXIT_OK: 0;
export const EXIT_USER_ERROR: 2;
export const EXIT_NO_SERVER: 3;
export const EXIT_SERVER_ERROR: 4;
export const HELP_TEXT: string;

export class UsageError extends Error {}

export function parsePortEnv(raw: string | undefined): { kind: 'unset' } | { kind: 'invalid'; raw: string } | { kind: 'valid'; port: number };
export function parseRalphArgs(argv: string[]): { help: true } | { help: false; command: 'status' | 'pause' | 'resume' | 'cancel'; taskId: string };
export function resolveBaseUrl(env?: Record<string, string | undefined>): Promise<
  | { kind: 'explicit'; baseUrl: string }
  | { kind: 'auto'; baseUrl: string; port: number }
  | { kind: 'invalid_port'; raw: string }
  | { kind: 'ambiguous'; ports: number[] }
  | { kind: 'none'; ports: number[] }
>;
export function requestRalphStatus(args: { baseUrl: string; taskId: string }): Promise<unknown>;
export function requestRalphControl(args: { baseUrl: string; command: 'pause' | 'resume' | 'cancel'; taskId: string }): Promise<unknown>;
export function renderRalphStatus(result: unknown): string;
export function renderRalphControl(result: unknown): string;
export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void };
  err?: { error: (msg: string) => void };
  exit?: (code: number) => never | void;
}): Promise<never | void>;
