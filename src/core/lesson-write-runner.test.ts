import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultSpoolDir, readPendingLessons } from './lesson-write-spool.js';
import { createKbRememberWriteFn, runKbRemember } from './lesson-write-runner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runKbRemember', () => {
  test('TS-LESSON-001: sends the exact replay argv and lesson body to kb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-kb-runner-'));
    tempDirs.push(dir);
    const kbBin = join(dir, 'kb');
    const capturePath = join(dir, 'capture.json');
    await writeFile(
      kbBin,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  writeFileSync(
    process.env.KOOKR_TEST_KB_CAPTURE,
    JSON.stringify({ argv: process.argv.slice(2), stdin }),
  );
});
`,
      'utf8',
    );
    await chmod(kbBin, 0o755);

    const body = 'Mistake: replay failed\nBetter next time: preserve stdin\n';
    const result = await runKbRemember({
      kb: 'agent-task-lessons',
      title: 'lesson replay contract',
      body,
      kbBin,
      env: { ...process.env, KOOKR_TEST_KB_CAPTURE: capturePath },
    });

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
      argv: [
        'remember',
        '--kb=agent-task-lessons',
        '--title=lesson replay contract',
        '--stdin',
        '--yes',
        '--no-check-similar',
      ],
      stdin: body,
    });
  });

  test('TS-LESSON-003: preserves failure when replay resolves through the spool shim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-kb-replay-shim-'));
    tempDirs.push(dir);
    const realBinDir = join(dir, 'real-bin');
    const argvPath = join(dir, 'argv.txt');
    const stdinPath = join(dir, 'stdin.txt');
    await mkdir(realBinDir);
    await writeFile(
      join(realBinDir, 'kb'),
      `#!/bin/sh
printf '%s\n' "$@" > "$KOOKR_TEST_KB_ARGV"
cat > "$KOOKR_TEST_KB_STDIN"
echo 'real kb provider unavailable' >&2
exit 17
`,
      'utf8',
    );
    await chmod(join(realBinDir, 'kb'), 0o755);

    const repoBinDir = fileURLToPath(new URL('../../bin', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      PATH: [repoBinDir, realBinDir, process.env.PATH ?? ''].join(delimiter),
      KOOKR_TEST_KB_ARGV: argvPath,
      KOOKR_TEST_KB_STDIN: stdinPath,
    };
    const body = 'lesson body must remain pending\n';
    const result = await runKbRemember({
      kb: 'agent-task-lessons',
      title: 'preserve downstream failure',
      body,
      kbBin: join(repoBinDir, 'kb'),
      env,
    });

    expect(result).toMatchObject({ ok: false, exitCode: 17 });
    expect(result.stderr).toContain('real kb provider unavailable');
    expect(await readFile(argvPath, 'utf8')).toBe([
      'remember',
      '--kb=agent-task-lessons',
      '--title=preserve downstream failure',
      '--stdin',
      '--yes',
      '--no-check-similar',
      '',
    ].join('\n'));
    expect(await readFile(stdinPath, 'utf8')).toBe(body);
    expect(await readPendingLessons(defaultSpoolDir(env))).toHaveLength(0);
  });
});

describe('createKbRememberWriteFn', () => {
  test('exports a LessonWriteFn factory', async () => {
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
