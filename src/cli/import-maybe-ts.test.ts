// Regression for issue #2095: plain-node source fallback must resolve the
// TypeScript dependency graph (relative `.js` → `.ts`) without a prior
// `pnpm build:server`. The bin helper activates tsx only when the entry is .ts.
//
// Issue #3301 extends the same dist→src fallback to five dispatcher handlers
// that still required a compiled `dist/` tree (`maintenance`, `lesson`,
// `emission`, `retro-verify`, `command outcome`).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { importMaybeTs } from '../../bin/import-maybe-ts.js';

const execFileAsync = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dispatcherPath = join(repoRoot, 'bin/kookr.js');
const contextPackSource = join(repoRoot, 'src/cli/kookr-context-pack.ts');
const contextPackDist = join(repoRoot, 'dist/cli/kookr-context-pack.js');

const LAGGING_COMMANDS = [
  {
    stem: 'kookr-maintenance',
    handler: 'runMaintenanceCommand',
    exportName: 'runMaintenanceCli',
  },
  {
    stem: 'kookr-lesson',
    handler: 'runLessonCommand',
    exportName: 'runLessonCli',
  },
  {
    stem: 'kookr-emission',
    handler: 'runEmissionCommand',
    exportName: 'runEmissionCli',
  },
  {
    stem: 'kookr-retro-verify',
    handler: 'runRetroVerifyCommand',
    exportName: 'runRetroVerifyCli',
  },
  {
    stem: 'kookr-command-outcome',
    handler: 'runCommandOutcomeCommand',
    exportName: 'runCommandOutcomeCli',
  },
] as const;

function handlerBody(dispatcher: string, fnName: string): string {
  const start = dispatcher.indexOf(`async function ${fnName}`);
  expect(start, `missing dispatcher handler ${fnName}`).toBeGreaterThanOrEqual(0);
  const next = dispatcher.indexOf('\nasync function ', start + 1);
  return dispatcher.slice(start, next === -1 ? undefined : next);
}

async function runDispatcher(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', ...argv], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

const DISPATCHER_SMOKES = [
  { argv: ['maintenance'], needle: 'kookr maintenance prune', expectCode: 2 },
  { argv: ['lesson', '--help'], needle: 'kookr lesson', expectCode: 0 },
  { argv: ['emission', '--help'], needle: 'kookr emission', expectCode: 0 },
  { argv: ['retro-verify', '--help'], needle: 'kookr retro-verify', expectCode: 0 },
  {
    argv: ['command', 'outcome', 'never-seen-cmd-3301'],
    needle: 'unknown-never-seen',
    expectCode: 0,
  },
] as const;

describe('importMaybeTs', () => {
  it('loads kookr-context-pack from TypeScript source (tsx graph resolution)', async () => {
    expect(existsSync(contextPackSource)).toBe(true);
    const mod = await importMaybeTs(contextPackSource);
    expect(typeof mod.runContextPackCli).toBe('function');

    const logs: string[] = [];
    const code = await mod.runContextPackCli(['--help'], {
      env: {},
      out: { log: (msg: string) => logs.push(msg), error: () => {} },
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('kookr context-pack — build a spawn-time context pack');
  });

  it('loads compiled dist when present without requiring a tsx graph', async () => {
    if (!existsSync(contextPackDist)) {
      // Clean-clone / IVL path: dist is intentionally absent; source path is covered above.
      return;
    }
    const mod = await importMaybeTs(contextPackDist);
    expect(typeof mod.runContextPackCli).toBe('function');
  });

  it('dispatcher source declares dist→src fallback wiring for the five lagging commands (#3301)', () => {
    const dispatcher = readFileSync(dispatcherPath, 'utf8');
    for (const { stem, handler } of LAGGING_COMMANDS) {
      const body = handlerBody(dispatcher, handler);
      expect(body, handler).toContain(`'${stem}.ts'`);
      expect(body, handler).toContain('existsSync(distEntry) ? distEntry : sourceEntry');
      expect(body, handler).toContain('await importMaybeTs(entry)');
      expect(body, handler).not.toContain('Build output not found');
    }
  });

  it.each(LAGGING_COMMANDS)(
    'loads $stem from TypeScript source (tsx graph resolution)',
    async ({ stem, exportName }) => {
      const sourceEntry = join(repoRoot, 'src/cli', `${stem}.ts`);
      expect(existsSync(sourceEntry)).toBe(true);
      const mod = await importMaybeTs(sourceEntry);
      expect(typeof mod[exportName]).toBe('function');
    },
  );

  it.each(DISPATCHER_SMOKES)(
    'dispatches $argv.0 through bin/kookr.js without requiring dist (#3301)',
    async ({ argv, needle, expectCode }) => {
      const { code, stdout, stderr } = await runDispatcher([...argv]);
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain('Build output not found');
      expect(code).toBe(expectCode);
      expect(combined).toContain(needle);
    },
  );
});
