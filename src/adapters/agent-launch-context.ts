import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TaskStore } from '../core/tasks.js';
import { ENTER_BYTES } from './keystroke.js';
import type { SessionId, TerminalBackend } from './terminal-backend.js';

const promptEncoder = new TextEncoder();
export const INITIAL_PROMPT_CHUNK_BYTES = 16 * 1024;

export interface AgentLaunchContext {
  env: Record<string, string>;
  permissionAllowlist: string[];
}

interface BuildAgentLaunchContextOptions {
  taskStore: TaskStore;
  taskId: string;
  cwd: string;
  serverPort?: number;
  /**
   * Pre-resolved per-task checkpoint directory. When provided, the launch
   * context exports `TASK_CHECKPOINT_DIR` and adds Read/Write/Bash entries
   * to the permission allowlist scoped to the directory tree.
   *
   * Resolution and pre-creation happen at the call site (server layer) where
   * `kookrDataDir` is in scope. See `src/core/checkpoint-path.ts`.
   * Always optional — the caller passes `undefined` on failure (fail-open).
   */
  checkpointDir?: string;
}

export async function buildAgentLaunchContext(
  opts: BuildAgentLaunchContextOptions,
): Promise<AgentLaunchContext> {
  const task = opts.taskStore.getTask(opts.taskId);
  const env: Record<string, string> = {
    KOOKR_TASK_ID: opts.taskId,
  };
  const permissionAllowlist = ['Bash(git *)'];

  if (task?.parentTaskId) {
    env.KOOKR_PARENT_TASK_ID = task.parentTaskId;
  }

  if (opts.serverPort) {
    env.KOOKR_PORT = String(opts.serverPort);
    env.KOOKR_API_BASE_URL = `http://127.0.0.1:${opts.serverPort}`;
    permissionAllowlist.push(
      'Bash(curl *KOOKR_API_BASE_URL*api/tasks*)',
      `Bash(curl *http://127.0.0.1:${opts.serverPort}/api/tasks*)`,
      `Bash(curl *http://localhost:${opts.serverPort}/api/tasks*)`,
    );
  }

  const gitCommonDir = await resolveGitCommonDir(opts.cwd);
  if (gitCommonDir) {
    env.KOOKR_GIT_COMMON_DIR = gitCommonDir;
    permissionAllowlist.push(
      `Read(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
      `Write(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
    );
  }

  if (opts.checkpointDir) {
    env.TASK_CHECKPOINT_DIR = opts.checkpointDir;
    permissionAllowlist.push(
      `Read(${toAbsolutePermissionPath(opts.checkpointDir)}/**)`,
      `Write(${toAbsolutePermissionPath(opts.checkpointDir)}/**)`,
      `Bash(${opts.checkpointDir}/repro.sh*)`,
    );
  }

  return { env, permissionAllowlist };
}

export async function deliverInitialPromptToSession(
  backend: TerminalBackend,
  sessionId: SessionId,
  prompt: string,
): Promise<void> {
  const promptBytes = promptEncoder.encode(prompt);
  const payloads: Uint8Array[] = [];
  for (let offset = 0; offset < promptBytes.length; offset += INITIAL_PROMPT_CHUNK_BYTES) {
    payloads.push(promptBytes.subarray(offset, offset + INITIAL_PROMPT_CHUNK_BYTES));
  }
  payloads.push(ENTER_BYTES);
  await backend.writeSequence(sessionId, payloads);
}

async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git');

  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }

  if (gitStat.isDirectory()) {
    return resolve(gitPath);
  }

  if (!gitStat.isFile()) {
    return null;
  }

  const content = await readFile(gitPath, 'utf-8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;

  return resolve(match[1].trim(), '..', '..');
}

function toAbsolutePermissionPath(path: string): string {
  return path.startsWith('/') ? `/${path}` : `//${path}`;
}
