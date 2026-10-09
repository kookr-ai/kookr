/**
 * Best-effort secret scrubbing for short, user/agent-authored free text that
 * gets broadcast to dashboard clients (task feedback notes, agent signal notes,
 * projected activity events).
 *
 * This matches a FIXED set of known token/credential prefixes, key-value
 * credential snippets, and PEM blocks.
 * It does NOT detect bare passwords, env-var values, or unknown credential
 * formats — treat it as a guardrail, not a guarantee. Callers that handle
 * higher-risk input should prefer an enum/structured field over free text.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style API key (also matches sk-ant-)
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, // GitHub classic PAT / OAuth / App / refresh tokens
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\bxox[bpa]-[A-Za-z0-9-]{16,}\b/g, // Slack bot / user / legacy app token
  /\bxapp-[A-Za-z0-9-]{16,}\b/g, // Slack app-level token
  /\bAIza[A-Za-z0-9_-]{20,}\b/g, // Google API key
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab PAT
  /\bhf_[A-Za-z0-9]{16,}\b/g, // HuggingFace token
  /\bnpm_[A-Za-z0-9]{16,}\b/g, // npm token
  /\bpypi-[A-Za-z0-9_-]{16,}\b/g, // PyPI token
  /\bdckr_pat_[A-Za-z0-9_-]{16,}\b/g, // Docker PAT
  /\bya29\.[A-Za-z0-9_-]+\b/g, // Google OAuth token
  /\b(?:[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password))\s*[:=]\s*[^\s&]+/gi, // key-value credentials
  // HTTP Authorization header values (Bearer, Basic, raw tokens — whole header)
  /\bAuthorization\s*[:=]\s*[^\r\n]+/gi,
  // Bare Bearer tokens outside an Authorization: prefix
  /\bBearer\s+[^\s"'\\]+/gi,
  // Cookie / Set-Cookie header values (session tokens in log lines)
  /\b(?:Set-)?Cookie\s*[:=]\s*[^\r\n]+/gi,
];

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';

/** Index just past a run of [A-Z ] starting at `from` (== from when the run is empty). */
function skipPemLabel(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || c === 32)) break;
    i++;
  }
  return i;
}

/**
 * Redact `-----BEGIN X-----` ... `-----END X-----` blocks with indexOf scans
 * instead of a lazy `[\s\S]+?` regex, which backtracks quadratically on many
 * BEGIN headers with no END. Unterminated blocks are left untouched (as the
 * old regex did). Each position is visited a bounded number of times.
 */
function redactPemBlocks(s: string): string {
  let out = '';
  let last = 0;
  let from = 0;
  for (;;) {
    const begin = s.indexOf(PEM_BEGIN, from);
    if (begin === -1) break;
    const labelStart = begin + PEM_BEGIN.length;
    const labelEnd = skipPemLabel(s, labelStart);
    if (labelEnd === labelStart || !s.startsWith(PEM_DASHES, labelEnd)) {
      from = begin + 1;
      continue;
    }
    const bodyStart = labelEnd + PEM_DASHES.length;
    // Find the first well-formed END terminator after the body start.
    let end = -1;
    let search = bodyStart + 1; // body needs at least one char
    for (;;) {
      const e = s.indexOf(PEM_END, search);
      if (e === -1) break;
      const eLabelStart = e + PEM_END.length;
      const eLabelEnd = skipPemLabel(s, eLabelStart);
      if (eLabelEnd > eLabelStart && s.startsWith(PEM_DASHES, eLabelEnd)) {
        end = eLabelEnd + PEM_DASHES.length;
        break;
      }
      search = e + 1;
    }
    // No terminator anywhere after this point means none for later BEGINs either.
    if (end === -1) break;
    out += s.slice(last, begin) + '[REDACTED]';
    last = end;
    from = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return redactPemBlocks(out);
}

export function isSecretFieldName(name: string): boolean {
  return /(?:api[_-]?key|token|secret|password)/i.test(name);
}
