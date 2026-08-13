import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWritingReviewNudgePath } from '../../core/hook-writer-paths.js';
import { buildGrokWritingReviewNudgeConfig } from './writing-review-nudge.js';

const SCRIPT = resolveWritingReviewNudgePath();

function runNudge(payload: unknown, env: NodeJS.ProcessEnv = {}): { status: number; stdout: string } {
  if (!SCRIPT) throw new Error('nudge script missing');
  const tmp = mkdtempSync(join(tmpdir(), 'writing-nudge-'));
  try {
    const result = spawnSync('/bin/bash', [SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmp, GROK_HOME: '', ...env },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? '' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('kookr-writing-review-nudge', () => {
  it('resolves the bundled script and emits a PreToolUse matcher', () => {
    expect(SCRIPT).toMatch(/kookr-writing-review-nudge\.sh$/);
    const cfg = buildGrokWritingReviewNudgeConfig();
    expect(cfg?.hooks.PreToolUse[0]?.matcher).toBe('Bash');
    expect(cfg?.hooks.PreToolUse[0]?.hooks[0]?.type).toBe('command');
    expect(cfg?.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(`/bin/bash '${SCRIPT}'`);
    expect(cfg?.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(10);
  });

  it('denies the first Grok-shaped gh pr create and allows the retry', () => {
    if (!SCRIPT) throw new Error('nudge script missing');
    const tmp = mkdtempSync(join(tmpdir(), 'writing-nudge-'));
    const payload = {
      sessionId: 'sess-grok-1',
      toolInput: { command: 'gh pr create --title docs --body-file data/pr-body.md' },
    };
    try {
      const env = { ...process.env, TMPDIR: tmp, GROK_HOME: '' };
      const first = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env,
      });
      expect(first.status).toBe(0);
      const denied = JSON.parse(first.stdout);
      expect(denied.decision).toBe('deny');
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(denied.reason).toMatch(/clear-technical-writing/);
      expect(denied.reason).toMatch(/clear-writing-reviewer/);
      expect(denied.reason).toMatch(/nits/);

      const second = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env,
      });
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stores the deny-once marker under GROK_HOME when set', () => {
    if (!SCRIPT) throw new Error('nudge script missing');
    const tmp = mkdtempSync(join(tmpdir(), 'writing-nudge-'));
    const home = join(tmp, 'grok-home');
    const payload = {
      sessionId: 'sess-home-1',
      toolInput: { command: 'gh pr create --title docs' },
    };
    try {
      mkdirSync(home, { recursive: true });
      const env = { ...process.env, TMPDIR: tmp, GROK_HOME: home };
      const first = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env,
      });
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).decision).toBe('deny');
      expect(existsSync(join(home, 'kookr-writing-review-nudge-sess-home-1'))).toBe(true);
      const second = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env,
      });
      expect(second.stdout.trim()).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not share a lock across missing session ids when GROK_HOME is unset', () => {
    if (!SCRIPT) throw new Error('nudge script missing');
    const tmp = mkdtempSync(join(tmpdir(), 'writing-nudge-'));
    const payload = {
      toolInput: { command: 'gh pr create --title docs' },
    };
    try {
      const first = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp, GROK_HOME: '' },
      });
      const second = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp, GROK_HOME: '' },
      });
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout.trim()).toBe('');
      expect(second.stdout.trim()).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps two session ids independent under the same TMPDIR', () => {
    if (!SCRIPT) throw new Error('nudge script missing');
    const tmp = mkdtempSync(join(tmpdir(), 'writing-nudge-'));
    const env = { ...process.env, TMPDIR: tmp, GROK_HOME: '' };
    try {
      const a = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify({
          sessionId: 'sess-a',
          toolInput: { command: 'gh pr create --title a' },
        }),
        encoding: 'utf8',
        env,
      });
      const b = spawnSync('/bin/bash', [SCRIPT], {
        input: JSON.stringify({
          sessionId: 'sess-b',
          toolInput: { command: 'gh pr create --title b' },
        }),
        encoding: 'utf8',
        env,
      });
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(JSON.parse(a.stdout).decision).toBe('deny');
      expect(JSON.parse(b.stdout).decision).toBe('deny');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts Claude snake_case payloads and ignores non-create commands', () => {
    const ignored = runNudge({
      session_id: 'sess-claude-1',
      tool_input: { command: 'gh pr view 12' },
    });
    expect(ignored.status).toBe(0);
    expect(ignored.stdout.trim()).toBe('');

    const first = runNudge({
      session_id: 'sess-claude-1',
      tool_input: { command: 'cd /tmp && gh pr create --title x' },
    });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).decision).toBe('deny');
  });
});
