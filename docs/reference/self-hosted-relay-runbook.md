# Self-Hosted Relay Runbook

This runbook is for operating a Kookr relay on a public VPS when a browser-only third-party viewer needs a public URL. If the only remote viewer is the operator, prefer WireGuard, Tailscale, or SSH port forwarding instead; those avoid a public application surface.

## Target Posture

- Public application port: `443` only.
- Port `80`: open only for ACME HTTP-01 and HTTP to HTTPS redirect.
- Port `22`: restricted to the operator source IP or closed if the Hetzner console is the only management plane.
- Relay process: listens on `127.0.0.1:$PORT`, behind Caddy TLS.
- Admin API: reachable only over loopback or an SSH tunnel. The relay also refuses non-loopback `/relay/admin/*` requests.
- State: SQLite with WAL at `/var/lib/kookr-relay/relay.sqlite`, backed up daily.

## Provision

1. Create a small Hetzner CX or CAX VPS running Debian or Ubuntu LTS.
2. Install the SSH key at creation time. Do not enable password login.
3. Create a Hetzner Cloud Firewall:
   - Allow `443/tcp` from anywhere.
   - Allow `80/tcp` from anywhere for ACME.
   - Allow `22/tcp` only from the operator IP range.
   - Do not expose the relay port.

## Host Baseline

```bash
sudo adduser --disabled-password --gecos '' kookr-relay
sudo mkdir -p /opt/kookr /etc/kookr /var/lib/kookr-relay /var/log/kookr-relay /var/backups/kookr-relay
sudo chown -R kookr-relay:kookr-relay /opt/kookr /var/lib/kookr-relay /var/log/kookr-relay
sudo apt-get update
sudo apt-get install -y caddy curl fail2ban git openssl sqlite3 unattended-upgrades ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.33.0 --activate
sudo sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from <operator-ip-or-cidr> to any port 22 proto tcp
sudo ufw enable
sudo systemctl enable --now unattended-upgrades fail2ban
```

Keep fail2ban scoped to SSH. Do not parse relay logs into firewall bans; relay-level brute force is handled by per-share lockout and rate limits.

## Build And Install

```bash
sudo -u kookr-relay git clone https://github.com/kookr-ai/kookr /opt/kookr
cd /opt/kookr
sudo -u kookr-relay pnpm install
sudo -u kookr-relay pnpm build:relay
sudo cp deploy/relay/relay.env.example /etc/kookr/relay.env
sudo install -m 0644 deploy/relay/kookr-relay.service /etc/systemd/system/kookr-relay.service
```

Edit `/etc/kookr/relay.env`:

```bash
PORT=8080
KOOKR_RELAY_BIND_HOST=127.0.0.1
KOOKR_RELAY_PUBLIC_ORIGIN=https://relay.example.com
KOOKR_RELAY_STATE_DB_PATH=/var/lib/kookr-relay/relay.sqlite
KOOKR_RELAY_ADMIN_TOKEN=<openssl rand -hex 32>
```

Self-hosted relays normally do not need the hosted relay product gate. Only set
the `KOOKR_HOSTED_RELAY_*` fields and `KOOKR_RELAY_INCIDENT_ESCALATION_URL`
below when operating this deployment as a hosted/public relay for multiple
tenants. After that hosted gate checklist passes, set the hosted relay fields. See
`docs/reference/hosted-relay-operations.md` for the checklist, synthetic probes,
per-tenant terminal kill switch, and metadata-only evidence export requirements:

```bash
KOOKR_HOSTED_RELAY_ENABLED=1
KOOKR_HOSTED_RELAY_OPS_GATES_MET=1
KOOKR_HOSTED_RELAY_OWNER=ops@example.com
KOOKR_HOSTED_RELAY_ENVIRONMENT=production
KOOKR_HOSTED_RELAY_TLS_EXPIRES_AT=2026-12-31T00:00:00.000Z
KOOKR_RELAY_INCIDENT_ESCALATION_URL=https://pager.example.invalid/kookr-relay
```

Then start the relay:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kookr-relay
sudo journalctl -u kookr-relay -n 50 --no-pager
```

On startup, confirm a `relay.state.loaded` log line reports registrations, invitations, lockouts, and load time.

## Caddy

```bash
sudo cp /opt/kookr/deploy/relay/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/relay.example.com/<your-domain>/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy terminates TLS, blocks `/relay/admin/*`, sets forwarding headers, and proxies to `127.0.0.1:8080`.

## Pair The Node

Pairing is a local operator action on the VPS. Use SSH or an SSH tunnel to call the loopback admin API:

```bash
curl --fail -sS \
  -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Workstation"}' \
  http://127.0.0.1:8080/relay/admin/nodes
```

Copy the returned node token to the local Kookr node configuration and use `https://<domain>` as the relay URL.

## Backups

Install a daily SQLite backup:

```bash
sudo tee /etc/cron.daily/kookr-relay-backup >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
sqlite3 /var/lib/kookr-relay/relay.sqlite ".backup '/var/backups/kookr-relay/relay-$(date +%Y%m%d).sqlite'"
find /var/backups/kookr-relay -type f -name 'relay-*.sqlite' -mtime +45 -delete
EOF
sudo chmod +x /etc/cron.daily/kookr-relay-backup
```

## Off-Box Monitor

Install the monitor on a different machine. It must not live only on the relay host.

Liveness every minute:

```cron
* * * * * curl --fail --silent --show-error https://relay.example.com/health >/dev/null && ssh relay-box 'date +\%s | sudo tee /var/lib/kookr-relay/monitor-heartbeat >/dev/null'
```

TLS expiry once daily with a 14-day warning threshold:

```bash
#!/usr/bin/env bash
set -euo pipefail
domain=relay.example.com
expiry=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)
expiry_epoch=$(date -d "$expiry" +%s)
if [ $(( (expiry_epoch - $(date +%s)) / 86400 )) -lt 14 ]; then
  printf 'Kookr relay certificate expires soon: %s\n' "$expiry" >&2
  exit 1
fi
```

Wire these checks to email, ntfy, PagerDuty, or another channel the operator actually sees.

## Metrics (Prometheus)

The relay exposes its metric snapshot as a Prometheus text exposition, so an operator
already scraping the Kookr server can graph relay time-series (connected nodes, ticket
outcomes, rate-limit hits, 5xx counts) and alert on `kookr_relay_alert_active`. It sits
behind the same admin-token / loopback gate as the JSON view — add `?format=prometheus`
to the existing `/relay/admin/metrics` endpoint:

```bash
curl --fail -sS \
  -H "Authorization: Bearer $KOOKR_RELAY_ADMIN_TOKEN" \
  'http://127.0.0.1:8080/relay/admin/metrics?format=prometheus'
```

Because the endpoint is loopback-only, scrape it through an SSH tunnel or a Prometheus
agent co-located on the relay host that forwards to your central Prometheus. Example
scrape config (agent running on the relay box, tunnelling the admin token):

```yaml
scrape_configs:
  - job_name: kookr-relay
    metrics_path: /relay/admin/metrics
    params:
      format: [prometheus]
    authorization:
      credentials_file: /etc/kookr-relay/admin-token
    static_configs:
      - targets: ['127.0.0.1:8080']
```

Omitting `format=prometheus` returns the existing `{ metrics, alerts }` JSON, unchanged.

## Verify

Run the read-only posture check from the server:

```bash
sudo KOOKR_RELAY_DOMAIN=relay.example.com /opt/kookr/deploy/relay/verify.sh
```

It checks loopback binding, TLS, admin-path refusal, SSH hardening, unattended upgrades, SSH fail2ban, the relay systemd unit, SQLite readability, monitor heartbeat, and daily backup presence. It does not apply changes.

## Recovery

Keep Hetzner console access working. If SSH is restricted to one source IP and that address changes, the console is the out-of-band recovery path.

For SQLite corruption, failed WAL startup, or a DB-open failure:

```bash
sudo systemctl stop kookr-relay
sudo install -d -m 0700 /var/lib/kookr-relay/recovery
sudo cp -a /var/lib/kookr-relay/relay.sqlite* /var/lib/kookr-relay/recovery/
latest_backup=$(ls -1t /var/backups/kookr-relay/relay-*.sqlite | head -1)
sqlite3 "$latest_backup" 'PRAGMA integrity_check;'
sudo install -o kookr-relay -g kookr-relay -m 0600 "$latest_backup" /var/lib/kookr-relay/relay.sqlite
sudo rm -f /var/lib/kookr-relay/relay.sqlite-wal /var/lib/kookr-relay/relay.sqlite-shm
sudo systemctl start kookr-relay
curl --fail https://relay.example.com/health
sudo journalctl -u kookr-relay -n 50 --no-pager
```

Restoring a backup rolls relay state back to that backup timestamp. Node tokens, share-ticket verifiers, revocations, and lockout counters created after the backup may be missing; re-pair affected nodes or re-create/revoke shares as needed.
