# Production Server Service

Kookr ships a systemd user unit template for operators who want the production
server to start at login, survive host reboots with lingering enabled, and come
back after crashes. This is Linux/systemd only. macOS launchd support is out of
scope for this template.

The unit starts the server directly with `node dist/server/start.js`. It does
not run `pnpm prod:restart`, because that script has its own pid-file process
manager. When the unit is active, `scripts/prod-restart.sh` detects it and
delegates to `systemctl --user restart kookr.service` instead of killing the
port process itself.

## Install

Build or update the production worktree first:

```bash
pnpm prod:update
```

Install the user unit:

```bash
mkdir -p ~/.config/systemd/user ~/.config/kookr
cp deploy/server/kookr.service ~/.config/systemd/user/kookr.service
systemctl --user daemon-reload
systemctl --user enable --now kookr.service
```

The template assumes the production worktree is at `%h/git/kookr-prod`, which
matches the default `pnpm prod:setup` and `pnpm prod:update` layout. If your
production checkout lives somewhere else, edit `WorkingDirectory=` in
`~/.config/systemd/user/kookr.service` before enabling the unit.

Optional environment overrides can live in `~/.config/kookr/kookr.env`:

```bash
KOOKR_PORT=4800
KOOKR_HOST=127.0.0.1
```

Do not put shell syntax such as `export` in this file. systemd environment
files use `KEY=value` lines.

## Start At Boot

User units normally start when the user logs in. To let the service start after
a reboot before an interactive login, enable lingering:

```bash
loginctl enable-linger "$USER"
systemctl --user enable --now kookr.service
```

On WSL2, systemd must also be enabled in `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

After changing `wsl.conf`, shut down and restart the distribution from Windows:

```powershell
wsl.exe --shutdown
```

## Operate

Check service state and logs:

```bash
systemctl --user status kookr.service
journalctl --user -u kookr.service -f
```

Restart through systemd when the unit is active:

```bash
systemctl --user restart kookr.service
```

`pnpm prod:update` remains the build-and-deploy command. After the build, its
restart step calls `scripts/prod-restart.sh`; when `kookr.service` is active,
the script delegates to the same `systemctl --user restart kookr.service`
command and waits for `/api/health`.

`pnpm prod:restart` behaves the same way. If the unit is inactive or systemd is
unavailable, the script falls back to the existing pid-file and port-kill
restart flow.

For short-lived runtime tuning without a restart, use the admin runtime-control
API documented in [API Reference](api.md#admin--runtime-control). It covers
temporary log-level changes with TTL auto-revert, operational alert threshold
updates, operational alert history, and drain/resume. Loopback requests are
trusted; non-loopback callers must pass normal owner API authentication and
provide `x-kookr-admin-token` matching `KOOKR_ADMIN_TOKEN`.

To return to script-managed operation:

```bash
systemctl --user disable --now kookr.service
pnpm prod:restart
```

## Verify

After installing the unit, verify the basic lifecycle:

```bash
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/health
systemctl --user kill --signal=SIGKILL kookr.service
sleep 10
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/health
```

For reboot validation, reboot the host or restart WSL2, then check:

```bash
systemctl --user status kookr.service
curl -fsS http://127.0.0.1:4800/api/health
```
