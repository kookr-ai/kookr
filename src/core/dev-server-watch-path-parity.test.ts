import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the manual-attach debug command documented in docs/development.md against
 * drift from the `dev:server` npm script (issue #3477). The doc already notes that
 * `pnpm dev:server` runs the same `build:dtach` preflight, so a contributor copying
 * the doc command also expects the same `--watch-path` coverage. If the two sets
 * diverge, edits to the unwatched source trees silently fail to restart the server
 * the debugger is attached to.
 */

// Resolve the repo root from this file (src/core/), independent of the directory
// vitest happens to run from.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function extractWatchPaths(command: string): string[] {
  // The repo consistently uses the `--watch-path=<dir>` (equals) form.
  return [...command.matchAll(/--watch-path=(\S+)/g)].map((match) => match[1]).sort();
}

function devServerScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.['dev:server'];
  if (!script) throw new Error('package.json has no "dev:server" script');
  return script;
}

function documentedManualAttachCommand(): string {
  // The manual-attach command is the documented `node --inspect ... src/server/start.ts`
  // invocation. Match on all three markers so an unrelated future command example
  // cannot be picked up by accident, and fail loudly if more than one line matches.
  const content = readFileSync(join(repoRoot, 'docs', 'development.md'), 'utf8');
  const matches = content
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes('--inspect') &&
        line.includes('--watch-path=') &&
        line.includes('src/server/start.ts'),
    );
  if (matches.length === 0) {
    throw new Error('docs/development.md has no manual-attach `node --inspect ... src/server/start.ts` command');
  }
  if (matches.length > 1) {
    throw new Error(`expected exactly one manual-attach command in docs/development.md, found ${matches.length}`);
  }
  return matches[0];
}

describe('dev:server watch-path parity', () => {
  it('documents the same --watch-path set as the dev:server script', () => {
    const scriptPaths = extractWatchPaths(devServerScript());
    const documentedPaths = extractWatchPaths(documentedManualAttachCommand());

    // Sanity floor: confirm the regex actually matched dev:server's watch paths
    // (not an empty set). We do NOT pin the exact list — the parity assertion below
    // is the real guard, and pinning would make this test fail when dev:server
    // legitimately gains a path even though the doc was updated in lockstep.
    expect(scriptPaths).toContain('src/server');
    expect(scriptPaths.length).toBeGreaterThanOrEqual(3);

    // The contract: the documented command watches exactly what dev:server watches.
    expect(documentedPaths).toEqual(scriptPaths);
  });
});
