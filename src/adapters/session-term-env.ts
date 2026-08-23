/**
 * Interactive TERM for managed agent sessions.
 *
 * Production restarts can leave the Kookr server with `TERM=dumb`. Managed
 * agents inherit that environment through LocalDtachBackend, but Codex runs
 * inside a PTY and blocks on a confirmation prompt when TERM is dumb.
 */
export const DEFAULT_AGENT_TERM = 'xterm-256color';

/** True when TERM is missing, blank, or the non-interactive `dumb` type. */
export function isNonInteractiveTerm(term: string | undefined | null): boolean {
  if (term == null) return true;
  const normalized = term.trim();
  return normalized.length === 0 || normalized.toLowerCase() === 'dumb';
}

/** Ensure `env.TERM` is usable by interactive agent TUIs. */
export function ensureInteractiveTermEnv<T extends NodeJS.ProcessEnv | Record<string, string>>(
  env: T,
): T {
  if (isNonInteractiveTerm(env.TERM)) {
    (env as Record<string, string>).TERM = DEFAULT_AGENT_TERM;
  }
  return env;
}
