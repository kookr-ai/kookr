import { isAbsolute } from 'node:path';

import { AVAILABLE_AGENT_TYPES, type AgentType } from '../shared/contracts/agent-types.js';

const AGENT_TYPES = new Set<AgentType>(AVAILABLE_AGENT_TYPES.map((agent) => agent.type));

export interface LaunchAllowlistEntry {
  projectId: string;
  cwd: string;
  agents: AgentType[];
  maxConcurrent: number;
}

export interface LaunchAllowlistConfig {
  version: 1;
  ownerId: string;
  projects: LaunchAllowlistEntry[];
}

export type LaunchAllowlistParseResult =
  | { ok: true; config: LaunchAllowlistConfig }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLaunchAllowlistAgent(value: unknown): value is AgentType {
  return typeof value === 'string' && AGENT_TYPES.has(value as AgentType);
}

function parseAgent(value: unknown): AgentType | null {
  return isLaunchAllowlistAgent(value)
    ? value as AgentType
    : null;
}

export function parseLaunchAllowlist(value: unknown): LaunchAllowlistParseResult {
  if (!isRecord(value)) return { ok: false, error: 'allowlist must be an object' };
  if (value.version !== 1) return { ok: false, error: 'allowlist version must be 1' };
  if (typeof value.ownerId !== 'string' || value.ownerId.trim() === '') {
    return { ok: false, error: 'allowlist ownerId must be a non-empty string' };
  }
  if (!Array.isArray(value.projects)) {
    return { ok: false, error: 'allowlist projects must be an array' };
  }

  const projects: LaunchAllowlistEntry[] = [];
  for (const [idx, rawProject] of value.projects.entries()) {
    if (!isRecord(rawProject)) return { ok: false, error: `projects[${idx}] must be an object` };
    const { projectId, cwd, agents, maxConcurrent } = rawProject;
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      return { ok: false, error: `projects[${idx}].projectId must be a non-empty string` };
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      return { ok: false, error: `projects[${idx}].cwd must be an absolute path` };
    }
    if (!Array.isArray(agents) || agents.length === 0) {
      return { ok: false, error: `projects[${idx}].agents must be a non-empty array` };
    }
    const parsedAgents = agents.map(parseAgent);
    const invalidAgent = parsedAgents.findIndex((agent) => agent === null);
    if (invalidAgent !== -1) {
      return { ok: false, error: `projects[${idx}].agents[${invalidAgent}] is not supported` };
    }
    if (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
      return { ok: false, error: `projects[${idx}].maxConcurrent must be a positive integer` };
    }
    projects.push({
      projectId: projectId.trim(),
      cwd,
      agents: [...new Set(parsedAgents as AgentType[])],
      maxConcurrent: maxConcurrent as number,
    });
  }

  return {
    ok: true,
    config: {
      version: 1,
      ownerId: value.ownerId.trim(),
      projects,
    },
  };
}

export function parseLaunchAllowlistJson(raw: string): LaunchAllowlistParseResult {
  try {
    return parseLaunchAllowlist(JSON.parse(raw));
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function findLaunchAllowlistEntry(
  config: LaunchAllowlistConfig,
  projectId: string,
  agentType: AgentType,
): LaunchAllowlistEntry | null {
  return config.projects.find((project) => (
    project.projectId === projectId && project.agents.includes(agentType)
  )) ?? null;
}
