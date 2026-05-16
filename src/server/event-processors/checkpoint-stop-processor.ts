import type { CheckpointCycler } from '../../core/checkpoint-cycler.js';
import { isCycleDisabled } from '../../core/checkpoint-cycler.js';

type StopCycler = Pick<CheckpointCycler, 'onStop'>;

interface AgentInputSender {
  sendInput(tmuxName: string, text: string): Promise<void>;
}

export interface CheckpointStopProcessorDeps {
  inputSender: AgentInputSender;
  checkpointCycler?: StopCycler;
}

export interface CheckpointStopProcessor {
  process(tmuxName: string): void;
}

export function createCheckpointStopProcessor({
  inputSender,
  checkpointCycler,
}: CheckpointStopProcessorDeps): CheckpointStopProcessor {
  return {
    process(tmuxName) {
      // v5 checkpoint cycle: advance state machine on Stop. The cycler returns
      // an action when it wants to send /compact (after the agent has finished
      // its checkpoint-write turn). Actions are dispatched via
      // `inputSender.sendInput` so that per-adapter input semantics (Codex CLI's
      // bracketed-paste handling, etc.) are honoured. Fail-open on send
      // errors — checkpointing never breaks the agent.
      if (!checkpointCycler || isCycleDisabled()) return;
      const action = checkpointCycler.onStop(tmuxName);
      if (action.kind === 'send_input' || action.kind === 'send_user_message') {
        const text = action.text;
        inputSender.sendInput(action.tmuxName, text).catch((err) => {
          console.error('[checkpoint-cycler] sendInput failed on Stop:', err);
        });
      }
    },
  };
}
