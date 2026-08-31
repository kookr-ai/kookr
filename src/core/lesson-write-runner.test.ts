import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createKbRememberWriteFn, runKbRemember } from './lesson-write-runner.js';

describe('createKbRememberWriteFn', () => {
  test('TS-LESSON-001: sends the exact replay argv and lesson body to kb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-kb-runner-'));
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
