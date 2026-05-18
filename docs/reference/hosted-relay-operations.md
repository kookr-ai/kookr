# Hosted Relay Operations

Phase D makes the hosted relay the normal Settings path only when all
operational gates are green. Self-hosted/custom relay pairing remains
available for development and dogfood environments.

## Deployment Owner And Environments

Deployment owner: Kookr operations.

Environments:

- `local`: developer relay on `127.0.0.1`, not a hosted default.
- `staging`: public test relay for release validation.
- `production`: `https://share.kookr.dev`.

The local Kookr app exposes hosted relay as the primary Settings option only
when both are true:

- `KOOKR_HOSTED_RELAY_ENABLED=true`
- `KOOKR_HOSTED_RELAY_OPS_GATES_MET=true`

`KOOKR_HOSTED_RELAY_MODE` controls availability:

- `available`: account pairing and new shares are allowed.
- `maintenance`: pairing/new share creation are refused with a clear local UI
  message; existing local Kookr operation is unaffected.
- `emergencyDisabled`: pairing/new share creation are refused immediately;
  local Kookr remains usable and existing local tasks continue.

## TLS And Domain Management

Production terminates TLS for `share.kookr.dev` before traffic reaches the
Node relay. The deployment must provide:

- HTTPS-only public origin in `KOOKR_HOSTED_RELAY_URL`.
- Certificate expiry surfaced via `KOOKR_HOSTED_RELAY_TLS_EXPIRES_AT`.
- A proxy or platform rule redirecting HTTP to HTTPS.
- No query-string secrets in join URLs; invite tokens and ticket passwords
  stay in URL fragments.

The relay `/health` response reports the hosted status and TLS expiry so an
external monitor can alert before certificate expiry.

## Account And Device Authentication

Hosted node pairing uses account authentication, not the relay admin token.
The local app calls `POST /relay/account/nodes` with a bearer account token.
The relay returns only the node credential:

- `nodeId`
- `nodeToken`

Kookr stores the node credential in `~/.kookr/relay-connection.json` with
0600 permissions. Account tokens and admin tokens are never persisted by the
local app and are not returned in status responses.

Custom relays keep the Phase B1 admin-token pairing path. Anonymous hosted
pairing is rejected.

## Data Retention

Default hosted relay retention is 30 days for metadata needed to operate
sharing:

- node registrations and last heartbeat;
- invitation/ticket lifecycle metadata;
- redacted share labels;
- aggregate metrics and alert state.

Durable storage must not retain ticket passwords, invitation tokens, member
tokens, terminal bytes, prompts, environment variables, or raw task models.
Secrets are stored as hashes/verifiers only. Remote collaborators receive only
safe task projections.

## Rate Limits And Abuse Controls

Hosted relay defaults:

- `KOOKR_RELAY_SHARE_CREATE_LIMIT_PER_MINUTE=20`
- `KOOKR_RELAY_ACCOUNT_PAIR_LIMIT_PER_MINUTE=10`
- ticket source lockout after repeated failed accepts.

Rate-limit hits are exposed in `/relay/admin/metrics` and produce an alert.
Unknown share IDs and wrong passwords both return `ticket-unavailable` so the
accept path does not enumerate valid share IDs.

## Metrics And Alerts

`GET /relay/admin/metrics` requires relay admin authentication and reports:

- tickets created, accepted, revoked, and currently expired;
- accept failures by reason;
- rate-limit hits;
- active node/client WebSockets;
- maximum node heartbeat age;
- last revoke propagation latency;
- policy sync failures;
- 5xx count.

Alerts are emitted for maintenance mode, emergency disable, rate-limit hits,
stale heartbeat age, policy sync failures, and 5xx threshold crossings.

## Terminal Viewing Production Gate

Hosted relay terminal viewing is fail-closed. If `KOOKR_HOSTED_RELAY_ENABLED=1`
but `KOOKR_HOSTED_RELAY_OPS_GATES_MET` is not set, terminal streams are
rejected even when ordinary status reads still work.

Before setting `KOOKR_HOSTED_RELAY_OPS_GATES_MET=1`, verify:

- tenant isolation rejects cross-tenant terminal streams;
- the public join page shows the live-only privacy notice;
- paging or escalation is configured in `KOOKR_RELAY_INCIDENT_ESCALATION_URL`;
- synthetic probe coverage includes invite, accept/refuse, terminal-view setup,
  revocation, and rollback;
- the per-tenant terminal kill switch tears down active streams without
  disabling unrelated tenants;
- logs and evidence exports contain metadata only, not terminal payloads or
  plaintext invite content.

Synthetic probe coverage is inspectable at `/relay/ops/synthetic-probes` and
the loopback/admin path `/relay/admin/synthetic-probes`.

Metadata evidence is exported from the loopback/admin-only
`/relay/admin/metadata-audit` endpoint. Rows include correlation IDs,
pseudonymous member/session IDs, byte counts, sequence ranges, policy versions,
and revocation state. They must not include terminal payloads, raw member IDs,
device IDs, invitation IDs, or plaintext invite content.

Use the per-tenant kill switch during an incident:

```bash
curl --fail -sS \
  -X POST \
  -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"tenant-incident"}' \
  http://127.0.0.1:8080/relay/admin/tenants/<tenant-id>/terminal-viewing/disable
```

Re-enable after the incident is resolved:

```bash
curl --fail -sS \
  -X POST \
  -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" \
  http://127.0.0.1:8080/relay/admin/tenants/<tenant-id>/terminal-viewing/enable
```

## Emergency Disable

Emergency disable is intentionally relay-scoped. It prevents new hosted
pairings and new share creation, but it does not stop the local Kookr server,
task supervision, terminal sessions, or the dashboard. Local UI surfaces the
disable state in Settings and in the Share modal.
