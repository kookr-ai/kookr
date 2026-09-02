import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const VERIFY_SCRIPT = 'deploy/relay/verify.sh';

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
