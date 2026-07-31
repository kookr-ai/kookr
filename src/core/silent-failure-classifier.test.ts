import { describe, it, expect } from 'vitest';
import type { AgentEvent } from './agent-events.js';
import {
  MAX_PROVIDER_TRANSIENT_RETRIES,
  PROVIDER_TRANSIENT_RETRY_DELAY_MS,
  countToolCalls,
  extractFinalMessage,
  isSilentProviderFailure,
  matchesProviderError,
  planTerminalClassification,
} from './silent-failure-classifier.js';

const SID = 'sess-1';

function stop(lastMessage: string): AgentEvent {
  return { type: 'stop', sessionId: SID, lastMessage };
}

function toolUse(toolName = 'Bash'): AgentEvent {
  return { type: 'tool_use', sessionId: SID, toolName };
}

describe('matchesProviderError', () => {
  it('matches the incident string (529 Overloaded / API Error)', () => {
    expect(matchesProviderError('API Error: 529 Overloaded')).toBe(true);
    expect(matchesProviderError('Overloaded')).toBe(true);
    expect(matchesProviderError('529')).toBe(true);
  });

  it('matches 429 and other 5xx status codes', () => {
    expect(matchesProviderError('HTTP 429 Too Many Requests')).toBe(true);
    expect(matchesProviderError('got a 503 from the gateway')).toBe(true);
    expect(matchesProviderError('500 Internal Server Error')).toBe(true);
  });

  it('matches rate-limit and structured error-type phrasings', () => {
    expect(matchesProviderError('rate limit exceeded')).toBe(true);
    expect(matchesProviderError('rate_limit_error')).toBe(true);
    expect(matchesProviderError('overloaded_error')).toBe(true);
  });

  it('does NOT match ordinary prose or non-error numbers', () => {
    expect(matchesProviderError('Completed the refactor and opened a PR')).toBe(false);
    expect(matchesProviderError('Filed issue #1826 in the year 2026')).toBe(false);
    expect(matchesProviderError('Changed 529000 bytes across files')).toBe(false);
    expect(matchesProviderError('')).toBe(false);
    expect(matchesProviderError(undefined)).toBe(false);
  });
});

describe('countToolCalls', () => {
  it('counts tool_use and tool_error, ignores other events', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: SID },
      toolUse(),
      { type: 'tool_result', sessionId: SID, toolName: 'Bash' },
      { type: 'tool_error', sessionId: SID, toolName: 'Bash', error: 'boom', isInterrupt: false },
      stop('done'),
    ];
    expect(countToolCalls(events)).toBe(2);
  });

  it('is zero for a turn that only started and stopped', () => {
    expect(countToolCalls([{ type: 'session_start', sessionId: SID }, stop('x')])).toBe(0);
  });
});

describe('extractFinalMessage', () => {
  it('returns the last message-bearing terminal event', () => {
    const events: AgentEvent[] = [stop('first'), { type: 'user_prompt', sessionId: SID, prompt: 'go' }, stop('final')];
    expect(extractFinalMessage(events)).toBe('final');
  });

  it('falls back to a stop_failure error when no message', () => {
    const events: AgentEvent[] = [
      { type: 'stop_failure', sessionId: SID, error: 'API Error: 529 Overloaded', lastMessage: '' },
    ];
    expect(extractFinalMessage(events)).toBe('API Error: 529 Overloaded');
  });

  it('reads a subagent_stop lastMessage — the subagent-only incident shape', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: SID },
      { type: 'subagent_stop', sessionId: SID, agentId: 'sub-1', agentType: 'scout', lastMessage: 'API Error: 529 Overloaded' },
    ];
    expect(extractFinalMessage(events)).toBe('API Error: 529 Overloaded');
    expect(isSilentProviderFailure({ events })).toBe(true);
  });

  it('reads an error event message', () => {
    const events: AgentEvent[] = [{ type: 'error', sessionId: SID, message: 'rate limit exceeded' }];
    expect(extractFinalMessage(events)).toBe('rate limit exceeded');
  });
});

describe('isSilentProviderFailure', () => {
  it('true when zero tool calls and a provider-error final message', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: SID },
      stop('API Error: 529 Overloaded'),
    ];
    expect(isSilentProviderFailure({ events })).toBe(true);
  });

  it('false when the run made at least one tool call (no false positives)', () => {
    const events: AgentEvent[] = [toolUse(), stop('API Error: 529 Overloaded')];
    expect(isSilentProviderFailure({ events })).toBe(false);
  });

  it('false for a clean completion with no error text', () => {
    expect(isSilentProviderFailure({ events: [stop('Filed 3 issues, all green')] })).toBe(false);
  });

  it('false when session_start aged out of a truncated window (cannot prove zero tool calls)', () => {
    // A long run whose early tool_use events fell out of the bounded monitor
    // window: no session_start in-window, so a zero-tool-call count is not
    // authoritative and must not be reclassified even on a provider-error tail.
    const events: AgentEvent[] = [
      { type: 'user_prompt', sessionId: SID, prompt: 'continue' },
      stop('API Error: 529 Overloaded'),
    ];
    expect(isSilentProviderFailure({ events })).toBe(false);
  });
});

describe('planTerminalClassification', () => {
  const scheduleFire = (lastMessage: string): AgentEvent[] => [
    { type: 'session_start', sessionId: SID },
    stop(lastMessage),
  ];

  it('AC1: 0 tool calls + "529 Overloaded" on a schedule task → failed/provider_transient + retry scheduled', () => {
    const plan = planTerminalClassification({
      events: scheduleFire('API Error: 529 Overloaded'),
      provenanceKind: 'schedule',
      priorRetryAttempts: 0,
    });
    expect(plan.reclassifyToFailed).toBe(true);
    expect(plan.failureClass).toBe('provider_transient');
    expect(plan.matchedMessage).toBe('API Error: 529 Overloaded');
    expect(plan.toolCallCount).toBe(0);
    expect(plan.retry).toEqual({ schedule: true, attempt: 1, delayMs: PROVIDER_TRANSIENT_RETRY_DELAY_MS });
    expect(plan.exhausted).toBe(false);
  });

  it('AC2: second retry can still fire; after the cap it exhausts with no further retry', () => {
    const firstRetry = planTerminalClassification({
      events: scheduleFire('Overloaded'),
      provenanceKind: 'schedule',
      priorRetryAttempts: 1,
    });
    expect(firstRetry.retry).toEqual({ schedule: true, attempt: 2, delayMs: PROVIDER_TRANSIENT_RETRY_DELAY_MS });
    expect(firstRetry.exhausted).toBe(false);

    const exhausted = planTerminalClassification({
      events: scheduleFire('Overloaded'),
      provenanceKind: 'schedule',
      priorRetryAttempts: MAX_PROVIDER_TRANSIENT_RETRIES,
    });
    expect(exhausted.reclassifyToFailed).toBe(true);
    expect(exhausted.retry.schedule).toBe(false);
    expect(exhausted.exhausted).toBe(true);
  });

  it('AC3: ≥1 tool call with an error-mentioning final message is NOT reclassified', () => {
    const plan = planTerminalClassification({
      events: [toolUse(), toolUse('Edit'), stop('Hit a 500 mid-run but recovered and finished')],
      provenanceKind: 'schedule',
    });
    expect(plan.reclassifyToFailed).toBe(false);
    expect(plan.failureClass).toBeUndefined();
    expect(plan.retry.schedule).toBe(false);
    expect(plan.exhausted).toBe(false);
  });

  it('reclassifies a non-schedule task but never auto-retries or alerts', () => {
    const plan = planTerminalClassification({
      events: scheduleFire('API Error: 529 Overloaded'),
      provenanceKind: 'manual',
    });
    expect(plan.reclassifyToFailed).toBe(true);
    expect(plan.retry.schedule).toBe(false);
    expect(plan.exhausted).toBe(false);
  });

  it('a clean completion passes through untouched', () => {
    const plan = planTerminalClassification({
      events: [toolUse(), stop('Opened PR #1900, tests green')],
      provenanceKind: 'schedule',
    });
    expect(plan).toEqual({ reclassifyToFailed: false, toolCallCount: 1, retry: { schedule: false, attempt: 0, delayMs: 0 }, exhausted: false });
  });
});
