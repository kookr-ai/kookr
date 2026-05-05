import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Drives the parse-frontmatter.ts hook directly. The hook reads a
 * Claude Code PreToolUse event from stdin and exits 0 (allow) or 2 (block).
 *
 * These tests cover the failure-mode-analyst concerns explicitly:
 *   - Memory path with `type: feedback` → block
 *   - Memory path with no frontmatter → block (fail-closed)
 *   - Memory path with malformed YAML → block
 *   - Memory path with `type: context` → allow
 *   - Non-memory path → allow (out of scope for the gate)
 *   - Edit replaces text in an existing memory file → uses post-edit content
 */

const PARSER = join(__dirname, '..', '..', '..', 'plugin', 'hooks', 'parse-frontmatter.ts');
const PARSER_ARGS = ['--import', 'tsx', PARSER] as const;

function runHook(input: object, env: Record<string, string> = {}): { exitCode: number; stderr: string } {
  const result = spawnSync(process.execPath, PARSER_ARGS, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, ...env, HOME: env.HOME ?? '/home/test' },
  });
  return { exitCode: result.status ?? -1, stderr: result.stderr };
}

describe('parse-frontmatter (memory write gate)', () => {
  const memPath = '/home/test/.claude/projects/-myproj/memory/some.md';

  test('non-Write tool is allowed without inspection', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: memPath } });
    expect(result.exitCode).toBe(0);
  });

  test('Write to a non-memory path is allowed', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/scratch.md', content: '---\ntype: feedback\n---\nx' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('Write to memory with type: feedback is BLOCKED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\nname: x\ntype: feedback\n---\nbody' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('feedback');
  });

  test('Write to memory with type: context is ALLOWED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\nname: x\ntype: context\n---\nbody' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('Write to memory with type: reference is ALLOWED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\nname: x\ntype: reference\n---\nbody' },
    });
    expect(result.exitCode).toBe(0);
  });

  test('Write to memory with no frontmatter is BLOCKED (fail-closed)', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: 'just body, no frontmatter' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/frontmatter/i);
  });

  test('Write to memory with unclosed frontmatter is BLOCKED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\ntype: context\nbody without close' },
    });
    expect(result.exitCode).toBe(2);
  });

  test('Write to memory with type field absent from frontmatter is BLOCKED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\nname: x\ndescription: y\n---\nbody' },
    });
    expect(result.exitCode).toBe(2);
  });

  test('Write to memory with unrecognized type value is BLOCKED', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memPath, content: '---\ntype: bogus\n---\nbody' },
    });
    expect(result.exitCode).toBe(2);
  });

  test('Edit on existing memory uses post-edit content for inspection', () => {
    // Create a real file with type: context, then edit to change to type: feedback
    const dir = mkdtempSync(join(tmpdir(), 'frontmatter-test-'));
    mkdirSync(join(dir, '.claude/projects/-myproj/memory'), { recursive: true });
    const filePath = join(dir, '.claude/projects/-myproj/memory/some.md');
    writeFileSync(filePath, '---\ntype: context\nname: ok\n---\nbody');
    const result = runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'type: context', new_string: 'type: feedback' },
      },
      { HOME: dir },
    );
    expect(result.exitCode).toBe(2);
  });

  test('legacy auto-memory types (user, project) are allowed', () => {
    for (const type of ['user', 'project']) {
      const result = runHook({
        tool_name: 'Write',
        tool_input: { file_path: memPath, content: `---\nname: x\ntype: ${type}\n---\nbody` },
      });
      expect(result.exitCode).toBe(0);
    }
  });

  test('malformed JSON event itself is BLOCKED (fail-closed)', () => {
    const result = spawnSync(process.execPath, PARSER_ARGS, {
      input: 'this is not json',
      encoding: 'utf-8',
      env: { ...process.env, HOME: '/home/test' },
    });
    expect(result.status).toBe(2);
  });
});
