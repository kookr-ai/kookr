export const SEMANTIC_CHECKPOINT_SCHEMA_VERSION = 'semantic-checkpoint.v1';
export const MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION = 'memory-write-candidates.v1';
export const CHECKPOINT_JSON_FILENAME = 'CHECKPOINT.json';
export const CHECKPOINT_MARKDOWN_FILENAME = 'CHECKPOINT.md';
export const MEMORY_WRITE_CANDIDATES_FILENAME = 'memory_write_candidates.json';

export type SemanticCheckpointVerdict = 'in_progress' | 'blocked' | 'stalled' | 'complete';

export type SemanticCheckpointInspection =
  | { kind: 'json'; jsonPath: string; markdownPath: string }
  | {
      kind: 'markdown';
      markdownPath: string;
      reason: 'json_missing' | 'json_invalid' | 'json_unreadable';
      warning?: string;
    }
  | {
      kind: 'none';
      reason: 'no_checkpoint_files' | 'checkpoint_dir_unreadable' | 'json_invalid' | 'json_unreadable';
      warning?: string;
    };

export type MemoryWriteCandidatesInspection =
  | { kind: 'valid'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string; warning: string };
