# README.md — Proposed Diff

Three textual changes to `/home/jean/git/kookr/README.md`. Ready to apply as a single commit alongside the `docs/codex-cli-setup.md` add.

---

## Change 1 — Update demo video link (line 21)

```diff
 <img src="assets/branding/derived/kookr-screenshot.png" alt="Kookr dashboard - detect anomalies, respond, auto-advance" width="960" />

-[Watch the narrated demo video](https://github.com/kookr-ai/kookr/releases/tag/demo-v1)
+[Watch the narrated demo video (1080p + 4K)](https://github.com/kookr-ai/kookr/releases/tag/demo-v3)

 ## What Kookr Does
```

**Rationale:** demo-v1 is the legacy 720p 90s cut. demo-v3 is the 1080p/4K 2:30 cut produced by this RFC.

**Pre-condition:** the GitHub Release `demo-v3` must exist before this commit merges. If the release isn't ready, hold the README PR.

---

## Change 2 — Add "Works with Codex CLI" line under Quick Start (after line 42)

```diff
 Open `http://localhost:5173`.

 Prerequisites: `git`, Node.js `>=22`, `pnpm >=10`, and build tools for native modules. Claude Code is only required when you want Kookr to launch Claude Code agents.

+**Works with Codex CLI** via a maintained fork that adds the Claude-compatible hooks Kookr depends on. See [Codex CLI Setup](docs/codex-cli-setup.md).
+
 If setup fails, run:
```

**Rationale:** the current Quick Start mentions Claude Code is optional but says nothing about how Codex CLI plugs in. New readers don't know there's a fork story. This single line surfaces it without leaving Quick Start.

---

## Change 3 — Update Core Features bullet (line 80)

```diff
 ## Core Features

-- Real-time monitoring for Claude Code and Codex CLI agents
+- Real-time monitoring for Claude Code and Codex CLI agents (Codex CLI requires the maintained [`jeanibarz/codex#feat/claude-compat`](docs/codex-cli-setup.md) fork)
 - Anomaly detection and prioritized findings
```

**Rationale:** the bullet today implies vanilla Codex CLI works out of the box. It doesn't — the upstream `openai/codex` is missing the hooks Kookr relies on. Naming the fork once in the headline bullet sets accurate expectations.

---

## Apply order

1. Land `docs/codex-cli-setup.md` (new file, content in `codex-cli-setup.md` of this drafts directory).
2. Apply Changes 1–3 to `README.md` in the same commit as step 1.
3. Verify the relative link `docs/codex-cli-setup.md` resolves from the rendered README on `github.com`.

## Out of scope for this diff

- The hero screenshot (`assets/branding/derived/kookr-screenshot.png`). Optional follow-up: regenerate it from the new 1920×1080 dashboard layout. Not required for v3 ship.
- The Star History image. Stays as-is.
- The "Architecture In One Screen" block. Stays as-is — multi-project / Codex compat doesn't change the architecture diagram materially.
