/**
 * Focused coverage for scripts/build-dtach.sh failure diagnostics (#1425).
 *
 * Acceptance:
 * - Forced configure/make failure prints real error text to stderr
 * - Success path stays quiet (no log dump)
 * - Failure exits non-zero
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/build-dtach.sh');

function prepareVendorTree(vendorDir: string, opts: {
  configureBody: string;
  makeBody: string;
}): void {
  const srcDir = join(vendorDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  // Pretend a clone already exists so the script skips `git clone`.
  mkdirSync(join(srcDir, '.git'), { recursive: true });

  writeFileSync(join(srcDir, 'configure'), `#!/usr/bin/env bash\n${opts.configureBody}\n`, {
    mode: 0o755,
  });
  chmodSync(join(srcDir, 'configure'), 0o755);

  // `make` is a real tool on PATH; the script runs `make` in SRC_DIR, so we
  // provide a Makefile that fails or succeeds as needed.
  writeFileSync(join(srcDir, 'Makefile'), opts.makeBody);
}

function runBuild(vendorDir: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('bash', [SCRIPT, '--force'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KOOKR_DTACH_VENDOR_DIR: vendorDir,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('build-dtach.sh', () => {
  it('tails configure/make log to stderr and exits non-zero on failure', () => {
    const vendorDir = mkdtempSync(join(tmpdir(), 'kookr-build-dtach-fail-'));
    try {
      prepareVendorTree(vendorDir, {
        configureBody: `echo "configure: error: CANARY_MISSING_HEADERS" >&2
exit 1`,
        makeBody: 'all:\n\t@echo should-not-run\n',
      });

      const { status, stdout, stderr } = runBuild(vendorDir);

      expect(status).toBe(1);
      expect(stderr).toContain('[build-dtach] build failed; last 20 lines of');
      expect(stderr).toContain('CANARY_MISSING_HEADERS');
      // Failure banner must not be swallowed into stdout-only silence.
      expect(stdout).not.toContain('CANARY_MISSING_HEADERS');
    } finally {
      rmSync(vendorDir, { recursive: true, force: true });
    }
  });

  it('keeps the success path quiet (no log dump) and exits 0', () => {
    const vendorDir = mkdtempSync(join(tmpdir(), 'kookr-build-dtach-ok-'));
    try {
      prepareVendorTree(vendorDir, {
        configureBody: `echo "configure: ok" >&2
exit 0`,
        makeBody: `all:
\t@printf '%s\\n' '#!/usr/bin/env bash' 'echo dtach-stub' > dtach
\t@chmod +x dtach
`,
      });

      const { status, stdout, stderr } = runBuild(vendorDir);

      expect(status).toBe(0);
      expect(stdout).toContain('[build-dtach] configuring + building');
      expect(stdout).toContain(`[build-dtach] built ${join(vendorDir, 'dtach')}`);
      // Success must not dump the captured log.
      expect(stderr).not.toContain('[build-dtach] build failed');
      expect(stderr).not.toContain('configure: ok');
      expect(stdout).not.toContain('configure: ok');
    } finally {
      rmSync(vendorDir, { recursive: true, force: true });
    }
  });
});
