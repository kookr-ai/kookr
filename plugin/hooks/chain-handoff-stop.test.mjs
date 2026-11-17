import { describe, it, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_BLOCKS, decide, endsWithQuestion, isSelfContinuationTask, readBlockCount, writeBlockCount } from './chain-handoff-stop.mjs';

// Prompt lines as the real chain tasks carried them (issue #3678).
// Hand-written successor prompt (task e553486c): a parameter list.
const SUCCESSOR_PROMPT = [
  'You are continuing a sequential Kookr task chain (continuation envelope v1).',
  '',
  'Execute the "Implement GitHub Issue" playbook ... with these parameter values:',
  '- repo: kookr-ai/kookr',
  '- mergeAfterImplementation: true',
  '- self-continuation: true',
].join('\n');
// Rendered implement-github-issue playbook (task d850beb1).
const RENDERED_PLAYBOOK = '## Optional run modes\n\n- **Self-continuation** — `true`. When `true` and you are NOT in Ralph loop mode, ...';
const RENDERED_PLAYBOOK_OFF = '## Optional run modes\n\n- **Self-continuation** — `false`. When `true` and you are NOT in Ralph loop mode, ...';
// A prompt that only talks about chains (like the task that fixes this issue).
const ABOUT_CHAINS = 'Implement GitHub issue #3678 (Self-continuation chains: sweep kills a live successor; no mechanical handoff gate).';

const chainTask = (extra = {}) => ({ id: 't1', status: 'inProgress', prompt: SUCCESSOR_PROMPT, ...extra });
const ev = (extra = {}) => ({ session_id: 's', ...extra });

describe('isSelfContinuationTask', () => {
  it('recognises the three prompt shapes chains use', () => {
    expect(isSelfContinuationTask({ prompt: SUCCESSOR_PROMPT })).toBe(true);
    expect(isSelfContinuationTask({ prompt: '- self-continuation: true\n' })).toBe(true);
    expect(isSelfContinuationTask({ prompt: RENDERED_PLAYBOOK })).toBe(true);
    expect(isSelfContinuationTask({ prompt: 'You are continuing a sequential Kookr task chain (continuation envelope v1).' })).toBe(true);
  });
  it('the playbook parameter decides when present', () => {
    expect(isSelfContinuationTask({ playbookParameterValues: { selfContinuation: 'true' }, prompt: '' })).toBe(true);
    expect(isSelfContinuationTask({ playbookParameterValues: { selfContinuation: 'false' }, prompt: SUCCESSOR_PROMPT })).toBe(false);
  });
  it('is false for a disabled toggle, a prompt about chains, and no task', () => {
    expect(isSelfContinuationTask({ prompt: RENDERED_PLAYBOOK_OFF })).toBe(false);
    expect(isSelfContinuationTask({ prompt: '- self-continuation: false' })).toBe(false);
    expect(isSelfContinuationTask({ prompt: ABOUT_CHAINS })).toBe(false);
    // Quoting the envelope header mid-line (a task editing the skill) is not a chain task.
    expect(isSelfContinuationTask({ prompt: 'Edit the line "You are continuing a sequential Kookr task chain (continuation envelope v1)."' })).toBe(false);
    expect(isSelfContinuationTask({ prompt: 'You are continuing a sequential Kookr task chain' })).toBe(false);
    expect(isSelfContinuationTask(null)).toBe(false);
  });
});

describe('decide', () => {
  it('blocks a chain task that stops with no child and no signal (task d850beb1)', () => {
    const reason = decide({ event: ev(), task: chainTask({ prompt: RENDERED_PLAYBOOK }) });
    expect(reason).toMatch(/no successor task and no recorded stop reason/);
    expect(reason).toMatch(/kookr spawn -C /);
    expect(reason).toMatch(/kookr signal completion-ready --note "chain end:/);
    expect(reason).toMatch(/not finished .* do not end the turn/);
  });
  it('tells an agent that already spawned an unlinked successor to record it, not spawn another (issue #4047)', () => {
    const reason = decide({ event: ev(), task: chainTask() });
    expect(reason).toMatch(/already spawned the successor without --parent-task-id, do not spawn a second one/);
    expect(reason).toMatch(/kookr signal completion-ready --note "successor <task id> spawned"/);
  });
  it('blocks even on a re-run after another Stop hook blocked (stop_hook_active)', () => {
    expect(decide({ event: ev({ stop_hook_active: true }), task: chainTask() })).not.toBeNull();
  });
  it('allows the stop once a successor exists or a stop reason is recorded', () => {
    expect(decide({ event: ev(), task: chainTask({ childTaskIds: ['c1'] }) })).toBeNull();
    expect(decide({ event: ev(), task: chainTask({ pendingSignal: { kind: 'completion_ready', note: 'chain end: none left' } }) })).toBeNull();
    expect(decide({ event: ev(), task: chainTask({ finishedSignalAt: '2026-11-12T20:00:00Z' }) })).toBeNull();
  });
  it('stays silent for tasks the chain contract does not cover', () => {
    expect(decide({ event: ev(), task: { status: 'inProgress', prompt: ABOUT_CHAINS } })).toBeNull();
    expect(decide({ event: ev(), task: chainTask({ chain: { chainId: 'c', iteration: 2 } }) })).toBeNull();
    expect(decide({ event: ev(), task: chainTask({ ralphLoop: { status: 'running' } }) })).toBeNull();
    expect(decide({ event: ev(), task: chainTask({ ralphLoop: { status: 'completed' } }) })).not.toBeNull();
    expect(decide({ event: ev(), task: chainTask({ status: 'completed' }) })).toBeNull();
    expect(decide({ event: ev(), task: null })).toBeNull();
  });
  it('stays silent while the agent is parked on its own background work', () => {
    expect(decide({ event: ev({ background_tasks: [{ status: 'running', type: 'shell' }] }), task: chainTask() })).toBeNull();
  });
  it('lets every stop through after MAX_BLOCKS blocks', () => {
    expect(decide({ event: ev(), task: chainTask(), priorBlocks: MAX_BLOCKS - 1 })).not.toBeNull();
    expect(decide({ event: ev(), task: chainTask(), priorBlocks: MAX_BLOCKS })).toBeNull();
  });
});

describe('attended chain task asking the operator (issue #4047)', () => {
  const ask = 'Two issues are eligible. Which one should the chain take next?\n\n1. #10\n2. #11';
  it('lets an unflagged or attended task end its turn on a question', () => {
    expect(decide({ event: ev({ last_assistant_message: ask }), task: chainTask() })).toBeNull();
    expect(decide({ event: ev({ last_assistant_message: ask }), task: chainTask({ unattended: false }) })).toBeNull();
  });
  it('still blocks a task flagged unattended, since nobody will answer', () => {
    expect(decide({ event: ev({ last_assistant_message: ask }), task: chainTask({ unattended: true }) })).not.toBeNull();
  });
  it('still blocks an unflagged task that ends without a question, or with no message', () => {
    expect(decide({ event: ev({ last_assistant_message: 'Unit done, PR merged.' }), task: chainTask() })).not.toBeNull();
    expect(decide({ event: ev({ last_assistant_message: '' }), task: chainTask() })).not.toBeNull();
    expect(decide({ event: ev(), task: chainTask() })).not.toBeNull();
  });
});

describe('endsWithQuestion', () => {
  it('finds a question on one of the last lines, ignoring markdown after the mark', () => {
    expect(endsWithQuestion('Should I merge now?')).toBe(true);
    expect(endsWithQuestion('**Should I merge now?**')).toBe(true);
    expect(endsWithQuestion('Pick one?\n- A\n- B\n')).toBe(true);
  });
  it('is false for statements, a question buried early, and non-strings', () => {
    expect(endsWithQuestion('Done. The PR is merged.')).toBe(false);
    expect(endsWithQuestion(['Why?', 'a', 'b', 'c', 'd', 'e', 'f'].join('\n'))).toBe(false);
    expect(endsWithQuestion(undefined)).toBe(false);
  });
});

describe('block counter', () => {
  it('round-trips per task and reads 0 when absent', () => {
    const id = `test-${process.pid}-${Date.now()}`;
    expect(readBlockCount(id)).toBe(0);
    writeBlockCount(id, 2);
    expect(readBlockCount(id)).toBe(2);
    rmSync(path.join(tmpdir(), 'kookr-chain-handoff-stop', `${id}.count`), { force: true });
  });
});

describe('main (process)', () => {
  const script = path.join(import.meta.dirname, 'chain-handoff-stop.mjs');
  const runHook = (env, input = '{}') => {
    try {
      execFileSync('node', [script], { input, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  it('allows the stop outside a Kookr task, with the opt-out, and when the server is unreachable', () => {
    expect(runHook({})).toBe(0);
    expect(runHook({ KOOKR_TASK_ID: 'x', KOOKR_CHAIN_HANDOFF_STOP_SKIP: '1' })).toBe(0);
    expect(runHook({ KOOKR_TASK_ID: 'x', KOOKR_API_BASE_URL: 'http://127.0.0.1:9' })).toBe(0);
    expect(runHook({ KOOKR_TASK_ID: 'x' }, 'not json')).toBe(0);
  });
});

describe('main (process) against a stub server', () => {
  const script = path.join(import.meta.dirname, 'chain-handoff-stop.mjs');
  const runAsync = (env, input = '{"session_id":"s"}') =>
    new Promise((resolve) => {
      const child = execFile('node', [script], { env: { PATH: process.env.PATH, ...env } }, (err, _out, stderr) => {
        resolve({ code: err ? err.code : 0, stderr });
      });
      child.stdin.end(input);
    });
  const withServer = async (taskJson, fn) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(taskJson()));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.close();
    }
  };
  const counter = (id) => path.join(tmpdir(), 'kookr-chain-handoff-stop', `${id}.count`);

  it('blocks with exit 2 and the reason, counts blocks, and stops blocking at the limit', async () => {
    const id = `proc-${process.pid}-${Date.now()}`;
    try {
      await withServer(() => chainTask({ id }), async (base) => {
        const env = { KOOKR_TASK_ID: id, KOOKR_API_BASE_URL: base };
        const first = await runAsync(env);
        expect(first.code).toBe(2);
        expect(first.stderr).toMatch(/no successor task and no recorded stop reason/);
        expect(readBlockCount(id)).toBe(1);
        for (let i = 1; i < MAX_BLOCKS; i += 1) expect((await runAsync(env)).code).toBe(2);
        expect((await runAsync(env)).code).toBe(0);
      });
    } finally {
      rmSync(counter(id), { force: true });
    }
  });

  it('allows an unflagged task asking a question without spending a block (issue #4047)', async () => {
    const id = `ask-${process.pid}-${Date.now()}`;
    const input = JSON.stringify({ session_id: 's', last_assistant_message: 'Which issue should come next?' });
    try {
      await withServer(() => chainTask({ id }), async (base) => {
        const env = { KOOKR_TASK_ID: id, KOOKR_API_BASE_URL: base };
        expect((await runAsync(env, input)).code).toBe(0);
        expect(readBlockCount(id)).toBe(0);
        expect((await runAsync(env)).code).toBe(2); // a later silent stop is still blocked
      });
    } finally {
      rmSync(counter(id), { force: true });
    }
  });

  it('after a hand-off, a later stop is allowed even when the signal was cleared', async () => {
    const id = `latch-${process.pid}-${Date.now()}`;
    let task = chainTask({ id, pendingSignal: { kind: 'completion_ready', note: 'chain end: none left' } });
    try {
      await withServer(() => ({ task }), async (base) => {
        const env = { KOOKR_TASK_ID: id, KOOKR_API_BASE_URL: base };
        expect((await runAsync(env)).code).toBe(0);
        task = chainTask({ id }); // an operator message cleared the signal
        expect((await runAsync(env)).code).toBe(0);
      });
    } finally {
      rmSync(counter(id), { force: true });
    }
  });
});

describe('registration', () => {
  it('is registered as a Stop hook', () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const commands = manifest.hooks.Stop.flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/chain-handoff-stop.sh');
  });
});
