import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SMOKE_SCRIPT = resolve('scripts/smoke-codex-code-mode.mjs');

function writeFakeCodex(directory: string, jsonl: string, exitCode = 0): string {
  const path = join(directory, 'codex');
  const stdoutPath = join(directory, 'stdout.jsonl');
  writeFileSync(stdoutPath, `${jsonl}\n`);
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$@" > ${JSON.stringify(join(directory, 'argv.log'))}\nprintf '%s' "\${CODEX_IPC_SMOKE_MARKER:-}" > ${JSON.stringify(join(directory, 'marker.log'))}\nprintf '%s' "$PWD" > ${JSON.stringify(join(directory, 'cwd.log'))}\ncommand cat ${JSON.stringify(stdoutPath)}\nexit ${exitCode}\n`,
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
  it('accepts the marker only after a completed command-to-response round trip', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(
      directory,
      [
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
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_2', type: 'agent_message', text: marker },
        }),
      ].join('\n'),
    );

    try {
      const result = runSmoke(codex, marker);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('code-mode IPC smoke passed');
      const args = readFileSync(join(directory, 'argv.log'), 'utf8').trimEnd().split('\n');
      expect(args).toEqual(expect.arrayContaining([
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        'features.code_mode={enabled=true}',
        'features.code_mode_only=true',
        'features.code_mode_host={enabled=true,disable_in_process_fallback=true}',
      ]));
      expect(args.at(-1)).toContain('Call functions.exec');
      expect(args.at(-1)).toContain('reply only with the exact value returned');
      expect(readFileSync(join(directory, 'marker.log'), 'utf8')).toBe(marker);
      expect(readFileSync(join(directory, 'cwd.log'), 'utf8')).toBe(tmpdir());
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
      expect(result.stderr).toContain(
        'marker did not complete the command-to-final-response code-mode round trip',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a command marker that is not returned after the host response', () => {
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
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('command-to-final-response code-mode round trip');
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
