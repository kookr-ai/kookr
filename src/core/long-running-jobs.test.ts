import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LONG_RUNNING_JOB_CAP_MS,
  MAX_PARENT_LINE_CHARS,
  evaluateLongRunningJobHold,
  formatReclaimKillLine,
  isNonJobService,
  sanitizeCommand,
  selectSessionJobs,
  toKilledProcesses,
  type ProcessInfo,
  type SessionJob,
} from './long-running-jobs.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A fake process lister: dtach master 100 started 5 h ago, agent 101 right after it. */
function sessionTree(extra: ProcessInfo[] = []): ProcessInfo[] {
  const rootStart = NOW - 5 * HOUR;
  return [
    { pid: 1, ppid: 0, comm: 'systemd', command: '/sbin/init', startedAtMs: NOW - 100 * HOUR },
    { pid: 100, ppid: 1, comm: 'dtach', command: 'dtach -n /tmp/s.sock -E claude', startedAtMs: rootStart },
    { pid: 101, ppid: 100, comm: 'claude', command: 'claude --dangerously-skip-permissions', startedAtMs: rootStart + 1_000 },
    // An unrelated process elsewhere on the host is never part of the session.
    { pid: 900, ppid: 1, comm: 'python3', command: 'python3 other.py', startedAtMs: NOW - 3 * HOUR },
    ...extra,
  ];
}

const bash = (pid: number, ppid: number, startedAtMs: number): ProcessInfo => ({
  pid, ppid, comm: 'bash', command: '/bin/bash -c source snapshot.sh && python train.py', startedAtMs,
});

describe('selectSessionJobs (issue #4237)', () => {
  it('agent-only tree: no jobs', () => {
    expect(selectSessionJobs(100, sessionTree(), { nowMs: NOW })).toEqual([]);
  });

  it('a job under the Bash tool shell counts; the shell itself does not', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      bash(200, 101, NOW - 2 * HOUR),
      { pid: 201, ppid: 200, comm: 'python', command: 'python train.py --epochs 3', startedAtMs: NOW - 2 * HOUR },
    ]), { nowMs: NOW });
    expect(jobs).toEqual([{ pid: 201, command: 'python train.py --epochs 3', ageMs: 2 * HOUR, holdsGpu: false }]);
  });

  it('a job the shell exec-ed straight under the agent counts', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 210, ppid: 101, comm: 'python', command: 'python eval.py', startedAtMs: NOW - 30 * MIN },
    ]), { nowMs: NOW });
    expect(jobs.map((j) => j.pid)).toEqual([210]);
  });

  it('ignores helpers started with the session (MCP servers) and pacing helpers like sleep', () => {
    const rootStart = NOW - 5 * HOUR;
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 220, ppid: 101, comm: 'node', command: 'node mcp-server.js', startedAtMs: rootStart + 20_000 },
      bash(221, 101, NOW - HOUR),
      { pid: 222, ppid: 221, comm: 'sleep', command: 'sleep 3600', startedAtMs: NOW - HOUR },
    ]), { nowMs: NOW });
    expect(jobs).toEqual([]);
  });

  it('marks a GPU holder, even one started with the session', () => {
    const rootStart = NOW - 5 * HOUR;
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 230, ppid: 101, comm: 'python', command: 'python serve.py', startedAtMs: rootStart + 5_000 },
    ]), { nowMs: NOW, gpuPids: new Set([230]) });
    expect(jobs).toEqual([expect.objectContaining({ pid: 230, holdsGpu: true })]);
  });

  it('never reports the agent itself, even when it holds the GPU', () => {
    expect(selectSessionJobs(100, sessionTree(), { nowMs: NOW, gpuPids: new Set([100, 101]) })).toEqual([]);
  });

  it('returns nothing when the root is not in the table', () => {
    expect(selectSessionJobs(4242, sessionTree(), { nowMs: NOW })).toEqual([]);
  });

  it('sanitizes the command and orders jobs oldest first', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 240, ppid: 101, comm: 'python', command: 'python a.py\nrm -rf /', startedAtMs: NOW - 20 * MIN },
      { pid: 241, ppid: 101, comm: 'python', command: 'python b.py', startedAtMs: NOW - 90 * MIN },
    ]), { nowMs: NOW });
    expect(jobs.map((j) => j.pid)).toEqual([241, 240]);
    expect(jobs[1]!.command).toBe('python a.py rm -rf /');
  });
});

describe('deny-list: services and watchers are not jobs (issue #4243)', () => {
  const proc = (comm: string, command: string) => ({ comm, command });

  it.each([
    ['tail -f', proc('tail', 'tail -f /tmp/train.log')],
    ['less', proc('less', 'less +F out.log')],
    ['watch', proc('watch', 'watch -n 5 nvidia-smi')],
    ['hung git push', proc('git', 'git push origin HEAD')],
    ['gh run watch', proc('gh', 'gh run watch 123')],
    ['gh pr checks --watch', proc('gh', 'gh pr checks 7 --watch')],
    ['typescript LSP', proc('node', 'node /usr/lib/node_modules/typescript-language-server/lib/cli.mjs --stdio')],
    ['pyright LSP', proc('node', 'node /home/u/.npm/bin/pyright-langserver --stdio')],
    ['tsserver', proc('node', 'node /repo/node_modules/typescript/lib/tsserver.js')],
    ['gopls', proc('gopls', 'gopls serve')],
    ['rust-analyzer', proc('rust-analyzer', '/home/u/.cargo/bin/rust-analyzer')],
    ['MCP via npx', proc('node', 'npx -y @modelcontextprotocol/server-github')],
    ['MCP via uvx', proc('python3', 'uvx mcp-server-fetch')],
    ['MCP server script', proc('python3', 'python3 -u /opt/tools/mcp_server.py')],
    ['MCP package by path', proc('node', 'node /r/node_modules/@modelcontextprotocol/server-github/dist/index.js')],
    ['MCP package dir', proc('node', 'node /r/node_modules/github-mcp-server/dist/index.js')],
    ['npm run dev', proc('node', 'node /usr/bin/npm run dev')],
    ['pnpm dev', proc('node', 'node /usr/lib/pnpm/bin/pnpm.cjs dev')],
    ['bun run dev', proc('bun', 'bun run dev')],
    ['bare vite', proc('node', 'node /repo/node_modules/.bin/../vite/bin/vite.js --port 5173')],
    ['next dev', proc('node', 'node /repo/node_modules/.bin/next dev')],
    ['uvicorn', proc('python3', 'python3 -m uvicorn app:app --reload')],
    ['http.server', proc('python3', 'python3 -m http.server 8000')],
    ['flask run', proc('flask', '/venv/bin/flask run')],
    ['django runserver', proc('python', 'python manage.py runserver')],
    ['a --watch process', proc('node', 'node /repo/node_modules/typescript/bin/tsc --watch')],
  ])('%s is a service', (_label, p) => {
    expect(isNonJobService(p)).toBe(true);
  });

  it.each([
    ['python train.py', proc('python', 'python train.py --epochs 3')],
    ['a script reading mcp.yaml', proc('python', 'python eval.py --config mcp.yaml --log tail.txt')],
    ['a job in an mcp-named directory', proc('python', 'python /home/u/mcp-experiments/train.py')],
    ['a job in an mcp-server worktree', proc('python', 'python /w/kookr-issue-5000-mcp-server-retry/scripts/train.py')],
    ['a job in a language-server worktree', proc('python', 'python /w/kookr-issue-5001-language-server-perf/bench.py')],
    ['an mcp-named training script', proc('python', 'python train_mcp.py')],
    ['an mcp-prefixed eval script', proc('python', 'python scripts/mcp_eval.py --n 1000')],
    ['torchrun via -m', proc('python3', 'python3 -m torch.distributed.run --nproc 8 train.py')],
    ['node eval script', proc('node', 'node --max-old-space-size=8192 scripts/eval.js')],
    ['vitest run', proc('node', 'node /repo/node_modules/.bin/vitest run')],
    ['pnpm test', proc('node', 'node /usr/lib/pnpm/bin/pnpm.cjs test')],
    ['vite build', proc('node', 'node /repo/node_modules/vite/bin/vite.js build')],
    ['bun script', proc('bun', 'bun scripts/bench.ts')],
    ['ssh remote job', proc('ssh', 'ssh gpu-box python train.py')],
    ['a shell whose script mentions --watch', proc('bash', '/bin/bash -c tsc --watch & python train.py')],
  ])('%s still counts as a job', (_label, p) => {
    expect(isNonJobService(p)).toBe(false);
  });

  it('a service and everything under it are not jobs; a sibling job still counts', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      bash(250, 101, NOW - 2 * HOUR),
      { pid: 251, ppid: 250, comm: 'git', command: 'git push origin HEAD', startedAtMs: NOW - 2 * HOUR },
      { pid: 252, ppid: 251, comm: 'ssh', command: 'ssh git@github.com git-receive-pack', startedAtMs: NOW - 2 * HOUR },
      { pid: 253, ppid: 101, comm: 'node', command: 'node /usr/bin/npm run dev', startedAtMs: NOW - HOUR },
      { pid: 254, ppid: 253, comm: 'sh', command: 'sh -c vite', startedAtMs: NOW - HOUR },
      { pid: 255, ppid: 254, comm: 'node', command: 'node /repo/node_modules/.bin/vite', startedAtMs: NOW - HOUR },
      { pid: 256, ppid: 255, comm: 'esbuild', command: '/repo/node_modules/esbuild/bin/esbuild --service', startedAtMs: NOW - HOUR },
      { pid: 257, ppid: 101, comm: 'node', command: 'node /x/typescript-language-server --stdio', startedAtMs: NOW - 3 * HOUR },
      { pid: 258, ppid: 101, comm: 'tail', command: 'tail -f run.log', startedAtMs: NOW - 2 * HOUR },
      { pid: 259, ppid: 250, comm: 'python', command: 'python train.py', startedAtMs: NOW - 90 * MIN },
    ]), { nowMs: NOW });
    expect(jobs.map((j) => j.pid)).toEqual([259]);
  });

  it('a GPU holder under a service still counts', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 260, ppid: 101, comm: 'node', command: 'node /usr/bin/npm run dev', startedAtMs: NOW - HOUR },
      { pid: 261, ppid: 260, comm: 'python', command: 'python serve_model.py', startedAtMs: NOW - HOUR },
    ]), { nowMs: NOW, gpuPids: new Set([261]) });
    expect(jobs).toEqual([expect.objectContaining({ pid: 261, holdsGpu: true })]);
  });
});

describe('evaluateLongRunningJobHold (issue #4237)', () => {
  const job = (overrides: Partial<SessionJob>): SessionJob => ({
    pid: 300, command: 'python train.py', ageMs: 30 * MIN, holdsGpu: false, ...overrides,
  });

  it('young child: no hold', () => {
    expect(evaluateLongRunningJobHold([job({ ageMs: 9 * MIN })], { silentForMs: HOUR }))
      .toEqual({ hold: false, reason: 'no_long_running_job' });
  });

  it('old child: hold', () => {
    const decision = evaluateLongRunningJobHold([job({ ageMs: 10 * MIN })], { silentForMs: HOUR });
    expect(decision).toEqual({ hold: true, job: job({ ageMs: 10 * MIN }) });
  });

  it('GPU child: hold even when young', () => {
    expect(evaluateLongRunningJobHold([job({ ageMs: MIN, holdsGpu: true })], { silentForMs: HOUR }).hold).toBe(true);
  });

  it('past the cap: no hold', () => {
    expect(evaluateLongRunningJobHold([job({ holdsGpu: true })], { silentForMs: DEFAULT_LONG_RUNNING_JOB_CAP_MS }))
      .toEqual({ hold: false, reason: 'cap_reached' });
    expect(evaluateLongRunningJobHold([job({})], { silentForMs: 2 * HOUR, capMs: 2 * HOUR }).hold).toBe(false);
  });

  it('agent-only tree (no jobs, or no snapshot): no hold', () => {
    expect(evaluateLongRunningJobHold([], { silentForMs: HOUR }).hold).toBe(false);
    expect(evaluateLongRunningJobHold(undefined, { silentForMs: HOUR }).hold).toBe(false);
  });
});

describe('kill report formatting (issue #4237)', () => {
  it('sanitizeCommand strips control characters and truncates', () => {
    expect(sanitizeCommand('a\u0000b\r\n\tc\u001b[31m')).toBe('a b c [31m');
    expect(sanitizeCommand('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('formats one bounded line for the parent', () => {
    const killed = toKilledProcesses([
      { pid: 201, command: 'python train.py', ageMs: 2 * HOUR + 30 * MIN, holdsGpu: true },
      { pid: 202, command: 'tail -f log', ageMs: 45_000, holdsGpu: false },
    ]);
    expect(killed).toEqual([
      { pid: 201, command: 'python train.py', ageSeconds: 9000, holdsGpu: true },
      { pid: 202, command: 'tail -f log', ageSeconds: 45, holdsGpu: false },
    ]);
    expect(formatReclaimKillLine({ workerName: 'eval\nworker', silentForMs: 61 * MIN, killed })).toBe(
      '[kookr] worker eval worker was reclaimed after 61 min of silence; it killed: '
      + 'python train.py (pid 201, 2.5h, GPU); tail -f log (pid 202, 45s)',
    );
  });

  it('caps the parent line length', () => {
    const killed = toKilledProcesses(Array.from({ length: 8 }, (_, i) => ({
      pid: 1000 + i, command: 'y'.repeat(200), ageMs: HOUR, holdsGpu: false,
    })));
    const line = formatReclaimKillLine({ workerName: 'w', silentForMs: HOUR, killed });
    expect(line.length).toBeLessThanOrEqual(MAX_PARENT_LINE_CHARS);
    expect(line).not.toMatch(/\n/);
  });
});
