import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookCommand,
  buildStopNudgeCommand,
  resolveAgentLauncherBinDir,
  resolveHookWriterPath,
  resolveStopNudgePath,
  resolveWritingReviewNudgePath,
} from './hook-writer-paths.js';

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

describe('resolveAgentLauncherBinDir', () => {
  it('returns the bin dir when the `kookr` launcher exists relative to baseDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-launcher-paths-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'kookr'), '#!/bin/sh\n');
      // Simulate dist/core/ or src/core/ — two levels up lands on root.
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveAgentLauncherBinDir(baseDir)).toBe(binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the launcher is missing (only bin/kookr.js present)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-launcher-paths-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      // The Node entry point exists but the extensionless launcher does not —
      // exactly the issue #786 state. Prepend nothing rather than a broken dir.
      writeFileSync(join(binDir, 'kookr.js'), '// stub');
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveAgentLauncherBinDir(baseDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildHookCommand', () => {
  it('emits the writer pipeline when writerPath is provided + serverPort set', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/tmp/kookr-hooks/kookr-deadbeef.jsonl',
      serverPort: 4800,
      writerPath: '/opt/kookr/bin/kookr-hook-writer.js',
      nodePath: '/usr/bin/node',
    });
    expect(cmd).toBe(
      "'/usr/bin/node' '/opt/kookr/bin/kookr-hook-writer.js' --session 'kookr-deadbeef' --file '/tmp/kookr-hooks/kookr-deadbeef.jsonl' --url 'http://localhost:4800/api/hook-event/kookr-deadbeef'",
    );
  });

  it('omits --url when serverPort is not set', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/h.jsonl',
      writerPath: '/opt/kookr/bin/kookr-hook-writer.js',
      nodePath: '/usr/bin/node',
    });
    expect(cmd).toBe("'/usr/bin/node' '/opt/kookr/bin/kookr-hook-writer.js' --session 'kookr-deadbeef' --file '/h.jsonl'");
  });

  it('quotes the node path used for the writer command', () => {
    const cmd = buildHookCommand({
      tmuxName: 'kookr-deadbeef',
      hookFile: '/h.jsonl',
      writerPath: '/opt/kookr/bin/kookr-hook-writer.js',
      nodePath: "/tmp/node's/bin/node",
    });
    expect(cmd).toBe(
      "'/tmp/node'\\''s/bin/node' '/opt/kookr/bin/kookr-hook-writer.js' --session 'kookr-deadbeef' --file '/h.jsonl'",
    );
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

describe('resolveStopNudgePath', () => {
  it('finds the nudge script relative to a baseDir two levels under repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-nudge-resolve-'));
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(join(root, 'bin', 'kookr-stop-nudge.js'), '// stub');
      const baseDir = join(root, 'dist', 'core');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveStopNudgePath(baseDir)).toBe(join(root, 'bin', 'kookr-stop-nudge.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the nudge script is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-nudge-missing-'));
    try {
      const baseDir = join(root, 'dist', 'core');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveStopNudgePath(baseDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveWritingReviewNudgePath', () => {
  it('finds the nudge script relative to a baseDir two levels under repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-writing-nudge-resolve-'));
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(join(root, 'bin', 'kookr-writing-review-nudge.sh'), '#!/bin/bash\n');
      const baseDir = join(root, 'dist', 'core');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveWritingReviewNudgePath(baseDir)).toBe(
        join(root, 'bin', 'kookr-writing-review-nudge.sh'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the nudge script is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-writing-nudge-missing-'));
    try {
      const baseDir = join(root, 'dist', 'core');
      mkdirSync(baseDir, { recursive: true });
      expect(resolveWritingReviewNudgePath(baseDir)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildStopNudgeCommand', () => {
  it('builds a quoted `node <nudge>` command', () => {
    expect(buildStopNudgeCommand({ nudgePath: '/x/bin/kookr-stop-nudge.js', nodePath: '/usr/bin/node' }))
      .toBe("'/usr/bin/node' '/x/bin/kookr-stop-nudge.js'");
  });
});
