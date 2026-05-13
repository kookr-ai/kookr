import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookCommand, resolveHookWriterPath } from './hook-writer-paths.js';

describe('resolveHookWriterPath', () => {
  it('returns the writer path when the bin file exists relative to baseDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-writer-paths-'));
    try {
      const binDir = join(root, 'bin');
      const writerPath = join(binDir, 'kookr-hook-writer.js');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(writerPath, '// stub');
      // Simulate dist/core/ or src/core/ — two levels up lands on root.
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveHookWriterPath(baseDir)).toBe(writerPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the writer is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-writer-paths-'));
    try {
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveHookWriterPath(baseDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildHookCommand', () => {
  it('emits the writer pipeline when writerPath is provided + serverPort set', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/home/u/.kookr/hooks/kookr-deadbeef.jsonl',
      serverPort: 4800,
      writerPath: '/opt/kookr/bin/kookr-hook-writer.js',
    });
    expect(cmd).toBe(
      "node '/opt/kookr/bin/kookr-hook-writer.js' --session 'kookr-deadbeef' --file '/home/u/.kookr/hooks/kookr-deadbeef.jsonl' --url 'http://localhost:4800/api/hook-event/kookr-deadbeef'",
    );
  });

  it('omits --url when serverPort is not set', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/h.jsonl',
      writerPath: '/opt/kookr/bin/kookr-hook-writer.js',
    });
    expect(cmd).toBe("node '/opt/kookr/bin/kookr-hook-writer.js' --session 'kookr-deadbeef' --file '/h.jsonl'");
  });

  it('falls back to legacy awk + curl when writerPath is missing', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/h.jsonl',
      serverPort: 4800,
    });
    expect(cmd).toContain("awk -v file='/h.jsonl'");
    expect(cmd).toContain('curl -s -X POST http://localhost:4800/api/hook-event/kookr-deadbeef');
  });

  it('falls back to file-only awk when writer and serverPort are both missing', () => {
    const cmd = buildHookCommand({ tmuxName: 'kookr-deadbeef', hookFile: '/h.jsonl' });
    expect(cmd).toBe("awk -v file='/h.jsonl' '{ print >> file }'");
  });
});
