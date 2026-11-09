/**
 * Session policy shared by every opencode launch mode (RFC #3541, S2a): which profile applies, the tool-permission
 * posture, and the AGENTS.md instructions (profile instructions plus its shelf lessons). Extracted unchanged from
 * `OpenCodeAdapter.prepareSession` so a container adapter composes the same policy as the TUI adapter.
 */
import type { OpenCodeProfile } from './opencode-kookr-hooks.js';
import { resolveOpenCodeProfile } from './opencode-profiles.js';
import { buildShelfLessonsSection, type ShelfShowRunner } from './opencode-shelf-memory.js';

export interface SessionPolicyDeps {
  profilesDir?: string;
  /** Constructor-level defaults. */
  defaultPermission: 'allow' | 'ask';
  defaultProfile?: OpenCodeProfile;
  env: NodeJS.ProcessEnv;
  shelfShow?: ShelfShowRunner;
  warn: (message: string) => void;
}

export interface SessionPolicyRequest {
  /** Explicit per-call profile id, else the id persisted on the task record. */
  profileId?: string;
  bypassPermissions?: boolean;
  extraEnv?: Record<string, string>;
}

export interface SessionPolicy {
  loaded?: OpenCodeProfile & { id: string };
  permission: 'allow' | 'ask';
  instructions?: string;
}

export async function resolveSessionPolicy(deps: SessionPolicyDeps, req: SessionPolicyRequest): Promise<SessionPolicy> {
  // Unknown id => typed OpenCodeProfileError from the resolver.
  const loaded = req.profileId ? resolveOpenCodeProfile(req.profileId, deps.profilesDir) : undefined;
  // Per-call bypass wins, then the profile's posture, then the constructor default.
  const permission = req.bypassPermissions !== undefined
    ? (req.bypassPermissions ? 'allow' : 'ask')
    : (loaded?.permission ?? deps.defaultPermission);
  let instructions = loaded?.instructions ?? deps.defaultProfile?.instructions;
  if (loaded?.shelves?.length) {
    // Profile-scoped memory: only THIS profile's shelves, read with the session's NB_DIR (fail-open).
    const lessons = await buildShelfLessonsSection(loaded.shelves, {
      env: { ...deps.env, ...(req.extraEnv ?? {}) },
      show: deps.shelfShow,
      warn: deps.warn,
    });
    if (lessons) instructions = `${instructions ?? ''}${instructions?.endsWith('\n') ? '\n' : '\n\n'}${lessons}`;
  }
  return { ...(loaded ? { loaded } : {}), permission, ...(instructions !== undefined ? { instructions } : {}) };
}
