/**
 * Parse `KOOKR_TELEGRAM_ALLOWED_USERS` (comma-separated numeric Telegram user
 * ids) into the set the bot accepts messages from.
 *
 * Kept in its own dependency-free file so both the bot start-up path and the
 * alert-delivery config (issue #3924: "one allowed user" means alerts can go to
 * that user's private chat) read the allowlist the same way, without loading
 * the lazily-imported Telegram bot module.
 */
export function parseAllowedUserIds(value: string | undefined): Set<number> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n)),
  );
}
