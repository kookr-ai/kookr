import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreateScheduleInput, Schedule, UpdateScheduleDefinitionInput } from '../core/schedule.js';
import { ScheduleValidationError, isValidMaxTriggers } from '../core/schedule.js';
import { isValidCron } from '../core/cron.js';
import { parsePlaybook, interpolateParameters, PlaybookParseError } from '../core/playbook-parser.js';
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
    if (!isValidCron(input.cron)) fieldErrors.cron = 'Invalid cron expression';
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
    });
  }

  async validateDefinitionUpdate(existing: Schedule, patch: UpdateScheduleDefinitionInput): Promise<void> {
    if (patch.cron !== undefined && !isValidCron(patch.cron)) {
      throw new ScheduleValidationError('Invalid schedule definition', { cron: 'Invalid cron expression' });
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid schedule definition', { maxTriggers: 'Must be a positive integer' });
    }

    const effective = {
      cwd: patch.cwd ?? existing.cwd,
      playbookPath: patch.playbook?.path ?? existing.playbook.path,
      parameterValues: patch.playbook?.parameters ?? existing.playbook.parameters,
    };

    await this.validateDefinitionFields(effective);
  }

  async resolveLaunch(schedule: Schedule): Promise<ResolvedScheduleLaunch> {
    const playbookPath = join(schedule.cwd, '.kookr', 'playbooks', schedule.playbook.path);
    if (!existsSync(schedule.cwd)) {
      throw new ScheduleValidationError(`cwd does not exist: ${schedule.cwd}`, { cwd: 'Working directory does not exist' });
    }
    if (!existsSync(playbookPath)) {
      throw new ScheduleValidationError(`Playbook not found: ${schedule.playbook.path}`, { playbook: 'Playbook not found' });
    }

    try {
      const raw = await readFile(playbookPath, 'utf-8');
      const playbook = parsePlaybook(raw, schedule.playbook.path, schedule.cwd);
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
  }): Promise<void> {
    const fieldErrors: Record<string, string> = {};

    if (!existsSync(input.cwd)) {
      fieldErrors.cwd = 'Working directory does not exist';
    }

    const playbookPath = join(input.cwd, '.kookr', 'playbooks', input.playbookPath);
    if (!existsSync(playbookPath)) {
      fieldErrors.playbook = 'Playbook not found';
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new ScheduleValidationError('Invalid schedule definition', fieldErrors);
    }

    try {
      const raw = await readFile(playbookPath, 'utf-8');
      const playbook = parsePlaybook(raw, input.playbookPath, input.cwd);
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
