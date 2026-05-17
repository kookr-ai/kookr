# Session Sharing

Session sharing lets an owner send a task link to a collaborator. The collaborator uses a browser only; they do not install Kookr.

## Owner Setup

1. Run Kookr and open Settings -> Sharing.
2. Pair a relay node with either hosted relay account pairing or a self-hosted relay admin token.
3. Enable terminal sharing explicitly:

```bash
printf 'KOOKR_RELAY_TRUSTED=true\n' >> .env
pnpm prod:restart
```

4. Confirm Settings -> Sharing shows the relay connected.
5. Open a task, click Share, choose the link duration, and copy the share ID/password link.

Terminal sharing requires `KOOKR_RELAY_TRUSTED=true` in the running Kookr process. Editing `.env` is not enough; restart Kookr after changing this value. Public browser access also requires HTTPS/WSS. Loopback HTTP is allowed for local development at `localhost`, `127.0.0.1`, or `[::1]`.

Useful local relay commands:

```bash
pnpm relay:start
pnpm relay:status
pnpm relay:logs
pnpm relay:restart
pnpm relay:stop
pnpm relay:doctor
```

For a public self-hosted relay, use [self-hosted-relay-runbook.md](./self-hosted-relay-runbook.md).

## Collaborator Flow

1. Open the shared link on a phone or desktop browser.
2. Enter the share password if the owner sent a share ID/password link.
3. Request terminal viewing or input if the page shows those actions.
4. Wait for the owner to approve the grant request.

Kookr installation is not required for collaborators. The relay page carries access in relay cookies after the share is accepted, so reopening the same browser can recover the current share state until the share expires or is revoked.

Grant states:

- Pending: the owner has not approved the request yet.
- Approved: terminal viewing or input is available when the node is online and policy sync has completed.
- Denied: the owner denied the request; repeated requests may cool down.
- Revoked: the owner revoked the share.
- Expired: the share reached its expiry time.
- Node offline: the owner node is not connected to the relay.

## Troubleshooting

### Terminal Sharing Disabled

Symptom: the owner approved access, but the collaborator still sees terminal sharing disabled.

Cause: the running Kookr process did not advertise terminal sharing. This is the dogfood failure where `KOOKR_RELAY_TRUSTED=true` was missing or `.env` changed without a restart.

Fix:

```bash
grep '^KOOKR_RELAY_TRUSTED=' .env
pnpm prod:restart
```

Expected value:

```bash
KOOKR_RELAY_TRUSTED=true
```

### Node Offline

Check the relay connection and restart the local node if needed:

```bash
pnpm relay:status
pnpm relay:doctor
pnpm prod:restart
```

### Policy Sync Pending Or Failed

The owner approval has not been acknowledged by the node yet. Keep the share open and check:

```bash
pnpm relay:doctor
pnpm relay:logs
```

If the relay token is rejected, re-pair the node from Settings -> Sharing.

### Relay Token Rejected

Rotate the node credential or re-pair with a relay admin token from Settings -> Sharing. A rotated token invalidates the previous token immediately.

### Env Changed But Not Restarted

Settings surfaces this as a restart-required diagnosis. Restart the process that needs the changed env:

```bash
pnpm prod:restart
pnpm relay:restart
```

Use `pnpm prod:restart` for Kookr process env such as `KOOKR_RELAY_TRUSTED`. Use `pnpm relay:restart` for relay process env such as `KOOKR_RELAY_ADMIN_TOKEN`, `KOOKR_RELAY_BIND_HOST`, or `KOOKR_RELAY_STATE_DB_PATH`.

### Insecure Transport

Public collaborator links require HTTPS/WSS. Put a public relay behind TLS, such as Caddy from [self-hosted-relay-runbook.md](./self-hosted-relay-runbook.md). Loopback HTTP is acceptable only for local development.

## Recovery Controls

Settings -> Sharing includes operator recovery controls. Each destructive action shows what it affects, requires confirmation, and writes an audit line to:

```bash
~/.kookr/session-sharing-recovery-audit.jsonl
```

Actions:

- Revoke all shares: revokes every active task share owned by this node.
- Disable terminal sharing: writes `KOOKR_RELAY_TRUSTED=false`, disconnects the current relay runtime, and requires `pnpm prod:restart`.
- Rotate credential: uses a relay admin token to invalidate the current node token and reconnect with a replacement.
- Re-pair node: issues a fresh node registration with a relay admin token.
- Relay logs: returns the local relay log path; equivalent command is `pnpm relay:logs`.
- Reset relay state: stops an owned local relay, backs up SQLite/WAL files, removes local relay state, and verifies removal.

Reset backups are written under:

```bash
~/.kookr/relay-state-backups/
```

## Local Rollback And Restore

If a local-only rollback to previous `main` cannot read current relay SQLite state, reset or restore from backup.

Reset path:

```bash
pnpm relay:stop
mkdir -p ~/.kookr/relay-state-backups/manual-$(date +%Y%m%d-%H%M%S)
cp -a ~/.kookr/relay.sqlite* ~/.kookr/relay-state-backups/manual-$(date +%Y%m%d-%H%M%S)/ 2>/dev/null || true
rm -f ~/.kookr/relay.sqlite ~/.kookr/relay.sqlite-wal ~/.kookr/relay.sqlite-shm
pnpm relay:start
```

Restore path:

```bash
pnpm relay:stop
latest=$(ls -1dt ~/.kookr/relay-state-backups/* | head -1)
cp -a "$latest"/relay.sqlite* ~/.kookr/ 2>/dev/null || true
pnpm relay:start
pnpm relay:doctor
```

After reset or restore, re-pair affected nodes and recreate shares if the backup predates the node token, share ticket, grant approval, or revocation you need.
