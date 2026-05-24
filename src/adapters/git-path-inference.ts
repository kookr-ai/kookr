import type { AgentEvent } from '../core/types.js';

const PATH_KEYS = new Set([
  'cwd',
  'file_path',
  'filePath',
  'path',
  'workdir',
  'workingDirectory',
]);

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`=:([{,])((?:\/[^\s"'`:;,|&<>(){}\[\]]+)+)/g;

/**
 * Infer the repository path an agent is actively touching from structured tool
 * payloads. Provider hook `cwd` is the process cwd; agents can still operate in
 * a sibling worktree via absolute file paths or command workdirs.
 */
export function inferGitInfoPathFromEvent(event: AgentEvent): string | null {
  const candidates: string[] = [];

  switch (event.type) {
    case 'tool_use':
      collectStructuredPaths(event.toolInput, candidates);
      collectCommandPaths(event.toolInput, candidates);
      break;
    case 'tool_result':
      collectStructuredPaths(event.toolResponse, candidates);
      break;
    case 'tool_error':
    case 'permission_request':
      collectStructuredPaths(event.toolInput, candidates);
      collectCommandPaths(event.toolInput, candidates);
      break;
  }

  return candidates.find(isUsableAbsolutePath) ?? null;
}

function collectStructuredPaths(value: unknown, out: string[], key?: string): void {
  if (typeof value === 'string') {
    if (key && PATH_KEYS.has(key) && value.startsWith('/')) out.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPaths(item, out, key);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectStructuredPaths(childValue, out, childKey);
  }
}

function collectCommandPaths(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const command = (value as { command?: unknown; cmd?: unknown }).command
    ?? (value as { command?: unknown; cmd?: unknown }).cmd;
  if (typeof command !== 'string') return;

  for (const match of command.matchAll(ABSOLUTE_PATH_RE)) {
    out.push(stripTrailingPunctuation(match[1]));
  }
}

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[.,]+$/, '');
}

function isUsableAbsolutePath(path: string): boolean {
  return path.startsWith('/') && path.length > 1;
}
