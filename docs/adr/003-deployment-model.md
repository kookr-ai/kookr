# ADR-003: Deployment Model

## Status

**Accepted** (2026-03-23, by Jean Ibarz)

## Context

Kookr must decide how it is deployed and run. This is complicated by a key constraint: **AI coding agents run as local processes**, and many target users work behind **corporate VPNs** where internal tools (GitHub Enterprise, GitLab, Jira) are not publicly accessible.

Three deployment models are considered:

## Options

### Option A: Local Desktop Application (Electron/Tauri)

The entire application (frontend + backend) is packaged as a desktop app.

**Pros:**
- Full access to local processes (agents) and VPN-protected services
- Offline capable
- No server infrastructure to maintain
- Single binary distribution

**Cons:**
- Desktop packaging adds complexity (Electron ~150MB, Tauri ~10MB)
- Cross-platform builds and testing (Linux, macOS, Windows)
- Auto-update mechanism needed
- Harder to share/collaborate (each user has their own instance)
- Electron in particular has a reputation for resource bloat

### Option B: Cloud-Hosted Web Application

Frontend served from the cloud, backend runs on a server.

**Pros:**
- Zero installation — just open a URL
- Automatic updates
- Multi-user / team features are natural
- Standard web deployment (containers, CI/CD)

**Cons:**
- **Cannot access local agent processes** — agents run on the developer's machine, not the cloud
- **Cannot access VPN-protected services** without tunneling
- Requires a relay/bridge agent on the developer's machine, adding significant complexity
- Latency for real-time agent monitoring
- Hosting costs

### Option C: Hybrid — Local Backend + Browser Frontend (recommended for exploration)

The backend runs locally (as a CLI daemon or service), and the frontend is served by the local backend and accessed in the user's browser.

**Pros:**
- Full access to local processes and VPN services (backend is local)
- No desktop packaging overhead — just `npx kookr` or `pip install kookr && kookr`
- Standard browser-based frontend — no Electron/Tauri build complexity
- Simple packaging (npm package or pip package)
- Migration path: the same backend could later be deployed to the cloud with minimal changes
- Frontend development uses standard web tooling

**Cons:**
- Single-user by default (but could add auth for local network access)
- Must start a local server (minor friction vs. desktop double-click)
- Port conflicts possible (mitigatable with auto port selection)
- Less "native" feel than a desktop app (no system tray, no OS notifications without additional work)

## Technical Criteria for Decision

| Criterion | Weight | Local Desktop | Cloud | Hybrid (Local+Browser) |
|-----------|--------|--------------|-------|----------------------|
| Access to local agent processes | Critical | Yes | No | Yes |
| Access to VPN services | Critical | Yes | No | Yes |
| Installation simplicity | High | Medium | Excellent | Good |
| Packaging complexity | High | High | Low | Low |
| Cross-platform support | High | Complex | Simple | Simple |
| Team collaboration | Medium | Poor | Excellent | Poor (extendable) |
| Offline support | Medium | Yes | No | Yes |
| Resource overhead | Medium | High (Electron) | None local | Low |
| Auto-updates | Low | Complex | Automatic | npm/pip update |

## Decision

**Option C: Hybrid — Local Backend + Browser Frontend.**

The backend runs as a local Node.js process (started via CLI, e.g. `npx kookr`), serving the frontend SPA and managing agent processes directly. The user accesses the GUI through their browser.

## Consequences

- Backend is a Node.js process started via CLI command
- Frontend is a SPA served by the local backend
- Distribution via npm — familiar to developers (`npx kookr` or `npm install -g kookr`)
- Must design backend API to be deployment-agnostic (could run locally or in cloud later)
- System notifications via Browser Notification API
- Port management (default + fallback) needed
- No Electron/Tauri packaging complexity
- Full access to local agents and VPN-protected services
