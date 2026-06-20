import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

import { probeKbPresence, CAPABILITY_PROBES } from './launch-capability-probe.js';

type ExecFileCallback = (
  error: (NodeJS.ErrnoException & { killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

function mockCommand(
  handler: (file: string, args: string[]) => {
    code?: string | number;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
  } | null,
) {
  mockExecFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const result = handler(file, args);
      if (!result) {
        cb(null, '', '');
        return;
      }
      const error = new Error(`${file} failed`) as NodeJS.ErrnoException & { killed?: boolean };
      if (result.code !== undefined) error.code = result.code as unknown as string;
      if (result.killed) error.killed = true;
      cb(error, result.stdout ?? '', result.stderr ?? '');
    },
  );
}

describe('probeKbPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('resolves to "available" when the spawn succeeds (exit 0)', async () => {
    mockCommand(() => null);
    await expect(probeKbPresence()).resolves.toBe('available');
  });

  test('resolves to "absent" on ENOENT (binary not on PATH)', async () => {
    mockCommand(() => ({ code: 'ENOENT' }));
    await expect(probeKbPresence()).resolves.toBe('absent');
  });

  test('resolves to undefined on timeout (killed=true)', async () => {
    mockCommand(() => ({ killed: true, code: undefined }));
    await expect(probeKbPresence()).resolves.toBeUndefined();
  });

  test('resolves to undefined on EACCES (non-executable binary)', async () => {
    mockCommand(() => ({ code: 'EACCES' }));
    await expect(probeKbPresence()).resolves.toBeUndefined();
  });

  test('resolves to undefined on ENOEXEC (wrong-arch binary)', async () => {
    mockCommand(() => ({ code: 'ENOEXEC' }));
    await expect(probeKbPresence()).resolves.toBeUndefined();
  });

  test('resolves to "available" on numeric non-zero exit (binary ran)', async () => {
    // execFile sets a numeric `code` for non-zero exit. The probe falls through
    // to fail-open `available` — the binary spawned and ran, so it is present.
    mockCommand(() => ({ code: 1 }));
    await expect(probeKbPresence()).resolves.toBe('available');
  });

  test('checks killed before code so a timed-out process is not misclassified as absent', async () => {
    // Defensive: even if the timeout error somehow carried code: 'ENOENT', the
    // `killed` branch must win to avoid a confident wrong `absent`.
    mockCommand(() => ({ killed: true, code: 'ENOENT' }));
    await expect(probeKbPresence()).resolves.toBeUndefined();
  });

  test('spawns `kb --version` with a bounded timeout', async () => {
    mockCommand(() => null);
    await probeKbPresence();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExecFile.mock.calls[0];
    expect(file).toBe('kb');
    expect(args).toEqual(['--version']);
    // Asserting on the options ensures the timeout is actually wired up — the
    // timeout-→-undefined behavior the rest of this suite relies on assumes it.
    expect(opts).toMatchObject({ timeout: expect.any(Number) });
    expect((opts as { timeout: number }).timeout).toBeGreaterThan(0);
    expect(opts).toMatchObject({ maxBuffer: expect.any(Number) });
  });
});

describe('CAPABILITY_PROBES', () => {
  test('wires every supported launch dependency to a probe', () => {
    // The Record<LaunchDependency, ...> type already enforces exhaustiveness
    // at compile time — adding a new LAUNCH_DEPENDENCIES member without
    // wiring a probe here is a TS error.
    expect(Object.keys(CAPABILITY_PROBES).sort()).toEqual(['evolution-config', 'kb']);
  });

  test('wires evolution-config to project-local config validation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-probe-'));
    try {
      await expect(CAPABILITY_PROBES['evolution-config'](cwd)).resolves.toBe('absent');

      await mkdir(join(cwd, '.kookr', 'evolution'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'evolution', 'config.json'), JSON.stringify({
        schemaVersion: 'kookr-evolution-config.v1',
        evaluate: './evaluate.sh',
        artifact: 'strategy.json',
      }));

      await expect(CAPABILITY_PROBES['evolution-config'](cwd)).resolves.toBe('available');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
