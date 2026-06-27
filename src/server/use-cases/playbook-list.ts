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
import { CAPABILITY_PROBES } from '../launch-capability-probe.js';

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
  const playbooks = await discoverPlaybooks(cwd);

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
