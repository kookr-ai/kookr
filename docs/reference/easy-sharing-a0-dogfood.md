# Easy Connection Sharing A0 Dogfood

Phase A0 sharing is intentionally env-configured and view-only.

For current terminal-sharing setup, browser collaborator flow, troubleshooting,
and recovery controls, see [session-sharing.md](./session-sharing.md).

## Enable

1. Start a relay with a short-lived dogfood token.
2. Start Kookr with `KOOKR_RELAY_URL` and `KOOKR_RELAY_TOKEN`.
3. Open a current task in the dashboard.
4. Click **Share**, create a link, and send the `/relay/join#inviteToken=...` URL to a second browser.

The invite token must stay in the URL fragment. The join page scrubs the
fragment before accepting the invitation, and the member token is carried by a
relay cookie after accept rather than by query string.

## Cleanup

Before ending a dogfood relay run, revoke active task shares from the owner
dashboard. If the owner dashboard is unavailable, revoke every dogfood
invitation from the relay admin surface:

```bash
curl -fsS "$KOOKR_RELAY_URL/relay/admin/invitations" \
  -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" |
  jq -r '.invitations[].invitationId' |
  while read -r invitation_id; do
    curl -fsS -X POST \
      "$KOOKR_RELAY_URL/relay/admin/invitations/$invitation_id/revoke" \
      -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" >/dev/null
  done
```

Disabling the local A0 UI by unsetting `KOOKR_RELAY_URL` /
`KOOKR_RELAY_TOKEN` does not make old links permanent. Existing A0 invitations
remain relay-owned and continue only until revoke or expiry; Phase A0 bounds
task-share TTLs to at most 24 hours.
