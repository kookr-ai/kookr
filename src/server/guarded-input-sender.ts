/**
 * Dialog-safe typing into a task's session, shared by server-side typists that are
 * not a human at the dashboard: supervision wakes and, from issue #4239, the
 * supervisor sentinel.
 *
 * It does exactly what `SupervisionService.deliver()` did: refuse up front when the
 * agent sits on a choice dialog, type through the adapter with a `beforeSubmit`
 * re-check, and map a vetoed Enter to a refusal. On top of that, a caller that
 * passes `source` gets one user-input delivery record per accepted line, so the
 * sentinel's own lines are visible (and told apart from the operator's) in the
 * delivery log. Supervision passes no `source` and records nothing, as before.
 */
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import {
  AgentInputRefusedError,
  asInputRefusal,
  guardChoiceDialog,
  type AwaitingChoiceProbe,
} from '../core/choice-dialog-guard.js';
import type { UserInputDeliverySource } from '../shared/contracts/user-input-delivery.js';

/** `sent`: the adapter accepted the line. `refused`: nothing submittable was typed. `failed`: ambiguous. */
export type GuardedSendOutcome =
  | { outcome: 'sent'; at: string }
  | { outcome: 'refused'; error: string }
  | { outcome: 'failed'; error: string };

/** One accepted line, for the user-input delivery log. */
export interface GuardedDeliveryRecord {
  sessionId: string;
  text: string;
  source: UserInputDeliverySource;
  at: string;
}

export interface GuardedInputSenderDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  isAwaitingChoice: AwaitingChoiceProbe | undefined;
  /** Writes the delivery log. Called only when the caller names a `source`. Errors are swallowed. */
  recordDelivery?: (record: GuardedDeliveryRecord) => void | Promise<void>;
  now?: () => Date;
}

export class GuardedInputSender {
  constructor(private readonly deps: GuardedInputSenderDeps) {}

  async send(sessionId: string, text: string, source?: UserInputDeliverySource): Promise<GuardedSendOutcome> {
    try {
      const opts = guardChoiceDialog(sessionId, this.deps.isAwaitingChoice);
      try {
        await (opts ? this.deps.adapter.sendInput(sessionId, text, opts) : this.deps.adapter.sendInput(sessionId, text));
      } catch (err) {
        throw asInputRefusal(err, sessionId);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A guard refusal definitely typed nothing submittable; any other error is ambiguous.
      return err instanceof AgentInputRefusedError ? { outcome: 'refused', error } : { outcome: 'failed', error };
    }
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    if (source !== undefined && this.deps.recordDelivery) {
      try {
        await this.deps.recordDelivery({ sessionId, text, source, at });
      } catch {
        // The line was typed; a lost log record must not turn it into a failed send.
      }
    }
    return { outcome: 'sent', at };
  }
}
