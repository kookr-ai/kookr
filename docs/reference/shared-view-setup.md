# Read-Only Shared View Setup

The **Read-Only Shared View** lets the Kookr owner hand a collaborator a link
that opens the live dashboard (or a single project) in their browser, **read
only** — they see tasks, activity, and terminal output stream in real time, but
cannot launch, stop, approve, type into a terminal, or change anything. The
collaborator installs nothing; they open a URL.

The design lives in `docs/rfc/rfc-shared-view-readonly.md`. This page is the
operator's how-to.

> ## Preview — viewer admission is not yet enabled
>
> This build ships the **owner side** of the feature: you can mint, list, and
> revoke read-only links from the Share dialog, and every server-side guard
> (read-only WS gate, viewer GET deny-list, terminal scope check, scoped
> snapshot filtering) is in place. **Live viewer admission is deliberately
> deferred** — the `resolveViewer` / `resolveTerminalActor` wiring that lets a
> viewer cookie actually connect onto the WebSocket and terminal streams is not
> turned on yet. So today a collaborator who opens a handoff link will reach the
> SPA but **will not be admitted to live data** until that wiring lands.
>
> Set things up now and the links are real and revocable; the moment admission
> is enabled they start carrying data. Nothing in this guide asks you to enable
> admission yourself — that is a code change, out of scope for setup.

---

## What you need

- Kookr running on a host you control.
- A **private network** between you and the collaborator — a [Tailscale](https://tailscale.com)
  tailnet (recommended) or a WireGuard mesh. The shared view is **not** meant to
  be exposed on the public internet; the private network *is* the security
  boundary (see [Threat model](#threat-model)).
- The collaborator on that same tailnet / mesh, with a browser.

---

## Step 1 — Bind Kookr to a network address

By default Kookr binds loopback (`127.0.0.1`), which is unreachable from another
machine and runs with auth **off**. To share, bind a non-loopback address — your
tailnet IP (preferred) or `0.0.0.0`:

```bash
# In the Kookr checkout's .env
KOOKR_HOST=100.x.y.z      # your tailnet IP (or 0.0.0.0 to bind all interfaces)
```

Binding a non-loopback host **activates the API-token auth gate**. On startup
Kookr will refuse to run a non-loopback bind that has no credential, unless you
provide or auto-generate one:

- Set `KOOKR_API_TOKEN=<secret>` to pin a stable token (used by the `kookr` CLIs
  as `Authorization: Bearer <token>`; use at least 24 characters), **or**
- Set `KOOKR_ALLOW_NON_LOOPBACK=true` to have Kookr auto-generate a token for the
  run and print it at startup.

For a temporary compatibility window with an existing short token, set
`KOOKR_ALLOW_WEAK_API_TOKEN=true`; Kookr logs a warning and still enforces that
provided token.

The browser dashboard does **not** use the bearer token directly — it exchanges
a one-time link token for an `HttpOnly` session cookie (Step 2). The bearer
token is for CLI/automation clients.

See [Environment Variables → Server And Data](environment-variables.md#server-and-data)
for the full matrix.

---

## Step 2 — Give the browser an encrypted path (cookie posture)

The session cookie Kookr sets after the link exchange is `HttpOnly;
SameSite=Strict; Path=/`. Its `Secure` flag — and whether the exchange is even
allowed — depends on how the browser reaches the host:

| How the dashboard is reached | Cookie | What you must do |
| --- | --- | --- |
| **HTTPS** (e.g. Tailscale Serve in front) | `Secure` | Nothing — this is the recommended path. |
| Plain HTTP over an asserted tunnel | non-`Secure` | Set `KOOKR_TRUSTED_TUNNEL=true`. |
| Plain HTTP, no assertion | — | **Refused (fail-closed).** The browser session exchange is rejected and Kookr logs why. |

A browser never sends a `Secure` cookie over plain `http://`, so a naive
`Secure` flag would silently break the whole exchange on a plain-HTTP tailnet
bind. Kookr therefore sets `Secure` **only** over HTTPS, and will issue a
non-`Secure` cookie over plain HTTP **only** when you assert the path is already
encrypted.

### Recommended: Tailscale Serve (HTTPS, keeps `Secure`)

Tailscale Serve terminates TLS for you and forwards `X-Forwarded-Proto: https`,
so the cookie stays `Secure` and you set **no** extra flag. Assuming Kookr is on
port 4800:

```bash
# Bind Kookr to your tailnet IP first (Step 1), then put Tailscale Serve in front:
tailscale serve --bg --https=443 http://localhost:4800
```

Your collaborator opens `https://<your-machine>.<tailnet>.ts.net/`. The link
handoff URL Kookr generates inherits the HTTPS scheme automatically (it honors
`X-Forwarded-Proto`).

### Alternative: plain HTTP over WireGuard / a raw tailnet

If you front nothing and serve plain `http://<tailnet-ip>:4800` directly, the
transport is still encrypted by the mesh, but the browser won't carry a `Secure`
cookie. Assert the encrypted tunnel so the exchange is permitted:

```bash
KOOKR_TRUSTED_TUNNEL=true
```

> **`KOOKR_TRUSTED_TUNNEL` is trusted, not validated.** It is your assertion that
> the bind sits behind a mesh-encrypted tunnel; Kookr does **not** verify the
> bind is non-public. **Never set it on a routable public bind** — doing so ships
> a non-`Secure` cookie on an unencrypted path, exposing the session. Prefer
> Tailscale Serve, which needs no flag.

Restart Kookr after editing `.env` so the new bind/posture take effect.
At startup Kookr logs the resolved posture, e.g.:

```
[auth] Non-loopback bind (KOOKR_HOST=100.x.y.z); KOOKR_TRUSTED_TUNNEL=true — issuing the session cookie over the asserted secure tunnel (non-Secure on plain HTTP).
```

or, if the exchange will be refused:

```
[auth] Non-loopback bind (KOOKR_HOST=100.x.y.z) without HTTPS or KOOKR_TRUSTED_TUNNEL — browser session cookie exchange is REFUSED over plain HTTP (fail-closed). Front the dashboard with HTTPS (e.g. Tailscale Serve) or set KOOKR_TRUSTED_TUNNEL=true only if the bind sits behind a mesh-encrypted tunnel.
```

---

## Step 3 — Create and hand off a link

The Share controls are reachable from your own dashboard (an owner action; the
owner-only share routes are active whenever the auth gate is on — i.e. a
non-loopback bind).

1. Open the command palette and run **"Share read-only view"** (search
   `share`, `viewer`, or `read-only`), or click **Share read-only view** in the
   Help & Shortcuts dialog (`?`).
2. **Pick a scope:**
   - **Whole dashboard** — the viewer sees every project and task.
   - **A single project** — the viewer sees only that project; everything else is
     scrubbed server-side before it reaches them.
3. **Pick an expiry** (optional): `Never`, `1 hour`, `24 hours`, `7 days`, or
   `30 days`.
4. Click **Create**. Kookr returns a **one-time handoff URL** of the form:

   ```
   https://<host>/#token=<token>
   ```

   The raw token rides in the URL **fragment** (`#token=…`), which a normal
   browser navigation never sends to any server. The token is shown **exactly
   once** and is not re-derivable — copy it now.
5. **Hand it off** over a channel you trust (e.g. a DM on the same tailnet).
   When the collaborator opens it, the SPA reads the fragment, exchanges it for
   the `HttpOnly` session cookie via `POST /api/auth/session`, and clears the
   fragment from the address bar. From then on the cookie rides automatically on
   HTTP fetches and the WebSocket upgrade — no token ever appears in a WS URL.

> **One session per browser origin.** The session cookie is per-origin and the
> last exchange wins. If a collaborator needs to hold both an owner and a viewer
> session to the same host, use a separate browser profile for each.

---

## Step 4 — Watch and revoke

The Share dialog lists every link with its scope, expiry/status, and a
connected / last-seen indicator drawn from the live viewer roster.

To cut off access, click **Revoke** on the link. Revocation is immediate at the
store and live sockets are dropped on the next revocation-sweep tick (within the
sweep interval) — the viewer's dashboard and any open terminal stream close.
Expired links stop admitting new sessions automatically.

---

## Threat model

The full analysis is in the RFC (§"Threat model"). The operationally important
points:

- **The private network is the boundary.** The tailnet / WireGuard mesh is
  mesh-encrypted and not public. The link credential scopes *what* a viewer sees
  and enforces *read-only* inside that scope; it is not a substitute for the
  network being private. Do not expose the bind to the public internet.
- **Read-only is server-enforced.** Viewers are denied every mutating path at
  the server (inbound WebSocket gate, API GET deny-list, no terminal write path).
  The UI also hides mutation controls for viewers, but that suppression is
  cosmetic — the real boundary is server-side.
- **Terminal output is visible by design.** A within-scope terminal stream is
  shown to the viewer as-is. **Any secret printed into a shared terminal is
  visible to the viewer** — treat terminal output as shared, and avoid echoing
  credentials in a session you're sharing.
- **A leaked link token is least-privilege.** It grants scoped, read-only access
  only — no mutation, no cross-scope escalation — and is revocable within a sweep
  interval. The session cookie is `HttpOnly`, so page XSS cannot read it; the raw
  token exists only in the one-time fragment.
- **`KOOKR_TRUSTED_TUNNEL` is an unverified assertion** (see Step 2). Never set
  it on a public bind.

---

## Quick reference

| Variable | Purpose |
| --- | --- |
| `KOOKR_HOST` | Bind address. Non-loopback activates the auth gate and the share feature. |
| `KOOKR_API_TOKEN` | Bearer token for CLI/automation clients on a non-loopback bind. Must be at least 24 characters unless explicitly overridden. Browsers use the session cookie instead. |
| `KOOKR_ALLOW_NON_LOOPBACK` | `true` auto-generates an API token (printed at startup) instead of refusing to start. |
| `KOOKR_ALLOW_WEAK_API_TOKEN` | `true` temporarily accepts an operator-provided token shorter than 24 characters on a non-loopback bind. |
| `KOOKR_TRUSTED_TUNNEL` | `true` permits a non-`Secure` session cookie over plain HTTP on a non-loopback bind. Trusted, not validated — never on a public bind. |
| `KOOKR_SHARE_GRANT_RETENTION_MS` | Retention window (ms) before revoked/expired viewer grants are compacted out of `share-grants.json`. Default `2592000000` (30 days); `0` prunes immediately. |
| `KOOKR_PORT` | HTTP/WebSocket port (default `4800`). |

Full details: [Environment Variables](environment-variables.md). Related:
[Session Sharing](session-sharing.md) (relay-based task link sharing — a separate
mechanism).
