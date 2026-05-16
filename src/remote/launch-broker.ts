import { DEFAULT_AGENT_TYPE, type AgentType } from '../shared/contracts/agent-types.js';
import {
  findLaunchAllowlistEntry,
  isLaunchAllowlistAgent,
  parseLaunchAllowlistJson,
  type LaunchAllowlistConfig,
  type LaunchAllowlistEntry,
} from './launch-allowlist.js';
import type { CommandEnvelope } from './command-journal.js';
import type { RemoteCommandHandler, ValidationResult } from './command-pipeline.js';
import type { KnownGrant } from './policy-sync.js';

export type RemoteLaunchErrorCode =
  | 'error.invalidRequest'
  | 'error.notOwner'
  | 'error.notAllowlisted'
  | 'error.concurrencyLimit'
  | 'error.launchFailed';

export type RemoteLaunchBrokerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteLaunchErrorCode; message: string };

function launchError(
  error: RemoteLaunchErrorCode,
  message: string,
): RemoteLaunchBrokerResult<never> {
  return { ok: false, error, message };
}

export interface RemoteLaunchRequest {
  type: 'launch';
  projectId: string;
  prompt: string;
  criteria?: string;
  agentType?: AgentType;
}

export interface RemoteLaunchResponse {
  taskId: string;
  queued: boolean;
  duplicate?: boolean;
}

export interface RemoteLaunchTaskOpts {
  prompt: string;
  cwd: string;
  criteria?: string;
  agentType: AgentType;
  projectId: string;
  disableDedup: boolean;
  launchSource: 'remote-relay';
}

export interface RemoteLaunchTaskResult {
  task: { id: string };
  queued: boolean;
  duplicate?: boolean;
}

export interface RemoteLaunchBrokerDeps {
  allowlist: LaunchAllowlistConfig;
  launchTask(opts: RemoteLaunchTaskOpts): Promise<RemoteLaunchTaskResult>;
  getActiveLaunchCount?: (scope: { projectId: string; agentType: AgentType }) => number;
  idempotencyTtlMs?: number;
  idempotencyMaxEntries?: number;
  allowCollaboratorGrants?: boolean;
}

export interface RemoteLaunchCommand extends CommandEnvelope {
  action: 'launch';
  grantsChecked: KnownGrant[];
  payload: RemoteLaunchRequest;
}

function commandKey(projectId: string, agentType: AgentType): string {
  return `${projectId}\0${agentType}`;
}

interface IdempotencyEntry {
  createdAt: number;
  result: Promise<RemoteLaunchBrokerResult<RemoteLaunchResponse>>;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1000;

function requestFingerprint(command: RemoteLaunchCommand, payload: RemoteLaunchRequest): string {
  return JSON.stringify({
    actorId: command.actorId,
    grantId: command.grantId,
    grantsChecked: [...command.grantsChecked].sort(),
    payload: {
      type: payload.type,
      projectId: payload.projectId.trim(),
      prompt: payload.prompt,
      criteria: payload.criteria,
      agentType: payload.agentType ?? DEFAULT_AGENT_TYPE,
    },
  });
}

function idempotencyKey(command: RemoteLaunchCommand, payload: RemoteLaunchRequest): string {
  return [
    command.nodeId,
    command.nodeEpoch,
    command.grantId,
    command.idempotencyKey,
    requestFingerprint(command, payload),
  ].join('\0');
}

function isLaunchRequest(value: unknown): value is RemoteLaunchRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const req = value as Partial<RemoteLaunchRequest>;
  return req.type === 'launch'
    && typeof req.projectId === 'string'
    && req.projectId.trim() !== ''
    && typeof req.prompt === 'string'
    && req.prompt.trim() !== ''
    && (req.criteria === undefined || typeof req.criteria === 'string')
    && (req.agentType === undefined || isLaunchAllowlistAgent(req.agentType));
}

export class RemoteLaunchBroker implements RemoteCommandHandler<RemoteLaunchCommand, RemoteLaunchResponse> {
  readonly action = 'launch' as const;

  private readonly deps: RemoteLaunchBrokerDeps;
  private readonly inFlight = new Map<string, number>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(deps: RemoteLaunchBrokerDeps) {
    this.deps = deps;
  }

  authorize(command: RemoteLaunchCommand): ValidationResult {
    if (command.actorId !== this.deps.allowlist.ownerId && !this.deps.allowCollaboratorGrants) {
      return { ok: false, reason: 'remote launch is restricted to the node owner' };
    }
    if (!command.grantsChecked.includes('launch') && !command.grantsChecked.includes('admin')) {
      return { ok: false, reason: 'remote command was not authorized for launch' };
    }
    return { ok: true };
  }

  validate(command: RemoteLaunchCommand): ValidationResult {
    if (!isLaunchRequest(command.payload)) {
      return { ok: false, reason: 'launch payload is malformed' };
    }
    const agentType = command.payload.agentType ?? DEFAULT_AGENT_TYPE;
    const projectId = command.payload.projectId.trim();
    if (!findLaunchAllowlistEntry(this.deps.allowlist, projectId, agentType)) {
      return { ok: false, reason: 'project and agent are not allowlisted for remote launch' };
    }
    return { ok: true };
  }

  async execute(command: RemoteLaunchCommand): Promise<RemoteLaunchResponse> {
    const result = await this.executeLaunch(command.payload);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  async handle(command: RemoteLaunchCommand): Promise<RemoteLaunchBrokerResult<RemoteLaunchResponse>> {
    if (command.actorId !== this.deps.allowlist.ownerId && !this.deps.allowCollaboratorGrants) {
      return launchError('error.notOwner', 'remote launch is restricted to the node owner');
    }
    if (!command.grantsChecked.includes('launch') && !command.grantsChecked.includes('admin')) {
      return launchError('error.notAllowlisted', 'remote command was not authorized for launch');
    }
    const validation = this.validate(command);
    if (!validation.ok) {
      return launchError(
        validation.reason.includes('allowlisted') ? 'error.notAllowlisted' : 'error.invalidRequest',
        validation.reason,
      );
    }

    this.pruneIdempotency();
    const key = idempotencyKey(command, command.payload);
    const existing = this.idempotency.get(key);
    if (existing) return existing.result;

    const pending = this.executeLaunch(command.payload);
    this.rememberIdempotency(key, pending);
    return pending;
  }

  private async executeLaunch(
    payload: RemoteLaunchRequest,
  ): Promise<RemoteLaunchBrokerResult<RemoteLaunchResponse>> {
    const agentType = payload.agentType ?? DEFAULT_AGENT_TYPE;
    const projectId = payload.projectId.trim();
    const entry = findLaunchAllowlistEntry(this.deps.allowlist, projectId, agentType);
    if (!entry) {
      return launchError('error.notAllowlisted', 'project and agent are not allowlisted for remote launch');
    }

    const reserved = this.reserve(entry, agentType);
    if (!reserved.ok) return reserved;

    try {
      const result = await this.deps.launchTask({
        prompt: payload.prompt,
        cwd: entry.cwd,
        criteria: payload.criteria,
        agentType,
        projectId,
        disableDedup: false,
        launchSource: 'remote-relay',
      });
      return {
        ok: true,
        value: {
          taskId: result.task.id,
          queued: result.queued,
          duplicate: result.duplicate,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return launchError('error.launchFailed', message);
    } finally {
      this.release(entry.projectId, agentType);
    }
  }

  private rememberIdempotency(
    key: string,
    result: Promise<RemoteLaunchBrokerResult<RemoteLaunchResponse>>,
  ): void {
    this.idempotency.set(key, { createdAt: Date.now(), result });
    const maxEntries = this.deps.idempotencyMaxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES;
    while (this.idempotency.size > maxEntries) {
      const oldest = this.idempotency.keys().next().value as string | undefined;
      if (!oldest) break;
      this.idempotency.delete(oldest);
    }
  }

  private pruneIdempotency(now = Date.now()): void {
    const ttlMs = this.deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.idempotency) {
      if (now - entry.createdAt > ttlMs) {
        this.idempotency.delete(key);
      }
    }
  }

  private reserve(entry: LaunchAllowlistEntry, agentType: AgentType): RemoteLaunchBrokerResult<void> {
    const key = commandKey(entry.projectId, agentType);
    const inFlight = this.inFlight.get(key) ?? 0;
    const active = this.deps.getActiveLaunchCount?.({ projectId: entry.projectId, agentType }) ?? 0;
    if (active + inFlight >= entry.maxConcurrent) {
      return launchError('error.concurrencyLimit', 'remote launch concurrency cap reached');
    }
    this.inFlight.set(key, inFlight + 1);
    return { ok: true, value: undefined };
  }

  private release(projectId: string, agentType: AgentType): void {
    const key = commandKey(projectId, agentType);
    const current = this.inFlight.get(key) ?? 0;
    if (current <= 1) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, current - 1);
    }
  }
}

export function remoteLaunchFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.KOOKR_RELAY_URL?.trim()) return false;
  return (env.KOOKR_RELAY_FEATURES ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .includes('launch');
}

export function createRemoteLaunchBrokerFromEnv(
  deps: Omit<RemoteLaunchBrokerDeps, 'allowlist'>,
  env: NodeJS.ProcessEnv = process.env,
): RemoteLaunchBroker {
  const raw = env.KOOKR_RELAY_LAUNCH_ALLOWLIST ?? '';
  const parsed = raw ? parseLaunchAllowlistJson(raw) : { ok: false as const, error: 'KOOKR_RELAY_LAUNCH_ALLOWLIST is unset' };
  if (!parsed.ok) {
    throw new Error(`invalid remote launch allowlist: ${parsed.error}`);
  }
  return new RemoteLaunchBroker({ ...deps, allowlist: parsed.config });
}
