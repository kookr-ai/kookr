import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parsePlaybook, interpolateParameters } from '../core/playbook-parser.js';
import { resolveSchedulePlaybookSync } from './schedule-validator.js';
import { expandConfiguredCwd } from './cwd-paths.js';
import { playbookScopeDir } from '../core/playbook-paths.js';
import type { PlaybookSourceIdentity } from '../shared/contracts/playbook.js';

/**
 * The playbook the idle-slot idea refinery (issue #2144) spawns: it picks ONE
 * open, human-sanctioned umbrella issue and files sized leaf issues that flow
 * through the normal vetting path. Shipped in the toolkit plugin tier.
 */
export const UMBRELLA_DECOMPOSE_PLAYBOOK_PATH = 'umbrella-decompose.md';

/** Launch inputs resolved from the umbrella-decompose playbook. */
export interface ResolvedRefineryLaunch {
  prompt: string;
  cwd: string;
  criteria?: string;
  name?: string;
  playbookId: string;
  playbookSource: PlaybookSourceIdentity;
  playbookParameterValues: Record<string, string>;
}

/**
 * Resolve the umbrella-decompose playbook (plugin tier) into launch inputs, or
 * `null` when it cannot be found/resolved in the plugin tier for `serverCwd`.
 *
 * Mirrors the resolution `ScheduleValidator.resolveLaunch` performs for a
 * scheduled playbook — same hardened path resolver, same frontmatter parse —
 * but for a fixed plugin-tier playbook with no operator parameters (the refinery
 * carries no per-launch config; the agent infers the target repo from the git
 * remote, as the repository-idea-scout playbook does).
 *
 * Returns `null` rather than throwing on a missing playbook so the runner can
 * skip quietly (and log once) instead of crashing its timer. A genuinely
 * malformed playbook body still throws {@link PlaybookParseError}.
 */
export async function resolveUmbrellaDecomposeLaunch(
  serverCwd: string,
): Promise<ResolvedRefineryLaunch | null> {
  if (!existsSync(serverCwd)) return null;
  const resolved = resolveSchedulePlaybookSync(UMBRELLA_DECOMPOSE_PLAYBOOK_PATH, 'plugin', serverCwd);
  if (!resolved) return null;

  const raw = await readFile(resolved.filePath, 'utf-8');
  const sourceCwd = playbookScopeDir('plugin', serverCwd) ?? serverCwd;
  const playbook = parsePlaybook(raw, UMBRELLA_DECOMPOSE_PLAYBOOK_PATH, sourceCwd, 'plugin');
  // No operator-supplied parameters: apply defaults only. A body with no
  // {{placeholders}} is returned unchanged.
  const playbookParameterValues = Object.fromEntries(
    playbook.parameters.flatMap((parameter) => (
      parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
    )),
  );
  const prompt = interpolateParameters(playbook.body, playbook.parameters, playbookParameterValues);
  const criteria = playbook.checklist.length > 0 ? playbook.checklist.join('\n') : undefined;
  const cwd = expandConfiguredCwd(playbook.cwd ?? serverCwd);

  return {
    prompt,
    cwd,
    ...(criteria ? { criteria } : {}),
    ...(playbook.name ? { name: playbook.name } : {}),
    playbookId: UMBRELLA_DECOMPOSE_PLAYBOOK_PATH,
    playbookSource: {
      id: UMBRELLA_DECOMPOSE_PLAYBOOK_PATH,
      scope: 'plugin',
      sourceCwd: playbook.sourceCwd,
      sourceDigest: playbook.sourceDigest,
    },
    playbookParameterValues,
  };
}
