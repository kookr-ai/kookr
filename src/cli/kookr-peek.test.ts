import { describe, expect, it } from 'vitest';

import type { TranscriptMessage } from '../shared/contracts/transcript.js';
import {
  capKeepingTail,
  deriveRunState,
  extractLastMessageView,
  parsePeekArgs,
  PEEK_HELP_TEXT,
  runPeekCli,
} from './kookr-peek.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (m: unknown) => logs.push(String(m)) },
    err: { error: (m: unknown) => errors.push(String(m)) },
  };
}

interface FakeRequest {
  url: string;
  method: string;
}

/**
 * A fetch double serving `/api/health` (port probe), `/api/snapshot`
 * (`agents`), and `/api/tasks/:id/transcript` (`transcript` or `transcriptStatus`).
 */
function fakeFetch({
  port = 4800,
  healthyPorts,
  agents = [] as unknown[],
  snapshotStatus = 200,
  transcript = { taskId: 't1', source: 'stored', messages: [] as TranscriptMessage[] } as unknown,
  transcriptStatus = 200,
}: {
  port?: number;
  healthyPorts?: number[];
  agents?: unknown;
  snapshotStatus?: number;
  transcript?: unknown;
  transcriptStatus?: number;
} = {}) {
  const requests: FakeRequest[] = [];
  const up = healthyPorts ?? [port];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    const portMatch = url.match(/127\.0\.0\.1:(\d+)/);
    const reqPort = portMatch ? Number(portMatch[1]) : NaN;
    if (url.includes('/api/health')) {
      if (up.includes(reqPort)) return { ok: true } as Response;
      throw new Error('ECONNREFUSED');
    }
    if (url.includes('/api/snapshot')) {
      return {
        ok: snapshotStatus >= 200 && snapshotStatus < 300,
        status: snapshotStatus,
        json: async () => agents,
      } as unknown as Response;
    }
    if (url.includes('/transcript')) {
      return {
        ok: transcriptStatus >= 200 && transcriptStatus < 300,
        status: transcriptStatus,
        json: async () => transcript,
      } as unknown as Response;
    }
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const BASE_ENV = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' } as NodeJS.ProcessEnv;

describe('parsePeekArgs', () => {
  it('reads taskRef, --json, --max-chars, --session in any order', () => {
    expect(parsePeekArgs(['t1', '--json'])).toMatchObject({ taskRef: 't1', json: true });
    expect(parsePeekArgs(['--max-chars', '500', 't1'])).toMatchObject({ taskRef: 't1', maxChars: 500 });
    expect(parsePeekArgs(['t1', '--session', 'kookr-abc'])).toMatchObject({ taskRef: 't1', session: 'kookr-abc' });
    expect(parsePeekArgs(['--help'])).toMatchObject({ help: true });
  });

  it('rejects a non-positive --max-chars', () => {
    expect(parsePeekArgs(['t1', '--max-chars', '0']).error).toContain('--max-chars');
    expect(parsePeekArgs(['t1', '--max-chars', 'x']).error).toContain('--max-chars');
  });

  it('flags unknown options and extra positionals', () => {
    expect(parsePeekArgs(['--bogus']).error).toContain('Unknown option');
    expect(parsePeekArgs(['t1', 't2']).error).toContain('exactly one');
  });

  it('requires a taskRef', () => {
    expect(parsePeekArgs([]).error).toContain('taskId|name');
  });
});

describe('deriveRunState', () => {
  it('reports a completed turn as awaiting-operator, NOT a stall (the false-idle bug)', () => {
    const v = deriveRunState({ turnState: 'completed_turn', classification: 'healthy-idle' });
    expect(v.state).toBe('awaiting-operator');
    expect(v.headline).toMatch(/AWAITING OPERATOR/);
  });

  it('reports needs_input/ask_user_question as an asked question', () => {
    const v = deriveRunState({ anomalyType: 'needs_input', anomalySubType: 'ask_user_question' });
    expect(v.state).toBe('awaiting-operator');
    expect(v.headline).toMatch(/asked a question/);
  });

  it('reports a running turn as working', () => {
    expect(deriveRunState({ turnState: 'running', classification: 'healthy-working' }).state).toBe('working');
  });

  it('reports a stalled session as possibly-hung', () => {
    expect(deriveRunState({ turnState: 'running', classification: 'provider-or-agent-stalled' }).state).toBe('possibly-hung');
  });

  it('lets a needs_input anomaly override a stale provider-or-agent-stalled classification', () => {
    // The headline promise: a task parked at the prompt (needs_input) is never
    // mislabeled as hung just because the freshness classifier went stale.
    expect(deriveRunState({ anomalyType: 'needs_input', classification: 'provider-or-agent-stalled' }).state).toBe('awaiting-operator');
  });

  it('prioritizes a hard block over an idle turn state', () => {
    expect(deriveRunState({ anomalyType: 'permission_blocked', turnState: 'completed_turn' }).state).toBe('blocked');
    expect(deriveRunState({ turnState: 'blocked' }).state).toBe('blocked');
  });

  it('reports a terminal task status as terminal', () => {
    expect(deriveRunState({ taskStatus: 'completed', turnState: 'running' }).state).toBe('terminal');
  });

  it('falls back to unknown with no usable signals', () => {
    expect(deriveRunState({}).state).toBe('unknown');
    expect(deriveRunState({ turnState: 'unknown' }).state).toBe('unknown');
  });
});

describe('extractLastMessageView', () => {
  it('joins the final assistant turn across tool-call-separated text blocks', () => {
    const messages: TranscriptMessage[] = [
      { kind: 'text', role: 'user', text: 'go' },
      { kind: 'text', role: 'assistant', text: 'working on it' },
      { kind: 'tool_call', name: 'Bash' },
      { kind: 'tool_result', name: 'Bash', text: 'out' },
      { kind: 'text', role: 'assistant', text: 'pausing here, say the word' },
    ];
    const v = extractLastMessageView(messages);
    expect(v.lastAssistant).toBe('working on it\n\npausing here, say the word');
    expect(v.repliesAfter).toEqual([]);
  });

  it('stops at the previous turn boundary (a user message) and lists replies after', () => {
    const messages: TranscriptMessage[] = [
      { kind: 'text', role: 'assistant', text: 'old turn — do NOT include' },
      { kind: 'text', role: 'user', text: 'new instruction' },
      { kind: 'text', role: 'assistant', text: 'final words' },
      { kind: 'text', role: 'user', text: 'operator reply after' },
      { kind: 'tool_result', name: 'Bash', text: 'out' },
    ];
    const v = extractLastMessageView(messages);
    expect(v.lastAssistant).toBe('final words');
    expect(v.lastAssistant).not.toContain('old turn');
    expect(v.repliesAfter).toEqual(['operator reply after']);
  });

  it('returns undefined when there is no assistant text message', () => {
    expect(extractLastMessageView([{ kind: 'tool_call', name: 'Bash' }]).lastAssistant).toBeUndefined();
  });
});

describe('capKeepingTail', () => {
  it('returns the full text when under the cap or uncapped', () => {
    expect(capKeepingTail('hello', 100)).toBe('hello');
    expect(capKeepingTail('hello')).toBe('hello');
  });

  it('keeps the TAIL (operative conclusion), not the head', () => {
    const text = 'HEAD'.repeat(10) + 'PAUSING HERE';
    const out = capKeepingTail(text, 12);
    expect(out).toContain('PAUSING HERE');
    expect(out).toMatch(/earlier char\(s\) omitted/);
    expect(out).not.toMatch(/HEADHEADHEAD/);
  });
});

describe('runPeekCli', () => {
  it('prints help and exits 0', async () => {
    const io = captureIo();
    const code = await runPeekCli(['--help'], { env: {}, out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.logs).toEqual([PEEK_HELP_TEXT]);
  });

  it('reproduces the scenario: a paused agent reads as awaiting-operator with its full last words', async () => {
    const io = captureIo();
    const longPause =
      'Stage 0 underway with verified progress.\n' +
      'X'.repeat(2000) +
      "\nI'm pausing at this clean slice boundary. Say the word if you want me to reprioritize R-S1.";
    const { impl } = fakeFetch({
      agents: [
        {
          agentId: 'kookr-1',
          taskId: 'f8862dd9',
          taskName: 'binaural',
          taskStatus: 'inProgress',
          turnState: 'completed_turn',
          anomaly: { type: 'needs_input', subType: 'stop', explanation: 'Agent is waiting for input.' },
          sessionHealth: { classification: 'healthy-idle' },
        },
      ],
      transcript: {
        taskId: 'f8862dd9',
        source: 'stored',
        messages: [{ kind: 'text', role: 'assistant', text: longPause }],
      },
    });
    const code = await runPeekCli(['f8862dd9', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const env = JSON.parse(io.logs[0]);
    expect(env.ok).toBe(true);
    expect(env.details.runState).toBe('awaiting-operator');
    // The operative conclusion at the END of the message is present in full.
    expect(env.details.lastAssistantMessage).toContain('Say the word if you want me to reprioritize');
    expect(env.details.signals.turnState).toBe('completed_turn');
  });

  it('human output surfaces run-state and the full last message, with a not-a-heartbeat note', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({
      agents: [
        {
          agentId: 'kookr-1',
          taskId: 't1',
          turnState: 'completed_turn',
          sessionHealth: { classification: 'healthy-idle' },
        },
      ],
      transcript: { taskId: 't1', source: 'stored', messages: [{ kind: 'text', role: 'assistant', text: 'paused and waiting' }] },
    });
    const code = await runPeekCli(['t1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const text = io.logs.join('\n');
    expect(text).toMatch(/AWAITING OPERATOR/);
    expect(text).toMatch(/not a heartbeat/);
    expect(text).toContain('paused and waiting');
  });

  it('works on a task absent from the live snapshot (terminal/aged) via the transcript', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [],
      transcript: { taskId: 'gone', source: 'stored', messages: [{ kind: 'text', role: 'assistant', text: 'final answer' }] },
    });
    const code = await runPeekCli(['gone', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const env = JSON.parse(io.logs[0]);
    expect(env.details.lastAssistantMessage).toBe('final answer');
    expect(env.details.runState).toBe('unknown');
    // The transcript was queried by the ref itself when no snapshot match.
    expect(requests.some((r) => r.url.includes('/api/tasks/gone/transcript'))).toBe(true);
  });

  it('returns NO_TASK (exit 2) for a 404 transcript', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: [], transcriptStatus: 404 });
    const code = await runPeekCli(['nope', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_TASK' });
  });

  it('names the session in a 404 when --session was given', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: [], transcriptStatus: 404 });
    const code = await runPeekCli(['t1', '--session', 'bogus', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(2);
    const env = JSON.parse(io.logs[0]);
    expect(env).toMatchObject({ ok: false, code: 'NO_TASK' });
    expect(env.message).toContain("session 'bogus'");
  });

  it('prefers the live task when a name is shared with a terminal one', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({
      agents: [
        { agentId: 'a1', taskId: 't-live', taskName: 'dup', taskStatus: 'inProgress', turnState: 'running' },
        { agentId: 'a2', taskId: 't-old', taskName: 'dup', taskStatus: 'completed' },
      ],
      transcript: { taskId: 't-live', source: 'stored', messages: [{ kind: 'text', role: 'assistant', text: 'live work' }] },
    });
    const code = await runPeekCli(['dup', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const env = JSON.parse(io.logs[0]);
    expect(env.details.taskId).toBe('t-live');
    expect(env.details.runState).toBe('working');
  });

  it('reports a non-ok snapshot as a server error (exit 4)', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ snapshotStatus: 500 });
    const code = await runPeekCli(['t1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
  });

  it('reports a non-array snapshot body as a server error (exit 4)', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: { not: 'an array' } });
    const code = await runPeekCli(['t1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
  });

  it('reports a 500 transcript as a server error (exit 4)', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: [], transcriptStatus: 500 });
    const code = await runPeekCli(['t1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
  });

  it('reports a non-object transcript body (HTTP 200) as a server error, not a crash', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: [], transcript: null });
    const code = await runPeekCli(['t1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
  });

  it('handles an unavailable transcript (aged-out task) without an assistant message', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ agents: [], transcript: { taskId: 'gone', unavailable: { reason: 'aged_out' } } });
    const code = await runPeekCli(['gone', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const env = JSON.parse(io.logs[0]);
    expect(env.details.transcriptUnavailable).toBe('aged_out');
    expect(env.details.lastAssistantMessage).toBeUndefined();
  });

  it('auto-detects the port (health probe) when no base URL is set', async () => {
    const io = captureIo();
    // Only :4800 answers health; :4801 refuses — exercises the probe path.
    const { impl, requests } = fakeFetch({
      healthyPorts: [4800],
      agents: [{ agentId: 'a1', taskId: 't1', turnState: 'running' }],
      transcript: { taskId: 't1', source: 'stored', messages: [{ kind: 'text', role: 'assistant', text: 'hi' }] },
    });
    const code = await runPeekCli(['t1', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    expect(requests.some((r) => r.url.includes('/api/health'))).toBe(true);
  });

  it('reports ambiguous ports (exit 5) when both default instances answer', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ healthyPorts: [4800, 4801] });
    const code = await runPeekCli(['t1', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(5);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'AMBIGUOUS_PORT' });
  });

  it('disambiguates when a name matches more than one live task', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({
      agents: [
        { agentId: 'a1', taskId: 't1', taskName: 'dup', taskStatus: 'inProgress' },
        { agentId: 'a2', taskId: 't2', taskName: 'dup', taskStatus: 'inProgress' },
      ],
    });
    const code = await runPeekCli(['dup', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(5);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'AMBIGUOUS_TASK' });
  });

  it('reports no server reachable (exit 3)', async () => {
    const io = captureIo();
    const code = await runPeekCli(['t1', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
    expect(code).toBe(3);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_SERVER' });
  });
});
