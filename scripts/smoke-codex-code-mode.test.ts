import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SMOKE_SCRIPT = resolve('scripts/smoke-codex-code-mode.mjs');

function writeFakeCodex(directory: string, jsonl: string, exitCode = 0): string {
  const path = join(directory, 'codex');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' ${JSON.stringify(jsonl)}\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function runSmoke(codex: string, marker: string) {
  return spawnSync(process.execPath, [SMOKE_SCRIPT, '--codex', codex], {
    cwd: resolve('.'),
    env: { ...process.env, CODEX_IPC_SMOKE_EXPECTED_MARKER: marker },
    encoding: 'utf8',
  });
}

describe('Codex code-mode IPC smoke', () => {
  it('accepts the marker only in a completed command result', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(
      directory,
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          status: 'completed',
          exit_code: 0,
          aggregated_output: `${marker}\n`,
        },
      }),
    );

    try {
      const result = runSmoke(codex, marker);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('code-mode IPC smoke passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a marker that appears only in an assistant message', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(
      directory,
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: marker },
      }),
    );

    try {
      const result = runSmoke(codex, marker);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('marker was not observed in a completed command result');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails when Codex exits unsuccessfully', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(directory, JSON.stringify({ type: 'turn.failed' }), 1);

    try {
      const result = runSmoke(codex, marker);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Codex smoke process exited with status 1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
