// Regression for issue #2095: plain-node source fallback must resolve the
// TypeScript dependency graph (relative `.js` → `.ts`) without a prior
// `pnpm build:server`. The bin helper activates tsx only when the entry is .ts.
//
// Issue #3301 extends the same dist→src fallback to five dispatcher handlers
// that still required a compiled `dist/` tree (`maintenance`, `lesson`,
// `emission`, `retro-verify`, `command outcome`).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importMaybeTs } from '../../bin/import-maybe-ts.js';

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

  it('bin/kookr.js falls back to src for the five lagging commands (#3301)', () => {
    const dispatcher = readFileSync(dispatcherPath, 'utf8');
    for (const { stem, handler } of LAGGING_COMMANDS) {
      const body = handlerBody(dispatcher, handler);
      expect(body, handler).toContain(`'${stem}.ts'`);
      expect(body, handler).toContain('importMaybeTs');
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
});
