/**
 * Soft, once-per-session reminder: the first human-facing publish command
 * (`gh pr create`, `gh issue create`, control-room post-message, Discord
 * webhook, last-synthesis.md write) is denied with writing-review
 * instructions; a retry in the same session is allowed.
 *
 * Isolated Grok sessions (a managed process whose config root is a temporary
 * GROK_HOME, not the operator's ~/.grok) never load hooks from the distributed
 * toolkit plugin. This file is written next to the monitoring hooks at launch
 * so the reminder reaches that session without mutating ~/.grok.
 * Issues #2455 / #2461.
 */
import { resolveWritingReviewNudgePath } from '../../core/hook-writer-paths.js';
import { GROK_HOOK_TIMEOUT_SECONDS } from './monitoring-hooks.js';

export const GROK_WRITING_REVIEW_NUDGE_FILENAME = 'kookr-writing-review-nudge.json';

export interface GrokWritingReviewNudgeConfig {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

export function buildGrokWritingReviewNudgeConfig(opts?: {
  scriptPath?: string;
  timeoutSeconds?: number;
}): GrokWritingReviewNudgeConfig | null {
  const scriptPath = opts?.scriptPath ?? resolveWritingReviewNudgePath();
  if (!scriptPath) return null;
  const timeout = opts?.timeoutSeconds ?? GROK_HOOK_TIMEOUT_SECONDS;
  return {
    hooks: {
      PreToolUse: [
        {
          // POC-A's working deny hook used matcher "Bash" only. Grok aliases
          // that name to run_terminal_command; a `|` alternation is unproven.
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `/bin/bash ${shellQuote(scriptPath)}`,
              timeout,
            },
          ],
        },
      ],
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
