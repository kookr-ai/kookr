import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeManagedPairManifest(directory: string, codex: string, sourceCommit: string) {
  const host = join(directory, 'codex-code-mode-host');
  const manifestPath = join(directory, 'codex-pair.json');
  writeFileSync(host, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(host, 0o755);
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    sourceCommit,
    source: 'source-build',
    cliSha256: sha256(codex),
    hostSha256: sha256(host),
  })}\n`);
  return { host, manifestPath };
}

function runSmoke(codex: string, marker: string, expectedSourceCommit?: string) {
  const args = [SMOKE_SCRIPT, '--codex', codex];
  if (expectedSourceCommit) args.push('--expected-source-commit', expectedSourceCommit);
  return spawnSync(process.execPath, args, {
    cwd: resolve('.'),
    env: { ...process.env, CODEX_IPC_SMOKE_EXPECTED_MARKER: marker },
    encoding: 'utf8',
  });
}

describe('Codex code-mode IPC smoke validator and invocation', () => {
  it('accepts the marker only after a completed command-to-response round trip', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const sourceCommit = 'a'.repeat(40);
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
    writeManagedPairManifest(directory, codex, sourceCommit);

    try {
      const result = runSmoke(codex, marker, sourceCommit);
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
      for (const value of [
        'features.code_mode={enabled=true}',
        'features.code_mode_only=true',
        'features.code_mode_host={enabled=true,disable_in_process_fallback=true}',
      ]) {
        expect(args[args.indexOf(value) - 1]).toBe('-c');
      }
      expect(args.at(-1)).toContain('Call functions.exec');
      expect(args.at(-1)).toContain('reply only with the exact value returned');
      expect(readFileSync(join(directory, 'marker.log'), 'utf8')).toBe(marker);
      expect(readFileSync(join(directory, 'cwd.log'), 'utf8')).toBe(tmpdir());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a managed CLI whose public host executable is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(directory, '');

    try {
      const result = runSmoke(codex, marker, 'a'.repeat(40));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('managed Codex host is missing or not executable');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['CLI', 'codex'],
    ['host', 'host'],
  ] as const)('rejects a managed pair whose %s hash differs from its manifest', (_label, target) => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const sourceCommit = 'a'.repeat(40);
    const codex = writeFakeCodex(directory, '');
    const { host } = writeManagedPairManifest(directory, codex, sourceCommit);
    writeFileSync(target === 'codex' ? codex : host, '#!/usr/bin/env bash\nexit 1\n');

    try {
      const result = runSmoke(codex, marker, sourceCommit);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'managed Codex pair manifest, source commit, or executable hashes do not match',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a managed pair whose source commit differs from the expected checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(directory, '');
    writeManagedPairManifest(directory, codex, 'a'.repeat(40));

    try {
      const result = runSmoke(codex, marker, 'b'.repeat(40));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'managed Codex pair manifest, source commit, or executable hashes do not match',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a managed pair whose manifest is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(directory, '');
    const host = join(directory, 'codex-code-mode-host');
    writeFileSync(host, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(host, 0o755);

    try {
      const result = runSmoke(codex, marker, 'a'.repeat(40));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('could not read managed Codex pair manifest');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a managed pair with an unsupported manifest schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const marker = 'kookr-ipc-smoke-test-marker';
    const sourceCommit = 'a'.repeat(40);
    const codex = writeFakeCodex(directory, '');
    const { manifestPath } = writeManagedPairManifest(directory, codex, sourceCommit);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: 2 })}\n`);

    try {
      const result = runSmoke(codex, marker, sourceCommit);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'managed Codex pair manifest, source commit, or executable hashes do not match',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects public CLI and host paths that resolve to different runtime directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kookr-codex-smoke-'));
    const otherPair = join(directory, 'other-pair');
    const marker = 'kookr-ipc-smoke-test-marker';
    const codex = writeFakeCodex(directory, '');
    mkdirSync(otherPair);
    const otherHost = join(otherPair, 'codex-code-mode-host');
    writeFileSync(otherHost, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(otherHost, 0o755);
    symlinkSync(otherHost, join(directory, 'codex-code-mode-host'));

    try {
      const result = runSmoke(codex, marker, 'a'.repeat(40));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'managed Codex CLI and host do not resolve to the same runtime pair',
      );
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
