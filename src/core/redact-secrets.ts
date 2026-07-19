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
  /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g, // PEM blocks
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function isSecretFieldName(name: string): boolean {
  return /(?:api[_-]?key|token|secret|password)/i.test(name);
}
