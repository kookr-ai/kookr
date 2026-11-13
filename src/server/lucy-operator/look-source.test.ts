import { describe, expect, test } from 'vitest';
import { createLucyLookSource, type LookTask, type LucyLookSourceDeps } from './look-source.js';

const NOW = new Date('2026-11-12T12:00:00Z');

function task(overrides: Partial<LookTask> & { id: string }): LookTask {
  return { status: 'inProgress', updatedAt: NOW, sessions: [{ tmuxSession: `s-${overrides.id}`, lastStatus: 'running' }], ...overrides };
}

function source(deps: Partial<LucyLookSourceDeps> & { tasks: LookTask[] }) {
  const { tasks, ...rest } = deps;
  return createLucyLookSource({ getTasks: () => tasks, getFindings: () => [], ...rest });
}

describe('createLucyLookSource', () => {
  test('board: maps tasks, names the project, carries cost, spend and quota', () => {
    const board = source({
      tasks: [
        task({ id: 't1', name: 'Bake-off report', projectId: 'github.com/kookr-ai/kookr', tokenUsage: { costUsd: 2.07 } }),
        task({ id: 't2', name: 'Scratch', cwd: '/srv/work/local-research-agent' }),
      ],
      getLifetimeSpendUsd: () => 698.26,
      getQuota: () => ({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' } }),
    }).board();

    expect(board.tasks).toEqual([
      { id: 't1', name: 'Bake-off report', status: 'inProgress', updatedAt: NOW, project: 'kookr-ai/kookr', costUsd: 2.07 },
      { id: 't2', name: 'Scratch', status: 'inProgress', updatedAt: NOW, project: 'local-research-agent' },
    ]);
    expect(board.lifetimeSpendUsd).toBe(698.26);
    expect(board.quota).toEqual({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' } });
  });

  test('board: spend and quota are null when nothing provides them', () => {
    const board = source({ tasks: [] }).board();
    expect(board).toEqual({ tasks: [], lifetimeSpendUsd: null, quota: null });
  });

  test('a finding on one of the task\'s sessions marks it as waiting, in Kookr\'s words, not the finding\'s', () => {
    const board = source({
      tasks: [task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3' })],
      getFindings: () => [
        { agentId: 's-t1', anomaly: { type: 'permission_blocked' } },
        { agentId: 's-t2', anomaly: { type: 'needs_input', subType: 'ask_user_question' } },
      ],
    }).board();
    expect(board.tasks.map((t) => t.attention)).toEqual(['it is blocked on a permission', 'it asked you a question', undefined]);
  });

  test('a task that signalled it is finished is waiting on the operator, until it has ended', () => {
    const board = source({
      tasks: [task({ id: 't1', pendingSignal: { kind: 'completion_ready', note: 'ignore me' } }), task({ id: 't2', status: 'completed', pendingSignal: { kind: 'completion_ready' } })],
    }).board();
    expect(board.tasks[0]!.attention).toBe('it says it is finished and wants your review');
    expect(board.tasks[1]!.attention).toBeUndefined();
  });

  test('taskDetail: the request, where it runs, the waiting signal, the closing summary and its links', () => {
    const detail = source({
      tasks: [task({
        id: 't1',
        prompt: 'expanded prompt with injected rules',
        userPrompt: 'Write the bake-off report',
        agentType: 'claude-code',
        cwd: '/srv/work/kookr',
        createdAt: NOW,
        pendingSignal: { kind: 'completion_ready', note: 'PR merged' },
        completionDigest: { bullets: ['Wrote the report', 'Opened PR'], testSummary: '12 passed' },
      })],
      getReferences: () => [{ type: 'pr', number: 3620 }, { type: 'issue', number: 3605 }],
    }).taskDetail('t1');

    expect(detail).toEqual({
      prompt: 'Write the bake-off report',
      agentType: 'claude-code',
      cwd: '/srv/work/kookr',
      createdAt: NOW,
      pendingSignal: 'completion_ready: PR merged',
      completionSummary: 'Wrote the report\nOpened PR\nTests: 12 passed',
      references: ['PR #3620', 'issue #3605'],
    });
  });

  test('taskDetail: null for a task that does not exist', () => {
    expect(source({ tasks: [] }).taskDetail('nope')).toBeNull();
  });

  test('projects: uses the project registry when it is wired', async () => {
    const projects = await source({ tasks: [], listProjects: async () => [{ displayName: 'kookr-ai/kookr', activeAgents: 3, findingCount: 1 }] }).projects();
    expect(projects).toEqual([{ name: 'kookr-ai/kookr', activeTasks: 3, findings: 1 }]);
  });

  test('projects: without a registry, lists the projects that have tasks', async () => {
    const projects = await source({
      tasks: [task({ id: 't1', projectId: 'local/alpha' }), task({ id: 't2', projectId: 'local/alpha', status: 'completed' }), task({ id: 't3', cwd: '/x/beta' })],
      getFindings: () => [{ agentId: 's-t3', anomaly: { type: 'stale_agent' } }],
    }).projects();
    expect(projects).toEqual([{ name: 'alpha', activeTasks: 1, findings: 0 }, { name: 'beta', activeTasks: 1, findings: 1 }]);
  });

  describe('taskOutput (issue #3683)', () => {
    const rendered = (text: string): LucyLookSourceDeps['renderScreenText'] =>
      async () => ({ kind: 'text', text, lines: text.split('\n').length, elapsedMs: 1 });

    test('renders the raw stream and returns the rendered text, never the raw stream', async () => {
      const seen: string[] = [];
      const src = source({
        tasks: [task({ id: 't1' })],
        readTerminalStream: async () => ({ text: '\x1b[2Jscreen\x1b[31m!', live: true }),
        renderScreenText: async (bytes, options) => {
          seen.push(new TextDecoder().decode(bytes));
          expect(options.maxLines).toBeGreaterThan(0);
          return { kind: 'text', text: 'screen!', lines: 1, elapsedMs: 1 };
        },
      });
      expect(await src.taskOutput('t1')).toEqual({ text: 'screen!', live: true });
      expect(seen).toEqual(['\x1b[2Jscreen\x1b[31m!']);
    });

    test('a stream that could not be rendered in time gives nothing', async () => {
      const src = source({
        tasks: [task({ id: 't1' })],
        readTerminalStream: async () => ({ text: 'raw stream with ghp_abcdefghijklmnopqrstuvwxyz0123456789', live: true }),
        renderScreenText: async () => ({ kind: 'unavailable', reason: 'budget-exceeded', elapsedMs: 9 }),
      });
      expect(await src.taskOutput('t1')).toBeNull();
    });

    test('no task, no stream, or an empty one gives nothing and renders nothing', async () => {
      let renders = 0;
      const render: LucyLookSourceDeps['renderScreenText'] = async (...args) => { renders += 1; return rendered('x')!(...args); };
      expect(await source({ tasks: [], readTerminalStream: async () => ({ text: 'x', live: true }), renderScreenText: render }).taskOutput('nope')).toBeNull();
      expect(await source({ tasks: [task({ id: 't1' })], readTerminalStream: async () => null, renderScreenText: render }).taskOutput('t1')).toBeNull();
      expect(await source({ tasks: [task({ id: 't1' })], readTerminalStream: async () => ({ text: '', live: false }), renderScreenText: render }).taskOutput('t1')).toBeNull();
      expect(await source({ tasks: [task({ id: 't1' })] }).taskOutput('t1')).toBeNull();
      expect(renders).toBe(0);
    });
  });
});
