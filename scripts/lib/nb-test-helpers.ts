// Shared helpers for the notebook store script tests. Every store is a throwaway
// directory under the OS temp dir (NEVER ~/.kookr/notebooks); shelves are written
// as plain files because that is the on-disk format, and all reads and writes the
// scripts make go through the real `nb` CLI from the pinned agent-notebook package.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The raw agent-notebook CLI (no Kookr shim, so no auto-commit). */
export const RAW_NB: string = join(dirname(require.resolve('agent-notebook')), 'cli.js');

/** A clean git environment: a pre-push hook exports GIT_DIR and friends, which would redirect `git -C <tmp>`. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
    'NB_SESSION',
  ]) {
    delete env[k];
  }
  return env;
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export type Lesson = [score: number, text: string];

/** Write a shelf file directly: optional description header, then `+N\ttext` lines in the given (file) order. */
export function writeShelf(dir: string, name: string, lessons: Lesson[], desc?: string): void {
  const header = desc ? `# desc: ${desc}\n` : '';
  const body = lessons.map(([s, t]) => `${s >= 0 ? `+${s}` : `${s}`}\t${t}`).join('\n');
  writeFileSync(join(dir, `${name}.md`), lessons.length || header ? `${header}${body}${body ? '\n' : ''}` : '');
}

/** A new throwaway store; `git: true` makes it a repo with one initial commit, like the real store. */
export function makeStore(opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nb-store-'));
  if (opts.git !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    // The real store ignores the usage ring; without this every nb call would dirty the tree.
    writeFileSync(join(dir, '.gitignore'), '.nb-usage*\n*.tmp\n');
  }
  return dir;
}

export function commitAll(dir: string, msg = 'seed'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
}

/** Install a pre-commit hook that always fails, so any commit in `dir` (the shim's, a script's) is refused. */
export function breakCommits(dir: string): void {
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "pre-commit hook says no" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}

export function destroy(dir: string | undefined): void {
  // Only ever remove a directory this helper created.
  if (dir && dir.startsWith(join(tmpdir(), 'nb-store-'))) rmSync(dir, { recursive: true, force: true });
}

/** Snapshot every file in the store (name -> content) so a test can assert "nothing changed". */
export function dirContents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (f === '.git' || f.startsWith('.nb-usage')) continue;
    const p = join(dir, f);
    if (statSync(p).isFile()) out[f] = readFileSync(p, 'utf-8');
  }
  return out;
}

export function fileExists(dir: string, shelf: string): boolean {
  return existsSync(join(dir, `${shelf}.md`));
}

/** Parse a shelf file into [score, text] pairs in file order (test-side reader). */
export function readLessons(dir: string, shelf: string): Lesson[] {
  const p = join(dir, `${shelf}.md`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => {
      const tab = l.indexOf('\t');
      return [Number.parseInt(l.slice(0, tab), 10), l.slice(tab + 1)] as Lesson;
    });
}

export function readDescription(dir: string, shelf: string): string | null {
  const p = join(dir, `${shelf}.md`);
  if (!existsSync(p)) return null;
  const m = /^#\s*desc:\s?(.*)$/m.exec(readFileSync(p, 'utf-8').split('\n').filter((l) => l.startsWith('#')).join('\n'));
  return m ? m[1] : null;
}
