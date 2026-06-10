import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from '../launch-service.js';
import { preparePlaybookList } from '../use-cases/playbook-list.js';
import {
  preparePlaybookLaunchWithMetadata,
  type PreparedPlaybookLaunch,
} from '../use-cases/playbook-launch.js';
import { handleLaunchResult } from './launch-result.js';

/** Narrow dependency bag for playbook-family messages. */
export interface PlaybookHandlerDeps {
  send: (msg: ServerMessage) => void;
  launchTask?: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
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
        const { playbooks, capabilities } = await preparePlaybookList(msg.cwd);
        this.deps.send({ type: 'playbooks', cwd: msg.cwd, playbooks, capabilities });
        return { duplicate: false };
      }

      case 'launchPlaybook': {
        let prepared: PreparedPlaybookLaunch | undefined;
        let result: LaunchResult | undefined;
        let err: unknown;
        try {
          prepared = await preparePlaybookLaunchWithMetadata({
            cwd: msg.cwd,
            playbookSourceCwd: msg.playbookSourceCwd,
            taskTargetCwd: msg.taskTargetCwd,
            projectId: msg.projectId,
            playbookPath: msg.playbookPath,
            parameterValues: msg.parameterValues,
            agentType: msg.agentType,
            scope: msg.scope,
          });
          result = await this.deps.launchTask?.(prepared.launchOpts, { deliveryPolicy: prepared.deliveryPolicy });
        } catch (e) { err = e; }
        const excerpt = (prepared?.launchOpts.name ?? prepared?.launchOpts.prompt ?? msg.playbookPath).slice(0, 40);
        return handleLaunchResult(this.deps.send, excerpt, result, err);
      }
    }
  }
}
