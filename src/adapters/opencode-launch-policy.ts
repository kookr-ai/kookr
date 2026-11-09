/**
 * Launch-mode resolver (RFC #3541, S2a). A task launches opencode either in a host TUI (`tui`, today's only mode) or
 * in a worker container (`container`, wired in S2d behind `KOOKR_OPENCODE_CONTAINERS`).
 *
 * Rules the RFC fixes now so later slices cannot weaken them:
 *  - the mode is decided once and persisted on the task (`opencodeLaunchMode`); a relaunch honours the persisted mode;
 *  - there is NO silent fallback: a task persisted as `container` is never launched as `tui` (or vice versa) —
 *    when the requested mode is unavailable the resolver returns a refusal the caller must surface;
 *  - until S2d the container mode is unavailable, so the resolver answers `tui` for everything that has no
 *    persisted mode and refuses a persisted `container`.
 */
export type OpenCodeLaunchMode = 'tui' | 'container';

export type OpenCodeLaunchPolicy =
  | { ok: true; mode: OpenCodeLaunchMode }
  | { ok: false; code: 'container_unavailable'; message: string };

export interface ResolveLaunchModeInput {
  /** `opencodeLaunchMode` persisted on the task record, if any. */
  persisted?: string;
  /** Whether this build can launch containers. Always false before S2d. */
  containersAvailable?: boolean;
}

export function resolveOpenCodeLaunchMode(input: ResolveLaunchModeInput = {}): OpenCodeLaunchPolicy {
  const containersAvailable = input.containersAvailable ?? false;
  if (input.persisted === 'container') {
    return containersAvailable
      ? { ok: true, mode: 'container' }
      : {
          ok: false,
          code: 'container_unavailable',
          message: 'task was launched in container mode but container launches are not available; refusing to fall back to the host TUI',
        };
  }
  // Absent or unrecognised persisted values mean the historical default.
  return { ok: true, mode: 'tui' };
}
