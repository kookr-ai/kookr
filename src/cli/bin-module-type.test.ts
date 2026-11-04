import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// Regression for the MODULE_TYPELESS_PACKAGE_JSON warning: every bin/*.js uses
// ESM syntax, but the root package.json declares no "type". Without a module
// type for the bin/ directory, Node reparses each bin as ESM and prints a
// per-invocation performance warning to stderr that pollutes agent transcripts
// (observed live when an agent ran `kookr signal completion-ready`). The fix is
// a bin/package.json pinning `{"type":"module"}` for the directory.
describe('bin/ module type', () => {
  it('declares type:module for the bin/ directory', () => {
    const pkgPath = join(process.cwd(), 'bin', 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.type).toBe('module');
  });

  // Fail-closed: without the bin/package.json fix this bin emits
  // "[MODULE_TYPELESS_PACKAGE_JSON] Warning: ... Reparsing as ES module ..." on
  // stderr. kb-spool-shim.js --help exits 0 and is otherwise silent, so it is a
  // clean probe for the warning.
  it('runs an ESM bin without a MODULE_TYPELESS reparse warning on stderr', async () => {
    const { stderr } = await execFileAsync(
      process.execPath,
      ['bin/kb-spool-shim.js', '--help'],
      { cwd: process.cwd() },
    );
    expect(stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
    expect(stderr).not.toContain('Reparsing as ES module');
  });
});
