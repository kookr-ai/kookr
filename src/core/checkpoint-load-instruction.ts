import {
  CHECKPOINT_JSON_FILENAME,
  CHECKPOINT_MARKDOWN_FILENAME,
  MEMORY_WRITE_CANDIDATES_FILENAME,
  MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION,
  SEMANTIC_CHECKPOINT_SCHEMA_VERSION,
  type MemoryWriteCandidatesInspection,
  type SemanticCheckpointInspection,
} from './checkpoint-contracts.js';
import { inspectMemoryWriteCandidates, inspectSemanticCheckpoint } from './checkpoint-inspection.js';

function maybeWarn(inspection: SemanticCheckpointInspection): void {
  if ('warning' in inspection && inspection.warning) {
    console.warn(`[checkpoint] ${inspection.warning}; falling back without breaking launch.`);
  }
}

function maybeWarnMemoryCandidates(inspection: MemoryWriteCandidatesInspection): void {
  if (inspection.kind === 'invalid') {
    console.warn(`[checkpoint] ${inspection.warning}; preserving the file without automatic promotion.`);
  }
}

/**
 * Instruction injected into spawned agents so they read checkpoint state on
 * resume. The instruction stays short because it sits in the system prompt
 * (Claude Code) or prompt prefix (Codex CLI) of checkpoint-enabled launches.
 *
 * Empirically validated post-`/compact` survival of system-prompt content in
 * `docs/poc/005-checkpoint-cycle-mechanics.md` (the `magic word?` sentinel).
 */
export async function buildCheckpointLoadInstruction(checkpointDir?: string): Promise<string> {
  if (!checkpointDir) return CHECKPOINT_LOAD_INSTRUCTION;

  const inspection = await inspectSemanticCheckpoint(checkpointDir);
  const memoryCandidatesInspection = await inspectMemoryWriteCandidates(checkpointDir);
  maybeWarn(inspection);
  maybeWarnMemoryCandidates(memoryCandidatesInspection);

  const candidateProtocol =
    `${MEMORY_WRITE_CANDIDATES_FILENAME} is the optional review-only memory candidate sidecar using schema_version ` +
    `"${MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION}". It must contain candidates with target, evidence, verifier.status, ` +
    `approval.status, lifecycle, and promotion metadata. If present and valid, preserve it across checkpoint/resume; ` +
    `do not promote candidates into KB, wisdom, or skills automatically.`;
  const candidateStatus =
    memoryCandidatesInspection.kind === 'valid'
      ? `Valid ${MEMORY_WRITE_CANDIDATES_FILENAME} detected; preserve it across checkpoint/resume.`
      : memoryCandidatesInspection.kind === 'invalid'
        ? `${MEMORY_WRITE_CANDIDATES_FILENAME} is invalid. Warn that ${MEMORY_WRITE_CANDIDATES_FILENAME} was invalid, then continue without promoting candidates automatically.`
        : `High-risk tasks may write $TASK_CHECKPOINT_DIR/${MEMORY_WRITE_CANDIDATES_FILENAME} for review-only memory updates.`;
  const writeProtocol =
    `When a user message asks you to update checkpoints (Kookr sends this proactively before /compact), ` +
    `use the Write tool to refresh both $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} and ` +
    `$TASK_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME}. The JSON file must use ` +
    `${SEMANTIC_CHECKPOINT_SCHEMA_VERSION} with task_id, repo, worktree, branch, verdict, decisions, ` +
    `evidence, files_changed, tests_run, open_risks, next_actions, and memory_write_candidates. ` +
    `${candidateProtocol} ${candidateStatus}`;

  if (inspection.kind === 'json') {
    return `Kookr checkpoint protocol: valid ${CHECKPOINT_JSON_FILENAME} detected. Read $TASK_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} as your very first action in this session; it is the durable semantic state from previous tasks on the same branch. ${CHECKPOINT_MARKDOWN_FILENAME} remains the human-readable companion. ${writeProtocol} See the task-checkpointing skill for the full protocol.`;
  }

  if (inspection.kind === 'markdown') {
    if (inspection.reason === 'json_missing') {
      return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is not present. Read $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} as your very first action in this session; it carries durable state from previous tasks on the same branch. ${writeProtocol} See the task-checkpointing skill for the full protocol.`;
    }
    return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is invalid. Warn that ${CHECKPOINT_JSON_FILENAME} was invalid, then Read $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} as your very first action in this session; Markdown is the fail-open fallback. ${writeProtocol} See the task-checkpointing skill for the full protocol.`;
  }

  if (inspection.reason === 'json_invalid' || inspection.reason === 'json_unreadable') {
    return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is invalid and no ${CHECKPOINT_MARKDOWN_FILENAME} fallback is available. Warn that ${CHECKPOINT_JSON_FILENAME} was invalid, then continue without blocking launch. ${writeProtocol} See the task-checkpointing skill for the full protocol.`;
  }

  return `Kookr checkpoint protocol: if the TASK_CHECKPOINT_DIR environment variable is set, prefer $TASK_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} when it exists and validates as ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}; otherwise fall back to $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} when present. ${writeProtocol} See the task-checkpointing skill for the full protocol.`;
}

export const CHECKPOINT_LOAD_INSTRUCTION =
  `Kookr checkpoint protocol: if the TASK_CHECKPOINT_DIR environment variable is set, prefer $TASK_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} when it exists and validates as ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}; otherwise fall back to $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} when present. When a user message asks you to update checkpoints (Kookr sends this proactively before /compact), use the Write tool to refresh both $TASK_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} and $TASK_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME}, then continue. High-risk tasks may write $TASK_CHECKPOINT_DIR/${MEMORY_WRITE_CANDIDATES_FILENAME} using schema_version "${MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION}" with target, evidence, verifier.status, approval.status, lifecycle, and promotion metadata; preserve it across checkpoint/resume and do not promote candidates into KB, wisdom, or skills automatically. See the task-checkpointing skill for the full protocol.`;
