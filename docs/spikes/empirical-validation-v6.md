# Empirical Validation Report — RFC v6

**Date:** 2026-04-21
**Runner:** manual probes from `design-experimenter`-philosophy session (agent file staged but not yet registered)
**Platform:** Linux WSL2, systemd-as-init, bash, user uid=1000
**Budget used:** ~90 min probed directly; no 4 h harness run for full xterm.js matrix

---

## Top-line verdict

**The RFC's motivating premise is falsified.** Neither Claude Code nor Codex CLI emit DECSET 1000 / 1002 / 1006 (mouse reporting) during startup or early interaction. The framing "xterm.js now eats wheel events locally and Claude Code never sees them" targets a feature Claude Code doesn't request. Any PR replacing tmux with dtach to "forward mouse events to Claude Code" is solving a problem that doesn't exist as stated.

Separately, the **`-r winch` behavior is weaker than v6 suggests** — it replays *nothing*, not just pre-alt-screen. The ring buffer is needed for more than OAuth URLs.

Several other RFC claims hold; details below.

---

## Tested claims

### C1: "systemd-logind `RemoveIPC=yes` is the default on most distros; `/run/user/$UID` is cleared on last session close"

- **Method:**
  ```bash
  systemctl show user@$(id -u).service | grep RemoveIPC
  grep RemoveIPC /etc/systemd/logind.conf
  ```
- **Observed:**
  ```
  RemoveIPC=no
  #RemoveIPC=yes         (commented default in logind.conf)
  ```
- **Verdict:** **PARTIAL / MISATTRIBUTED**.
  - On this WSL2 system, `RemoveIPC` is currently `no`.
  - The concern the RFC is pointing at is real (runtime-dir teardown on logout) but is controlled by `pam_systemd` + `systemd-user-runtime-dir@.service`, not `RemoveIPC`. `RemoveIPC` covers SysV/POSIX IPC objects, not the `/run/user/$UID` directory.
- **RFC implication:** rename the justification from "`RemoveIPC=yes` defaults" to "`systemd-user-runtime-dir@` tears down `/run/user/$UID` on last session close." The conclusion (default to `/tmp`) stays the same.

---

### C2: "`dtach` is installed at install time. `start.ts` probes `command -v dtach` at startup; missing → exit with install hint."

- **Method:**
  ```bash
  command -v dtach
  dpkg -l | grep dtach
  ```
- **Observed:** `dtach` not installed; not in `dpkg`.
- **Verdict:** **FAILS** as-is. Distribution assumption wrong on at least this Ubuntu/Debian-on-WSL image.
- **Side-finding (not a failure):** dtach source is tiny and builds cleanly from https://github.com/crigler/dtach. 77 KB binary, 3 files, 2 s build. No flaky deps. Committing a build script or shipping a vendored binary is feasible.
- **RFC implication:** "install via `apt install dtach`" assumption is off-base for some Debian flavors. Either (a) vendor a build script, (b) bundle the binary per-platform, or (c) accept that some users see the install-hint path even on mainstream distros.

---

### C3: "default socket dir is `/tmp/kookr-dtach/<uid>/` to survive `RemoveIPC=yes`"

- **Method:**
  ```bash
  findmnt /tmp
  findmnt /run/user/$(id -u)
  stat -c '%a %U %G %n' /tmp /run/user/$(id -u)
  ```
- **Observed:**
  - `/tmp` — not a separate mount (on ext4 root), mode `1777` (world-writable + sticky).
  - `/run/user/1000` — `tmpfs`, mode `700`, owned `jean:jean`, options include `nosuid,nodev`.
- **Verdict:** **HOLDS**. `/tmp` is persistent (within WSL distro lifetime) and survives logout; `/run/user/$UID` is tmpfs and torn down.
- **RFC implication:** `/tmp/kookr-dtach/<uid>/` is the correct default. The per-uid subdirectory matters because `/tmp` has mode 1777 (any user can create siblings) — the RFC currently specifies `<uid>` correctly.

---

### C4: "xterm.js's `coreMouseService` forwards wheel events as CSI sequences natively over a byte-transparent WS + PTY"

- **Method:** not run end-to-end. The existing POC harness at `docs/spikes/mouse-forwarding-poc/` covers 1 of 6 required cells. Full 48-cell matrix expansion (~2–4 days) was not performed.
- **Verdict:** **CANNOT TEST** at this session's budget. Critically, **Claim C7 below falsifies the motivation** — Claude Code/Codex don't emit mouse modes, so C4's success or failure is moot for those agents.
- **RFC implication:** if the RFC pivots to target a different use case (e.g., wheel → xterm.js scrollback as PR #320 already does), the xterm.js forwarding test is no longer load-bearing.

---

### C5: "`dtach -r winch` triggers alt-screen TUI repaint on attach (SIGWINCH delivery to child)"

- **Method:** minimal Python TUI prints `PRE-ALT-SCREEN-MARKER`, enters alt-screen, draws content, installs SIGWINCH handler that clears and prints `REPAINT-ON-WINCH`. Spawn under `dtach -n /tmp/test4.sock -r winch -- python3 test-tui.py`. Attach twice from a fresh PTY-backed client. See `/tmp/test-tui.py` and `/tmp/dtach-probe.py`.
- **Observed:**
  ```
  === ATTACH 1 (63 bytes) ===
    MISSING: PRE-ALT-SCREEN-MARKER
    MISSING: ALT-SCREEN-CONTENT
    FOUND:   REPAINT-ON-WINCH
    first bytes: \x1b[H\x1b[J\x1b[H\x1b[2JREPAINT-ON-WINCH line A\r\n...

  === ATTACH 2 (63 bytes) ===
    (identical — SIGWINCH fires again on re-attach)
  ```
- **Verdict:** **HOLDS**. SIGWINCH is delivered; the child's handler runs and the output reaches the attached client.

---

### C6: "`-r winch` does NOT replay pre-alt-screen output"

- **Method:** same harness as C5.
- **Observed:** `PRE-ALT-SCREEN-MARKER` absent from every attach capture. Additionally, `ALT-SCREEN-CONTENT` (initial alt-screen draw *before* SIGWINCH fires) is also absent.
- **Verdict:** **CONFIRMED — STRONGER THAN RFC STATES**. `-r winch` replays *nothing* — not pre-alt-screen, not pre-SIGWINCH alt-screen. It only delivers whatever the child emits *in response* to SIGWINCH.
- **RFC implication:** the ring-buffer requirement (v6 §Ring buffer) is even more critical than v6 says. Without a buffer, reattaching loses:
  - OAuth URLs / startup banners (pre-alt-screen) — v6 already acknowledges this
  - Any alt-screen content drawn before the child's first SIGWINCH repaint cycle (v6 does NOT acknowledge — assumed `-r winch` covers it)
  - Any stderr or bytes outside the child's SIGWINCH repaint path
  If the child's SIGWINCH handler is slow or skipped, the client sees a blank screen until the next natural redraw.

---

### C7: "Claude Code emits DECSET 1000/1006 (mouse reporting)"

- **Method:**
  ```bash
  script -q -f -c 'claude --model haiku' /tmp/cc-session.log   # 6 s interactive
  python3 -c "<regex scan for \\x1b[?NNNN{h,l}>"               # all DECSET modes
  ```
  - Same for `codex`.
- **Observed (Claude Code, 1426 bytes captured):**
  ```
  DECSET/RST modes (count):
    1004h: 1   (focus events)
    2004h: 1   (bracketed paste)
    2031h: 1   (color-palette change notifications)
    25h:   1   (show cursor)
    25l:   1   (hide cursor)
  Mouse-related modes found: NONE
  ```
  Additionally: `\e[<u` `\e[>1u` (kitty keyboard protocol), `\e[>4;2m` (modifyOtherKeys level 2).
- **Observed (Codex CLI, 181 bytes captured, shorter session):**
  ```
  DECSET/RST modes (count):
    1004h: 1
    2004h: 1
  Mouse-related modes: NONE
  ```
- **Verdict:** **FALSIFIED (both agents)**. Neither Claude Code nor Codex CLI enables mouse reporting. They use kitty keyboard protocol + modifyOtherKeys for enhanced keys, not mouse.
- **RFC implication:** this is load-bearing for the whole RFC. The problem statement "xterm.js now eats wheel events locally and Claude Code never sees them" is factually correct but misses the point — Claude Code didn't want them in the first place. Any design that justifies itself as "let the agent see wheel events" is targeting a feature the agents don't request. **The RFC needs re-grounding against a specific user pain that is not "forward mouse to agent."**

---

### C8: "WebSocket transport is binary-framed. The current text-mode WS coercion path (if any) is fixed as part of this PR"

- **Method:**
  ```bash
  rg -n "ws\.send|data\.toString" src/server/terminal-bridge.ts
  ```
- **Observed:** `src/server/terminal-bridge.ts:41`:
  ```typescript
  this.ws.on('message', (data) => {
    if (!this.pty) return;
    const msg = data.toString();   // ← string coercion
    …
    this.pty.write(msg);            // ← write as string
    …
    if (msg.includes('\r') || msg.includes('\n')) { … }
  });
  ```
  Output direction (`this.ws.send(data)` where `data` is a node-pty `Buffer`) is byte-transparent. Input direction is string-coerced.
- **Verdict:** **FAILS as-stated**. Current Kookr WS is only byte-transparent one way. Any byte-identity test across the full round-trip will fail today regardless of dtach.
- **RFC implication:** this is not a v6-introduced problem — it's a pre-existing latent bug. Fixing it is arguably worth doing independently of dtach. If the user pain is actually about characters getting through correctly (e.g., paste of non-ASCII content, or mouse CSI bytes that include `>=0x80`), fixing the `.toString()` is the right immediate step.

---

### C9: "Concurrent `createSession` with read-modify-write on one manifest file corrupts it"

- **Method:** not run. Stopped probing once C7 falsified the RFC premise.
- **Verdict:** **CANNOT TEST (budget reprioritized)**. Would be a 15-min reproducer.

---

### C10: "Linux UDS sockaddr path limit is 108 bytes"

- **Method:** Python `socket.bind(path)` with paths of length 100, 107, 108, 109, 110.
- **Observed:**
  ```
  len=100: OK
  len=107: OK
  len=108: FAIL
  len=109: FAIL
  len=110: FAIL
  ```
- **Verdict:** **CORRECTED**. Max usable path is **107 bytes**, not 108. The `sockaddr_un.sun_path[108]` header is 108 bytes *including the NUL terminator*, so only 107 bytes of path.
- **RFC implication:** edge case #8 should cite 107 not 108; session-ID length cap should be computed against 107 minus the rest of the path (`/tmp/kookr-dtach/<uid>/<instanceId>/<id>.sock`). With uid `1000`, instance `prod-4800`, that's `/tmp/kookr-dtach/1000/prod-4800/X.sock` = 35 chars; leaves 72 bytes for `X`. Safe at the current 40-char cap, but long worktree-derived IDs could exceed.

---

### Additional findings (not in the original claim list)

**F1: Claude Code uses kitty keyboard protocol.** Observed: `\e[<u` (push) and `\e[>1u` (set). If the project ever wants richer key forwarding to Claude Code (e.g., Alt/Cmd modifiers for power users), that path is kitty-kb, not mouse. Entirely orthogonal to this RFC.

**F2: Kookr's existing WS stringify bug predates PR #320.** The `data.toString()` in `terminal-bridge.ts:41` has been there since the initial ADR-009 implementation. It's not caused by the change this RFC is trying to fix.

**F3: dtach source is small enough to vendor.** If distribution is a concern (C2), 3 C files + 1 header + autoconf produces a 77 KB binary. A `scripts/build-dtach.sh` that clones/compiles into `./vendor/dtach` is a 10-line option — cheaper than the "install via package manager" story the RFC currently assumes.

---

## Not tested

- **C4** (xterm.js native wheel forwarding end-to-end) — moot now due to C7 falsification.
- **C9** (manifest race reproducer) — time reallocated after C7 changed the RFC's baseline.
- **macOS parity cells** — no macOS runner available. CANNOT TEST.
- **Full POC 48-cell matrix** — 2–4 day effort, explicitly out of this probe's scope.

---

## Recommended RFC changes

1. **Re-ground the RFC against a concrete user pain.** Claude Code and Codex CLI do not emit mouse modes. The current problem statement targets a non-existent feature. Before iterating to v7, elicit from Jean: *what specifically is broken for you since PR #320?* Candidates (Jean to confirm/reject):
   - Wheel should scroll xterm.js scrollback of terminal output — **already works after #320** via xterm.js native scrollback. If this is what Jean wants, **no dtach migration is needed**.
   - Wheel should scroll Claude Code's conversation view — **Claude Code does not support this** (no DECSET 1000/1006). Would require a Claude Code feature change, not a Kookr terminal-backend change.
   - Something else (text selection, right-click menu, touchpad gesture) — needs to be named concretely.
2. **If R2/R3 (session persistence + pre-alt-screen survival) are the real drivers**, the dtach + ring-buffer design is still valid but its motivation should be rewritten to stop invoking the mouse problem.
3. **`-r winch` description must be strengthened:** v6 says "alt-screen TUIs repaint." The probe shows it replays *nothing* — only whatever the child emits in response to SIGWINCH. The ring buffer is load-bearing for *all* reconnect content, not just pre-alt-screen.
4. **Edge case 8:** cite 107 bytes (not 108) as the Linux UDS path limit.
5. **§ Manifest:** rename "`RemoveIPC=yes`" justification to "pam_systemd / `systemd-user-runtime-dir@` tears down `/run/user/$UID` on last logout."
6. **New prereq:** fix `terminal-bridge.ts:41` `data.toString()` string coercion. This is a latent bug independent of the migration; should be fixed regardless of whether the RFC proceeds.
7. **C2 distribution:** add explicit vendoring/build option for dtach. Mainstream distros don't uniformly ship it.

---

## Follow-up probes (not done; would be useful)

- Full POC harness run (4 backends × 6 cells × Linux) — answers C4 if the RFC survives re-grounding.
- Manifest-race reproducer (15 min) — confirms or refutes the v6 race claim.
- Codex CLI's full interactive stream under load (to check whether mouse modes appear in long-running sessions, not just startup).
- macOS cells — requires a runner.

---

## Artifacts

- `/tmp/test-tui.py` — the minimal Python TUI used for C5/C6.
- `/tmp/dtach-probe.py` — PTY-backed dtach attach client.
- `/tmp/claude-interactive.log`, `/tmp/cc-session.log`, `/tmp/codex-session.log` — raw DECSET captures.
- `/tmp/dtach-build/dtach/dtach` — dtach 0.9 built from upstream.
