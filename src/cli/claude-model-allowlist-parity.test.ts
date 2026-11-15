/**
 * #3649: CLAUDE_CODE_MODEL_IDS (agent-types.ts) is the source of truth for the
 * Claude model allowlist, but three copies inline it because they cannot import
 * it at runtime or are prose:
 *
 * - bin/kookr-spawn.js `CLAUDE_MODEL_IDS` (CLI fast-fail, runs without a build)
 * - src/cli/kookr-completion.ts `SPAWN_MODEL_IDS` (spawn `--model` completion)
 * - docs/reference/api.md (the `claude-code` allowed base ids list)
 *
 * Each copy must hold exactly the contract ids, so adding an id to the contract
 * fails here naming the stale copy. The older behavioral check in
 * src/cli/kookr-spawn.test.ts cannot catch this: the CLI accepts dated suffixes
 * by prefix, so a missing `claude-opus-5-6` would still pass via `claude-opus-5`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOOKR_COMPLETION_COMMANDS } from './kookr-completion.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_CLI_MODEL_IDS } from '../shared/contracts/agent-types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** Quoted string literals inside the `const <name> = [ ... ]` array in `source`. */
function extractArrayLiteral(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`could not find \`const ${name} = [...]\``);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Backticked `claude-*` ids in the api.md bullet that lists the claude-code base ids. */
function extractApiDocClaudeIds(markdown: string): string[] {
  const start = markdown.indexOf('Allowed base ids for `claude-code`:');
  if (start < 0) throw new Error('could not find "Allowed base ids for `claude-code`:" in docs/reference/api.md');
  const end = markdown.indexOf('- dated suffixes', start);
  if (end < 0) throw new Error('could not find the "- dated suffixes" bullet ending the claude-code id list');
  return [...markdown.slice(start, end).matchAll(/`(claude-[^`]+)`/g)].map((m) => m[1]!).filter((id) => id !== 'claude-code');
}

const CONTRACT = [...CLAUDE_CODE_MODEL_IDS];

describe('Claude model allowlist copies match CLAUDE_CODE_MODEL_IDS (#3649)', () => {
  it('bin/kookr-spawn.js CLAUDE_MODEL_IDS', () => {
    const copy = extractArrayLiteral(readRepoFile('bin/kookr-spawn.js'), 'CLAUDE_MODEL_IDS');
    expect(copy, 'stale copy: bin/kookr-spawn.js CLAUDE_MODEL_IDS — update it to match CLAUDE_CODE_MODEL_IDS').toEqual(
      CONTRACT,
    );
  });

  it('src/cli/kookr-completion.ts SPAWN_MODEL_IDS (spawn --model completion)', () => {
    const spawn = KOOKR_COMPLETION_COMMANDS.find((c) => c.name === 'spawn');
    const values = spawn?.flagValues?.['--model'];
    expect(values, 'spawn --model completion values').toBeDefined();
    expect(
      [...values!],
      'stale copy: src/cli/kookr-completion.ts SPAWN_MODEL_IDS — update it to CLAUDE_CODE_MODEL_IDS followed by CODEX_CLI_MODEL_IDS',
    ).toEqual([...CONTRACT, ...CODEX_CLI_MODEL_IDS]);
  });

  it('docs/reference/api.md claude-code allowed base ids', () => {
    const copy = extractApiDocClaudeIds(readRepoFile('docs/reference/api.md'));
    expect(copy, 'stale copy: docs/reference/api.md "Allowed base ids for `claude-code`" list').toEqual(CONTRACT);
  });

  it('extractors see a stale copy (guards the parser, not the copies)', () => {
    const staleJs = "const CLAUDE_MODEL_IDS = [\n  'claude-opus-5',\n];";
    expect(extractArrayLiteral(staleJs, 'CLAUDE_MODEL_IDS')).toEqual(['claude-opus-5']);
    const staleDoc = 'Allowed base ids for `claude-code`:\n\n- `claude-opus-5`, `claude-haiku-4-5`\n- dated suffixes of `claude-x`';
    expect(extractApiDocClaudeIds(staleDoc)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
  });
});
