/**
 * Best-effort secret scrubbing for short, user/agent-authored free text that
 * gets broadcast to dashboard clients (task feedback notes, agent signal notes).
 *
 * This matches a FIXED set of known token/credential prefixes and PEM blocks.
 * It does NOT detect bare passwords, env-var values, or unknown credential
 * formats — treat it as a guardrail, not a guarantee. Callers that handle
 * higher-risk input should prefer an enum/structured field over free text.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // Anthropic/OpenAI API key
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key
  /\bghp_[A-Za-z0-9]{16,}\b/g, // GitHub PAT
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\bxoxb-[A-Za-z0-9-]{16,}\b/g, // Slack bot token
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab PAT
  /\bhf_[A-Za-z0-9]{16,}\b/g, // HuggingFace token
  /\bnpm_[A-Za-z0-9]{16,}\b/g, // npm token
  /\bpypi-[A-Za-z0-9_-]{16,}\b/g, // PyPI token
  /\bdckr_pat_[A-Za-z0-9_-]{16,}\b/g, // Docker PAT
  /\bya29\.[A-Za-z0-9_-]+\b/g, // Google OAuth token
  /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g, // PEM blocks
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
