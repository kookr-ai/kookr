/**
 * Conservative credential-shape detector for Telegram-visible and audit-log
 * text. If any pattern matches, the entire body is replaced with a sentinel.
 * False positives are acceptable; false negatives are not.
 */
export function redactCredentials(text: string): string {
  const patterns = /(BEGIN [A-Z ]*PRIVATE KEY|password|token|secret|api[_-]?key|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|Bearer\s+\S+)/i;
  if (!patterns.test(text)) return text;
  return '<prompt redacted; view in dashboard>';
}
