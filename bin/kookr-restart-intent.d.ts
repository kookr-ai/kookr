// Type sidecar for bin/kookr-restart-intent.js so TypeScript tests and CLIs can
// import its helpers without a // @ts-expect-error suppression. The runtime file
// is plain ESM JavaScript (no build step, no deps) — see bin/kookr-restart-intent.js.

export const RESTART_INTENT_SCHEMA_VERSION: 'restart-intent.v1';
export const RESTART_INTENT_FILENAME: 'restart-intent.json';
export const RESTART_INTENT_STALE_MS: number;
export const RESTART_INTENT_EXPIRY_MS: number;

export interface RestartIntent {
  schemaVersion: string | null;
  reason: string;
  startedAt: string;
  startedAtMs: number;
  token: string | null;
  initiator: string | null;
  pid: number | null;
  staleAfterMs: number | null;
  host: string | null;
}

export type RestartIntentState = 'none' | 'in-progress' | 'stale';

export interface RestartIntentClassification {
  state: RestartIntentState;
  ageMs: number;
}

export function resolveKookrDir(options?: {
  dir?: string | null;
  port?: string | number | null;
  env?: Record<string, string | undefined>;
}): string;

export function restartIntentPath(kookrDir: string): string;

export function writeRestartIntent(options: {
  kookrDir: string;
  reason?: string | null;
  initiator?: string | null;
  pid?: number | null;
  staleAfterMs?: number | null;
  token?: string | null;
  now?: number;
  host?: string | null;
}): {
  schemaVersion: string;
  reason: string;
  startedAt: string;
  token: string;
  initiator: string;
  pid: number | null;
  staleAfterMs: number | null;
  host: string | null;
};

export function clearRestartIntent(kookrDir: string, options?: { expectToken?: string | null }): void;
export function readRestartIntent(kookrDir: string): RestartIntent | null;

export function classifyRestartIntent(
  intent: RestartIntent | null,
  now?: number,
): RestartIntentClassification;

export function formatAge(ms: number): string;
export function describeRestartIntent(intent: RestartIntent | null, now?: number): string | null;
export function describeUnreachableCause(intent: RestartIntent | null, now?: number): string;

export interface RestartIntentJson {
  state: RestartIntentState;
  ageMs: number;
  reason: string | null;
  startedAt: string | null;
}

export function restartIntentJson(intent: RestartIntent | null, now?: number): RestartIntentJson;

export function readUnreachableCause(options?: {
  dir?: string | null;
  port?: string | number | null;
  env?: Record<string, string | undefined>;
  now?: number;
}): {
  kookrDir: string;
  intent: RestartIntent | null;
  classification: RestartIntentClassification;
  message: string;
};

export function firstRestartIntentAcrossPorts(
  ports: Array<string | number>,
  options?: { env?: Record<string, string | undefined> },
): { port: string | number; kookrDir: string; intent: RestartIntent } | null;

export function main(
  argv?: string[],
  deps?: { out?: { write: (s: string) => void }; err?: { write: (s: string) => void } },
): Promise<number>;
