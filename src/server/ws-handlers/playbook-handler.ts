import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { preparePlaybookLaunchWithMetadata } from '../use-cases/playbook-launch.js';
import { handleLaunchResult } from './launch-result.js';

/** Narrow dependency bag for playbook-family messages. */
export interface PlaybookHandlerDeps {
  send: (msg: ServerMessage) => void;
  launchTask?: (opts: LaunchOpts) => Promise<LaunchResult>;
}

type PlaybookMessage = Extract<ClientMessage, { type: 'listPlaybooks' | 'launchPlaybook' }>;

/**
 * Handles the playbook family — listing and launching playbooks.
 *
 * Returns `{ duplicate }` from `handle(...)` so the dispatching router can
 * track whether the most recent launch was deduplicated.
 */
export class PlaybookHandler {
  constructor(private readonly deps: PlaybookHandlerDeps) {}

  async handle(msg: PlaybookMessage): Promise<{ duplicate: boolean }> {
    switch (msg.type) {
      case 'listPlaybooks': {
        const playbooks = await discoverPlaybooks(msg.cwd);
        this.deps.send({ type: 'playbooks', cwd: msg.cwd, playbooks });
        return { duplicate: false };
      }

      case 'launchPlaybook': {
        let opts: LaunchOpts | undefined;
        let result: LaunchResult | undefined;
        let err: unknown;
        try {
          const prepared = await preparePlaybookLaunchWithMetadata({
            cwd: msg.cwd,
            playbookPath: msg.playbookPath,
            parameterValues: msg.parameterValues,
            autonomy: msg.autonomy,
            agentType: msg.agentType,
          });
          opts = prepared.launchOpts;
          // Defense-in-depth: the launch dialog already suppresses the
          // checkbox when a playbook pins its own cwd:, but a misbehaving
          // or older client could still send `updateProjectLocalPath: true`.
          // Honor the flag only when the playbook does not pin a cwd —
          // otherwise we would write the playbook's hardcoded path as the
          // project's localPath, which is never what the user intended.
          if (msg.updateProjectLocalPath && !prepared.playbook.cwd) {
            opts = { ...opts, updateProjectLocalPath: true };
          }
          result = await this.deps.launchTask?.(opts);
        } catch (e) { err = e; }
        const excerpt = (opts?.name ?? opts?.prompt ?? msg.playbookPath).slice(0, 40);
        return handleLaunchResult(this.deps.send, excerpt, result, err);
      }
    }
  }
}
