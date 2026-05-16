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

## Emergency Disable

Emergency disable is intentionally relay-scoped. It prevents new hosted
pairings and new share creation, but it does not stop the local Kookr server,
task supervision, terminal sessions, or the dashboard. Local UI surfaces the
disable state in Settings and in the Share modal.
