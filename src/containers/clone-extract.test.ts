import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cloneForWorker, extractDeliverable, fsckClean, readDeliverableFile } from './clone-extract.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
let root: string;
let src: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clone-extract-'));
  src = join(root, 'src');
  mkdirSync(src);
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  writeFileSync(join(src, 'a.txt'), 'one\n');
  g(src, 'add', '.');
  g(src, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('clone + extract', () => {
  test('clone does not hardlink objects, worker commit lands as a ref on the host, fsck stays clean', async () => {
    const clone = join(root, 'w', 'clone');
    await cloneForWorker(src, clone);
    // --no-hardlinks: no object file is shared with the host repo (link count 1)
    const objs = join(clone, '.git', 'objects');
    const sample = readdirSync(objs).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => readdirSync(join(objs, d)).map((f) => join(objs, d, f)));
    expect(sample.length).toBeGreaterThan(0);
    for (const f of sample) expect(statSync(f).nlink).toBe(1);

    writeFileSync(join(clone, 'a.txt'), 'two\n');
    g(clone, 'commit', '-aqm', 'worker change');
    const r = await extractDeliverable(src, clone, 'task-1');
    expect(r.ref).toBe('refs/kookr/opencode/task-1');
    expect(g(src, 'show', `${r.ref}:a.txt`)).toBe('two');
    expect(g(src, 'rev-parse', 'main')).not.toBe(r.head); // the source branch is untouched
    expect(await fsckClean(src)).toBe(true);
  });

  test('a clone whose config tries to run code on fetch (fsmonitor, hooks, aliases) executes nothing on the host', async () => {
    const clone = join(root, 'clone');
    await cloneForWorker(src, clone);
    const marker = join(root, 'PWNED');
    writeFileSync(join(clone, 'b.txt'), 'x\n');
    g(clone, 'add', '.');
    g(clone, 'commit', '-qm', 'c');
    // Plant the code-running config only AFTER the test's own commit (the helper itself would run it).
    appendFileSync(join(clone, '.git', 'config'), `[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = ${join(root, 'evil')}\n[uploadpack]\n\tpackObjectsHook = touch ${marker}\n`);
    mkdirSync(join(root, 'evil'));
    writeFileSync(join(root, 'evil', 'reference-transaction'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await extractDeliverable(src, clone, 'task-2');
    expect(existsSync(marker)).toBe(false);
    expect(await fsckClean(src)).toBe(true);
  });

  test('a clone with a corrupted object is refused by the fetch and the host repo stays clean', async () => {
    const clone = join(root, 'clone');
    await cloneForWorker(src, clone);
    writeFileSync(join(clone, 'c.txt'), 'y\n');
    g(clone, 'add', '.');
    g(clone, 'commit', '-qm', 'c');
    const head = g(clone, 'rev-parse', 'HEAD');
    const loose = join(clone, '.git', 'objects', head.slice(0, 2), head.slice(2));
    execFileSync('chmod', ['644', loose]);
    writeFileSync(loose, 'garbage');
    await expect(extractDeliverable(src, clone, 'task-3')).rejects.toThrow();
    expect(await fsckClean(src)).toBe(true);
    expect(() => g(src, 'rev-parse', '--verify', 'refs/kookr/opencode/task-3')).toThrow();
  });

  test('rejects a task id that is not a plain id; deliverable reads refuse symlinks', async () => {
    await expect(extractDeliverable(src, src, '../x')).rejects.toThrow('invalid task id');
    const clone = join(root, 'clone');
    mkdirSync(clone);
    writeFileSync(join(clone, 'PR_BODY.md'), 'body');
    expect(await readDeliverableFile(clone, 'PR_BODY.md')).toBe('body');
    symlinkSync('/etc/hostname', join(clone, 'REVIEW.md'));
    expect(await readDeliverableFile(clone, 'REVIEW.md')).toBeUndefined();
    await expect(readDeliverableFile(clone, '../x')).rejects.toThrow('invalid deliverable name');
  });
});
