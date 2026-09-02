import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const VERIFY_SCRIPT = 'deploy/relay/verify.sh';

function resolveCurl(): string | null {
  try {
    return execFileSync('bash', ['-lc', 'command -v curl'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const REAL_CURL = resolveCurl();

async function readVerifyScript(): Promise<string> {
  return readFile(VERIFY_SCRIPT, 'utf8');
}

function verifyScriptLines(script: string): string[] {
  return script.split('\n');
}

describe('relay verify.sh network-probe timeouts (issue #2796)', () => {
  it('stays syntactically valid so the static assertions below are not false confidence', () => {
    // `bash -n` parses without executing. Without this, a syntax error
    // elsewhere in the script would leave every string assertion below green.
    expect(() => execFileSync('bash', ['-n', VERIFY_SCRIPT])).not.toThrow();
  });

  it('defines a single configurable, overridable per-probe timeout with a sane default', async () => {
    const script = await readVerifyScript();
    // A default long enough for expected under-load relay latency, overridable
    // via KOOKR_RELAY_VERIFY_TIMEOUT for unusual deployments.
    expect(script).toMatch(/VERIFY_TIMEOUT="\$\{KOOKR_RELAY_VERIFY_TIMEOUT:-\d+\}"/);
    const match = script.match(/KOOKR_RELAY_VERIFY_TIMEOUT:-(\d+)/);
    expect(match).not.toBeNull();
    const defaultSeconds = Number(match?.[1]);
    expect(defaultSeconds).toBeGreaterThanOrEqual(5);
    expect(defaultSeconds).toBeLessThanOrEqual(60);
  });

  it('bounds every curl probe with --max-time so a stalled probe returns control', async () => {
    const script = await readVerifyScript();
    const curlLines = verifyScriptLines(script).filter((line) => /\bcurl\b/.test(line));
    // Guard against the test silently passing if the probes are ever removed.
    expect(curlLines.length).toBeGreaterThan(0);
    for (const line of curlLines) {
      expect(line, `curl probe missing --max-time: ${line.trim()}`).toContain(
        '--max-time "$VERIFY_TIMEOUT"',
      );
    }
  });

  it('bounds the openssl s_client TLS probe with the shared deadline helper', async () => {
    const script = await readVerifyScript();
    const opensslLines = verifyScriptLines(script).filter((line) =>
      /openssl s_client/.test(line),
    );
    expect(opensslLines.length).toBeGreaterThan(0);
    for (const line of opensslLines) {
      expect(line, `openssl probe not bounded by with_deadline: ${line.trim()}`).toMatch(
        /with_deadline openssl s_client/,
      );
    }
    // The helper enforces the same VERIFY_TIMEOUT via coreutils timeout.
    expect(script).toMatch(/with_deadline\(\)/);
    expect(script).toMatch(/timeout "\$VERIFY_TIMEOUT"/);
  });

  it('keeps the per-check failure labels so a timeout identifies the stalled check', async () => {
    const script = await readVerifyScript();
    // Each network probe runs under the labelled check() wrapper, so a timeout
    // failure surfaces as "not ok - <check name>" rather than a bare hang.
    expect(script).toContain('check "https /health is reachable" https_health_ok');
    expect(script).toContain('check "tls certificate verifies" tls_valid');
    expect(script).toContain('check "admin path is refused off-box" admin_refused_off_box');
    expect(script).toContain(
      'check "port 80 redirects or serves ACME only" http_redirect_or_acme_only',
    );
    expect(script).toContain(
      'check "synthetic probe manifest is reachable" synthetic_probe_manifest_available',
    );
  });
});

describe('relay verify.sh readiness probe (issue #2795)', () => {
  it('probes /ready with --fail so a 503 fails the check, as a separate liveness probe', async () => {
    const script = await readVerifyScript();
    // A dedicated readiness probe function, distinct from the /health liveness
    // probe, so a live-but-not-ready relay (503 on /ready) fails verification.
    const readyFn = script.match(/https_ready_ok\(\)\s*\{[\s\S]*?\n\}/);
    expect(readyFn, 'https_ready_ok() must be defined').not.toBeNull();
    const readyBody = readyFn![0];
    expect(readyBody, 'readiness probe must target /ready').toContain('/ready');
    // --fail makes curl exit non-zero on the 503 that /ready returns when the
    // instance must not receive traffic, so the check reports "not ok".
    expect(readyBody, 'readiness probe must use --fail so 503 fails the check').toContain('--fail');
    // Bounded by the same per-probe deadline as every other network probe.
    expect(readyBody).toContain('--max-time "$VERIFY_TIMEOUT"');
  });

  it('wires /ready as its own check, kept separate from the /health liveness check', async () => {
    const script = await readVerifyScript();
    expect(script).toContain('check "https /health is reachable" https_health_ok');
    expect(script).toContain('check "relay reports ready on /ready" https_ready_ok');
    // Liveness and readiness stay distinct checks: /health can be ok while
    // /ready is not, which distinguishes a boot window from a dead process.
    const lines = verifyScriptLines(script);
    const healthIdx = lines.findIndex((l) => l.includes('https_health_ok') && l.startsWith('check '));
    const readyIdx = lines.findIndex((l) => l.includes('https_ready_ok') && l.startsWith('check '));
    expect(healthIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThan(healthIdx);
  });
});

// Behavioral coverage of ready vs. not-ready responses without a real relay
// host: run the actual https_ready_ok body from the script against a local
// mock server, via a curl shim that rewrites the https URL to the mock.
describe.skipIf(!REAL_CURL)('relay verify.sh readiness probe behavior (issue #2795)', () => {
  let server: Server | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  async function runReadinessProbe(readyStatus: number): Promise<number> {
    server = createServer((req, res) => {
      if (req.url === '/ready') {
        res.writeHead(readyStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready: readyStatus === 200 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    workDir = await mkdtemp(join(tmpdir(), 'kookr-verify-ready-'));
    // curl shim: rewrite the https://<domain> the probe builds to the mock,
    // then exec the real curl so --fail/--max-time behave exactly as in prod.
    const shim = join(workDir, 'curl');
    await writeFile(
      shim,
      [
        '#!/usr/bin/env bash',
        'args=()',
        'for a in "$@"; do',
        '  a="${a//https:\\/\\/relay.test/http:\\/\\/127.0.0.1:' + port + '}"',
        '  args+=("$a")',
        'done',
        `exec ${REAL_CURL} "\${args[@]}"`,
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(shim, 0o755);

    // Source only the probe function from the real script and invoke it, so the
    // exit code reflects the shipped logic rather than a re-typed copy.
    const runner = [
      'set -euo pipefail',
      `source <(awk '/^https_ready_ok\\(\\)/,/^}/' "${VERIFY_SCRIPT}")`,
      'https_ready_ok',
    ].join('\n');
    // Must be async: a synchronous child would block the event loop and the
    // mock server would never answer, timing the probe out regardless of status.
    try {
      await promisify(execFile)('bash', ['-c', runner], {
        env: { ...process.env, PATH: `${workDir}:${process.env.PATH ?? ''}`, DOMAIN: 'relay.test', VERIFY_TIMEOUT: '5' },
      });
      return 0;
    } catch (err) {
      return (err as { code?: number }).code ?? 1;
    }
  }

  it('passes when /ready returns 200 (relay live and ready)', async () => {
    expect(await runReadinessProbe(200)).toBe(0);
  });

  it('fails when /ready returns 503 (relay live but not ready)', async () => {
    // Pin the exact curl exit for --fail on an HTTP >= 400 (22), not merely
    // "non-zero": a broken shim (connection refused, 7) or a timeout (28) would
    // also be non-zero, so `.toBe(22)` proves the failure came from the 503.
    expect(await runReadinessProbe(503)).toBe(22);
  });
});
