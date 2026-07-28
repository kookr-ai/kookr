import { describe, expect, test, vi } from 'vitest';

// runKbRemember shells out; unit-test the write-fn adapter with a mock by
// exercising createKbRememberWriteFn against a fake PATH entry is heavier than
// needed. Cover the pure redact path indirectly via failure shaping is hard
// without a real binary — keep a thin contract test that documents the API.

describe('createKbRememberWriteFn', () => {
  test('exports a LessonWriteFn factory', async () => {
    const { createKbRememberWriteFn } = await import('./lesson-write-runner.js');
    const write = createKbRememberWriteFn({ kbBin: 'kb-that-does-not-exist-xyz' });
    const result = await write({
      kb: 'agent-task-lessons',
      title: 't',
      body: 'body\n',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found|ENOENT|kb/i);
  });
});

// Silence unused vi import when no mocks used — keep for future expansion.
void vi;
