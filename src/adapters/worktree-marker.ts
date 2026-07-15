import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROTECTED_MARKER,
  deriveParentRepoFromProtected,
  endsWithProtectedSuffix,
} from '../core/worktree-protection.js';

export {
  getWorktreeRemovalGuardReason,
  isPrimaryWorkingTree,
  isProtectedBranch,
  isRegisteredLinkedWorktree,
  looksLikeLinkedWorktree,
} from './worktree-safety.js';

export interface ProtectedMarker {
  reason: string;
  parentRepo: string | null;
}

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function markerPathFor(worktreePath: string): string {
  return join(stripTrailingSep(worktreePath), PROTECTED_MARKER);
}

/**
 * Server-authoritative protection check. A worktree is protected when the
 * `.kookr-protected` marker exists at its root — basename is no longer load-
 * bearing.
 */
export function isProtectedWorktreePath(worktreePath: string): boolean {
  return existsSync(markerPathFor(worktreePath));
}

/** Read the marker file. Returns null if absent, unreadable, or empty. */
export function readProtectedMarker(worktreePath: string): ProtectedMarker | null {
  let raw: string;
  try {
    raw = readFileSync(markerPathFor(worktreePath), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').map((l) => l.trimEnd());
  const reason = (lines.find((l) => l.length > 0) ?? '').trim();
  if (!reason) return null;
  let parentRepo: string | null = null;
  for (const line of lines) {
    const m = /^parentRepo:\s*(.+)$/.exec(line);
    if (m) {
      parentRepo = m[1].trim();
      break;
    }
  }
  return { reason, parentRepo };
}

/**
 * Resolve the parent repo path for a protected worktree. Prefers the marker's
 * `parentRepo:` field; falls back to the legacy `-prod` basename strip.
 */
export function resolveParentRepoFromMarker(worktreePath: string): string {
  const cleaned = stripTrailingSep(worktreePath);
  const marker = readProtectedMarker(cleaned);
  if (marker?.parentRepo) return marker.parentRepo;
  return deriveParentRepoFromProtected(cleaned);
}

/**
 * One-time idempotent migration. If the worktree path matches the legacy
 * `kookr-prod` basename convention and lacks a marker, write one with reason
 * `production runtime` and a `parentRepo:` line. Returns true when a marker
 * is newly written.
 */
export function migrateLegacyProtectedWorktree(worktreePath: string): boolean {
  const cleaned = stripTrailingSep(worktreePath);
  if (!endsWithProtectedSuffix(cleaned)) return false;
  const marker = markerPathFor(cleaned);
  if (existsSync(marker)) return false;
  if (!existsSync(cleaned)) return false;
  const parent = deriveParentRepoFromProtected(cleaned);
  writeFileSync(marker, `production runtime\nparentRepo: ${parent}\n`, 'utf8');
  return true;
}
