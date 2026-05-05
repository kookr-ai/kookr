import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { parsePlaybook, interpolateParameters } from '../../core/playbook-parser.js';
import { projectIdFromRepoSpecifier } from '../../core/project-identity.js';
import type { AgentType } from '../../core/agent-types.js';
import type { AutonomyLevel } from '../../core/tasks.js';
import type { LaunchOpts } from '../launch-service.js';
import { normalizePromptFileReferences } from '../prompt-file-paths.js';

export interface PreparePlaybookLaunchInput {
  cwd: string;
  playbookPath: string;
  parameterValues: Record<string, string>;
  autonomy?: AutonomyLevel;
  agentType?: AgentType;
}

export interface PreparedPlaybookLaunch {
  playbook: ReturnType<typeof parsePlaybook>;
  launchOpts: LaunchOpts;
}

export async function preparePlaybookLaunch(input: PreparePlaybookLaunchInput): Promise<LaunchOpts> {
  return (await preparePlaybookLaunchWithMetadata(input)).launchOpts;
}

export async function preparePlaybookLaunchWithMetadata(input: PreparePlaybookLaunchInput): Promise<PreparedPlaybookLaunch> {
  const playbooksDir = join(input.cwd, '.kookr', 'playbooks');
  const filePath = join(playbooksDir, input.playbookPath);
  if (!filePath.startsWith(playbooksDir + '/')) {
    throw new Error(`Invalid playbook path: ${input.playbookPath}`);
  }

  const content = await readFile(filePath, 'utf-8');
  const playbook = parsePlaybook(content, input.playbookPath, input.cwd);
  const criteria = playbook.checklist.length > 0
    ? playbook.checklist.map((item) => `- ${item}`).join('\n')
    : undefined;

  const effectiveCwd = playbook.cwd ?? input.cwd;
  if (effectiveCwd && !existsSync(effectiveCwd)) {
    throw new Error(
      `Playbook "${playbook.name}" requires working directory ${effectiveCwd} which does not exist. `
      + 'Clone or create it first.',
    );
  }
  const prompt = normalizePromptFileReferences(
    interpolateParameters(playbook.body, playbook.parameters, input.parameterValues),
    effectiveCwd,
  );

  // Derive project ID from the first parameter with source: tracked-projects
  // (e.g., repoFullName = "grafana/grafana" → projectId = "github.com/grafana/grafana")
  let projectId: string | undefined;
  for (const param of playbook.parameters) {
    if (param.source === 'tracked-projects') {
      const value = input.parameterValues[param.name];
      if (value) {
        projectId = projectIdFromRepoSpecifier(value) ?? undefined;
        break;
      }
    }
  }

  return {
    playbook,
    launchOpts: {
      prompt,
      cwd: effectiveCwd,
      criteria,
      name: playbook.name,
      playbookId: playbook.id,
      playbookParameterValues: input.parameterValues,
      autonomy: input.autonomy,
      agentType: input.agentType,
      projectId,
    },
  };
}
