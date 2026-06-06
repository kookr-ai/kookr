import type { AgentEvent } from '../types.js';

let toolUseCounter = 0;

function nextToolUseId(): string {
  toolUseCounter += 1;
  return `toolu_${toolUseCounter}`;
}

export function resetAnomalyDetectorBuilderIds(): void {
  toolUseCounter = 0;
}

export class AnomalyEventSequenceBuilder {
  private readonly events: AgentEvent[] = [];

  constructor(private readonly sessionId = 's1') {}

  toolUse(
    toolName: string,
    toolInput?: unknown,
    toolUseId = nextToolUseId(),
  ): this {
    this.events.push({ type: 'tool_use', sessionId: this.sessionId, toolName, toolInput, toolUseId });
    return this;
  }

  toolResult(
    toolName: string,
    toolResponse?: unknown,
    toolUseId?: string,
  ): this {
    this.events.push({
      type: 'tool_result',
      sessionId: this.sessionId,
      toolName,
      toolResponse,
      toolUseId,
    });
    return this;
  }

  bashResult(command: string, toolResponse: unknown, toolUseId = nextToolUseId()): this {
    this.events.push({
      type: 'tool_use',
      sessionId: this.sessionId,
      toolName: 'Bash',
      toolInput: { command },
      toolUseId,
    });
    this.events.push({
      type: 'tool_result',
      sessionId: this.sessionId,
      toolName: 'Bash',
      toolResponse,
      toolUseId,
    });
    return this;
  }

  gitConflict(file = 'src/index.ts'): this {
    return this.bashResult(
      'git merge feature',
      `CONFLICT (content): Merge conflict in ${file}\nAutomatic merge failed; fix conflicts and then commit the result.`,
    );
  }

  error(message: string, count = 1): this {
    for (let i = 0; i < count; i += 1) {
      this.events.push({ type: 'error', sessionId: this.sessionId, message });
    }
    return this;
  }

  permissionRequest(toolName: string, toolInput?: unknown): this {
    this.events.push({ type: 'permission_request', sessionId: this.sessionId, toolName, toolInput });
    return this;
  }

  askUserQuestion(): this {
    return this.toolUse('AskUserQuestion');
  }

  stop(lastMessage = 'Waiting for input'): this {
    this.events.push({ type: 'stop', sessionId: this.sessionId, lastMessage });
    return this;
  }

  stopFailure(error: string, lastMessage = ''): this {
    this.events.push({ type: 'stop_failure', sessionId: this.sessionId, error, lastMessage });
    return this;
  }

  build(): AgentEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function eventSequence(sessionId?: string): AnomalyEventSequenceBuilder {
  return new AnomalyEventSequenceBuilder(sessionId);
}
