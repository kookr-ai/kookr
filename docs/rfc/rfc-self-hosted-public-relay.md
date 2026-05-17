# RFC: Self-Hosted Public Relay Deployment And Hardening

## Status

Draft (v3 — post-review revision, 2 critic rounds, converged)
Date: 2026-05-17
Author: Jean Ibarz (with Claude)

---

## Problem

The relay (`relay/server.ts`) and the sharing stack it serves are merged and
working — `rfc-easy-connection-sharing.md` phases A0–E and the
`rfc-collaborative-remote-sessions.md` phases all shipped. Two deliberate
scoping decisions now block a use case the author wants:

1. **Self-hosting on a public server is undocumented and unhardened.**
   `hosted-relay-operations.md` treats only the Kookr-operated
   `share.kookr.dev` as "production"; custom relays are described as for
   "development and dogfood environments." There is no supported story for a
   user running *their own* relay on *their own* internet-facing VPS (e.g. a
   Hetzner box). The relay binds `0.0.0.0` directly, has no reverse-proxy/TLS
   story for the self-host case, and no operator hardening guidance.

2. **Share links die after 24 hours.** `NODE_SHARE_MAX_TTL_MS` /
   `TASK_SHARE_MAX_TTL_MS` cap a task-share invitation at 24h. The relay
   comment is explicit: the cap exists "to keep the dashboard from minting an
   effectively permanent share." The author needs links that live up to ~1
   month for a long-running shared task — without converting them into the
   "effectively permanent share" the cap rightly forbids.

A 24h cap is correct for an anonymous, casually-passworded, short-lived
share. A one-month link reachable from the open internet is a materially
different security object. This RFC makes self-hosted public relays a
first-class, hardened configuration and raises the TTL ceiling **only
together with the compensating controls — and the durability — that keep the
longer window real and safe.**

### The durability blocker (found in review)

Review established, by reading the code, that **all relay state is
in-memory**: `registrations`, `tokenIndex`, `ticketSourceFailures`, and the
`InvitationStore` are plain `Map`s (`relay/server.ts:639-656`,
`relay/src/invitations/store.ts:136-141`). Nothing is persisted. A relay
restart — crash, redeploy, OOM, or the `unattended-upgrades` reboot the
hardening runbook *mandates* (roughly monthly on Debian LTS) — wipes every
invitation, node registration, and node token.

A 31-day TTL on today's relay is therefore a fiction: the share's *real*
lifetime is bounded by relay uptime, and a restart also disconnects the node
permanently (its token is gone). **Raising the TTL ceiling without durable
relay state would ship a promise the system cannot keep.** Persisting relay
state is Phase 1 of this RFC and a hard prerequisite for the TTL raise.

## Relationship To Existing Remote-Sharing RFCs

This RFC does **not** fork the protocol or the invitation lifecycle:

- `rfc-easy-connection-sharing.md` — owns the share/invitation/ticket model,
  the `RemoteTaskProjectionV1` view-only contract, the revocation state
  machine, and the Phase B1 custom-relay admin-token pairing path. Unchanged.
- `rfc-collaborative-remote-sessions.md` — owns the node↔relay protocol,
  control events, the `relay.hello` handshake, and the local-only safety
  contract. This RFC extends `RelayHello` by one optional field (§9);
  nothing else.
- `hosted-relay-operations.md` — owns the Kookr-operated `share.kookr.dev`.
  This RFC is the **self-hosted sibling**: same relay binary, operator is the
  user. Per that document the hosted relay already runs behind a
  TLS-terminating proxy. Because this RFC changes a shared binary, every
  phase below states its effect on that existing deployment explicitly (see
  Migration Plan — upgrade compatibility).

The view-only projection guarantee — a remote viewer sees only
`RemoteTaskProjectionV1`, no terminal bytes, no secrets — is **preserved
unchanged**.

## Goals

1. A user can run their own relay on their own public VPS and pair a local
   Kookr node to it, following documented, hardened steps.
2. Relay state (invitations, registrations, hashed tokens, per-share lockout)
   **survives restart**, so a share's real lifetime equals its `expiresAt`.
3. Task-share links can be created with a lifetime up to **31 days**, chosen
   per share, with the maximum being an **operator-configured** value
   (default stays 24h — opting into longer is explicit).
4. A complete, written threat model for exposing the relay on a public IP,
   each threat paired with a mitigation **enforced in code** wherever
   feasible, not left to operator diligence.
5. Longer-lived shares carry proportionally stronger secrets.
6. The system is **diagnosable**: an operator can tell *why* a share stopped
   working without console access.
7. A reproducible Hetzner runbook plus a **verification script that fails
   loudly** if the box's posture drifts.

## Non-Goals

- Not changing what a remote viewer sees — still `RemoteTaskProjectionV1`,
  view-only, no terminal bytes.
- Not building a hosting control panel, multi-tenant relay, or billing.
- Not replacing `share.kookr.dev`; the Kookr-hosted relay path is untouched.
- Not adding accounts/SSO to the self-hosted relay — it keeps the existing
  admin-token + node-token + share-ticket model.
- Not "permanent" shares. 31 days is a hard cap in code; no unbounded option.
- Not peer-to-peer / NAT-hole-punching. The relay stays the rendezvous.
- Not a relay-log → firewall auto-ban pipeline (see Alternatives).
- Not remote admin access — the admin API is loopback-only; remote
  administration is an SSH tunnel.

## When NOT To Use This

If you only ever view *your own* tasks remotely, a public relay is the wrong
tool — a WireGuard/Tailscale tunnel or SSH port-forward gives device-level
authentication with **no public attack surface at all**, deleting threats
T1–T7 outright. This RFC's machinery exists *because* a public URL must be
openable by a second person in a plain browser with no client install. The
runbook leads with this decision so an operator picks the public relay only
when a non-technical third-party viewer genuinely needs browser-only access.

## Recommendation

Ship four phases, ordered so each security/durability piece lands before the
capability that depends on it:

1. **Relay state persistence + verifier hardening** — durable SQLite store
   for invitations, registrations, hashed tokens, and per-share lockout;
   strong (scrypt) password verifiers written from day one.
2. **Edge hardening + diagnosability** — loopback-bind support, relay-enforced
   admin isolation, constant-time secret comparison, correct client-IP behind
   a proxy, per-share lockout wired and surfaced, a real `/health` DB probe,
   a per-share diagnostic endpoint, windowed alert metrics.
3. **Operator deployment kit + Hetzner runbook** — `deploy/relay/` artifacts,
   a `verify.sh` posture check, and a concretely-specified off-box monitor.
4. **TTL ceiling raise** — operator-configurable up to a 31-day hard cap,
   lifetime-scaled password entropy, retention alignment, the node↔relay
   capability handshake, an operator-chosen share display label, and the
   offline-node viewer state.

Order is load-bearing: Phase 4 must not merge before 1, 2, and the security
artifacts of 3.

## Threat Model

Scope: the relay process and its HTTP(S)/WebSocket surface, reachable from the
open internet. The local node and the operator's workstation are out of scope
except where the relay can harm them.

Assets, by sensitivity:

- **Admin token** (`KOOKR_RELAY_ADMIN_TOKEN`) — registers nodes; full relay
  control. Highest value.
- **Node token** — authenticates one node's outbound connection.
- **Share ticket** (share ID + password) — grants view of one task
  projection for one share's lifetime.
- **Task projection** (`RemoteTaskProjectionV1`) — `taskLabel` (free text,
  ≤80 chars), status, anomaly flags, timestamps. **Not low-sensitivity by
  default** — see §8.

| # | Threat | Vector | Mitigation | Status |
|---|--------|--------|-----------|--------|
| T1 | Share-password brute force | Repeated guesses against a known share ID | Per-source lockout (exists); **per-share-ID lockout wired at the relay accept path** (§6); rate limits; entropy scaled to TTL (§7); slow-hash verifier (§7) | Per-source exists; per-share wiring + KDF are new |
| T2 | Share-ID enumeration | Probing share IDs for live shares | Unknown ID and wrong password return byte-identical `ticket-unavailable` | Exists; add a regression test |
| T3 | Admin-API compromise | Reaching/guessing `/relay/admin/*` from the internet | Relay **refuses** non-loopback admin requests itself (§5); constant-time token compare (§4); proxy also blocks the path (defense-in-depth) | Relay-side enforcement + constant-time are new |
| T4 | Node-token theft/replay | Stolen token impersonates a node | Tokens stored hashed + persisted (§1); TLS-only; rotation endpoint exists; document rotation | Persistence + docs new |
| T5 | Transport interception | Plaintext HTTP leaks tokens, passwords, cookies | TLS mandatory for any non-loopback origin; relay refuses an unacknowledged insecure public bind (§2); secrets ride the URL fragment | Fragment-only exists; bind guard is new |
| T6 | Resource-exhaustion DoS | Connection floods, oversized bodies, slowloris | Proxy connection/body/timeout limits; relay body cap; systemd resource limits | Partly new |
| T7 | Spam share/pairing creation | Authenticated-but-abusive node looping creates | `KOOKR_RELAY_SHARE_CREATE_LIMIT_PER_MINUTE`, `..._ACCOUNT_PAIR_LIMIT_PER_MINUTE` | Exists; verify defaults + correct source key |
| T8 | Stale long-lived share | A 31-day link forgotten and left live | Owner revoke; 31-day hard cap; metrics surface the oldest live share; retention covers the window (§6); persisted state so revoke/expiry actually hold | Persistence + retention new |
| T9 | Host compromise | SSH brute force, unpatched CVEs | Runbook: key-only SSH, `unattended-upgrades`, non-root systemd service, minimal packages, SSH source-IP firewalling, SSH-only fail2ban; `verify.sh` | Runbook + verify script are new |
| T10 | Relay-tainted local state | A public relay corrupting node-local state | Existing local-only-safety contract: `src/remote/*` dynamic-import isolation, `kookr local-only doctor` | Exists (prior RFC); cited, unchanged |
| T11 | State loss / undiagnosable failure | Crash/redeploy/reboot wiping shares; operator cannot tell why a share failed | Phase 1 persistence; real `/health` DB probe; per-share diagnostic endpoint; off-box liveness + cert-expiry monitor; structured startup log | Entirely new — this RFC |

T1's per-source lockout alone does not stop a distributed (botnet/VPS-pool)
attacker. The per-share-ID counter is the control that does — and review
found the counter field already exists in `InvitationStore`
(`SHARE_TICKET_MAX_FAILED_ATTEMPTS`, `store.ts`) but is **not wired to the
relay accept path** for the global-failure case; §6 wires it.

## Design

### 1. Durable relay state + verifier hardening (Phase 1 — prerequisite)

The relay persists to **SQLite** on the same (loopback) box: invitations and
share tickets (verifiers/hashes only — never plaintext secrets), node
registrations and hashed node tokens, and per-share lockout counters
(`failedAcceptCount` / `lockedUntil`).

Implementation shape (pinned, not a "cache"): **load all rows into the
existing in-memory `Map`s at startup; on every mutation write to SQLite
synchronously before the method returns.** The `Map` stays the hot read path;
SQLite is the journal. There is no read cache and no cache-coherence logic.
The relay is single-process, so a synchronous embedded driver
(`better-sqlite3`) is the right fit; the handful of writes per accept/create
do not threaten the event loop. WAL mode is required (`PRAGMA
journal_mode=WAL`) and verified at open.

- **Restart correctness:** state reloads; live shares stay joinable; a node
  reconnects with its existing token; lockout counters survive (an attacker
  cannot reset a lockout by forcing a restart).
- **Per-*source* lockout (`ticketSourceFailures`) is deliberately NOT
  persisted** — it stays in-memory. It is a minor nicety; the persisted
  *per-share* counter is the real defense, so a restart resetting per-source
  state is acceptable and keeps the Phase 1 schema small.
- **Corruption safety:** `PRAGMA integrity_check` at boot; a row that fails
  schema validation is quarantined (logged, skipped) rather than crashing the
  load — one bad row must not poison-pill the relay into a `StartLimit`
  shutdown. A DB that fails to open at all is a hard, logged exit (not a
  silent empty-state start).
- **Startup observability:** the relay logs a structured line —
  `relay.state.loaded { invitations, registrations, lockouts, ms }` — so an
  operator can confirm after any restart that state actually reloaded.
- **Verifier KDF (folded in here, not Phase 4):** the share-password verifier
  is currently a single SHA-256 round (`sha256:salt:digest`). Because Phase 1
  creates the SQLite store empty, **scrypt verifiers are written from day
  one** — there are no on-disk legacy verifiers to migrate, so no
  compatibility branch is needed. (`crypto.scrypt` is in Node core — chosen
  over argon2id specifically to add no native dependency to a
  security-sensitive standalone binary; see Critic Feedback for the
  resolution.) WebSocket-session state (`nodeSockets`, replay buffers,
  presence) stays in-memory by nature — reconstructed on reconnect.

Acceptance gate: relay killed and restarted mid-share — the share is still
joinable and the node reconnects without re-pairing; lockout counters intact;
the startup log reports the reloaded counts. **One-time caveat:** the *first*
restart onto the Phase 1 binary is still a full state wipe — state created
under the pre-Phase-1 binary was never persisted. This is expected and
documented; persistence protects shares created from Phase 1 onward.

### 2. Loopback bind, phased to avoid bricking existing relays

`relay.httpServer.listen` gains `KOOKR_RELAY_BIND_HOST`. The relay belongs
behind a reverse proxy (Caddy — automatic TLS) that terminates TLS on `:443`
and proxies to a loopback relay; the single public *application* port is then
`443`, with `:80` open only for the ACME challenge + HTTP→HTTPS redirect.

Because this is a shared binary (it also runs `share.kookr.dev`), the bind
default flip is **phased like a parallel-fields migration**, not a hard cut:

- **Phase 2 release:** `KOOKR_RELAY_BIND_HOST` is introduced; its default
  stays today's `0.0.0.0`. A relay bound to a non-loopback host logs a clear
  startup warning unless `KOOKR_RELAY_ALLOW_INSECURE_BIND=1` acknowledges it.
  Nothing bricks.
- **A later minor release:** the default flips to `127.0.0.1`. By then every
  intentionally-public deployment (including the hosted relay) has explicitly
  set its bind, surfaced by the warning.

`KOOKR_RELAY_PUBLIC_ORIGIN` is the `https://` domain, used for join URLs and
`/health`. A non-loopback bind without `KOOKR_RELAY_ALLOW_INSECURE_BIND=1`
*refuses to start* once the default has flipped — a logged warning is not
enough for the post-flip world, but the warn-first release prevents a
surprise brick.

### 3. Correct client identity behind the proxy

`remoteAddressKey()` reads `req.socket.remoteAddress`. Behind a loopback proxy
every request arrives as `127.0.0.1`, which breaks the per-source lockout
(T1) and the rate limits (T7).

Decision: when `KOOKR_RELAY_BIND_HOST` is loopback the relay **assumes it is
behind one trusted proxy** and reads the client IP from the last hop of
`X-Forwarded-For` (the trusted proxy sets it and strips any client-supplied
value). `KOOKR_RELAY_TRUSTED_PROXY=0` is an explicit override for local dev
that wants the raw socket address. There is no separate refuse-to-start trap
for "loopback without a flag" — the loopback bind *is* the signal, so a
behind-proxy operator cannot forget it. The Caddyfile in the kit is the
documented trusted hop.

### 4. Constant-time secret comparison

Admin-token and account-token comparisons in `relay/server.ts` use `===`,
which short-circuits on the first mismatched byte — a timing oracle for T3.
(The share-password verifier in `store.ts` already uses `timingSafeEqual`.)
All token-equality checks move to `crypto.timingSafeEqual` over fixed-length
encodings.

### 5. Admin-API isolation, enforced by the relay

`/relay/admin/*` mints credentials and must not depend on a correct Caddyfile
as its only barrier. The relay itself **refuses** (`403`) any `/relay/admin/*`
request whose client identity (per §3) is not loopback, and counts it as a
security event. The proxy *also* blocks the path — defense-in-depth — so a
proxy misconfiguration is a degraded posture, not a full compromise. For a
self-hosted relay, node pairing is a one-time operator action over SSH
against `127.0.0.1`; the admin API never needs a public route. Remote
administration, if ever needed, is an SSH tunnel — there is no
remote-allowlist env var (cut in review as an unearned generalization).

### 6. Abuse controls, diagnosability, and retention

- **Per-share lockout (T1).** `InvitationStore` already carries
  `failedAcceptCount` / `lockedUntil` per invitation; the relay accept path
  currently increments only its per-*source* map. Phase 2 wires the relay's
  `not-found`/`invalid-password` accept result into the per-*share* counter,
  so a share locks after N global failures regardless of source IP. The lock
  has a **decay window** and an **owner-initiated reset** (re-mint the
  password); the reset is itself rate-limited so it cannot reopen T1. The
  lock is surfaced to the owner — see the diagnostic endpoint below — and a
  `perShareLockCount` metric is added.
- **Rate limits** keep hosted defaults; they key on the §3-correct client IP.
- **Request limits:** explicit relay request-body cap; the proxy adds
  connection-rate, concurrency, and read-timeout limits (slowloris).
- **Real `/health`:** `dbReachable` is currently hard-coded `true`. Phase 2
  makes it the result of a synchronous `SELECT 1` probe; `status` becomes
  `degraded` when it fails. `version` reports the real build, not `"dev"`.
- **Per-share diagnostic endpoint:** `GET /relay/node/invitations/:id`
  (authenticated with the existing node token — no new auth surface) returns
  `expiresAt`, `revokedAt`, `lockedUntil`, `failedAcceptCount`, and the
  owning node's connected/disconnected status. This is the answer to "why
  did my share stop working?" — expired vs revoked vs locked vs node-offline
  become distinguishable without console access.
- **Windowed alert metrics:** counters like `rateLimitHits` are all-time
  totals today, so an alert fires forever once tripped. Phase 2 adds a
  recent-window snapshot; alert logic uses the window so alerts can clear.
- **Off-box monitor:** auth-failure spikes raise an in-relay alert, but an
  alert pipeline inside a dead relay emits nothing. The runbook ships a
  concrete external monitor — `cron` + `curl --fail https://<domain>/health`
  every 60s, plus a daily TLS-expiry check (`openssl s_client`) alerting at a
  14-day lead — delivering to the operator by email or webhook. Installing it
  is part of the Phase 3 acceptance gate.
- **Retention:** one relay variable `KOOKR_RELAY_METADATA_RETENTION_DAYS`
  (default 30). Metadata is retained until `max(expiresAt, retention)` so a
  31-day share is never pruned early. `hosted-relay-operations.md` and this
  RFC both defer to that one variable.

### 7. TTL ceiling and password entropy

- New relay env `KOOKR_RELAY_SHARE_MAX_TTL_MS`, parsed at startup and clamped
  to the code constant `RELAY_SHARE_TTL_HARD_CAP_MS = 31 days`. **Unset →
  24h** (today's behavior; longer is explicit opt-in). `NODE_SHARE_MAX_TTL_MS`
  becomes the resolved configured value.
- **Password generation is relay-side** — `createShareTicket()` is in
  `relay/src/invitations/store.ts`, called by the relay, which knows the TTL.
  Entropy scaling is therefore enforced where the secret is minted. Current
  `SHARE_PASSWORD_BYTES = 7` = **56 bits**. Two tiers:

  | Share TTL | Password entropy |
  |-----------|------------------|
  | ≤ 24h | 56 bits (unchanged) |
  | > 24h | ≥ 80 bits |

  The 24h threshold is not arbitrary: it is the boundary of the *existing*
  model — at/below 24h a share is the anonymous short-lived object the
  current 56-bit/lockout design was sized for; above it the share becomes the
  new longer-lived object this RFC introduces. One step, one new object
  class; a finer gradient would be precision the threat model cannot justify.
- The verifier KDF (scrypt) is handled in Phase 1 (§1), so a >24h share
  already gets both the longer password and the slow-hash verifier.

### 8. Long-lived shares: operator-chosen display label

Review rejected the draft's "low intrinsic sensitivity" claim for the task
projection: `taskLabel` is free text the user chose ("fix auth bypass in
payments"), and 31 days of live `status`/`hasFinding` is a slow metadata leak
the 24h model never had to defend.

The RFC does not change the projection *contract*, but Phase 4 adds a real
mitigation, not just a warning: the share-create flow accepts an optional
operator-chosen **display label** that the relay substitutes for `taskLabel`
in that share's projection. The `redactedShareLabel` field is **already
plumbed** through `store.ts` and `share-contract.ts`, so this is a UI input
plus a relay-side substitution — not a contract change. The share-create UI
also warns, for any share over 24h, what will be visible and for how long.

### 9. Node↔relay capability handshake

The node must know the relay's effective `SHARE_MAX_TTL_MS` to populate the
duration picker; otherwise an operator who raised the ceiling finds the UI
still capped at 24h and the feature is unreachable without the API. The
existing `RelayHello` message (`src/remote/handshake.ts`, already
version-negotiated) gains one optional field, `shareMaxTtlMs`. The picker is
populated from it; the relay remains authoritative and still rejects an
over-cap `ttlMs`. This ships in Phase 4 — the first time a user can create a
>24h share, so the picker must be correct then.

### 10. Operator deployment kit

A new top-level `deploy/relay/` directory (kept out of the relay *source*
tree):

- `kookr-relay.service` — systemd unit: non-root user, `Restart=on-failure`,
  `StartLimit*` tuned so a crash-loop surfaces rather than flaps silently,
  `MemoryMax`, `NoNewPrivileges`, `ProtectSystem=strict`, env file.
- `Caddyfile.example` — Let's Encrypt TLS, proxy to `127.0.0.1:PORT`,
  `/relay/admin/*` blocked, sets the trusted forwarding header, security
  headers, request limits.
- `relay.env.example` — every relay env var with safe defaults.
- `verify.sh` — a **read-only** posture check: relay port is loopback-only;
  `:443` serves a valid cert; `/relay/admin/*` is refused from off-box; `:80`
  is ACME-only; SSH is key-only; `unattended-upgrades` and SSH fail2ban are
  active; the SQLite file exists and is readable; the systemd unit is
  `active (running)`, not crash-looping; the off-box monitor heartbeat is
  recent; a daily SQLite backup exists. It *checks*; it does not *apply*
  (config-apply commands stay as runbook copy-paste blocks).

A trivial CI test asserts `deploy/relay/verify.sh` exists, so the
"Phase 3 precedes Phase 4" rule has a mechanical backstop, not only PR
discipline.

## Migration Plan

Each phase is independently shippable. Security/durability phases precede the
capability. Every phase states its effect on the existing `share.kookr.dev`
deployment.

### Phase 1 — Relay state persistence + verifier hardening (T4, T8, T11)

SQLite-backed durable store (load-at-startup + synchronous write-on-mutation,
WAL, integrity-check, quarantine-bad-rows) for invitations, registrations,
hashed tokens, and per-share lockout counters; scrypt verifiers from day one;
structured startup log. **Upgrade effect:** the first restart onto this binary
is a one-time state wipe (old state was never persisted) — true for both
self-hosted and `share.kookr.dev`; documented, not a regression.
Acceptance: relay killed mid-share — share still joinable, node reconnects
with its token, per-share lockout counters intact, startup log reports
reloaded counts; a corrupt-row and a failed-open negative test pass.

### Phase 2 — Edge hardening + diagnosability (T1, T2, T3, T5, T6, T7, T11)

`KOOKR_RELAY_BIND_HOST` (default still `0.0.0.0`, non-loopback warns);
relay-enforced admin `403`; constant-time token compares; trusted-proxy
client-IP; per-share lockout wired + decay + owner reset; request-body cap;
real `/health` DB probe; `GET /relay/node/invitations/:id`; windowed alert
metrics. **Upgrade effect:** none bricks — the bind default is unchanged this
release. Acceptance: a simulated *distributed* (multi-source) brute force
trips the per-share lockout and raises `perShareLockCount`; enumeration test
confirms byte-identical `ticket-unavailable`; `/relay/admin/*` from a
non-loopback origin is refused by the relay with the proxy removed from the
test; `/health` reports `degraded` when the DB probe fails.

### Phase 3 — Operator deployment kit + Hetzner runbook (T9, T11)

`deploy/relay/` artifacts, `verify.sh`, the off-box monitor spec, and
`docs/reference/self-hosted-relay-runbook.md`. **Upgrade effect:** none —
docs and config templates only. Acceptance: a clean VPS, following the
runbook, ends with one public application port, valid TLS, SSH fail2ban +
`unattended-upgrades` + the off-box monitor active, the relay as a non-root
service; `verify.sh` exits zero. The proxy/firewall/TLS artifacts are a hard
predecessor of Phase 4.

### Phase 4 — TTL ceiling raise (T1, T8)

`KOOKR_RELAY_SHARE_MAX_TTL_MS` + `RELAY_SHARE_TTL_HARD_CAP_MS = 31d`;
relay-side entropy-scaled password generator (two tiers);
`KOOKR_RELAY_METADATA_RETENTION_DAYS` retention alignment;
`RelayHello.shareMaxTtlMs` handshake; duration picker learns the relay max
and gains longer presets; operator-chosen share display label; the
offline-node viewer state. The bind default may also flip to `127.0.0.1` in
this release or a later one — see §2. **Upgrade effect:** additive; unset
`KOOKR_RELAY_SHARE_MAX_TTL_MS` keeps the 24h cap, so `share.kookr.dev` is
unchanged unless it opts in. Acceptance: a `ttlMs` over the configured or
hard cap is rejected; a >24h share gets an ≥80-bit password; metadata
survives a simulated 31-day window — tested with the store's injectable
`now?: () => Date` clock, not a real 31-day wait — across a relay restart.

Phase 4 must not merge before Phases 1, 2, and Phase 3's security artifacts.

## What a viewer sees when the node is offline

A 31-day *link* does not imply a 31-day-online *node*. Kookr nodes are
laptops — they sleep and change networks. When the node is disconnected the
relay returns `node-offline`. A long-lived share must make this explicit: the
join page shows a clear "the shared task's machine is currently offline —
last seen <time>" state, distinct from a generic error. The relay does **not**
buffer or persist a last-known projection for an offline node — review noted
that would be a new durable surface and would enlarge the T8 metadata leak
(a stale projection readable while the node is off). So the offline state is
exactly that: an offline notice with a last-seen time, no stale data shown.
The link living 31 days and the task being *viewable* right now are different
guarantees, and the UI must not conflate them.

## Operator Runbook — Hetzner (summary; full version ships in Phase 3)

1. **Provision** — smallest Hetzner CX/CAX VPS, Debian/Ubuntu LTS, SSH key at
   create time, no root password.
2. **Hetzner Cloud Firewall** — inbound: `443` from anywhere; **`80` from
   anywhere** (ACME); `22` from the operator's IP/range only. Nothing else.
   The relay's own port is never listed — it is loopback.
3. **Host baseline** — non-root sudo user; `ufw` mirroring the cloud
   firewall; SSH `PasswordAuthentication no`, `PermitRootLogin no`;
   `unattended-upgrades`; `fail2ban` **SSH jail only**, with `ignoreip` for
   the operator range (no relay-log jail — see Alternatives).
4. **TLS + proxy** — DNS A record → box; Caddy with the kit Caddyfile gets a
   Let's Encrypt cert automatically, proxies `:443` → `127.0.0.1:PORT`,
   blocks `/relay/admin/*`, sets the trusted forwarding header.
5. **Relay** — clone, `pnpm install`, `pnpm build:relay`; `relay.env` with a
   `KOOKR_RELAY_ADMIN_TOKEN` from `openssl rand -hex 32`,
   `KOOKR_RELAY_BIND_HOST=127.0.0.1`, the SQLite path, and the desired
   `KOOKR_RELAY_SHARE_MAX_TTL_MS`; install and start the systemd unit.
6. **Backup** — a daily `sqlite3 .backup` of the relay DB to a second path
   (and ideally off-box), with a cron entry; `verify.sh` checks it ran.
7. **Off-box monitor** — install the `cron` + `curl --fail` liveness check
   and the daily TLS-expiry check on a *different* machine.
8. **Pair** — over SSH on the box, run `kookr-relay-init.ts` against
   `http://127.0.0.1:PORT`; copy the node token to the workstation; pair the
   local node to `https://<domain>` in Settings.
9. **Verify** — run `verify.sh`; it must exit zero. Create a share over the
   public domain and confirm the join flow.
10. **Recovery plane** — keep the Hetzner web console as the out-of-band
    path; if SSH is firewalled to one IP and that IP changes, the console is
    the only way back in.

On the "single open port" ask: **443 is the only public *application*
port.** SSH (22) is a management port, firewalled to the operator's source
IP rather than removed — locking yourself out of a remote box is the larger
risk. An operator who manages the box exclusively via the Hetzner console may
close 22 entirely.

## Testing Plan

- **Persistence** — relay killed and restarted mid-share: share joinable,
  node reconnects with its token, per-share lockout counters intact, startup
  log reports counts. Negative tests: a corrupt row is quarantined (relay
  starts); a DB that cannot be opened produces a hard logged exit.
- **Verifier** — new verifiers use scrypt; `timingSafeEqual` verification.
- **Bind** — `KOOKR_RELAY_BIND_HOST` non-loopback without
  `KOOKR_RELAY_ALLOW_INSECURE_BIND=1` warns (Phase 2) / refuses (post-flip).
- **Trusted proxy** — loopback bind reads the forwarded client IP; a
  client-supplied `X-Forwarded-For` cannot spoof it; lockout does not collapse
  all viewers into one bucket.
- **Admin isolation** — `/relay/admin/*` from a non-loopback client is
  `403`'d by the relay with the proxy absent; token compares are constant-time.
- **`/health`** — `dbReachable` reflects a real probe; `status` is `degraded`
  when the probe fails.
- **Diagnostic endpoint** — `GET /relay/node/invitations/:id` distinguishes
  expired / revoked / locked / node-offline.
- **TTL ceiling** — `ttlMs` over the configured max and over the 31-day hard
  cap both rejected; unset config still caps at 24h.
- **Entropy** — a >24h share gets an ≥80-bit password.
- **Enumeration (T2)** — unknown share ID and wrong password yield
  byte-identical responses.
- **Lockout (T1)** — per-share lockout trips under a simulated multi-source
  attack, surfaces via the diagnostic endpoint and `perShareLockCount`, and
  the owner reset clears it (and is itself rate-limited).
- **Retention (T8)** — a 31-day invitation's metadata is not pruned at the
  30-day default boundary (fake-clock test).
- **Offline node** — the join page renders the explicit offline state with a
  last-seen time and shows no stale projection.
- **Runbook dry-run** — Phase 3 scripts a provision against a throwaway VPS
  (or local container approximation) and runs `verify.sh`.

## Alternatives Considered

- **Use the hosted `share.kookr.dev` relay.** Doesn't satisfy "my own
  server"; routes the operator's task metadata through Kookr infrastructure.
- **Relay terminates TLS itself.** Re-implements what Caddy does well and
  keeps cert/renewal/0-day surface inside the relay. Reverse proxy is the
  smaller-blast-radius standard.
- **Keep 24h; re-share daily.** Rejected by the user as overkill friction for
  a long-running shared task. The 24h *default* is kept; only the ceiling
  becomes raisable.
- **Unbounded / non-expiring shares.** Rejected — the exact "effectively
  permanent share" the original cap forbids.
- **VPN / SSH tunnel / Tailscale.** The right answer when the only viewer is
  the operator (see "When NOT To Use This"); deletes the public attack
  surface. The runbook leads with it; it is not the default only because it
  needs a client install a one-off non-technical browser viewer cannot do.
- **Relay-log → fail2ban auto-ban jail.** Rejected: parsing the relay's own
  logs to drive firewall bans adds a log-injection→ban pathway and a real
  operator-self-lockout risk, for marginal gain over the in-process per-share
  lockout (§6). fail2ban is kept for SSH only.
- **In-memory state + accept short real lifetimes.** Rejected — it would make
  the 31-day TTL misleading; persistence (Phase 1) is non-negotiable.
- **A "write-through cache" two-layer store.** Rejected for the simpler
  load-at-startup + synchronous-write journaling shape (§1): same correctness
  for a single-process relay, no cache-coherence logic.
- **`KOOKR_RELAY_ADMIN_ALLOWLIST` for remote admin.** Rejected as an unearned
  generalization — the admin API is loopback-only; remote admin is an SSH
  tunnel.

## Open Questions

1. Should long-lived (>24h) shares also offer per-field projection redaction
   (e.g. hiding `hasFinding`), beyond the operator-chosen display label of §8?
   The display label covers the worst leak (the task name); per-field
   redaction is a possible later refinement.
2. SQLite backup destination: the runbook specifies a daily on-box `.backup`;
   should Phase 3 also script an off-box copy (adds a credential/transport to
   manage), or leave off-box backup to operator discretion?

(Resolved during review and no longer open: the verifier KDF — scrypt, §1;
the 31-day hard cap — honors the user's "~1 month" requirement, default
stays 24h; SQLite WAL/event-loop behavior — an implementation concern of
Phase 1, not a design question; the node↔relay handshake — ships in Phase 4,
§9.)

## Critic Feedback Incorporated

**Round 1 (2026-05-17)** — `failure-mode-analyst`, `boundary-critic`,
`design-minimalist`, `ambition-amplifier`, `socratic-challenger`, parallel.
Verified against `relay/server.ts`, `relay/src/invitations/store.ts`,
`src/remote/handshake.ts`.

Incorporated: in-memory relay state → Phase 1 persistence (the central
finding); trusted client-IP promoted from Open Question to a decided design
(§3); password generation corrected to relay-side; entropy baseline corrected
40→56 bits; verifier hardened to a slow KDF; admin isolation made
relay-enforced (§5); constant-time token comparison (§4); per-share lockout
(§6); runbook firewall fixed to allow `:80`; off-box monitoring added;
task-projection sensitivity acknowledged (§8); offline-node section added;
retention consolidated to one variable (§6); `deploy/relay/` moved out of the
source tree; refuse-insecure-bind (§2); Phase 3 gates Phase 4; old Phases 1+2
merged; `firewall.sh` replaced with read-only `verify.sh`.

**Round 2 (2026-05-17)** — `failure-mode-analyst`, `design-minimalist`,
`ambition-amplifier`, `delivery-pragmatist`, `operability-reviewer`, parallel.
The round confirmed the four-phase architecture held; findings were
refinements and one upgrade-compat risk, no structural breaks.

Incorporated: the "write-through cache" was an unspecified label → pinned to
load-at-startup + synchronous write-on-mutation journaling, `better-sqlite3`,
WAL, integrity-check, quarantine-bad-rows, hard-exit on load failure
(failure-mode L1/L4, design-minimalist); per-share lockout needed a decay
window + rate-limited owner reset, else persistence makes an unkillable lock
(failure-mode L2); the bind-default flip would brick existing relays incl.
`share.kookr.dev` → phased warn-then-flip migration, every phase now states
its upgrade effect (failure-mode L3, delivery-pragmatist); the verifier KDF
moved into Phase 1 so no on-disk legacy verifier ever exists and the
compat branch is dropped (failure-mode L5, design-minimalist); RFC text
corrected — the per-share `failedAcceptCount` counter already exists in
`store.ts`, the new work is wiring it at the relay accept path
(failure-mode F6, ambition); the loopback+no-flag refuse-to-start was a
trap → loopback bind now simply implies trusted-proxy mode
(design-minimalist, delivery-pragmatist); `KOOKR_RELAY_ADMIN_ALLOWLIST` cut
as unearned (design-minimalist); per-source lockout left in-memory, not
persisted, to keep the Phase 1 schema small (design-minimalist);
`/health` `dbReachable` is currently hard-coded and must become a real probe,
plus a per-share diagnostic endpoint and windowed alert metrics so failures
are diagnosable (operability — a whole class of "needs better signals"
findings); off-box monitor specified concretely (operability); SQLite
corruption handling, WAL, backup, and a structured startup log added
(operability, failure-mode L4); Phase 1's one-time upgrade state-wipe
documented (delivery-pragmatist); Phase 4's 31-day acceptance test uses the
store's injectable clock (failure-mode); a CI check backs the
Phase-3-gates-Phase-4 rule (delivery-pragmatist); the offline-node
"last-known projection" idea dropped — it would be a new durable surface and
enlarge the T8 leak (failure-mode L6); the share display-label mitigation
(§8) replaced "just warn the operator", using the already-plumbed
`redactedShareLabel` field (ambition).

**Adversarial-pair resolutions (`ambition-amplifier` ↔ `design-minimalist`):**

- *Capability handshake* (round 1) — minimalist said defer past Phase 4,
  ambition said ship in Phase 4. **Resolved with ambition:** deferring ships a
  feature unreachable from the dashboard; the `RelayHello` channel exists, so
  the cost is one optional field — §9.
- *Relay-log fail2ban jail* (round 1) — ambition said ship it, minimalist said
  documented-option-only. **Resolved with neither — dropped entirely:** the
  in-process per-share lockout covers app-layer brute force, and a log→ban
  pipeline adds an injection surface and a self-lockout footgun.
- *Verifier KDF* (round 2) — ambition leaned argon2id (stronger), minimalist
  leaned scrypt (no native dependency). **Resolved with design-minimalist:**
  scrypt is in Node core and adequately memory-hard; adding a native
  dependency to a security-sensitive standalone binary is not worth the
  marginal gain — §1.
- *Entropy tiers* (raised both rounds) — ambition wanted ≥3 tiers / a finer
  gradient, minimalist wanted a flat 2-tier rule. **Resolved with
  design-minimalist (held across both rounds):** two tiers, with §7 now
  stating *why* 24h is the threshold (it is the boundary of the existing
  short-lived-share model) so the coarseness is justified, not arbitrary.

**Invocation log:**
- `ambition-amplifier` 2026-05-17 (round 1): novel finding — relay
  self-probe, capability handshake in Phase 4, verifier-KDF gap.
- `ambition-amplifier` 2026-05-17 (round 2): novel finding — per-share
  counter not wired at the relay accept path; share display-label mitigation
  using the existing `redactedShareLabel` plumbing.
- Empirical checkpoint: the load-bearing claim "relay state survives restart"
  was probed in round 1 — `failure-mode-analyst` and `socratic-challenger`
  read `relay/src/invitations/store.ts` and `relay/server.ts` and confirmed
  it FALSE. The RFC was restructured around that reality (Phase 1). No
  separate `design-experimenter` run was needed — the probe was a direct
  code read, already conclusive.

**Rejected / out of scope:** "why a public relay at all vs a VPN"
(socratic) — the public-browser-link requirement is the user's deliberate
product choice; addressed via the "When NOT To Use This" section rather than
removing the RFC's premise. A relay outbound self-probe of its own public
surface (ambition) — `verify.sh` covers reachability at lower complexity and
with a cleaner failure mode; §5's relay-side `403` already removes the
catastrophic admin-exposure case.

**Convergence note:** stopped after 2 rounds. Round 2 produced substantive
refinements but confirmed the four-phase architecture; a 3rd critic round
would be diminishing returns on implementation-detail polish that the human
review (next step) is better placed to direct.
