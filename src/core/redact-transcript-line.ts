/**
 * Best-effort redaction for one line of agent transcript text.
 *
 * Builds on `redactSecrets` (known token prefixes, `token=...` snippets, PEM,
 * auth headers) and adds detectors for leaks it misses in transcripts:
 * URL userinfo, `*_KEY=` / `*_SECRET_*=` style assignments, `curl -u`, and
 * long base64 blobs. This is a guardrail, NOT a guarantee: unknown formats,
 * bare passwords, and secrets split across lines or longer than the bounds
 * below can still leak.
 *
 * Cost is linear in line length. Every regex either has no nested/overlapping
 * unbounded quantifiers or uses explicit {0,N} bounds so a failed attempt at
 * one start position costs O(1), and each line is hard-capped first.
 */
import { redactSecrets } from './redact-secrets.js';

const REDACTED = '[REDACTED]';

/** Lines longer than this are truncated before any scanning. */
export const MAX_TRANSCRIPT_LINE_CHARS = 100_000;
const TRUNCATION_MARKER = '…[truncated]';

// scheme://user:pass@  and  scheme://:pass@  (userinfo has no '/', '@', or whitespace)
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{0,256}:[^\s/@]{0,1024}@/gi;

// Key name containing a credential word, then `=` or `:`, then the value.
// Anchored on the keyword (not on the whole key) and bounded to avoid
// quadratic rescans of long identifier runs.
const CREDENTIAL_ASSIGNMENT =
  /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Za-z0-9_.-]{0,64}\s{0,16}[:=]\s{0,16}("?)[^\s"']+\1/gi;

// curl -u user:pass / --user user:pass / --user=user:pass
const CURL_USER = /(\s(?:-u|--user)(?:\s+|=))(?:'[^']*'|"[^"]*"|\S+)/g;

// Long base64-ish run. Hex-only runs (sha256, git hashes) and path-like runs are skipped.
const BASE64_BLOB = /[A-Za-z0-9+/]{80,}={0,2}/g;
const HEX_ONLY = /^[0-9a-f]+$/i;

function redactUrlUserinfo(s: string): string {
  if (!s.includes('://')) return s;
  return s.replace(URL_USERINFO, `$1${REDACTED}@`);
}

function redactCredentialAssignments(s: string): string {
  if (!/[:=]/.test(s)) return s;
  return s.replace(CREDENTIAL_ASSIGNMENT, (m) => {
    const sep = m.search(/[:=]/);
    return `${m.slice(0, sep + 1)}${REDACTED}`;
  });
}

function redactCurlUser(s: string): string {
  if (!s.includes('curl')) return s;
  return s.replace(CURL_USER, `$1${REDACTED}`);
}

function redactBase64Blobs(s: string): string {
  return s.replace(BASE64_BLOB, (m) => {
    const core = m.replace(/=+$/, '');
    if (HEX_ONLY.test(core)) return m;
    let slashes = 0;
    for (let i = 0; i < core.length; i++) if (core.charCodeAt(i) === 47) slashes++;
    if (slashes * 8 > core.length) return m; // looks like a filesystem path
    return REDACTED;
  });
}

export function redactTranscriptLine(line: string): string {
  let s = line;
  if (s.length > MAX_TRANSCRIPT_LINE_CHARS) {
    s = s.slice(0, MAX_TRANSCRIPT_LINE_CHARS) + TRUNCATION_MARKER;
  }
  s = redactSecrets(s);
  s = redactUrlUserinfo(s);
  s = redactCredentialAssignments(s);
  s = redactCurlUser(s);
  s = redactBase64Blobs(s);
  return s;
}

/** Redact multi-line text one line at a time (each line independently capped). */
export function redactTranscriptText(text: string): string {
  return text.split('\n').map(redactTranscriptLine).join('\n');
}
