const TOKEN_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(KOOKR_[A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD)=)[^\s]+/g,
  /(kookr_tok_v1_)[A-Za-z0-9_-]+/g,
  /("?(?:relayToken|nodeToken|adminToken|accountToken)"?\s*:\s*")[^"]+/g,
];

export function redactRelaySecret(text: string): string {
  let redacted = text;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, '$1[redacted]');
  }
  return redacted;
}
