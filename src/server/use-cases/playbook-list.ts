/**
 * Playbook-list use-case: discover playbooks for a cwd and, when some
 * discovered playbook gates a parameter on a launch dependency, probe that
 * dependency's presence on the Kookr server host.
 *
 * Probe orchestration lives here rather than in the WS handler so the
 * probe-trigger policy (R5: probe only when a gated parameter exists) is
 * unit-testable without a WebSocket layer.
 *
 * See `docs/rfc/rfc-capability-gated-playbook-params.md`.
 */
import type { LaunchDependency, Playbook } from '../../core/playbook.js';
import type { HostCapability } from '../../shared/contracts/messages.js';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { getProjectId } from '../../core/project-identity.js';
import { CAPABILITY_PROBES } from '../launch-capability-probe.js';
import { expandConfiguredCwd } from '../cwd-paths.js';

interface PlaybookListResult {
  playbooks: Playbook[];
  /** Omitted entirely when no discovered playbook gates a parameter. */
  capabilities?: Partial<Record<LaunchDependency, HostCapability>>;
}

/**
 * Discover playbooks for `cwd` and attach host-capability state for any
 * dependency a discovered parameter is `gatedBy`.
 *
 * The capability probes are resolve-only, so this never rejects because of a
 * probe. The only rejection source is `discoverPlaybooks`, whose failure
 * behavior is unchanged by capability gating.
 */
export async function preparePlaybookList(cwd: string): Promise<PlaybookListResult> {
  const playbooks = await discoverApplicablePlaybooks(cwd);

  // R5: probe only the dependencies that some discovered parameter gates on.
  const gatedDeps = new Set<LaunchDependency>();
  for (const playbook of playbooks) {
    for (const parameter of playbook.parameters) {
      if (parameter.gatedBy) gatedDeps.add(parameter.gatedBy);
    }
  }
  if (gatedDeps.size === 0) return { playbooks };

  const capabilities: Partial<Record<LaunchDependency, HostCapability>> = {};
  await Promise.all(
    [...gatedDeps].map(async (dependency) => {
      const status = await CAPABILITY_PROBES[dependency](cwd);
      // Omit on `undefined` (unknown) so the form fails open.
      if (status) capabilities[dependency] = status;
    }),
  );
  return { playbooks, capabilities };
}

/**
 * Discover the catalog entries that can execute in `cwd`'s repository.
 *
 * An unpinned playbook is portable and remains visible everywhere. A playbook
 * with frontmatter `cwd:` belongs to that cwd's repository, so showing it in a
 * different project is misleading: selecting it would silently replace the
 * project target. Repository identity (rather than path equality) keeps pins
 * visible across alternate checkouts and worktrees of the same repository.
 */
export async function discoverApplicablePlaybooks(cwd: string): Promise<Playbook[]> {
  const playbooks = await discoverPlaybooks(cwd);
  const pinnedCwds = new Set(
    playbooks.flatMap((playbook) => (
      playbook.cwd?.trim() ? [expandConfiguredCwd(playbook.cwd.trim())] : []
    )),
  );
  if (pinnedCwds.size === 0) return playbooks;

  const targetProjectId = await getProjectId(expandConfiguredCwd(cwd));
  const pinnedProjectIds = new Map(
    await Promise.all(
      [...pinnedCwds].map(async (pinnedCwd) => [pinnedCwd, await getProjectId(pinnedCwd)] as const),
    ),
  );

  return playbooks.filter((playbook) => {
    const pinnedCwd = playbook.cwd?.trim();
    if (!pinnedCwd) return true;
    return pinnedProjectIds.get(expandConfiguredCwd(pinnedCwd)) === targetProjectId;
  });
}
