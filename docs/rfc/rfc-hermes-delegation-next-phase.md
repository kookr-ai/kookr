# RFC: Hermes Delegation, Next Phase — Isolation, Governed Triage Digests, and What Waits

**Status:** Draft (v4 — post two review rounds, an isolation probe, and one consensus attack)
**Date:** 2026-11-07
**Author:** Jean Ibarz (with Claude)
**Related:** `rfc-kookr-hermes-delegation.md` (delegation design; slice 1a shipped dark), `rfc-kookr-hermes-delegation-value-test.md`, `rfc-hermes-observed-activity-bridge.md`

---

## Problem

The delegation plumbing is merged and switched off. Three things stand between it and useful work:

1. **It cannot be turned on safely.** The delegation RFC makes worker isolation a condition for enabling it, but that condition is enforced only by operator attestation, and the default worker network can reach services on the host (including the Kookr API, which has no authentication on a loopback bind).
2. **Nothing uses it.** Slice 1a is the server half: no command, no job that runs by itself. The value test (Hermes preferred on 9 of 10 triage items, at about a cent and a half per issue) is not being collected.
3. **Sending repository content to an external model provider is governed by worker configuration**, not by a per-project, per-provider decision that Kookr enforces, and a worker's persistent state can carry content between projects.

This RFC says what to do next, in what order, what must be true first, and how each step is measured.
Two review rounds cut it down from eight workstreams to four committed ones; what was cut or deferred is
listed with entry criteria, not dropped.

Scope note: everything measured was on Docker Desktop under WSL2. Native Linux and macOS were **not**
tested, and a deployment there needs its own validation of the isolation check.

## Why this, and what would make us stop

Triage is **not** the product and **not** justified by cost: the whole backlog is about USD 1 with
Hermes and a few dollars with Claude, so the saving is noise at this volume. The reasons to proceed are:

1. **The supervisor/worker pattern is the operator's stated aim,** and a governed, isolated, measurable
   Hermes worker is the base every later job needs (audits across many projects, shadow patches, parallel
   cheap workers) — the jobs where Hermes's price and parallelism start to matter.
2. **Triage is the cheapest proving workload** for that base: short, read-only, easy to judge, with a
   measured Claude comparison already in hand.
3. **It generates a dataset** (Hermes versus Claude on the operator's own judgement, at more than n=10).

That framing has a failure mode the review named: the operator may simply not want triage digests, and
reviewing them becomes chore work whose "acceptance rate" measures politeness. So this RFC adds a cheap
demand test before the expensive work, and a stop condition:

- **Step 0 (before W1 build): a one-off Claude pass over the current backlog** (about 60 issues, a few
  dollars), delivered as one digest, with no new infrastructure. If the operator does not read it or act
  on it, triage is the wrong proving job. W1-0 (the throwaway probe run), W2-0a (governance in the
  service) and the W4 PRs are cheap and independent and are kept either way; the W1 build, W2-0b, W2-0c,
  W2-1 and W3 do **not** start on triage's account. The operator then chooses between switching the
  proving job to test audits (the stronger Hermes result: precision 0.89 against 0.50, but n=1, so
  after a random-sample replication; the infrastructure then proceeds unchanged because audits use the
  same base) and pausing the Hermes worker work altogether.
- **The first Hermes sweep is reviewed blind against a Claude triage of the same issues,** so the
  acceptance numbers compare Hermes with the free alternative on the operator's own judgement, not with
  nothing.
- The infrastructure in W1 and W2-0 is justified by reason 1, not by triage in particular: it serves
  any read-only job, so a failed Step 0 changes the proving job, not the case for the base. It is wasted
  only if the operator drops the Hermes worker aim altogether, which is what the "pause" option covers.

## Evidence

| Fact | Source |
|---|---|
| A container on an ordinary Docker network reaches a loopback-bound host service through Docker Desktop's host proxy with no credentials; renaming the host inside the container does not stop it. | Throwaway containers. |
| On a Docker `--internal` network the host-proxy route and the name are gone and external DNS does not resolve (a DNS sink saw 0 queries from it, 7 from a normal network). However, the network's own bridge-gateway address belongs to the host/VM namespace and answers at layer 3. | Isolation probe. |
| A worker whose only egress was an allow-listing proxy completed a real model call; Hermes honours `HTTPS_PROXY`. With the proxy down it fails closed, slowly (retries for minutes). | Isolation probe, 6 model calls. |
| A squid CONNECT allow-list (port 443, named hosts) with SNI peek/splice denied every IP-literal form, private range, lookalike name and privately-resolving name tried; denials surface to the client as TLS errors, so the proxy's access log is the reliable signal. | Isolation probe. |
| `socat` forwarders bound to the gateway's external-network address behind a pre-published fixed loopback port range worked; a worker cannot use another worker's forward. Docker cannot add a published port to a running container. | Isolation probe. |
| A gateway restart fails `message/stream` jobs but `message/send` jobs complete and are readable with `tasks/get`. | Isolation probe. |
| Other containers on the machine can reach loopback-published ports through the host proxy; the worker bearer token (401 without it) is then the only gate. The agent card is public. | Isolation probe. |
| Hermes workers persist state between jobs (a worker saved skills into its own volume during the value test). | Value-test log. |
| Triage of one real issue cost about USD 0.015; the value test (12 sessions) about USD 0.18; the open backlog across five projects is about 60 issues. | `hx.sh cost`, `gh issue list`. |
| Scheduled jobs in Kookr launch agent tasks (`schedule-runner.ts` → `launch-service`). | Code. |
| The merged slice 1a mounts one shared snapshots root into every worker, and project consent, visibility and provider checks do not exist in the service. | Code. |
| `createTask` has no spawn-depth guard. | Code. |
| The activity ledger is keyed by session and pruned by age once the session is terminal; the observed-activity RFC keeps its own lane's data out of it for the same reason, and the same reasoning applies here. | Code, related RFC. |
| `gitExecEnv` and the slice 1a `cleanGitEnv` each strip variables the other does not (`GIT_CEILING_DIRECTORIES` vs `GIT_NAMESPACE`/`GIT_QUARANTINE_PATH`/`GIT_CONFIG_KEY_n`). The two other test files spawning git without a scrubber only run read-only commands. | Code. |

## Requirements

- **R1 — Safe before on; an anti-mistake control enforced in code.** Delegation does not dispatch unless a recent passing isolation check, bound to the workers' actual forward ports and container identities, covers every configured worker. This guards against mistakes, not against an adversary who can write the check file; that limit is stated.
- **R2 — Consent per project, per provider, per audience, enforced in the service for every caller.**
- **R3 — The supervisor acts, deterministically.** Workers propose; digests are built by code from schema-validated results, never by an agent reading worker text; nothing in this phase writes to GitHub.
- **R4 — Measured with numbers written in advance,** an interval, a named method, and a record that survives record pruning.
- **R5 — Staged and reversible.** Each workstream ships independently; each job type goes Step 0 → dry run → digest-only → (later) apply.
- **R6 — No exploit detail in public documents.** Risks are described generically; addresses and configurations live in the private deployment.
- **Non-goals (this phase):** applying anything to GitHub; test audits; worker-written code; routing decided by software; a measurement framework; a general multi-agent mesh.

## Workstreams

### W1. Worker isolation, and a gate in code (cross-repo; all of it ships dark)

**Design (verified by the probe).** Workers run on one `--internal` Docker network. One gateway container sits on that network and on a normal one and does two things: (1) `socat` forwarders, one per worker, bound to the gateway's external-network address only, behind a pre-published loopback port range; (2) a squid allow-list proxy: port 443 only, one hostname per provider, deny IP literals in every form, deny private/link-local/ULA ranges, resolve names itself and refuse privately-resolving names, and `ssl_bump` peek/splice so the SNI must also be on the allow-list. Workers get `HTTPS_PROXY` pointing at it. The gateway is part of the trusted base (it can reach the host): pinned minimal image, non-root, read-only filesystem, dropped capabilities, listeners bound to specific addresses.

**One provider per deployment for now.** The allow-list is the set of providers every worker behind this gateway may use; `allowedProviders` consent is checked against it. Per-worker provider ACLs are deferred. A prompt-injected worker can still send data to the *allowed* provider; per-worker, revocable provider keys are the mitigation, and the exposure is a residual risk, stated.

**Delegation workers are new, dedicated agents** (not the demo agents), created on the internal network. The demo agents stay where they are, so there is no cutover of existing uses and no "old mode" to keep alive: delegation is dark and simply cannot pass the gate until a worker is on the isolated network.

**The acceptance check** is a versioned script in the deployment tooling. A full table of cases runs at W1-0, at deploy, and on every worker or gateway restart; a short recurring subset runs daily. Every negative is paired with a positive control in the same invocation; failures are classified (`refused`, `no-route`, `timeout`, `dns-fail`); addresses are discovered at run time; the proxy's access log is read for allow/deny; output is JSON with versions and timestamps.

| Group | Cases (all expected blocked) | Recurring subset |
|---|---|---|
| Host | The host-proxy route and name; the Kookr port; **a full port scan of the internal network's own gateway address (any open port fails)**; services bound to the VM's wildcard address | host-proxy, Kookr port, gateway-address scan |
| Peers | Another worker's A2A port directly and via the gateway; another worker's forward port from the wrong network | peer forward |
| Internet | A public host directly; via the proxy: non-allow-listed name, IP literals incl. IPv6 and IPv4-mapped, private ranges, wrong port, lookalike name, privately-resolving allowed name, SNI mismatch | direct internet; one proxy deny/allow pair |
| DNS | External name resolution; a DNS sink sees nothing | (full run only) |
| Worker filesystem | Mount is read-only; no Docker socket; *(added by W2-0b)* a project the worker does not serve is absent | (full run only) |
| Worker state | The worker's data volume carries a marker written at creation naming its audience, and it matches the audience registered in Kookr (a reused volume fails) | (full run only) |
| Positive | The model provider through the proxy (this is also the canary); the worker reachable from Kookr through its forward | both |

**The gate.** Kookr reads the latest check result from `isolationCheckFile` and refuses to dispatch unless: the file parses and has a known `schemaVersion`; it is a pass; it covers every configured worker **by forward port and container identity** (a malformed, missing or partial file is `failed`); and it is younger than `isolationMaxAgeHours` (default 24). Status is shown as `isolation: verified | stale | failed`. The recurring check also runs when any new port is published on the machine; the 24 h window is the stated exposure for a wildcard listener started after a pass, and the check's port scan is what catches it.

**Merge order.** (1) hermes-fleet: gate-file JSON schema v1 and the check script; (2) Kookr: the gate reads it (delegation stays dark: the file does not exist yet); (3) hermes-fleet: gateway tooling and one new dedicated worker on the isolated network; (4) run the full check; (5) register the worker in Kookr. Each step is independently revertible.

**Operational facts.** A gateway outage looks like a hung task (Hermes retries for minutes), so Kookr's deadline must be shorter than Hermes's retry cycles and the recovery grace must exceed a gateway restart (config value, 120 s). Restarting the gateway during jobs is a destructive event for streaming jobs; Kookr already uses `message/send` plus `tasks/get`.

### W2. Governance, and a usable CLI

**W2-0, three ordered sub-slices, before any hook or sweep runs.** Revert is safe only while the delegation store is empty, i.e. until the first delegation of any kind is submitted (W2-0c is the sub-slice that introduces schema version 2): record schema moves to version 2 with a reader that accepts 1 and 2, and downgrade after real records exist is not supported.

- **W2-0a (Kookr).** Per project: `audience` (a string; `public` for public repositories) and `allowedProviders`. A worker declares its `provider` and its `audience`. The service refuses (`external_model_not_allowed`) any submission where the project does not allow the worker's provider or the audiences differ, **for every caller**, re-reading consent on every submit and **refusing if it cannot be read**. Project visibility is checked against `gh repo view` at submit (cached an hour), so a repository labelled public that is private is refused. A worker serves exactly one audience because **worker state persists between jobs**; moving a worker to another audience requires a fresh data volume.
- **W2-0b (hermes-fleet).** A worker mounts, read-only, only the per-project directories of the projects it serves (the snapshot layout `<root>/<project>/<sha>` stays; Kookr creates `<root>/<project>` at startup so the mount target exists). W2-0b adds the check's "unserved project is absent" case and passes it; W1 finishes without it, since before W2-0b workers still mount the shared root. No change to snapshot keys or the submit path.
- **W2-0c (Kookr).** An append-only **outcome log** (its own file, not the activity ledger, kept at least 30 days) with one line per delegation: id, project, audience, provider and model, snapshot sha, issue number, `promptVersion`, a copy of the validated verdict, and later the operator's review. This is also the egress record; the statement is made honestly: the whole tracked tree at that sha is assumed sent, and so is the issue text; there is no per-file or per-byte accounting.

**W2-1 (Kookr).** The CLI: `kookr delegate` as in the delegation RFC, plus `kookr delegate review <id> accept|reject [field]` that records the operator's judgement into the outcome log (the dataset for R4), and `kookr delegate sweep <project>`. The merged RFC's apply step is **not** part of this phase (see Future work).

### W3. Triage digests (hand-run or timer-run; no agent in the loop)

`kookr delegate sweep <project>` is a plain command, run by hand or by a systemd timer, so there is no agent task, no execution slot and no worker text read by an LLM. For an opted-in project it:

1. lists open **issues only** (pull requests are filtered out) whose `updatedAt` is newer than what the outcome log has already seen, skipping an issue that already has a terminal record at the same `updatedAt`; an issue that fails three sweeps in a row is quarantined and shown in the coverage header, so it cannot stall or re-bill every run;
2. delegates triage through the service (so W2-0a governance applies; runs use at most half the global cap, leaving room for interactive callers; delegation keys are `sweep:<run>:<issue>` so an interrupted run resumes);
3. builds the digest **in deterministic code** from the validated results. Triage schema v2 adds `likely_done` (with evidence drawn from the issue text, its comments and the snapshot) and drops free-form related issues; there is no `duplicate_of` (the worker sees one issue and would invent one). Any worker-derived text in the digest, and in the short summary sent to the operator, has URLs, images and HTML stripped, and the summary is sent with link previews disabled (a rendered image or preview fetched by a third party is an exfiltration channel the proxy cannot see);
4. stores the digest with a **coverage header** ("covered 3/5 projects, 41/47 issues; not covered: X (why)"), and a failed or skipped run is recorded with its reason. The failure policy is skip, never fall back to another provider.

Nothing is written to GitHub, so the self-triggering and staleness problems of an apply step do not exist in this phase.

**Stages and numbers (written now, before any digest exists).** The sweep interval is a named parameter (weekly by default).

| Stage | Exit predicate |
|---|---|
| Step 0 (no infrastructure) | A one-off Claude triage of the current backlog is delivered as one digest; the operator reads it and says what they would act on. Stop condition above if not |
| Dry run (manual, **outside Kookr's delegation path**, no gate bypass) | The value-test script run once by hand on a project whose issues are all operator-authored; the pipeline works end to end and the acceptance clock can start |
| Digest-only | After W1 passes, with the first sweep also triaged by Claude on the same issues and reviewed blind (A/B labels): ≥ 40 proposals reviewed across ≥ 2 projects and ≥ 3 sweeps (the first sweep is a backlog catch-up; later sweeps add a few each, so realistically 4 weeks); unreviewed rate ≤ 30%, with items reviewed in random order; acceptance per (unique issue, field) with a **Wilson 95% interval**; a field with n < 15 is not judged |
| Entry to the apply RFC | A field whose interval lower bound is ≥ 60% with point estimate ≥ 80%, and agreement of the operator's review on at least 15 accepted items re-checked blind |

Nothing switches off automatically; the operator reads the numbers and decides.

### W4. Hygiene, as plain PRs

(1) Make one git-environment scrubber: add to `gitExecEnv` only the strip-list entries it lacks, have `snapshots.ts` call it, and keep `GIT_TERMINAL_PROMPT=0` local to the snapshot code (adding it to the shared helper would change behaviour for the 18 other files that import it, and for every default call through `runGit`). (2) Unset repository-redirecting `GIT_*` variables once in the shared vitest setup so no test can leak them however it spawns git (this replaces the proposed scan-for-spawns guard). `pnpm merge` exiting non-zero after a successful remote merge is filed as a separate bug.

## Sequence and gates

| Order | Work | Gate to start | Predicate to finish |
|---|---|---|---|
| 0 | Step 0: one-off Claude backlog digest | none | the operator has read it and stated what they would act on (or the stop condition fires) |
| 1 | W1-0 (a throwaway run of the check cases by hand against a scratch gateway, before the check script exists); W2-0a; W4 PRs | none (kept even if Step 0 stops the build) | committed probe log with pass/fail per case; consent/audience/visibility tests; suite green |
| 2 | W1 build per the merge order | W1-0 pass **and** Step 0 not stopped | check JSON from the last 24 h, all cases pass, ports and container ids match; `isolation: verified` |
| 3 | W2-0b, then W2-0c | Step 0 not stopped; W1 build underway | the check's "unserved project is absent" case passes (added to the check by W2-0b); outcome-log tests; revert note present |
| 4 | W2-1 (CLI, `review`, `sweep`), schema v2, digest | W2-0 done, W1 verified | end-to-end test; skip-not-fall-back test; URL-stripping test |
| 5 | W3 digest-only (the manual dry run can happen any time after Step 0; it is outside delegation) | W1, W2-0, W2-1 done | stage predicates above |
| 6 | Apply RFC | digest-only exit met | its own RFC |

## Future work (not committed; entry criteria recorded)

- **Apply to GitHub.** Design constraints for its RFC: labels from a per-repository allow-list and comments as quoted data; **never close**; per-field apply, idempotent (labels are additive no-ops; comments carry a hidden marker); refuse when the issue changed since the proposal (compare against the *expected post-apply state*, since Kookr writes with the operator's credential and cannot be told apart by author); record intent, then write, then commit; a supervised first stage (labels only, one project, operator confirms each, reversals counted from there); an apply route that requires authentication, which depends on loopback authentication being enforced.
- **Loopback API authentication** (the root cause of the exposure): opt-in, observe-first, with a client inventory that includes browser, WebSocket and rare clients. Filed as an issue, not a gate.
- **Test-quality audits.** After a random-sample replication of the audit comparison (n=1 is not enough). Kookr verifies that cited locations exist and drops findings it cannot locate.
- **Issue implementation**, starting as shadow patches (stored, never applied, judged blind against the normal review gate) once W1 is in place; any stage that applies a patch also needs a spawn-depth guard (plain hardening: `createTask` walks the parent chain, filed as an issue) and the delegation RFC's constraints list.
- **Earned-field auto-apply and acceptance-driven routing** (per job type: Claude only / Hermes shadow / Hermes primary), using the apply stage's numbers as the template.
- **A second read-only job type** (CI-failure triage); a **supported operator-notify helper** over the existing Telegram client; observed-lane follow-ups; a **measurement harness**, only after a second manual re-run shows friction.

## Amendments to the merged delegation RFC

This RFC supersedes two statements there: "several workers can share one snapshots root" (workers mount only the project directories they serve) and the single `operatorAttestedLeaf` attestation (the isolation gate is added alongside it). It also clarifies the fall-back rule: the playbook hook's "fall back to doing it yourself" applies to interactive callers, where the caller is an agent the operator already uses; sweeps have no caller to fall back to and skip.

## Files to change (summary)

hermes-fleet (private): gateway container and tooling (`squid` and `socat` config, pre-published port range), network and dedicated-worker creation in `hx.sh`, per-project read-only mounts, the isolation check script and its JSON schema, docs. Kookr: `src/server/delegation/` (consent, audience and visibility checks, isolation gate, outcome log, review command, sweep), `bin/` (`kookr delegate` verbs), `src/core/git-helpers.ts` and the vitest setup, docs. Each workstream's PR lists exact files.

## Edge cases

- **Gateway down:** the gateway has its own probe and is reported as its own component; if every worker fails together and the gateway probe fails, the report says "gateway down". A sweep that cannot run is recorded as skipped with a reason.
- **Provider hostname changes:** a denied host is counted and logged by the gateway; the daily canary surfaces it before the weekly sweep. Four other hosts Hermes contacts at startup are denied and expected.
- **Docker Desktop update:** addresses and behaviour can change; the check discovers addresses and records versions, and the gate goes stale on its own.
- **Opt-in revoked mid-run:** unsent work is cancelled, stored results kept but flagged, and the next coverage header says `skipped: not opted in`.
- **Repository visibility changes:** caught at the next submit by the `gh repo view` check.
- **A tracked symlink in a project:** snapshot extraction already uses `realpath` containment on cited paths; nothing in this phase reads the tree on the host.
- **Worker reassigned to another audience:** requires a fresh data volume; the check's worker-state case flags a volume reused across audiences.

## Alternatives considered

1. **A secret scan on snapshots and issue text.** Cut: the RFC's own assumption is that the whole tree is sent, a regex scan catches tokens but not the proprietary code that is the real concern, and it adds a rule set to maintain. Per-project consent is the control; a one-off check with an existing tool at opt-in time is recommended.
2. **Per-worker snapshot trees.** Rejected: it changes the snapshot key, the prompt path, cleanup and the worker choice made inside the submit transaction; mounting only the served project directories gives the same isolation with no change to snapshot keys or the submit path (Kookr only creates `<root>/<project>` at startup).
3. **One internal network per worker.** Deferred: tokens already gate peers; a probe case re-tests it.
4. **Hostname override, or an in-container firewall.** The first does not work (measured); the second needs a capability the workers drop.
5. **Sweeps as a scheduled playbook.** Rejected: launches an agent that holds a slot and reads untrusted worker text.
6. **A new server-side sweep job.** Deferred: a hand-run or timer-run command is enough for the first stages and avoids a new always-on component.
7. **An `attested`/`verified` isolation mode with the old mode allowed.** Rejected: a bypass becomes a permanent production footgun; dedicated new workers avoid needing one.
8. **Terminate TLS at the gateway and keep the provider key there.** Stronger against same-provider exfiltration but a much larger trusted component; a possible later step.
9. **Start with issue implementation.** Rejected: highest risk, unmeasured quality, needs W1 and a depth guard.
10. **Test audits as the proving job instead of triage.** The stronger measured Hermes result, but n=1; kept as the fallback if Step 0 shows the operator does not want triage digests.
11. **Do nothing beyond a one-off Claude pass.** The honest cheap alternative at this volume. Rejected as the whole plan because the operator's aim is the governed worker base (reason 1); retained as Step 0 so the decision to build is made on observed demand.

## Open questions

1. After Step 0: does the operator want triage digests at all, and if not, is audits the proving job?
2. Which projects does the operator opt in first, and which audience labels do they get?
3. Is the host-address port scan enough on native Linux, where a host service bound to a wildcard address is more exposed? (Untested.)
4. Does Hermes expose a way to wipe worker state other than recreating the volume?
5. Telegram: summary only, or also a per-proposal callback (relevant only once apply exists)?

## Critic feedback incorporated

**Round 1:** `delivery-pragmatist`, `failure-mode-analyst`, `design-minimalist`, `ambition-amplifier`, `operability-reviewer`, plus a `design-experimenter` isolation probe. **Round 2:** `failure-mode-analyst`, `delivery-pragmatist`, `design-minimalist`.

Intent-preservation check: the operator's load-bearing aims are compounding experiments with useful work on their own projects, and not being asked for decisions. Both are kept: W3 produces real, cheap output on their projects, and the RFC decides what it can and lists only genuine questions.

- *Incorporated, round 1:* sweeps are not an agent task (scheduled playbooks launch agents) and the digest is built by code; governance (consent, visibility, scope of what a worker can read) before any hook; the isolation gate enforced in code with checkable predicates; hardening of the gateway, the proxy's bypass classes, DNS and the discovered hole at the network's gateway address; numeric stage predicates with an interval; the apply step can never close.
- *Incorporated, round 2:* the bridge-gateway hole is now checked by a full port scan and stated as a residual exposure, not "closed"; the dry run no longer contradicts the gate (it is a manual script outside delegation); per-worker snapshot trees replaced by per-project read-only mounts; **worker state persists, so a worker serves one audience** (new finding); visibility is verified, not declared; consent is re-read per submit and fails closed; links/images stripped from worker-derived text and previews disabled; a dedicated outcome log instead of the activity ledger (which is pruned by age once a session is terminal, and whose use for new data the observed-activity RFC argues against for its own lane) and the verdict is copied so it outlives record pruning; poison-issue quarantine, PR filtering, `duplicate_of` removed; the circular apply predicate removed by moving apply out of this phase; Wilson interval named, random review order, unique (issue, field) counting; check bound to forward ports and container identity and R1 restated as an anti-mistake control; W2-0 split into ordered sub-slices with a stated revert boundary; W1 given a merge order; amendments to the merged RFC listed; public-document detail reduced.
- *Adversarial pair `design-minimalist` vs `ambition-amplifier`:* the author sided with the minimalist for this phase. Cut: secret scan, egress ledger as a separate store, per-worker trees, per-worker provider ACLs, W1b loopback auth in the RFC (now an issue), apply machinery and its token, audits, the measurement harness, the notify helper, the 10% blind audit, the 30-day reversal window, and part of the recurring check. The ambition reviewer's ideas are kept as future work with entry criteria: loopback auth, earned-field auto-apply and routing, shadow patches, a second job type.
- *Rejected / reduced with reason:* an attested bypass mode for the dry run (permanent footgun); host firewall rules inside the Docker VM as a W1 requirement (not available on Docker Desktop; replaced by the port-scan check and the stated residual); a new always-on sweep service (hand-run or timer-run command first).
- `design-experimenter` 2026-11-07 (isolation probe): confirmed `HTTPS_PROXY`, squid policy, DNS, forwarding and restart behaviour; found the gateway-address hole, that denied CONNECTs look like TLS errors, and two proxy traps (kept in the private deployment notes per R6).
- `general-purpose` 2026-11-07: consensus-attack — **finding**: the panel treated "triage digests are worth producing" as settled and argued only how to produce them safely; at about USD 1 for the backlog the cost advantage is noise, the digest-only stage measured acceptance without a Claude comparison on the operator's own judgement, and nobody tested whether the operator would act on digests at all. Triaged once and incorporated as the *Why this, and what would make us stop* section, Step 0, the blind paired first sweep, a stop condition and Alternatives 10-11. No further review round, per the one-attack bound. The isolation design itself was not found flawed by this attack.
- `assumption-archaeologist`: not invoked.
