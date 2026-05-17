#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${KOOKR_RELAY_DOMAIN:-}"
RELAY_PORT="${KOOKR_RELAY_PORT:-8080}"
RELAY_DB="${KOOKR_RELAY_DB:-/var/lib/kookr-relay/relay.sqlite}"
UNIT="${KOOKR_RELAY_UNIT:-kookr-relay.service}"
MONITOR_STAMP="${KOOKR_RELAY_MONITOR_STAMP:-/var/lib/kookr-relay/monitor-heartbeat}"
BACKUP_GLOB="${KOOKR_RELAY_BACKUP_GLOB:-/var/backups/kookr-relay/*.sqlite}"
SSH_PORT="${KOOKR_RELAY_SSH_PORT:-22}"

failures=0

check() {
  local name="$1"
  shift
  if "$@"; then
    printf 'ok - %s\n' "$name"
  else
    printf 'not ok - %s\n' "$name" >&2
    failures=$((failures + 1))
  fi
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

relay_loopback_only() {
  if has_command ss; then
    ss -ltn "sport = :${RELAY_PORT}" | awk 'NR > 1 { print $4 }' | grep -Eq "(^|:)127\\.0\\.0\\.1:${RELAY_PORT}$|\\[::1\\]:${RELAY_PORT}$"
    ! ss -ltn "sport = :${RELAY_PORT}" | awk 'NR > 1 { print $4 }' | grep -Ev "(^|:)127\\.0\\.0\\.1:${RELAY_PORT}$|\\[::1\\]:${RELAY_PORT}$"
    return
  fi
  if has_command lsof; then
    lsof -nP -iTCP:"${RELAY_PORT}" -sTCP:LISTEN | awk 'NR > 1 { print $9 }' | grep -Eq "127\\.0\\.0\\.1:${RELAY_PORT}|\\[::1\\]:${RELAY_PORT}"
    return
  fi
  return 1
}

https_health_ok() {
  [ -n "$DOMAIN" ] && curl --fail --silent --show-error "https://${DOMAIN}/health" >/dev/null
}

tls_valid() {
  [ -n "$DOMAIN" ] && echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" -verify_return_error >/dev/null 2>&1
}

admin_refused_off_box() {
  [ -n "$DOMAIN" ] && [ "$(curl --silent --output /dev/null --write-out '%{http_code}' "https://${DOMAIN}/relay/admin/metrics")" = "403" ]
}

http_redirect_or_acme_only() {
  [ -n "$DOMAIN" ] && curl --silent --output /dev/null --write-out '%{http_code}' "http://${DOMAIN}/health" | grep -Eq '^(301|302|308|404)$'
}

ssh_key_only() {
  sshd -T 2>/dev/null | grep -Eq '^passwordauthentication no$' \
    && sshd -T 2>/dev/null | grep -Eq '^permitrootlogin (no|prohibit-password)$'
}

service_active() {
  systemctl is-active --quiet "$UNIT"
}

fail2ban_ssh_active() {
  systemctl is-active --quiet fail2ban && fail2ban-client status sshd >/dev/null 2>&1
}

unattended_upgrades_active() {
  systemctl is-enabled --quiet unattended-upgrades || systemctl is-active --quiet unattended-upgrades
}

sqlite_readable() {
  [ -r "$RELAY_DB" ] && sqlite3 "$RELAY_DB" 'PRAGMA quick_check;' | grep -qx ok
}

monitor_recent() {
  [ -f "$MONITOR_STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$MONITOR_STAMP") )) -lt 180 ]
}

daily_backup_exists() {
  find ${BACKUP_GLOB} -mtime -2 -type f -size +0c >/dev/null 2>&1
}

ssh_not_public_when_ufw_present() {
  if ! has_command ufw; then
    return 0
  fi
  ! ufw status numbered | grep -E "${SSH_PORT}/tcp" | grep -q 'Anywhere'
}

check "relay port is loopback-only" relay_loopback_only
check "https /health is reachable" https_health_ok
check "tls certificate verifies" tls_valid
check "admin path is refused off-box" admin_refused_off_box
check "port 80 redirects or serves ACME only" http_redirect_or_acme_only
check "ssh password auth is disabled" ssh_key_only
check "ssh is not broadly open in ufw when ufw is present" ssh_not_public_when_ufw_present
check "unattended-upgrades is enabled or active" unattended_upgrades_active
check "fail2ban ssh jail is active" fail2ban_ssh_active
check "systemd relay unit is active" service_active
check "sqlite database exists and passes quick_check" sqlite_readable
check "off-box monitor heartbeat is recent" monitor_recent
check "daily sqlite backup exists" daily_backup_exists

if [ "$failures" -ne 0 ]; then
  printf '%s posture check(s) failed\n' "$failures" >&2
  exit 1
fi
