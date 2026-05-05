/**
 * Shared types and Zod schemas for the Telegram remote-chat trigger.
 *
 * See `docs/rfc/rfc-remote-chat-trigger.md` for the design rationale.
 */

import { z } from 'zod';
import type { AgentType } from '../../core/agent-types.js';

export const AgentTypeSchema = z.enum(['claude-code', 'codex-cli']);

/**
 * Result of rephrasing a free-form Telegram message into a structured task
 * spec. The LLM emits one of:
 *   - a valid spec (cwd in the project allowlist, prompt in length range)
 *   - { ambiguous: "..." } if it can't infer which project the user means
 *
 * `agentType` is structured metadata so phrases like "use codex" do not need
 * to survive as prompt text. The launch-service trust boundary still gates
 * whether Codex remote-spawn is enabled.
 */
export const TaskSpecSchema = z
  .object({
    prompt: z.string().min(1).max(2000),
    cwd: z.string(),
    agentType: AgentTypeSchema.optional(),
    suggestedBranch: z
      .string()
      .regex(/^[a-zA-Z0-9_/-]{1,80}$/)
      .optional(),
    ambiguous: z.string().optional(),
  })
  .strict();

/**
 * Same shape as TaskSpecSchema but used for the /task bypass path —
 * the prompt is user-typed verbatim, not LLM-mediated. The validation is
 * the same length cap (round-3 V12 fix).
 */
export const TaskSpecBypassSchema = z
  .object({
    prompt: z.string().min(1).max(2000),
    cwd: z.string(),
    agentType: AgentTypeSchema.optional(),
  })
  .strict();

export interface ProjectInfo {
  /** Short label the user types after `/task@` — e.g., "kookr". */
  name: string;
  /** Absolute filesystem path. Used as the spawned task's cwd. */
  cwd: string;
}

/**
 * Validated task spec with `cwd` confirmed in the project allowlist and the
 * selected agent resolved. This is what the bus passes to launchTask.
 */
export interface ValidatedTaskSpec {
  prompt: string;
  cwd: string;
  agentType: AgentType;
  suggestedBranch?: string;
}
