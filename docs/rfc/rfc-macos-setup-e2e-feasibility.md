# RFC: Extending the AI-Driven Onboarding Smoke Test to macOS (Feasibility MVP)

## Status

**Draft (v3 — revised after parallel critic review: design-minimalist, delivery-pragmatist, failure-mode-analyst, socratic-challenger)**

**Date:** 2026-06-18
**Author:** Jean Ibarz (with Claude)

---

## Validation update (2026-06-19)

Option D from this RFC (drive a real Mac over SSH with the onboarding agent) was
executed manually as a first dry-run: a Scaleway Apple-silicon Mac mini (macOS
26, arm64, bash 3.2, `brew install node@22`) was driven over SSH through the
verbatim `getting-started.md` steps. It surfaced **five macOS-specific defects
that Linux CI cannot catch**, each since fixed:

1. `setsid` task-launch failure on macOS (#1033).
2. `mapfile` (bash 4+) in `prod-restart.sh`; node-22 `doctor` preflight; missing
   Homebrew install step (#1034).
3. node-pty `spawn-helper` losing its executable bit under pnpm → `posix_spawnp`
   (#1035).
4. Empty-array `unbound variable` under `set -u` in `install-hooks.sh` /
   `kookr-merge.sh` (#1036).

This is direct evidence for the RFC's core thesis (a live macOS run finds rot
the Debian suite cannot) and for the recommendation to prefer a real-Mac
substrate (Options C/D) over a local approximation (Options A/B). The remaining
open work is to **automate** this run behind the existing onboarding harness.

---

## Problem

Kookr already has an **AI-driven onboarding smoke test** for Linux. An agent
(`claude -p`) plays a brand-new user inside a clean Docker Ubuntu container,
follows `README.md` with no outside knowledge, verifies the dashboard responds,
and writes a structured PASS/FAIL verdict. Today it only covers Ubuntu/Debian.
There is **no equivalent for macOS**, even though:

- `docs/getting-started.md` documents a macOS install path
  (`xcode-select --install`, `brew install node@22 pnpm`, native `node-pty`
  compile, `clang`-built vendored `dtach`).
- `doctor.sh`'s own header declares the project supports "Linux + macOS only."
- A darwin-only code path exists at `src/adapters/local-dtach-backend.ts:76`.

So macOS setup instructions can rot silently — a renamed Homebrew formula, a
GNU-vs-BSD assumption in `scripts/*.sh`, a native-module break — and nothing
catches it until a real Mac user bounces at the highest-leverage drop-off point
in the funnel.

The maintainer develops on Debian (currently WSL2) and has no Mac. The original
request was "extend the macOS test so I can run it on my WSL2 box like the
Debian one." This RFC proposes a **time-boxed MVP** to study feasibility — but
first it renegotiates that requirement, because critic review showed the
literal version of it leads to the worst option.

## Renegotiating the requirement (read this first)

"Runs on my physical box" is **not** actually the goal. The Linux test runs
locally only because Docker makes a faithful clean Ubuntu free. macOS has no
such cheap, faithful container on Linux, so every Linux-hosted macOS substrate
is an *approximation that fakes exactly the parts we most need to test* (Apple
toolchain, Homebrew, native compile, Apple Silicon).

The real goal is **"catch macOS setup rot, and let me trigger and read the
result from my WSL2 box."** Those are different requirements:

- "Runs on my box" → forces a local macOS substrate (QEMU/Darling) → low
  fidelity, fragile, x86-only, EULA-gray.
- "I orchestrate from my box" → the substrate can be a **real Mac I drive
  remotely**, giving full fidelity while I stay local as the orchestrator.

This reframing is the single most important change from v2, and it makes the
previously-omitted options dominate. The MVP below leads with the cheap
experiment that settles the question, not with the expensive local track.

## The existing harness (what we reuse vs. what changes)

The Linux smoke test (`scripts/onboarding-smoke-test.sh`,
`e2e/onboarding/Dockerfile`, `e2e/onboarding/prompt.md`; original
`docs/rfc/rfc-onboarding-smoke-test.md`) decomposes into **three layers**:

| Layer | Linux today | macOS change |
|---|---|---|
| **1. Clean-OS substrate** | `docker run ubuntu:24.04` | the open question — see options |
| **2. Command transport** | `docker exec … bash -c '<cmd>'` | runner shell, or `ssh … '<cmd>'` |
| **3. Agent + prompt + verdict report** | `claude -p` plays first-time user, README-only, writes PASS/FAIL | reused; add a macOS prompt variant (Homebrew/Xcode CLT prereqs) |

Layer 3 is the expensive, proven part, and it does not change. What we study is
layer 1.

### What the agent layer buys over a plain scripted job

A critic asked the sharp question: the things that break on macOS (renamed
formula, `sed -i`, native compile failure) are deterministic — a scripted
`macos-26` job running the verbatim `getting-started.md` commands plus
`pnpm doctor` plus a health check would catch them. So why the LLM agent?

Honest answer: **they catch different things.**

- A **scripted job** answers *"does the documented path still build and run?"*
  — deterministic, cheap, the right first deliverable.
- The **agent** answers *"is the README sufficient for a human with no outside
  knowledge?"* — it catches ambiguity, missing steps, and implicit assumptions
  (the original onboarding RFC's whole point), which a script that already
  encodes the "right" commands cannot.

This distinction reorders the MVP: **ship the scripted check first** (it is the
cheap high-fidelity signal), then add the agent layer for doc-sufficiency.

## A correction to the framing: kookr is not a GUI app

The substrate research that motivated this RFC concludes a QEMU macOS VM is
mandatory for GUI validation. **Kookr is a Node server + CLI plus a web
dashboard at `http://localhost:4800`** — the same surface the Linux test
verifies with an HTTP health check, no desktop GUI. So the QEMU-for-GUI
argument mostly does not apply, and Darling's headline weakness (GUI apps) is
irrelevant — while its real limitation is fatal: it fakes the Apple toolchain
the test exists to exercise.

## Goals

- Settle, with a ≤2-day experiment, whether a Linux/WSL2-*orchestrated* macOS
  onboarding test is worth building, and which substrate.
- Reuse layer 3 unchanged; add only a macOS prompt variant and a
  substrate/transport adapter.
- Prefer real-macOS fidelity (remote or CI) over a local approximation unless a
  hard constraint (offline, cost) forces otherwise.
- Keep the MVP disposable, and be honest about what "disposable" covers.

## Non-goals

- Not shipping a permanent blocking macOS CI gate in this RFC.
- Not validating a native macOS GUI (there isn't one).
- Not codesigning / notarization / distribution artifacts.
- Not adding macOS to default PR CI in V1; mirror the gated/manual model
  (`test:onboarding`, `/run-e2e`).
- Not endorsing an EULA-violating configuration as a *supported* path (Legal).

## Substrate options (layer 1)

| Option | Substrate | Maintainer stays local? | Real Apple toolchain? | Apple Silicon? | Gate-able? | EULA |
|---|---|---|---|---|---|---|
| A. Darling | translation layer on Linux | yes (runs on box) | **no** | no | no | clean |
| B. QEMU macOS VM | x86 macOS guest, nested-KVM in WSL2 | yes (runs on box) | yes | **no** | no | gray |
| C. GitHub `macos-26` CI | real Apple Silicon runner | orchestrates via push/dispatch | yes | yes | **yes** | clean |
| D. Remote real Mac over SSH | cloud Mac / Tart / owned Mac mini | orchestrates via SSH | yes | yes | yes | clean |

### Option A — Darling: rejected as the substrate

Actively maintained as of 2026 but provides Darwin syscall/framework
reimplementations, **not** Homebrew/Xcode CLT/Apple SDK. The onboarding test's
whole point — does `pnpm install` build native modules on macOS? — is faked or
absent. Possible niche value as a fast darwin-branch unit probe, but it does
not answer the onboarding question. **Not the substrate.**

### Option B — Local QEMU macOS VM: local but worst-fidelity

Highest *local* fidelity (real Homebrew/CLT/compile), but: needs **nested
virtualization inside WSL2** (demonstrated but version-dependent and reported
broken on newer Win11/WSL builds; AMD needs Win11); OSX-KVM images are
**x86_64** so they give **zero Apple-Silicon signal** (the dominant Mac and the
`macos-26` default); multi-hour image build + OpenCore maintenance; EULA-gray.
**Last resort, only if a hard offline/cost constraint rules out C and D.**

### Option C — GitHub `macos-26` CI: the trustable gate

Real Apple Silicon runners (GA Feb 2026), near-zero setup (add a job), billed
**10× Linux minutes** so it belongs on manual/scheduled triggers (mirror
`e2e.yml` / `/run-e2e`). The agent's transport is just the runner's own shell.
Maximal fidelity including Apple Silicon. Only candidate that can be a blocking
gate. Constraint: ephemeral and cloud — you cannot poke at a stuck run
interactively.

### Option D — Remote real Mac over SSH: the maintainer's actual want

Spin up a **temporary cloud Mac** (or a self-hosted **Tart** VM / a cheap owned
Mac mini) and drive it with the **same agent over SSH** — the exact transport
Option B's QEMU path already needs and Option C's runner shell replaces. This
keeps the maintainer **local as orchestrator** while getting **real Apple
Silicon fidelity**, with no nested-virt, no EULA gray zone, and no x86 gap. It
is the option the original research and v2 both omitted, and it dominates B on
fidelity and C on interactivity. Cost is hourly Mac rental (or one-time Mac
mini), and it requires SSH transport work (see Risks).

## Recommendation

**Phase 0 first — a 2-day decision spike, before committing to any substrate.**
Run the two cheapest, most decisive probes in parallel; let their results pick
the path:

1. **B1 (scripted `macos-26`, ~1 day):** A manual-trigger GitHub Actions job
   that runs the verbatim `getting-started.md` macOS steps + `pnpm doctor` +
   a `localhost:4800` health check — **no agent yet.** This is the real
   high-fidelity feasibility answer, and the ground-truth result set.
2. **A0 (KVM nested-virt probe, ~1 day, parallel):** Enable
   `nestedVirtualization=true` in `.wslconfig`, boot any KVM guest, confirm
   `/dev/kvm`. Record *why* it fails if it does (BIOS flag / hypervisor / WSL
   kernel) so "couldn't get it working" is not mistaken for "can't work." This
   probe alone decides whether local Option B is even on the table.

**Decision after Phase 0:**

- If B1 passes → **adopt Option C as the macOS gate** (manual/scheduled,
  non-blocking first). This satisfies the true goal for the lowest cost.
- For local-feeling iteration the maintainer wanted → **add Option D** (drive a
  rented/owned Mac over SSH with the reused agent). Recommended over Option B.
- **Defer Option B (local QEMU)** to conditional future work, pursued only if
  A0 succeeded *and* an offline/cost constraint later rules out C and D.

**Then, and only if Phase 0 justifies it — Phase 1, the agent + doc-sufficiency
layer:** fork `e2e/onboarding/prompt.md` into a macOS variant and run it on the
substrate chosen above (C runner shell, or D over SSH). This adds the
README-sufficiency signal on top of the scripted "does it build" signal.

This honors the maintainer's real intent (orchestrate from the WSL2 box, catch
macOS rot) while refusing the literal-but-self-defeating "must run the OS on my
box." If A0 fails or B is dropped, that conclusion is explicit and
evidence-backed, reached in 2 days rather than a week.

## On measuring fidelity (corrected from v2)

v2 proposed grading a local track by "≥X% of the real Mac's failures
reproduced." Critic review showed that metric is **non-identifiable** and it is
removed:

- **Agent non-determinism:** two runs on identical substrate already differ, so
  a discrepancy cannot be attributed to fidelity vs. agent variance.
- **Architecture mismatch:** x86 (Option B) and arm64 (Options C/D) test
  partly disjoint failure universes; arm64-only failures *cannot* appear on B
  by construction, so the ratio measures arch-portability, not fidelity.
- **Empty denominator:** a clean macOS setup yields zero failures, making the
  ratio `0/0` and the gate meaningless exactly when setup is healthy.

Replacement, only relevant if both a real-Mac path and a local path are ever
run together: compare **qualitatively** over an **arch-neutral** partition of
failures, report arm64-only issues as a permanent structural blind spot of any
x86 local substrate, and **inject a known-fault fixture** (a deliberately
broken README step) each run so there is always a non-empty, detectable
ground-truth failure to confirm the harness can still *detect* failure rather
than observing a green frozen world.

## On the `sun_path` canary (corrected from v2)

v2 named the `sun_path` 103-byte limit as the ground-truth probe. It is a poor
canary: `src/adapters/local-dtach-backend.ts:76` is a compile-time
`process.platform === 'darwin' ? 103 : 107` **constant**, trivially satisfied
by anything reporting `darwin` — including Darling, which fakes the platform
string while faking everything that matters. It tests kookr's own literal, not
the kernel.

Corrected approach:

- The real ground-truth signal that distinguishes a faithful macOS from a fake
  is the **Apple-toolchain native compile** — `node-pty` and `dtach` actually
  building against the Apple SDK during `pnpm install`. That is the canary,
  and it is exactly what Option A (Darling) cannot fake.
- The `sun_path` *constant* math, if worth pinning, belongs in a free unit test
  that mocks `process.platform` — not in the substrate's job. (A real syscall
  probe that binds an overlength Unix socket and asserts macOS `bind()` fails
  where Linux succeeds is the only substrate-level version worth doing, and
  only if that limit ever regresses.)

## Risks and mitigations

- **WSL2 nested-virt is make-or-break for Option B.** A0 is the day-one
  kill-gate; it records *why* it failed to separate misconfiguration from
  unsupported-host.
- **`claude` auth on the runner/remote Mac is an unbudgeted hard dependency.**
  The Linux harness preflights host `claude` auth (`onboarding-smoke-test.sh`
  `run_claude_preflight`). Options C and D need `ANTHROPIC_API_KEY` as a
  secret + `claude` installed (`curl -fsSL https://claude.ai/install.sh | bash`)
  before any agent run. Budgeted as a named ~0.5-day sub-step of Phase 1, not
  zero. (Phase 0's B1 is scripted and needs no Claude auth — another reason to
  lead with it.)
- **OSX-KVM image acquisition is multi-hour, not free.** `fetch-macOS`, disk
  build, and first-boot macOS install can take hours (worse under TCG). If
  Option B is ever pursued, budget a discrete ~0.5–1 day image-build step
  before any boot-to-shell estimate.
- **SSH transport ≠ `docker exec`.** The proven prompt injects a container name
  and uses `docker exec`. Options B and D need `ssh user@host '<cmd>'` with
  host-key handling (`StrictHostKeyChecking=no` for ephemeral hosts), login-vs
  non-login shell differences (`~/.bash_profile` vs `~/.profile`), and dynamic
  host/IP injection. Prototype the SSH transport on a throwaway Linux VM first
  (~0.5 day) before pointing the agent at macOS.
- **Silent rot one layer up.** A green run certifies one frozen tuple of
  (macOS version, Homebrew/bottle state, region). `xcode-select --install`
  even launches a **GUI dialog** on real hardware (pre-installed on runners),
  so the install path is not identical to Linux apt. Mitigation: record the
  full environment tuple in every verdict and fail loudly when the runner's
  macOS/Homebrew version drifts from what was last graded.
- **"Removable in one commit" is only true for Options C/D.** Option B leaves
  host-side artifacts (20–40 GB image, `.wslconfig` edits, QEMU/libvirt
  packages) needing manual teardown. Scope the disposability claim accordingly
  and add a teardown checklist if B is pursued.
- **Legal** (below).

## Legal

Apple's macOS EULA restricts running macOS on non-Apple hardware, including in
a VM; Option B (QEMU/OSX-KVM) is in that gray area. Options C (`macos-26`) and
D (cloud Mac / Tart / owned Mac) run on genuine Apple hardware and are
EULA-clean. This RFC recommends the EULA-clean options as the *supported* path
precisely so the official macOS signal never depends on an EULA-violating
configuration.

## Open questions

- Phase 0 first: does B1 (scripted `macos-26`) pass on a clean checkout today,
  and does A0 (KVM nested-virt) work on this specific WSL2 host? These two
  answers reshape everything below them.
- For Option D, which Mac source — hourly cloud rental, self-hosted Tart, or a
  cheap owned Mac mini — best fits "local-feeling, on-demand, low-cost"?
- Does the maintainer actually need a local/remote interactive loop (Option D)
  at all, or is the CI gate (Option C) plus the agent doc-sufficiency run on CI
  sufficient — making Option D a nice-to-have rather than a requirement?
- Cadence once proven: per-release, weekly schedule, or manual `/run-macos`
  mirroring `/run-e2e`?

## Appendix: references

- Existing harness: `scripts/onboarding-smoke-test.sh`,
  `e2e/onboarding/{Dockerfile,prompt.md}`,
  `docs/rfc/rfc-onboarding-smoke-test.md`.
- Internal macOS anchors: `docs/getting-started.md`,
  `src/adapters/local-dtach-backend.ts:76`, `scripts/doctor.sh`,
  `e2e/canary.spec.ts`, `.github/workflows/{ci,e2e}.yml`.
- Darling: <https://github.com/darlinghq/darling>
- QEMU macOS images — OSX-KVM: <https://github.com/kholia/OSX-KVM>
- WSL2 nested-virt + macOS fragility:
  <https://dev.to/nicole/running-macos-on-windows-10-with-wsl2-kvm-and-qemu-21e1>,
  <https://github.com/microsoft/WSL/issues/11216>
- GitHub `macos-26` runners GA (Feb 2026):
  <https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/>
- Self-hosted Apple-Silicon runners via Tart:
  <https://josephduffy.co.uk/posts/self-hosting-macos-github-runners>
