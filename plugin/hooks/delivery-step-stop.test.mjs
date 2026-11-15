import { describe, it, expect } from 'vitest';
import { decide, lastTestOutcome, latestVerdict, isParked, hasMergeAuthority, parseIntegrationBranch, isSharedBranch, readIntegrationBranch } from './delivery-step-stop.mjs';
import { taskHasMergeAuthority } from '../../src/core/merge-required.ts';
import { parseIntegrationBranch as parseIntegrationBranchTs } from '../../src/core/integration-branch.ts';
import { readIntegrationBranch as readIntegrationBranchTs } from '../../src/core/delivery-gate-config.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tu = (id, command) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const tr = (id, text, is_error) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
const SHA = 'a'.repeat(40);
const verdict = (v, sha = SHA) => `<!-- kookr-independent-review -->\nkookr-review-verdict: ${v}\nreview-lane: claude\nreview-head-sha: ${sha}`;
const pr = (comments = []) => ({ number: 7, headSha: SHA, comments });
const ev = (extra = {}) => ({ session_id: 's', ...extra });

describe('transcript replay', () => {
  it('shape 1: red test with PR open blocks', () => {
    const t = [tu('1', 'pnpm test:changed 2>&1 | tee log'), tr('1', 'Exit code 1\nFAIL', true)].join('\n');
    expect(lastTestOutcome(t)).toBe('red');
    expect(decide({ event: ev(), testOutcome: 'red', pr: pr(), mergeAuthority: true })).toMatch(/last test\/gate run failed/);
  });
  it('a later green run clears the red', () => {
    const t = [tu('1', 'vitest run'), tr('1', 'Exit code 1', true), tu('2', 'vitest run'), tr('2', 'ok', false)].join('\n');
    expect(lastTestOutcome(t)).toBe('green');
  });
  it('shape 2: PR open, no review verdict blocks', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr(), mergeAuthority: true })).toMatch(/independent review/);
  });
  it('shape 3: pass verdict + pre-authorized blocks with the merge instruction', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr([verdict('pass')]), mergeAuthority: true })).toMatch(/kookr merge/);
  });
  it('no merge authority: only the red-test nudge applies', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr(), mergeAuthority: false })).toBeNull();
    expect(decide({ event: ev(), testOutcome: 'red', pr: pr(), mergeAuthority: false })).toMatch(/failed/);
  });
  it('advisory repo and review-skipped-timeout do not nudge a review', () => {
    expect(decide({ event: ev(), testOutcome: null, pr: pr(), mergeAuthority: true, advisoryReview: true })).toBeNull();
    expect(decide({ event: ev(), testOutcome: null, pr: pr(['review-skipped-timeout']), mergeAuthority: true })).toBeNull();
  });
  it('parked check ignores finished tasks and the artifact listener', () => {
    expect(isParked({ background_tasks: [{ status: 'completed' }, { type: 'monitor', description: 'live updates for artifact x' }] })).toBe(false);
    expect(isParked({ background_tasks: [{ status: 'running', type: 'shell' }] })).toBe(true);
  });
  it('merge authority matches taskHasMergeAuthority', () => {
    const cases = [
      {}, { mergeRequired: true }, { terminalState: 'merged-pr' }, { metadata: { mergeRequired: true } },
      { playbookParameterValues: { mergeAfterImplementation: 'true' } },
      { playbookParameterValues: { mergeAfterImplementation: 'false' } },
      { prompt: 'x TERMINAL-STATE CONTRACT (mergeAfterImplementation=true): y' },
      { prompt: 'mergeAfterImplementation=true and you hold merge authority' },
      { prompt: 'mergeAfterImplementation=true' }, { prompt: 'just a prompt' },
    ];
    for (const c of cases) expect(hasMergeAuthority(c)).toBe(taskHasMergeAuthority(c));
  });
  it('PR with pass verdict but no merge authority allows the stop', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr([verdict('pass')]), mergeAuthority: false })).toBeNull();
  });
  it('stale verdict (head moved) asks for a re-review', () => {
    expect(decide({ event: ev(), testOutcome: null, pr: pr([verdict('pass', 'b'.repeat(40))]), mergeAuthority: true })).toMatch(/head moved/);
  });
  it('block verdict asks for fixes', () => {
    expect(decide({ event: ev(), testOutcome: null, pr: pr([verdict('block')]), mergeAuthority: true })).toMatch(/BLOCK/);
  });
});

describe('test command detection', () => {
  it('ignores read-only commands that merely mention a test runner', () => {
    const t = [tu('1', 'grep vitest package.json'), tr('1', 'Exit code 1', true)].join('\n');
    expect(lastTestOutcome(t)).toBeNull();
  });
});

describe('does not fire', () => {
  it('when parked on background work or crons', () => {
    expect(isParked({ background_tasks: 1 })).toBe(true);
    expect(decide({ event: ev({ background_tasks: 2 }), testOutcome: 'red', pr: pr(), mergeAuthority: true })).toBeNull();
    expect(decide({ event: ev({ session_crons: [{}] }), testOutcome: 'red', pr: pr(), mergeAuthority: true })).toBeNull();
  });
  it('on the re-run after a block', () => {
    expect(decide({ event: ev({ stop_hook_active: true }), testOutcome: 'red', pr: pr(), mergeAuthority: true })).toBeNull();
  });
  it('when the task has no open PR', () => {
    expect(decide({ event: ev(), testOutcome: 'red', pr: null, mergeAuthority: true })).toBeNull();
  });
});

describe('latestVerdict', () => {
  it('takes the most recent verdict', () => {
    expect(latestVerdict([verdict('block'), 'chatter', verdict('pass')])?.verdict).toBe('pass');
  });
});

describe('integration branch (#3797)', () => {
  it('exempts the configured integration branch like main', () => {
    expect(isSharedBranch('staging', 'staging')).toBe(true);
    expect(isSharedBranch('main', 'staging')).toBe(true);
    expect(isSharedBranch('feat-x', 'staging')).toBe(false);
  });
  it('without a config, staging is an ordinary branch (legacy behaviour)', () => {
    expect(isSharedBranch('staging', null)).toBe(false);
    expect(isSharedBranch('main', null)).toBe(true);
    expect(isSharedBranch('HEAD', null)).toBe(true);
    expect(isSharedBranch('', null)).toBe(true);
  });
  it.each([
    '{"integrationBranch":"staging"}',
    '{"integrationBranch":"release/next"}',
    '{"integrationBranch":"main"}',
    '{"integrationBranch":"--evil"}',
    '{"integrationBranch":"a..b"}',
    '{"integrationBranch":"a b"}',
    '{"integrationBranch":""}',
    '{"integrationBranch":3}',
    '{"prePushGate":"fast"}',
    '{}',
    '"staging"',
    '[]',
    'null',
    'not json',
  ])('parser matches src/core/integration-branch.ts for %s', (json) => {
    expect(parseIntegrationBranch(json)).toBe(parseIntegrationBranchTs(json));
  });
});

describe('readIntegrationBranch matches src/core/delivery-gate-config.ts (#3797)', () => {
  const dirs = [];
  const repo = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stop-hook-gate-'));
    dirs.push(dir);
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'root');
    return { dir, git };
  };
  const writeConfig = (dir, json) => {
    mkdirSync(path.join(dir, '.kookr'), { recursive: true });
    writeFileSync(path.join(dir, '.kookr', 'delivery-gate.json'), json);
  };
  const both = async (dir) => {
    const js = readIntegrationBranch(dir);
    expect(js).toBe(await readIntegrationBranchTs(dir));
    return js;
  };

  it('no config: null', async () => {
    const { dir } = repo();
    expect(await both(dir)).toBeNull();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('working tree when origin/main is missing', async () => {
    const { dir } = repo();
    writeConfig(dir, '{"integrationBranch":"staging"}');
    expect(await both(dir)).toBe('staging');
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('origin/main wins over the working tree, including its absence', async () => {
    const { dir, git } = repo();
    writeConfig(dir, '{"integrationBranch":"staging"}');
    git('add', '.kookr/delivery-gate.json');
    git('commit', '-q', '-m', 'config');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(await both(dir)).toBe('staging');
    git('rm', '-q', '.kookr/delivery-gate.json');
    git('commit', '-q', '-m', 'revert');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeConfig(dir, '{"integrationBranch":"staging"}');
    expect(await both(dir)).toBeNull();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});
