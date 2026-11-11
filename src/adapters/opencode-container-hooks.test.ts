import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defaultKookrClaudeHooks } from './opencode-kookr-hooks.js';
import { buildContainerLedgerCommand, CONTAINER_PATHS, stageContainerHooks } from './opencode-container-hooks.js';

const repo = resolve(__dirname, '..', '..');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-hooks-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('container hook path map', () => {
  test('commands name container paths only: no host path survives', () => {
    const hooks = defaultKookrClaudeHooks({
      pluginHooksDir: join(repo, 'plugin', 'hooks'), binDir: join(repo, 'bin'), nodePath: process.execPath,
      deliverable: { kind: 'commit-and-pr-body' }, containerPaths: CONTAINER_PATHS,
    })!;
    const all = [...(hooks.hooks.SessionStart ?? []), ...(hooks.hooks.PreToolUse ?? []), ...(hooks.hooks.Stop ?? [])].flatMap((g) => g.hooks.map((h) => h.command)).join('\n');
    expect(all).toContain("'/usr/local/bin/node' '/kookr-hooks/bin/kookr-opencode-gate.js' --kind 'commit-and-pr-body'");
    expect(all).toContain("'/usr/local/bin/node' '/kookr-hooks/bin/kookr-opencode-push-guard.js'");
    expect(all).toContain("bash '/kookr-hooks/plugin-hooks/nb-inject.sh'");
    expect(all).toContain("bash '/kookr-hooks/plugin-hooks/nb-retro.sh'");
    expect(all).toContain('/kookr-hooks/bin/kookr-stop-nudge.js');
    expect(all).not.toContain(repo);
    expect(all).not.toContain(process.execPath);
    expect(hooks.env?.CLAUDE_PLUGIN_ROOT).toBe('/kookr-hooks');
  });

  test('without containerPaths the host commands are unchanged', () => {
    const hooks = defaultKookrClaudeHooks({ binDir: join(repo, 'bin'), deliverable: { kind: 'commit-and-pr-body' } })!;
    expect(hooks.hooks.Stop![0]!.hooks[0]!.command).toContain(join(repo, 'bin', 'kookr-opencode-gate.js'));
  });

  test('stage copies executables, writes a container-path MANIFEST, and an omitted file stays listed (so the entrypoint exits 14)', async () => {
    const out = join(dir, 'hooks');
    const staged = await stageContainerHooks({ hostBinDir: join(repo, 'bin'), hostPluginHooksDir: join(repo, 'plugin', 'hooks'), destDir: out, omit: ['kookr-opencode-gate.js'] });
    expect(staged.manifest).toContain('/kookr-hooks/bin/kookr-opencode-gate.js');
    expect(readFileSync(join(out, 'MANIFEST'), 'utf8').split('\n')).toContain('/kookr-hooks/bin/kookr-hook-writer.js');
    expect(existsSync(join(out, 'bin', 'kookr-opencode-gate.js'))).toBe(false);
    expect(statSync(join(out, 'bin', 'kookr-hook-writer.js')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(out, 'plugin-hooks', 'nb-retro.mjs'))).toBe(true);
    // The push guard is part of the staged set and the MANIFEST, so a worker image never lacks it.
    expect(staged.manifest).toContain('/kookr-hooks/bin/kookr-opencode-push-guard.js');
    expect(statSync(join(out, 'bin', 'kookr-opencode-push-guard.js')).mode & 0o111).not.toBe(0);
  });

  test('ledger command appends to the spool, never to localhost', () => {
    const c = buildContainerLedgerCommand('kookr-oc-abcd1234-tok12345');
    expect(c).toContain("--file '/kookr-spool/ledger.jsonl'");
    expect(c).not.toMatch(/--url|localhost/);
  });
});
