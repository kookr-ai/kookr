/**
 * Parser for the `/task` bypass command (R18). Skips rephrase entirely.
 *
 * Forms:
 *   /task <prompt>            — only valid when there's exactly one allowed project
 *   /task@<name> <prompt>     — explicit project pick
 *
 * Returns a discriminated union so the caller doesn't need to re-grep prefixes.
 *
 * See `docs/rfc/rfc-remote-chat-trigger.md` §2 (R18) and round-3 boundary
 * "low-severity" cleanup for the dispatch extraction.
 */

import type { ProjectInfo } from './types.js';

export type ParsedTaskCommand =
  | { kind: 'spec'; prompt: string; project: ProjectInfo }
  | { kind: 'usage_error'; message: string };

export function parseTaskCommand(text: string, allowedProjects: ProjectInfo[]): ParsedTaskCommand {
  if (!text.startsWith('/task')) {
    return { kind: 'usage_error', message: 'parseTaskCommand called on non-/task message (caller bug)' };
  }

  // /task@<name> <prompt>
  if (text.startsWith('/task@')) {
    const m = text.match(/^\/task@(\S+)\s+([\s\S]+)$/);
    if (!m) {
      return { kind: 'usage_error', message: 'Usage: /task@<project> <prompt>' };
    }
    const name = m[1];
    const prompt = m[2].trim();
    if (!prompt) return { kind: 'usage_error', message: 'Empty prompt. Usage: /task@<project> <prompt>' };
    const project = allowedProjects.find((p) => p.name === name);
    if (!project) {
      const list = allowedProjects.map((p) => p.name).join(', ') || '(none configured)';
      return { kind: 'usage_error', message: `Unknown project: ${name}. Allowed: ${list}` };
    }
    return { kind: 'spec', prompt, project };
  }

  // /task <prompt>  — only valid for single-project setups
  if (text === '/task' || text === '/task ') {
    return { kind: 'usage_error', message: 'Usage: /task <prompt>  or  /task@<project> <prompt>' };
  }
  if (text.startsWith('/task ')) {
    const prompt = text.slice(6).trim();
    if (!prompt) {
      return { kind: 'usage_error', message: 'Empty prompt. Usage: /task <prompt>' };
    }
    if (allowedProjects.length === 0) {
      return { kind: 'usage_error', message: 'No projects configured (KOOKR_REMOTE_CHAT_PROJECTS).' };
    }
    if (allowedProjects.length > 1) {
      const list = allowedProjects.map((p) => p.name).join(', ');
      return { kind: 'usage_error', message: `Multiple projects allowed; use /task@<project> <prompt>. Allowed: ${list}` };
    }
    return { kind: 'spec', prompt, project: allowedProjects[0] };
  }

  // Anything else starting with /task (e.g. /tasks) is unrecognized.
  return { kind: 'usage_error', message: 'Unrecognized command. Usage: /task <prompt>  or  /task@<project> <prompt>' };
}
