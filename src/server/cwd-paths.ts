/**
 * Expand portable CWD spellings used in playbook metadata into concrete paths.
 * This is intentionally narrow: it supports the forms documented in bundled
 * playbooks without turning CWD fields into a general shell expansion surface.
 */
export function expandConfiguredCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  if (!home) return cwd;

  if (cwd === '~' || cwd === '$HOME' || cwd === '${HOME}') {
    return home;
  }
  if (cwd.startsWith('~/')) {
    return `${home}${cwd.slice(1)}`;
  }
  if (cwd.startsWith('$HOME/')) {
    return `${home}${cwd.slice('$HOME'.length)}`;
  }
  if (cwd.startsWith('${HOME}/')) {
    return `${home}${cwd.slice('${HOME}'.length)}`;
  }

  return cwd;
}
