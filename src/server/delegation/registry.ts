import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isTerminalState, type Delegation } from './store.js';

/**
 * Worker and project registry for delegation (RFC sections 1, 4 and 10).
 *
 * Plain-language summary: the operator describes, in one JSON file, which Hermes
 * workers exist, where they listen, which token file proves who Kookr is to each,
 * which projects each worker may serve, and what the operator vouches for (the worker
 * is a leaf that cannot delegate onward, its workspace is read-only, and its reply
 * timeout). This module checks that description and chooses a worker for a new job.
 * Both functions that matter are pure (no I/O, no clock unless passed in), so the
 * rules are unit-tested as a table.
 *
 * Nothing here can verify the operator's attestations - Kookr cannot see inside a
 * container. What it CAN do is refuse the setups the RFC measured as dangerous: a
 * shared bearer token (so one compromised worker could impersonate another), the
 * well-known `hx.sh` default token, and worker URLs that point somewhere other than
 * this machine unless the operator explicitly allow-lists the host.
 */

/**
 * SHA-256 hashes of known weak or retired worker tokens (for example the shared default the
 * launcher used before per-agent tokens existed). Only hashes are stored, so no credential
 * value appears in this repository. A token whose hash is listed here is rejected.
 */
export const KNOWN_WEAK_TOKEN_HASHES: readonly string[] = [
  '7e4d3419b9a80288bdfd7fd9286e308205360e991ae21c134adfed25d09e24d4',
];

/** Seconds subtracted from a worker's reply timeout to get Kookr's own deadline. */
export const DEADLINE_MARGIN_SEC = 30;
const MIN_REPLY_TIMEOUT_SEC = 60;
const DEFAULT_REPLY_TIMEOUT_SEC = 300;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_MAX_DELEGATIONS = 8;
/** How long a job that ended `timed_out`/`cancelled`/`worker_failed` still counts as running. */
export const LEAK_GRACE_MS = 5 * 60_000;

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

const projectSchema = z.object({
  repoDir: z.string().min(1),
  githubRepo: z.string().regex(GITHUB_REPO_RE, 'githubRepo must look like "owner/name"'),
  /** Optional; otherwise detected from `origin/HEAD`, then `main`/`master`. */
  defaultBranch: z.string().min(1).optional(),
});

const workerSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'worker name must be letters, digits, "_" or "-"'),
  url: z.string().min(1),
  tokenFile: z.string().min(1),
  projects: z.array(z.string()).min(1),
  maxInFlight: z.number().int().min(1).max(32).default(DEFAULT_MAX_IN_FLIGHT),
  operatorAttestedLeaf: z.boolean().default(false),
  workspaceMode: z.string().default(''),
  replyTimeoutSec: z.number().int().min(MIN_REPLY_TIMEOUT_SEC).default(DEFAULT_REPLY_TIMEOUT_SEC),
});

export const delegationConfigSchema = z.object({
  snapshotsRoot: z.string().min(1),
  /** Where the worker sees `snapshotsRoot` (the container mount point). */
  containerSnapshotsPath: z.string().min(1).default('/opt/workspace'),
  projects: z.record(z.string(), projectSchema),
  workers: z.array(workerSchema).min(1),
  maxDelegations: z.number().int().min(1).max(256).default(DEFAULT_MAX_DELEGATIONS),
  /** Non-loopback hosts the operator explicitly allows as worker URLs. */
  allowedHosts: z.array(z.string()).default([]),
  maxTerminalRecords: z.number().int().min(10).max(5000).optional(),
  /** Ordered-disable switch (RFC section 6): false refuses new submissions only; default true. */
  acceptingNewDelegations: z.boolean().default(true),
  /** Extra SHA-256 hashes (hex) of tokens to refuse, added to the built-in denylist. */
  weakTokenHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).default([]),
});

export type DelegationConfig = z.infer<typeof delegationConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export interface RegistryIssue {
  code:
    | 'invalid_config'
    | 'duplicate_worker_name'
    | 'unknown_project'
    | 'invalid_project_id'
    | 'not_attested_leaf'
    | 'workspace_not_ro'
    | 'invalid_url'
    | 'url_host_not_allowed'
    | 'token_missing'
    | 'token_default'
    | 'token_duplicate';
  /** Worker the issue is about, when applicable. Never a token. */
  worker?: string;
  message: string;
}

export type ValidatedWorker = WorkerConfig & { workspaceMode: 'ro' };

export type RegistryValidation =
  | { ok: true; workers: ValidatedWorker[] }
  | { ok: false; issues: RegistryIssue[] };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** True for `localhost`, 127.0.0.0/8, and `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  return false;
}

/**
 * Pure token checks. `tokens` maps worker name to the token text read from its file
 * (undefined/empty = unreadable). Tokens are compared by SHA-256 hash, and issue
 * messages name workers only: neither a token nor a hash is ever printed.
 * Returns one issue per offending worker.
 */
export function checkWorkerTokens(
  workerNames: readonly string[],
  tokens: ReadonlyMap<string, string | undefined>,
  extraWeakTokenHashes: readonly string[] = [],
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const byHash = new Map<string, string[]>();
  const weakHashes = new Set([...KNOWN_WEAK_TOKEN_HASHES, ...(extraWeakTokenHashes ?? [])]);
  for (const name of workerNames) {
    const token = tokens.get(name)?.trim();
    if (!token) {
      issues.push({ code: 'token_missing', worker: name, message: `worker "${name}": token file is missing or empty` });
      continue;
    }
    const h = hashToken(token);
    if (weakHashes.has(h)) {
      issues.push({ code: 'token_default', worker: name, message: `worker "${name}": uses a known weak or retired token, which is refused` });
    }
    byHash.set(h, [...(byHash.get(h) ?? []), name]);
  }
  for (const names of byHash.values()) {
    if (names.length < 2) continue;
    for (const name of names) {
      issues.push({
        code: 'token_duplicate',
        worker: name,
        message: `worker "${name}": shares its token with ${names.filter((n) => n !== name).map((n) => `"${n}"`).join(', ')}; every worker needs a distinct token`,
      });
    }
  }
  return issues;
}

/**
 * Validate the parsed configuration plus the tokens already read from disk. Pure.
 * Collects every problem instead of stopping at the first, so the operator fixes the
 * file once.
 */
export function validateWorkerRegistry(
  config: DelegationConfig,
  tokens: ReadonlyMap<string, string | undefined>,
): RegistryValidation {
  const issues: RegistryIssue[] = [];
  const names = new Set<string>();
  const allowed = new Set(config.allowedHosts.map((h) => h.toLowerCase()));

  for (const id of Object.keys(config.projects)) {
    if (!PROJECT_ID_RE.test(id)) {
      issues.push({ code: 'invalid_project_id', message: `project id "${id}" must match ${PROJECT_ID_RE.source}` });
    }
  }

  for (const w of config.workers) {
    if (names.has(w.name)) {
      issues.push({ code: 'duplicate_worker_name', worker: w.name, message: `worker name "${w.name}" is used more than once` });
    }
    names.add(w.name);

    if (w.operatorAttestedLeaf !== true) {
      issues.push({ code: 'not_attested_leaf', worker: w.name, message: `worker "${w.name}": operatorAttestedLeaf must be true` });
    }
    if (w.workspaceMode !== 'ro') {
      issues.push({ code: 'workspace_not_ro', worker: w.name, message: `worker "${w.name}": workspaceMode must be "ro"` });
    }
    for (const p of w.projects) {
      if (!(p in config.projects)) {
        issues.push({ code: 'unknown_project', worker: w.name, message: `worker "${w.name}": project "${p}" is not defined under "projects"` });
      }
    }

    let url: URL | undefined;
    try {
      url = new URL(w.url);
    } catch {
      /* reported below */
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      issues.push({ code: 'invalid_url', worker: w.name, message: `worker "${w.name}": url must be a valid http(s) URL` });
    } else if (url.username || url.password) {
      issues.push({ code: 'invalid_url', worker: w.name, message: `worker "${w.name}": url must not embed credentials` });
    } else if (!isLoopbackHost(url.hostname) && !allowed.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())) {
      issues.push({
        code: 'url_host_not_allowed',
        worker: w.name,
        message: `worker "${w.name}": host "${url.hostname}" is not loopback and is not listed in allowedHosts`,
      });
    }
  }

  issues.push(...checkWorkerTokens(config.workers.map((w) => w.name), tokens, config.weakTokenHashes ?? []));

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, workers: config.workers.map((w) => ({ ...w, workspaceMode: 'ro' as const })) };
}

/** Parse + schema-check raw JSON text. Messages name fields, never values. */
export function parseDelegationConfig(
  raw: unknown,
): { ok: true; config: DelegationConfig } | { ok: false; issues: RegistryIssue[] } {
  const r = delegationConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      code: 'invalid_config' as const,
      message: `config field "${i.path.join('.') || '(root)'}": ${i.message}`,
    })),
  };
}

/** Read worker token files. A read failure becomes `undefined` (reported as token_missing). */
export async function readWorkerTokens(workers: readonly Pick<WorkerConfig, 'name' | 'tokenFile'>[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  await Promise.all(
    workers.map(async (w) => {
      try {
        out.set(w.name, (await readFile(w.tokenFile, 'utf-8')).replace(/[\r\n]+$/g, ''));
      } catch {
        out.set(w.name, undefined);
      }
    }),
  );
  return out;
}

/** Deadline for a job, relative to submission. `kindDefaultMs` is the kind's own ceiling. */
export function computeDeadlineMs(kindDefaultMs: number, replyTimeoutSec: number, marginSec = DEADLINE_MARGIN_SEC): number {
  return Math.min(kindDefaultMs, Math.max(1, replyTimeoutSec - marginSec) * 1000);
}

/**
 * Does this record still (possibly) occupy a slot on its worker? Non-terminal records
 * do. A job that ended `timed_out`, `cancelled` or `worker_failed` may still be
 * running on the worker (cancel and reply-timeout are bookkeeping only, measured), so
 * it keeps counting until its deadline plus a grace period has passed.
 */
export function occupiesWorker(r: Delegation, now: number, graceMs = LEAK_GRACE_MS): boolean {
  if (!isTerminalState(r.state)) return true;
  const leaked =
    r.state === 'timed_out' ||
    r.state === 'cancelled' ||
    (r.state === 'failed' && r.failureReason === 'worker_failed');
  return leaked && now < r.deadlineAt + graceMs;
}

export function inFlightCount(records: readonly Delegation[], workerName: string, now: number, graceMs = LEAK_GRACE_MS): number {
  return records.filter((r) => r.workerId === workerName && occupiesWorker(r, now, graceMs)).length;
}

export function totalInFlight(records: readonly Delegation[], now: number, graceMs = LEAK_GRACE_MS): number {
  return records.filter((r) => occupiesWorker(r, now, graceMs)).length;
}

export type PickResult =
  | { ok: true; worker: ValidatedWorker }
  | { ok: false; reason: 'pool_unavailable' | 'pool_busy' };

export interface PickOptions {
  now?: number;
  graceMs?: number;
  /** Workers to skip because they recently failed at the transport level (passive health). */
  unreachable?: ReadonlySet<string>;
  /** Workers to skip because their token failed validation on this read. */
  unusable?: ReadonlySet<string>;
}

/**
 * Choose the worker for a new job: it must serve the project, must not be marked
 * unreachable or unusable, and must have a free slot. Among the eligible, the one with
 * the fewest jobs in flight wins; ties go to the earlier entry in the config. `pool_unavailable`
 * means no usable worker serves the project at all, `pool_busy` means some do but all are full.
 */
export function pickWorker(
  records: readonly Delegation[],
  workers: readonly ValidatedWorker[],
  projectId: string,
  options: PickOptions = {},
): PickResult {
  const now = options.now ?? Date.now();
  const usable = workers.filter(
    (w) => w.projects.includes(projectId) && !options.unreachable?.has(w.name) && !options.unusable?.has(w.name),
  );
  if (usable.length === 0) return { ok: false, reason: 'pool_unavailable' };
  let best: { worker: ValidatedWorker; load: number } | undefined;
  for (const w of usable) {
    const load = inFlightCount(records, w.name, now, options.graceMs);
    if (load >= w.maxInFlight) continue;
    if (!best || load < best.load) best = { worker: w, load };
  }
  return best ? { ok: true, worker: best.worker } : { ok: false, reason: 'pool_busy' };
}
