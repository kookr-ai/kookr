import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parsePlaybook, interpolateParameters } from '../../core/playbook-parser.js';
import { readEvolutionConfig } from '../../core/evolution-config.js';
import { userPlaybooksDir, pluginPlaybooksDir } from '../../core/playbook-discovery.js';
import { isPathInside } from '../../core/playbook-paths.js';
import { getProjectId, projectDisplayName, projectIdFromRepoSpecifier } from '../../core/project-identity.js';
import type { AgentSelection } from '../../core/agent-types.js';
import type { PlaybookParameter, PlaybookScope } from '../../core/playbook.js';
import type { Playbook } from '../../shared/contracts/playbook.js';
import { canonicalizeCwd } from '../cwd.js';
import type { LaunchOpts } from '../launch-service.js';
import type { DeliveryPolicy } from '../worktree-guardrails.js';
import { normalizePromptFileReferences } from '../prompt-file-paths.js';
import { expandConfiguredCwd } from '../cwd-paths.js';

export interface PreparePlaybookLaunchInput {
  /**
   * Legacy field. When split fields are omitted this is both catalog source
   * and execution target.
   */
  cwd?: string;
  /** CWD whose .kookr/playbooks directory supplies playbook definitions. */
  playbookSourceCwd?: string;
  /** CWD where the task should execute. */
  taskTargetCwd?: string;
  /**
   * Set by route adapters when taskTargetCwd was intentionally supplied.
   * Legacy `cwd` plus playbook frontmatter `cwd:` remains valid.
   */
  taskTargetCwdExplicit?: boolean;
  /** Explicit project identity requested by the launch surface. */
  projectId?: string;
  playbookPath: string;
  parameterValues: Record<string, string>;
  agentType?: AgentSelection;
  /** Where to read the playbook file from. Defaults to 'project' for back-compat. */
  scope?: PlaybookScope;
}

export interface NormalizedPlaybookLaunchInput extends PreparePlaybookLaunchInput {
  playbookSourceCwd: string;
  taskTargetCwd: string;
  taskTargetCwdExplicit: boolean;
}

export interface PreparedPlaybookLaunch {
  playbook: ReturnType<typeof parsePlaybook>;
  launchOpts: LaunchOpts;
  deliveryPolicy: DeliveryPolicy;
}

export async function preparePlaybookLaunch(input: PreparePlaybookLaunchInput): Promise<LaunchOpts> {
  return (await preparePlaybookLaunchWithMetadata(input)).launchOpts;
}

export async function preparePlaybookLaunchWithMetadata(input: PreparePlaybookLaunchInput): Promise<PreparedPlaybookLaunch> {
  const normalized = normalizePlaybookLaunchInput(input);
  const scope: PlaybookScope = input.scope ?? 'project';
  const playbooksDir = resolvePlaybooksDir(scope, normalized.playbookSourceCwd);
  if (playbooksDir === undefined) {
    throw new Error(`No playbooks directory available for scope "${scope}" — is the kookr-toolkit plugin installed?`);
  }
  const filePath = join(playbooksDir, input.playbookPath);
  if (!isPathInside(filePath, playbooksDir)) {
    throw new Error(`Invalid playbook path: ${input.playbookPath}`);
  }

  const content = await readFile(filePath, 'utf-8');
  // Non-project scopes use the playbooks dir itself as sourceCwd so that
  // per-scope param-snapshot keys (sourceCwd::id) stay stable across cwds.
  const sourceCwd = scope === 'project' ? normalized.playbookSourceCwd : playbooksDir;
  const playbook = parsePlaybook(content, input.playbookPath, sourceCwd, scope);
  const criteria = playbook.checklist.length > 0
    ? playbook.checklist.map((item) => `- ${item}`).join('\n')
    : undefined;

  const requestedTargetCwd = expandConfiguredCwd(normalized.taskTargetCwd);
  const playbookPinnedCwd = playbook.cwd ? expandConfiguredCwd(playbook.cwd) : undefined;
  if (
    playbookPinnedCwd
    && normalized.taskTargetCwdExplicit
    && canonicalizeCwd(playbookPinnedCwd) !== canonicalizeCwd(requestedTargetCwd)
  ) {
    throw new Error(
      `Playbook "${playbook.name}" pins working directory ${playbookPinnedCwd}; `
      + `cannot override with requested target ${requestedTargetCwd}.`,
    );
  }

  const effectiveCwd = playbookPinnedCwd ?? requestedTargetCwd;
  if (effectiveCwd && !existsSync(effectiveCwd)) {
    throw new Error(
      `Playbook "${playbook.name}" requires working directory ${effectiveCwd} which does not exist. `
      + 'Clone or create it first.',
    );
  }
  const parameterValues = await resolveParameterValuesFromLaunchContext(
    playbook.parameters,
    input.parameterValues,
    effectiveCwd,
  );
  await validatePlaybookLaunchCapabilities(playbook, parameterValues, effectiveCwd);

  const body = normalizePromptFileReferences(
    interpolateParameters(playbook.body, playbook.parameters, parameterValues),
    effectiveCwd,
  );
  const prompt = `${playbookContextHeader(playbook, filePath)}\n\n${body}`;

  // Derive project ID from the first parameter with source: tracked-projects.
  // Project-drawer launches can also send an explicit projectId. Accept it
  // only when it matches any tracked-project value and the target cwd.
  const parameterProjectId = projectIdFromTrackedProjectParam(playbook, parameterValues);
  const requestedProjectId = normalizeRequestedProjectId(input.projectId);
  let projectId = parameterProjectId;
  if (requestedProjectId) {
    if (parameterProjectId && requestedProjectId !== parameterProjectId) {
      throw new Error(`Requested projectId ${requestedProjectId} does not match tracked-project parameter ${parameterProjectId}.`);
    }
    const targetProjectId = await getProjectId(effectiveCwd);
    if (requestedProjectId !== targetProjectId) {
      throw new Error(`Requested projectId ${requestedProjectId} does not match target cwd project ${targetProjectId}.`);
    }
    projectId = requestedProjectId;
  }
  if (!projectId) {
    const repoFullName = parameterValues.repoFullName;
    if (repoFullName) {
      projectId = projectIdFromRepoSpecifier(repoFullName) ?? undefined;
    }
  }

  return {
    playbook,
    deliveryPolicy: playbook.deliveryPreAuthorized ? 'pre-authorized' : 'ask-first',
    launchOpts: {
      prompt,
      cwd: effectiveCwd,
      criteria,
      name: playbook.name,
      playbookId: playbook.id,
      playbookParameterValues: parameterValues,
      agentType: input.agentType,
      projectId,
      dependencies: playbook.dependencies,
      ...(playbook.autoCloseOnSignal === undefined ? {} : { autoCloseOnSignal: playbook.autoCloseOnSignal }),
    },
  };
}

/**
 * A short context note prepended to every playbook prompt so the coding agent
 * knows it is executing a playbook and where the definition lives. Without this
 * the agent has no way to tell it is running a playbook, and "modify this
 * playbook" would require blindly searching the playbook dirs.
 */
function playbookContextHeader(
  playbook: Pick<Playbook, 'name' | 'scope'>,
  filePath: string,
): string {
  // The name is author-controlled and lands inside markdown emphasis next to a
  // code span. A backtick or newline in it would close the span early and let
  // the playbook forge the rest of the header — including the definition path
  // the agent is told to edit.
  const name = playbook.name.replace(/[`\r\n]/g, '');
  return (
    `> _Kookr playbook context — you are executing the **${name}** playbook `
    + `(scope: ${playbook.scope}). Its definition file is at \`${filePath}\`. `
    + `If asked to modify this playbook, edit that file._`
  );
}

async function validatePlaybookLaunchCapabilities(
  playbook: ReturnType<typeof parsePlaybook>,
  parameterValues: Record<string, string>,
  effectiveCwd: string,
): Promise<void> {
  if (!playbook.parameters.some((parameter) => parameter.gatedBy === 'evolution-config')) {
    return;
  }
  const projectCwd = parameterValues.projectCwd?.trim() || effectiveCwd;
  const validation = await readEvolutionConfig(projectCwd);
  if (!validation.ok) {
    throw new Error(`Autonomous Evolution requires a valid .kookr/evolution/config.json. ${validation.error}`);
  }
}

function resolvePlaybooksDir(scope: PlaybookScope, projectCwd: string): string | undefined {
  switch (scope) {
    case 'project': return join(projectCwd, '.kookr', 'playbooks');
    case 'user':    return userPlaybooksDir();
    case 'plugin':  return pluginPlaybooksDir();
  }
}

export function normalizePlaybookLaunchInput(input: PreparePlaybookLaunchInput): NormalizedPlaybookLaunchInput {
  const legacyCwd = input.cwd?.trim();
  const rawSourceCwd = input.playbookSourceCwd?.trim() || legacyCwd;
  const rawTargetCwd = input.taskTargetCwd?.trim() || legacyCwd || rawSourceCwd;

  if (!rawSourceCwd) {
    throw new Error('playbookSourceCwd or cwd is required for playbook launches.');
  }
  if (!rawTargetCwd) {
    throw new Error('taskTargetCwd or cwd is required for playbook launches.');
  }

  const taskTargetCwdExplicit = input.taskTargetCwdExplicit
    ?? Boolean(input.taskTargetCwd?.trim());

  return {
    ...input,
    playbookSourceCwd: resolve(expandConfiguredCwd(rawSourceCwd)),
    taskTargetCwd: resolve(expandConfiguredCwd(rawTargetCwd)),
    taskTargetCwdExplicit,
  };
}

async function resolveParameterValuesFromLaunchContext(
  parameters: PlaybookParameter[],
  inputValues: Record<string, string>,
  cwd: string,
): Promise<Record<string, string>> {
  const values = { ...inputValues };
  let gitRemoteRepo: string | null | undefined;

  for (const param of parameters) {
    if (param.defaultFrom !== 'git-remote') continue;
    const currentValue = values[param.name]?.trim();
    if (currentValue) continue;

    gitRemoteRepo ??= await resolveGithubRepoFromCwd(cwd);
    if (gitRemoteRepo) {
      values[param.name] = gitRemoteRepo;
    }
  }

  return values;
}

async function resolveGithubRepoFromCwd(cwd: string): Promise<string | null> {
  const projectId = await getProjectId(cwd);
  if (!projectId.startsWith('github.com/')) return null;
  const displayName = projectDisplayName(projectId);
  return /^[^/\s]+\/[^/\s]+$/.test(displayName) ? displayName : null;
}

function projectIdFromTrackedProjectParam(
  playbook: ReturnType<typeof parsePlaybook>,
  parameterValues: Record<string, string>,
): string | undefined {
  for (const param of playbook.parameters) {
    if (param.source === 'tracked-projects') {
      const value = parameterValues[param.name];
      if (value) {
        return projectIdFromRepoSpecifier(value) ?? undefined;
      }
    }
  }
  return undefined;
}

function normalizeRequestedProjectId(projectId: string | undefined): string | undefined {
  const trimmed = projectId?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('local/')) return trimmed;
  return projectIdFromRepoSpecifier(trimmed) ?? trimmed.toLowerCase();
}
