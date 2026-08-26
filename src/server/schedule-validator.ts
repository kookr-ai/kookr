import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import type { CreateScheduleInput, Schedule, UpdateScheduleDefinitionInput } from '../core/schedule.js';
import { ScheduleValidationError, isValidMaxTriggers } from '../core/schedule.js';
import { isPracticalCron, isValidCron } from '../core/cron.js';
import { parsePlaybook, interpolateParameters, PlaybookParseError } from '../core/playbook-parser.js';
import type { PlaybookScope } from '../core/playbook.js';
import type { LaunchDependency } from '../shared/contracts/playbook.js';
import { isPathInside, playbookScopeDir, resolvePlaybookInScope } from '../core/playbook-paths.js';
import { projectIdFromRepoSpecifier } from '../core/project-identity.js';
import {
  DEFAULT_AGENT_TYPE,
  ROUND_ROBIN_AGENT_TYPE,
  isAgentType,
  isValidEffortForAgent,
  isValidModelForAgent,
  effortLevelsForAgent,
  modelsForAgent,
  ALL_EFFORT_LEVELS,
  type AgentSelection,
} from '../core/agent-types.js';
import { expandConfiguredCwd } from './cwd-paths.js';

export interface ResolvedScheduleLaunch {
  prompt: string;
  cwd: string;
  criteria?: string;
  name: string;
  playbookId: string;
  projectId?: string;
  dependencies?: LaunchDependency[];
}

const INVALID_PLAYBOOK_PATH_MESSAGE = 'Playbook path must stay inside the selected playbooks directory';

export class ScheduleValidator {
  async validateCreate(
    input: CreateScheduleInput,
    getDefaultAgentType?: () => AgentSelection,
  ): Promise<void> {
    const fieldErrors: Record<string, string> = {};

    if (!input.name?.trim()) fieldErrors.name = 'Required';
    if (!input.cwd?.trim()) fieldErrors.cwd = 'Required';
    if (!input.playbook?.path) fieldErrors.playbook = 'Required';
    const cronError = validateCron(input.cron);
    if (cronError) fieldErrors.cron = cronError;
    if (input.maxTriggers !== undefined && !isValidMaxTriggers(input.maxTriggers)) {
      fieldErrors.maxTriggers = 'Must be a positive integer';
    }

    // Effort/model pins are validated against the pin when present, else the
    // live server default (same agent the fire path will use).
    const agentType = input.agentType ?? getDefaultAgentType?.() ?? DEFAULT_AGENT_TYPE;
    Object.assign(fieldErrors, validateScheduleEffortModel(agentType, input.effort, input.model));

    if (Object.keys(fieldErrors).length > 0) {
      throw new ScheduleValidationError('Invalid schedule definition', fieldErrors);
    }

    await this.validateDefinitionFields({
      cwd: input.cwd,
      playbookPath: input.playbook.path,
      parameterValues: input.playbook.parameters,
      scope: input.playbook.scope,
    });
  }

  async validateDefinitionUpdate(
    existing: Schedule,
    patch: UpdateScheduleDefinitionInput,
    getDefaultAgentType?: () => AgentSelection,
  ): Promise<void> {
    if (patch.cron !== undefined) {
      const cronError = validateCron(patch.cron);
      if (cronError) {
        throw new ScheduleValidationError('Invalid schedule definition', { cron: cronError });
      }
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid schedule definition', { maxTriggers: 'Must be a positive integer' });
    }

    // null clears the pin → validate against the live default; omit keeps
    // the existing pin (or default when the schedule never pinned).
    const resolvedAgent =
      patch.agentType === null
        ? (getDefaultAgentType?.() ?? DEFAULT_AGENT_TYPE)
        : (patch.agentType ?? existing.agentType ?? getDefaultAgentType?.() ?? DEFAULT_AGENT_TYPE);
    const effort = patch.effort !== undefined ? patch.effort : existing.effort;
    const model = patch.model !== undefined ? patch.model : existing.model;
    const effortModelErrors = validateScheduleEffortModel(resolvedAgent, effort, model);
    if (Object.keys(effortModelErrors).length > 0) {
      throw new ScheduleValidationError('Invalid schedule definition', effortModelErrors);
    }

    // Agent / effort / model-only patches must not re-walk the playbook on disk.
    // Re-validating parameters blocks legitimate pin clears when a schedule
    // already carries legacy/unknown params (e.g. channelId) that fire-time
    // resolution tolerates. FS + parameter validation only when the launch
    // surface (cwd / playbook) is being changed.
    if (patch.cwd === undefined && patch.playbook === undefined) {
      return;
    }

    const effective = {
      cwd: patch.cwd ?? existing.cwd,
      playbookPath: patch.playbook?.path ?? existing.playbook.path,
      parameterValues: patch.playbook?.parameters ?? existing.playbook.parameters,
      // Resolve the same scope `resolveLaunch` would after the merge-carry
      // (R6 parity): an omitted scope falls back to the already-pinned one.
      scope: patch.playbook?.scope ?? existing.playbook.scope,
    };

    await this.validateDefinitionFields(effective);
  }

  async resolveLaunch(schedule: Schedule): Promise<ResolvedScheduleLaunch> {
    if (!existsSync(schedule.cwd)) {
      throw new ScheduleValidationError(`cwd does not exist: ${schedule.cwd}`, { cwd: 'Working directory does not exist' });
    }
    // R3: legacy schedules with no `scope` resolve project-tier only — no
    // probe, no cross-tier fallback. R5: re-resolve the tier *directory*
    // (plugin upgrades change the versioned path) but never the *tier*.
    const scope: PlaybookScope = schedule.playbook.scope ?? 'project';
    const resolved = await resolveSchedulePlaybook(schedule.playbook.path, scope, schedule.cwd);
    if (!resolved) {
      throw new ScheduleValidationError(
        `Playbook not found in ${scope} tier: ${schedule.playbook.path}`,
        { playbook: 'Playbook not found' },
      );
    }

    try {
      const raw = await readFile(resolved.filePath, 'utf-8');
      const playbook = parsePlaybook(raw, schedule.playbook.path, schedule.cwd, scope);
      const prompt = interpolateParameters(playbook.body, playbook.parameters, schedule.playbook.parameters);
      const criteria = playbook.checklist.length > 0
        ? playbook.checklist.join('\n')
        : undefined;
      const cwd = expandConfiguredCwd(playbook.cwd ?? schedule.cwd);

      if (!existsSync(cwd)) {
        throw new ScheduleValidationError(`cwd does not exist: ${cwd}`, { cwd: 'Working directory does not exist' });
      }

      // Derive project ID from tracked-projects parameter (same logic as playbook-launch.ts)
      let projectId: string | undefined;
      for (const param of playbook.parameters) {
        if (param.source === 'tracked-projects') {
          const value = schedule.playbook.parameters[param.name];
          if (value) {
            projectId = projectIdFromRepoSpecifier(value) ?? undefined;
            break;
          }
        }
      }

      return {
        prompt,
        cwd,
        criteria,
        name: playbook.name ?? schedule.name,
        playbookId: schedule.playbook.path,
        projectId,
        ...(playbook.dependencies ? { dependencies: [...playbook.dependencies] } : {}),
      };
    } catch (err) {
      if (err instanceof ScheduleValidationError) throw err;
      if (err instanceof PlaybookParseError) {
        throw new ScheduleValidationError(err.message, { playbook: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ScheduleValidationError(message);
    }
  }

  private async validateDefinitionFields(input: {
    cwd: string;
    playbookPath: string;
    parameterValues: Record<string, string>;
    scope?: PlaybookScope;
  }): Promise<void> {
    const fieldErrors: Record<string, string> = {};

    if (!existsSync(input.cwd)) {
      fieldErrors.cwd = 'Working directory does not exist';
    }

    // Use the same single-scope resolver as `resolveLaunch` (R6 parity),
    // defaulting an omitted scope to `project`. An unknown/unrecognised scope
    // resolves to `undefined` (treated as unresolvable) rather than throwing,
    // so a PR1 revert while a newer UI persists `scope` cannot wedge updates.
    const scope: PlaybookScope = input.scope ?? 'project';
    let resolved: { filePath: string } | undefined;
    try {
      resolved = await resolveSchedulePlaybook(input.playbookPath, scope, input.cwd);
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        fieldErrors.playbook = err.fieldErrors?.playbook ?? INVALID_PLAYBOOK_PATH_MESSAGE;
      } else {
        throw err;
      }
    }
    if (!resolved) {
      fieldErrors.playbook ??= 'Playbook not found';
    }

    if (!resolved || Object.keys(fieldErrors).length > 0) {
      throw new ScheduleValidationError('Invalid schedule definition', fieldErrors);
    }

    try {
      const raw = await readFile(resolved.filePath, 'utf-8');
      const playbook = parsePlaybook(raw, input.playbookPath, input.cwd, scope);
      const allowedNames = new Set(playbook.parameters.map((param) => param.name));
      const unknown = Object.keys(input.parameterValues).filter((key) => !allowedNames.has(key));
      if (unknown.length > 0) {
        throw new ScheduleValidationError('Invalid schedule definition', {
          parameters: `Unknown parameters: ${unknown.join(', ')}`,
        });
      }
      interpolateParameters(playbook.body, playbook.parameters, input.parameterValues);
    } catch (err) {
      if (err instanceof ScheduleValidationError) throw err;
      if (err instanceof PlaybookParseError) {
        throw new ScheduleValidationError('Invalid schedule definition', { playbook: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ScheduleValidationError('Invalid schedule definition', { parameters: message });
    }
  }
}

export function validateCron(cron: string): string | undefined {
  if (!isValidCron(cron)) return 'Invalid cron expression';
  if (!isPracticalCron(cron)) return 'Cron expression must not fire more often than every 5 minutes';
  return undefined;
}

/**
 * Validate optional schedule-level effort/model pins (#1518).
 *
 * For a concrete agent, use the agent-specific allowlists. For `round-robin`,
 * use the cross-agent union (authoritative check still runs at launch once a
 * concrete agent is resolved). Empty allowlists (codex/grok model) reject any
 * model pin with an explicit message rather than silently ignoring it.
 */
export function validateScheduleEffortModel(
  agentType: AgentSelection,
  effort: string | undefined,
  model: string | undefined,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  if (effort !== undefined) {
    if (typeof effort !== 'string' || effort.length === 0) {
      fieldErrors.effort = 'Must be a non-empty string';
    } else if (agentType === ROUND_ROBIN_AGENT_TYPE) {
      if (!ALL_EFFORT_LEVELS.includes(effort)) {
        fieldErrors.effort = `Must be one of: ${ALL_EFFORT_LEVELS.join(', ')}`;
      }
    } else if (isAgentType(agentType)) {
      if (!isValidEffortForAgent(agentType, effort)) {
        const levels = effortLevelsForAgent(agentType);
        fieldErrors.effort = levels.length === 0
          ? `Agent ${agentType} does not accept an effort pin`
          : `Must be one of: ${levels.join(', ')}`;
      }
    }
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || model.length === 0) {
      fieldErrors.model = 'Must be a non-empty string';
    } else if (agentType === ROUND_ROBIN_AGENT_TYPE) {
      // Model pins require a concrete agent so the allowlist is meaningful.
      fieldErrors.model = 'model requires a concrete agentType (not round-robin)';
    } else if (isAgentType(agentType)) {
      if (!isValidModelForAgent(agentType, model)) {
        const models = modelsForAgent(agentType);
        fieldErrors.model = models.length === 0
          ? `Agent ${agentType} does not accept a per-schedule model pin`
          : `Must be one of: ${models.join(', ')} (dated suffixes of those bases also accepted)`;
      }
    }
  }
  return fieldErrors;
}

async function resolveSchedulePlaybook(
  playbookPath: string,
  scope: PlaybookScope,
  cwd: string,
): Promise<{ filePath: string } | undefined> {
  validateSchedulePlaybookPath(playbookPath);

  const resolved = resolvePlaybookInScope(playbookPath, scope, cwd);
  if (!resolved) return undefined;

  const dir = playbookScopeDir(scope, cwd);
  if (dir === undefined) return undefined;

  const [realDir, realFilePath] = await Promise.all([
    realpath(dir),
    realpath(resolved.filePath),
  ]);
  if (!isPathInside(realFilePath, realDir)) {
    throw invalidPlaybookPathError();
  }

  return { filePath: realFilePath };
}

export function resolveSchedulePlaybookSync(
  playbookPath: string,
  scope: PlaybookScope,
  cwd: string,
): { filePath: string } | undefined {
  validateSchedulePlaybookPath(playbookPath);

  const resolved = resolvePlaybookInScope(playbookPath, scope, cwd);
  if (!resolved) return undefined;

  const dir = playbookScopeDir(scope, cwd);
  if (dir === undefined) return undefined;

  const realDir = realpathSync(dir);
  const realFilePath = realpathSync(resolved.filePath);
  if (!isPathInside(realFilePath, realDir)) {
    throw invalidPlaybookPathError();
  }

  return { filePath: realFilePath };
}

function validateSchedulePlaybookPath(playbookPath: string): void {
  if (
    isAbsolute(playbookPath)
    || win32.isAbsolute(playbookPath)
    || playbookPath.split(/[\\/]+/).includes('..')
  ) {
    throw invalidPlaybookPathError();
  }
}

function invalidPlaybookPathError(): ScheduleValidationError {
  return new ScheduleValidationError(INVALID_PLAYBOOK_PATH_MESSAGE, {
    playbook: INVALID_PLAYBOOK_PATH_MESSAGE,
  });
}
