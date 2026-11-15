import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EXIT_CODEX_UNUSABLE, EXIT_OK, EXIT_USAGE, MAX_PROMPT_BYTES, codexArgs, parseArgs, readSettings, runLane } from './codex-review-lane.mjs';

const SCRIPT = fileURLToPath(new URL('./codex-review-lane.mjs', import.meta.url));

// A fake `codex` on PATH. FAKE_CODEX_MODE picks its behaviour; every call appends
// its argv to FAKE_CODEX_LOG so tests can check what the lane passed.
const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
const prompt = args[args.length - 1];
// Like real codex's argument parser: a dash-leading prompt must follow '--'.
if (prompt.startsWith('-') && args[args.length - 2] !== '--') { process.stderr.write('error: unexpected argument\\n'); process.exit(2); }
const preflight = prompt.startsWith('Reply with exactly the word OK');
const mode = process.env.FAKE_CODEX_MODE;
if (mode === 'reject') {
  process.stderr.write('ERROR: {"error":{"code":"model_not_found","message":"The model does not exist"}}\\n');
  process.exit(1);
}
if (mode === 'reject-exit0') {
  process.stderr.write('stream error: model_not_found\\n');
  process.exit(0);
}
if (mode === 'hang' || (mode === 'review-hangs' && !preflight)) setInterval(() => {}, 1000);
else if (mode === 'review-empty' && !preflight) process.exit(0);
else if (mode === 'echo-prompt' && preflight) process.stdout.write(prompt + '\\n');
else if (mode === 'review-fails' && !preflight) { process.stderr.write('usage limit reached\\n'); process.exit(1); }
else {
  const answer = () => process.stdout.write(preflight ? 'OK\\n' : 'VERDICT: PASS\\nno confirmed findings\\n');
  // 'stdin' mode behaves like real codex exec: it reads stdin to EOF first, so it
  // would hang forever if the lane left stdin open.
  if (mode === 'stdin') { process.stdin.resume(); process.stdin.on('end', answer); }
  else answer();
}
`;

let dir, bin, log, promptFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-lane-'));
  bin = join(dir, 'bin');
  log = join(dir, 'calls.log');
  promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, 'Review the diff and return VERDICT: PASS or BLOCK.');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), FAKE_CODEX);
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'bwrap'), 0o755);
  writeFileSync(log, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the lane CLI with stdin left OPEN (a pipe never written or closed). */
function runCli({ mode, env = {}, args = ['--prompt-file', promptFile], script = SCRIPT }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: bin, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('codex-review-lane CLI', () => {
  test('a model the API rejects exits with the unusable code fast, before any review call', async () => {
    const r = await runCli({ mode: 'reject', env: { KOOKR_CODEX_REVIEW_MODEL: 'bad-model' } });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.stderr).toMatch(/preflight failed \(model bad-model/);
    expect(r.stderr).toMatch(/model_not_found/);
    expect(r.stdout).toBe('');
    expect(calls()).toHaveLength(1); // preflight only
  });

  test('the exit codes are the numbers SKILL.md documents', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_CODEX_UNUSABLE).toBe(3);
  });

  test('a rejected model is caught even when codex exits 0 without answering OK', async () => {
    const r = await runCli({ mode: 'reject-exit0' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/preflight failed .*model_not_found/s);
    expect(calls()).toHaveLength(1);
  });

  test('a preflight that only echoes the prompt (which contains the word OK) does not pass', async () => {
    const r = await runCli({ mode: 'echo-prompt' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/preflight failed/);
  });

  test('a review that hangs after a good preflight is killed at the review timeout', async () => {
    const r = await runCli({ mode: 'review-hangs', env: { KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT: '10', KOOKR_CODEX_REVIEW_TIMEOUT: '1' } });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/review timed out after 1s/);
  });

  test('a review that exits 0 with no output is unusable', async () => {
    const r = await runCli({ mode: 'review-empty' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/review failed \(exit 0\)/);
  });

  test('KOOKR_CODEX_REVIEW_SANDBOX overrides the sandbox mode', async () => {
    const r = await runCli({ mode: 'answer', env: { KOOKR_CODEX_REVIEW_SANDBOX: 'workspace-write' } });
    expect(r.code).toBe(EXIT_OK);
    for (const call of calls()) expect(call.slice(1, 4)).toEqual(['--skip-git-repo-check', '--sandbox', 'workspace-write']);
  });

  test('a hung preflight is killed at the preflight timeout', async () => {
    const r = await runCli({ mode: 'hang', env: { KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT: '1' } });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/preflight timed out after 1s/);
    expect(r.ms).toBeLessThan(10_000);
  });

  test('a working model returns the reviewer output and passes the configured model and sandbox', async () => {
    const r = await runCli({ mode: 'answer', env: { KOOKR_CODEX_REVIEW_MODEL: 'good-model' }, args: ['--prompt-file', promptFile, '--repo-dir', dir] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe('VERDICT: PASS\nno confirmed findings\n');
    const [pre, review] = calls();
    expect(pre).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"', '--model', 'good-model', '--cd', dir, '--', expect.stringMatching(/^Reply with exactly the word OK/)]);
    expect(review.at(-1)).toBe('Review the diff and return VERDICT: PASS or BLOCK.');
    expect(review).toContain('good-model');
    expect(review).toContain('model_reasoning_effort="high"');
  });

  test('a prompt that starts with front matter dashes is passed after --', async () => {
    writeFileSync(promptFile, '---\nrole: reviewer\n---\nReview the diff.');
    const r = await runCli({ mode: 'answer' });
    expect(r.code).toBe(EXIT_OK);
    expect(calls()[1].slice(-2)).toEqual(['--', '---\nrole: reviewer\n---\nReview the diff.']);
  });

  test('an oversized prompt is a usage error before any codex call', async () => {
    writeFileSync(promptFile, 'x'.repeat(MAX_PROMPT_BYTES + 1));
    const r = await runCli({ mode: 'answer' });
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/reference the diff file by path/);
    expect(calls()).toHaveLength(0);
  });

  test('never waits on stdin: a codex that reads stdin to EOF still answers while the caller keeps stdin open', async () => {
    // If the lane left stdin open, the fake would block until these timeouts and exit 3.
    const r = await runCli({ mode: 'stdin', env: { KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT: '10', KOOKR_CODEX_REVIEW_TIMEOUT: '10' } });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('VERDICT: PASS');
  }, 30_000);

  test('a review run that fails after a good preflight is reported as unusable', async () => {
    const r = await runCli({ mode: 'review-fails' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/review failed \(exit 1\): usage limit reached/);
  });

  test('no codex binary on PATH is unusable', async () => {
    rmSync(join(bin, 'codex'));
    const r = await runCli({ mode: 'answer' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/codex binary not found/);
  });

  test.skipIf(process.platform !== 'linux')('missing bubblewrap on Linux is unusable without calling codex', async () => {
    rmSync(join(bin, 'bwrap'));
    const r = await runCli({ mode: 'answer' });
    expect(r.code).toBe(EXIT_CODEX_UNUSABLE);
    expect(r.stderr).toMatch(/bubblewrap \(bwrap\) not installed/);
    expect(calls()).toHaveLength(0);
  });

  test('bubblewrap is not required off Linux', () => {
    rmSync(join(bin, 'bwrap'));
    const r = runLane({ prompt: 'p', platform: 'darwin', env: { PATH: bin, FAKE_CODEX_MODE: 'answer', FAKE_CODEX_LOG: log } });
    expect(r.code).toBe(EXIT_OK);
    expect(calls()).toHaveLength(2);
  });

  test('runs when reached through a symlinked directory', async () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    copyFileSync(SCRIPT, join(real, 'codex-review-lane.mjs'));
    symlinkSync(real, join(dir, 'link'));
    const r = await runCli({ mode: 'answer', script: join(dir, 'link', 'codex-review-lane.mjs') });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('VERDICT: PASS');
  });

  test('a missing prompt file is a usage error, not a fallback signal', async () => {
    const r = await runCli({ mode: 'answer', args: ['--prompt-file', join(dir, 'nope.md')] });
    expect(r.code).toBe(EXIT_USAGE);
    expect(calls()).toHaveLength(0);
  });
});

describe('codex-review-lane helpers', () => {
  test('parseArgs requires --prompt-file and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--prompt-file is required/);
    expect(() => parseArgs(['--prompt-file', 'p', '--model', 'x'])).toThrow(/unknown argument: --model/);
  });

  test('readSettings defaults and an unset model leaves --model off', () => {
    const s = readSettings({ KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT: 'junk' });
    expect(s).toEqual({ model: null, sandbox: 'read-only', preflightTimeoutS: 25, reviewTimeoutS: 570 });
    expect(codexArgs(s, 'p', null)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'model_reasoning_effort="high"', '--', 'p']);
  });
});
