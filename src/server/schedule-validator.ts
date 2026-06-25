import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CreateScheduleInput, Schedule, UpdateScheduleDefinitionInput } from '../core/schedule.js';
import { ScheduleValidationError, isValidMaxTriggers } from '../core/schedule.js';
import { isPracticalCron, isValidCron } from '../core/cron.js';
import { parsePlaybook, interpolateParameters, PlaybookParseError } from '../core/playbook-parser.js';
import type { PlaybookScope } from '../core/playbook.js';
import { resolvePlaybookInScope } from '../core/playbook-paths.js';
import { projectIdFromRepoSpecifier } from '../core/project-identity.js';
import { expandConfiguredCwd } from './cwd-paths.js';

export interface ResolvedScheduleLaunch {
  prompt: string;
  cwd: string;
  criteria?: string;
  name: string;
  playbookId: string;
  projectId?: string;
}

export class ScheduleValidator {
  async validateCreate(input: CreateScheduleInput): Promise<void> {
    const fieldErrors: Record<string, string> = {};

    if (!input.name?.trim()) fieldErrors.name = 'Required';
    if (!input.cwd?.trim()) fieldErrors.cwd = 'Required';
    if (!input.playbook?.path) fieldErrors.playbook = 'Required';
    const cronError = validateCron(input.cron);
    if (cronError) fieldErrors.cron = cronError;
    if (input.maxTriggers !== undefined && !isValidMaxTriggers(input.maxTriggers)) {
      fieldErrors.maxTriggers = 'Must be a positive integer';
    }

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

  async validateDefinitionUpdate(existing: Schedule, patch: UpdateScheduleDefinitionInput): Promise<void> {
    if (patch.cron !== undefined) {
      const cronError = validateCron(patch.cron);
      if (cronError) {
        throw new ScheduleValidationError('Invalid schedule definition', { cron: cronError });
      }
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid schedule definition', { maxTriggers: 'Must be a positive integer' });
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
    const resolved = resolvePlaybookInScope(schedule.playbook.path, scope, schedule.cwd);
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
    const resolved = resolvePlaybookInScope(input.playbookPath, scope, input.cwd);
    if (!resolved) {
      fieldErrors.playbook = 'Playbook not found';
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
