# opencode parity + scale through an isolated Kookr server

Branch `opencode-parity-run`, worktree frozen at `ce2692c8` (`~/git/kookr-opencode-parity`). Harness: `scripts/opencode-parity.ts`
(tables: `scripts/opencode-parity-tables.py`). Raw artifacts (`opencode-parity-data/`, `opencode-scale-data/`) are not committed to this repository (they were kept next to the original run),
and bake-off-shaped result dirs `~/hermes-sandbox/shadow-run/bakeoff/results/<case>-opencode-kookr/`.

**Provenance legend.** K = measured by me now, through Kookr. B = reused bake-off numbers (opencode run in docker, no Kookr, no gate). H = reused Hermes data (read-only, `shadow-run/exp/*`). Nothing in K was copied from B or H.

## Answer in five lines

1. Through Kookr, opencode delivered **6/6** (commit + `Closes #N` + lint-clean `PR_BODY.md`, no uncommitted tracked files). 3/6 delivered at the first stop; the 3 others were blocked once by the deliverable gate (exit 2) and then delivered. Hermes raw: 2/6 delivered, nudged 6/6 (H). Bake-off opencode raw: 8/11 runs delivered (B).
2. Reference-test verdicts (bake-off `grade.sh`): **5/6 PASS**; `agent-notebook-90` FAIL, which every bake-off arm (opencode, qwen, pi, Hermes raw, Hermes mem-on) also fails (interface-coupled reference test, see caveats). `lucy-3315` is PASS here but FAIL in the single bake-off opencode run (n=1 noise, not a Kookr effect we can claim).
3. Cost per task through Kookr: $0.017 to $0.044 (Kookr-reported `costUsd` from the opencode db; bake-off "est $" uses a different, slightly lower price model, so compare orders of magnitude, not cents).
4. RAM: opencode TUI process 1.2 to 1.5 GB RSS peak per worker (docs say ~1.2 GB: confirmed); tool children (test runners) add 0.6 GB (small repo) to 4.7 GB (lucy) on top. Per worker PSS peak 1.4 to 3.5 GB.
5. Scale: 4 and 8 concurrent workers on one server: **12/12 delivered, 0 launch failures, 0 gate blocks, 0 throttle (429/rate-limit/APIError) markers**. Peak summed PSS 4.4 GB (4 workers) and 8.1 GB (8 workers), i.e. about 1.0 GB PSS per worker for the cheap case; host is shared and was loaded by other agents, so absolute numbers carry that noise.

## What was run

* Per case a fresh hermetic server (`node --import tsx src/server/start.ts`, temp `HOME`, free loopback port, rebuilt `env`, dtach namespace `port-<port>`, `KOOKR_HOST_STALE_DTACH_REAP=0` so the host-wide reaper cannot see other agents' dtach masters, `KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0`, `KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT=1`, `KOOKR_OPENCODE_BIN=~/.kookr/tools/opencode-1.19.5/...`, `KOOKR_OPENCODE_PLUGIN_DEBUG=<file>`, `KOOKR_PR_LINT_CMD=<wrapper> {pr_body}`). The server PID is the only process the harness kills (per-case server PIDs are recorded in each `kookr-metrics.json`).
* The task: `POST /api/tasks {prompt, cwd: <clone>, agentType:'opencode', profile:'scoped-fix', issue:N}`. The clone is `git clone https://github.com/<slug>.git`, `checkout <base>`, `origin` removed, branch `work/issue-N`, local git identity `bakeoff-worker`.
* Prompt: the exact bake-off replay prompt (`results/<short>-<issue>-opencode/prompt.md`, 46 to 72 KB). The single container-path occurrence `/w` ("mounted at\n/w (cd there first)") is **rewritten to the clone path**, and a one-line `NOTE: your working directory is <clone> (the checkout described below as /w)` preamble is prepended. Stored as `prompt.kookr.md` in each result dir. The profile gives the worker no generic Kookr worktree preamble, as designed.
* PR lint: per-run wrapper `exec pr-body-lint.sh "$1" --repo "$PWD" --base <base>` (the gate runs lint with cwd = the clone, so `$PWD` is the clone; base hardcoded).
* Completion: the `completion_ready` pending signal on the task record AND the last hook event being `Stop` and quiet for 8 s (fallbacks: idle 300 s, 40 min hard timeout; none triggered, every `done_reason` is `completion_ready`). Then `POST /api/tasks/:id/complete`, then the task record's `tokenUsage`.
* Sampling every 2 s: all processes whose cwd is inside the clone plus their descendants (dtach master, opencode TUI, shells, node/vitest/npm/git children). Harness = the opencode process; "other" = everything else that is not dtach or a `sh -c` wrapper. `mem.csv` has the requested header; since there is no container, `cg_current_mb`/`cg_peak_mb` are the tree total RSS and its running peak.
* Gate blocks counted two ways that agree on every case: plugin debug lines `Stop hook ... kookr-opencode-gate.js code 2`, and the gate's per-session counter file in the session dir.
* Grading: unmodified `bakeoff/grade.sh <name> <slug> <base> <fixpr>`, run for all six after the last case (so docker `npm ci` did not disturb RSS sampling).
* Disk: after each case the temp work dir (clone, cache, temp HOME with npm cache, session dir) was removed (only our own `mkdtemp` path). No `node_modules` left; `/tmp` free space stayed at ~30 GB.

## Results

### Table 1 — delivery / verdict / time / cost, per case

K = measured now through Kookr (this report); B = reused bake-off opencode runs (docker `opencode run`, no Kookr gate; best = PASS first then fastest, median over secs); H = reused Hermes data (read-only). "delivered(raw)" = committed + lint-clean PR body at the first stop, before any nudge. For B, "nudges" = post-hoc nudges the bake-off needed; for K, "gate blocks" = Stop-hook blocks by the Kookr deliverable gate (exit 2).

| case | K deliv final (first-stop) | K gate blocks | K ref | K secs | K tokens in/cache/out | K cost $ | B n | B deliv(raw) best/med | B ref best | B secs best/med | B est $ med | H raw | H nudged (nudges) | H ref | H secs raw/nudged |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| agent-notebook-90 | Y (Y) | 0 | FAIL | 248 | 45646/1854336/9366 | 0.0259 | 1 | Y (n_deliv 1/1) | FAIL | 124/124 | 0.024 | Y | Y (0) | FAIL | 263/870 |
| agent-notebook-273 | Y (N) | 1 | PASS | 196 | 38076/1142400/4869 | 0.0174 | 3 | Y (n_deliv 3/3) | PASS | 108/159 | 0.013 | N | Y (1) | PASS | 241/241 |
| agent-notebook-300 | Y (Y) | 0 | PASS | 216 | 43717/1487232/6854 | 0.0218 | 3 | Y (n_deliv 3/3) | PASS | 134/142 | 0.011 | N | Y (1) | PASS | 414/414 |
| lucy-3265 | Y (N) | 1 | PASS | 517 | 50182/2188928/10529 | 0.0295 | 3 | Y (n_deliv 1/3) | PASS | 375/497 | 0.021 | N | Y (2) | n/a | 319/2168 |
| knowledge-base-mcp-server-1165 | Y (Y) | 0 | PASS | 955 | 49997/2521088/10870 | 0.0316 | 1 | N (n_deliv 0/1) | PASS | 1121/1121 | 0.022 | Y | Y (1) | PASS | 1115/1633 |
| lucy-3315 | Y (N) | 1 | PASS | 561 | 96551/2723456/13174 | 0.0436 | 1 | N (n_deliv 0/1) | FAIL | 859/859 | 0.020 | N | Y (0) | PASS | 1733/1595 |

### Table 2 — RAM (MB, peak over the run)

K: sampled every 2 s from the process tree of the task (cwd inside the clone + descendants): harness = opencode TUI process, other = tool children (node/vitest/npm/git...), total = both plus dtach/wrappers, PSS = proportional set size of the same tree. B: docker cgroup peak (`cg_peak_mb`, includes page cache of the container) and harness-process RSS peak from mem.csv of the bake-off run with the highest cg peak; Hermes was not memory-sampled.

| case | K harness RSS | K tool-children RSS | K tree total RSS | K tree PSS | B cgroup peak (max of runs) | B harness RSS peak | B other RSS peak |
|---|---|---|---|---|---|---|---|
| agent-notebook-90 | 1522 | 636 | 1557 | 1521 | 1247 | 713 | 458 |
| agent-notebook-273 | 1209 | 1611 | 2594 | 1656 | 1973 | 864 | 976 |
| agent-notebook-300 | 1218 | 1084 | 1974 | 1394 | 1970 | 926 | 2457 |
| lucy-3265 | 1338 | 4679 | 5537 | 3468 | 5827 | 731 | 5679 |
| knowledge-base-mcp-server-1165 | 1461 | 2970 | 3896 | 3284 | 4942 | 715 | 2753 |
| lucy-3315 | 1487 | 4147 | 5041 | 3443 | 6227 | 763 | 5767 |

### Table 3 — bake-off opencode runs (reused, per run)

| case | run | delivered(raw) | nudges needed | ref | secs | est $ | cg peak MB |
|---|---|---|---|---|---|---|---|
| agent-notebook-90 | r1 | Y | 0 | FAIL | 124 | 0.024 | 1247 |
| agent-notebook-273 | r1 | Y | 0 | PASS | 159 | 0.013 | 1927 |
| agent-notebook-273 | -r2 | Y | 0 | PASS | 161 | – | 1864 |
| agent-notebook-273 | -r3 | Y | 0 | PASS | 108 | – | 1973 |
| agent-notebook-300 | r1 | Y | 0 | PASS | 134 | 0.011 | 1965 |
| agent-notebook-300 | -r2 | Y | 0 | PASS | 187 | – | 1970 |
| agent-notebook-300 | -r3 | Y | 0 | PASS | 142 | – | 1950 |
| lucy-3265 | r1 | N | 1 | PASS | 918 | 0.021 | 5827 |
| lucy-3265 | -r2 | Y | 0 | PASS | 375 | – | 4843 |
| lucy-3265 | -r3 | N | 0 | PASS | 497 | – | 4777 |
| knowledge-base-mcp-server-1165 | r1 | N | 2 | PASS | 1121 | 0.022 | 4942 |
| lucy-3315 | r1 | N | 1 | FAIL | 859 | 0.020 | 6227 |

Notes on the tables.

* "K deliv final (first-stop)": final = committed + lint-clean body; first-stop = delivered with zero gate blocks. A gate block is the Kookr analogue of the bake-off/Hermes "nudge". The three blocked cases were: `agent-notebook-273` (tracked `package-lock.json` modified by `npm install`, so the gate demanded a commit), `lucy-3265` (PR lint: body omitted 2 of 10 template items), `lucy-3315` (PR lint: unticked README/help items). One block each, fixed in the next turn; the gate never hit its 3-block limit.
* Hook-event counts per task (K, from `kookr-metrics.json`): every run shows SessionStart 1, UserPromptSubmit 3 to 4, PreToolUse = PostToolUse (30 to 59), Stop 3 to 4. The Stop chain per turn was gate -> `nb-retro.sh` (exit 2 once: the one-time retrospective) -> `kookr-stop-nudge.js` (once), exactly as `docs/reference/opencode-agent.md` describes.
* Time: Kookr adds about 11 s to first hook (TUI boot, `first_hook_sec` 11.5 to 11.7 on all parity runs) and 10 to 20 s for retrospective + `kookr signal completion-ready` after the work is done (first Stop to last Stop: 14 s, 18 s, 13 s, 86 s incl. gate fix, 8 s, 130 s incl. gate fix). On the short agent-notebook cases that makes K about 1.2 to 2x the bake-off wall time (B 108 to 187 s vs K 196 to 248 s); on the long cases the model's own variance dominates (KB-1165: K 955 s vs B 1121 s; lucy-3315 K 561 s vs B 859 s; lucy-3265 K 517 s, B 375 to 918 s). n=1 per case for K.
* Differences between K and B setups that the reader should know: B runs `opencode run` headless in docker with `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000` and the repo's tooling image; K runs the interactive TUI on the host with the adapter's defaults (no bash-timeout override), a temp HOME with a cold npm cache, and the Kookr profile instructions (`AGENTS.md`) in addition to the replay prompt. B's cgroup peak includes page cache; K's RSS does not.
* Hermes columns are only comparable on delivery/ref/secs (H has no token/cost/RAM data in `exp/`). Hermes raw = `exp/<case>-off`, nudged = `exp/<case>-offnudge` or the `nudges` field of the `-off` report, same conventions as `table.py`.
* Tokens (K): `inputTokens` is uncached input, `cacheReadTokens` the cache-read tokens, from the per-session opencode db summed at `/complete` (e.g. task `ee406718...`). Costs are Kookr's `costUsd`.

Evidence (K, parity): task ids, sessions and server PIDs per case are in `docs/reports/opencode-parity-data/<name>/kookr-metrics.json`, hook trail in `hooks.jsonl.gz`, plugin debug in `plugin-debug.jsonl.gz`, grader output in `grade.json` / `verdict.txt`. Example (agent-notebook-273, task `ee406718-...`): `"gate_blocks_plugin_debug": 1`, stop hook codes `{"kookr-opencode-gate.js#2": 1, "kookr-opencode-gate.js#0": 3, "nb-retro.sh#2": 1, ...}`, gate reprompt reason `There are uncommitted changes to tracked files: M package-lock.json`, `grade.json` verdict PASS "ref fails on base (1p/1f) and passes on patch (2p)".

| case | task id | session | server pid / port | verdict |
|---|---|---|---|---|
| agent-notebook-90 | `f29e466a-8239-4652-8af6-ca7555b2b16f` | `kookr-163c6598` | 488445 / 36315 | FAIL |
| agent-notebook-273 | `ee406718-4b60-4d4f-b82c-7f9d2d184760` | `kookr-2c40456f` | 496557 / 40869 | PASS |
| agent-notebook-300 | `a6d77dd8-f665-46ee-aa2f-c4b18523db2c` | `kookr-1afbba0a` | 507356 / 45945 | PASS |
| lucy-3265 | `a955f535-7c05-41d7-831d-c1ebc334b80f` | `kookr-c2a7acb6` | 518953 / 39993 | PASS |
| knowledge-base-mcp-server-1165 | `d154e8e5-2642-430d-8711-ac5f7c88d782` | `kookr-41c48596` | 615510 / 45217 | PASS |
| lucy-3315 | `b4ebe03a-99cc-427c-b021-4357620c6fa1` | `kookr-69b76872` | 644603 / 45053 | PASS |

## Scale (all numbers K)

Same harness (`--scale N`), case `agent-notebook-273` (cheapest, ~110 to 200 s in bake-off), N independent local clones of one GitHub clone at the base commit, all N tasks launched back to back through `POST /api/tasks` on ONE isolated server, 2 s sampling of every process attributed to a task (RSS from `ps`, PSS from `/proc/<pid>/smaps_rollup`), host `MemAvailable`, `/proc/loadavg`, `/proc/stat` CPU, and worker CPU from per-process utime+stime. 16 cores, 32 GB RAM, 24 GB swap; the host also ran other agents and containers during the runs (host load average about 1 to 2 just before each run, up to 16 during the 8-worker run).

| metric | scale 4 | scale 8 |
|---|---|---|
| tasks delivered (commit + `Closes #273` + lint-clean body) | 4/4 | 8/8 |
| task failures / launch failures / queued-out | 0 / 0 / 0 | 0 / 0 / 0 |
| gate blocks (counter files + plugin debug) | 0 | 0 |
| throttle markers (HTTP 429, "Too Many Requests", `rate_limit_exceeded`, `APIError`, retry status) in session db/logs + server log | 0 | 0 |
| wall seconds min / median / max | 161 / 217 / 233 | 193 / 252 / 441 |
| time to first hook, seconds min / max | 7.9 / 10.8 | 7.8 / 11 |
| peak summed RSS, all workers (MB) | 6681 | 11056 |
| peak summed PSS (MB) | 4418 | 8108 |
| peak summed opencode TUI RSS / tool-children RSS (MB) | 3964 / 3319 | 7354 / 4379 |
| per-worker peak tree RSS min-max (MB) | 2239-2801 | 1925-2850 |
| per-worker peak TUI RSS min-max (MB) | 913-1509 | 857-1285 |
| per-worker peak PSS min-max (MB) | 1246-1494 | 1194-1401 |
| peak host CPU (all 16 cores) / mean | 69% / 14% | 68% / 17% |
| peak worker CPU (cores busy, summed) | 5.86 | 5.28 |
| peak host load1 | 7.1 | 16.3 |
| `MemAvailable` start / min / delta (MB) | 19422 / 18494 / 928 | 16316 / 14947 / 1369 |
| total cost (Kookr `costUsd`, sum) | $0.081 | $0.155 |
| server pid / port | 748034 / 39501 | 783091 / 42205 |

Reading it.

* **No failure and no throttling at 8 concurrent workers.** All 12 tasks reached `completion_ready` with a delivered commit; the model provider showed no 429/APIError markers in any session db or in the server log. The 8-worker run had one slow task (#2, 441 s vs 193 to 316 s for the others) with no gate block or error marker; it made 38 tool calls vs 23 to 34 for its siblings, so I attribute it to model/test variance on a loaded host, not to Kookr.
* **Memory scales linearly: about 1.0 GB PSS per worker** (peak of the per-sample sum over all workers: 4.4 GB at 4 workers, 8.1 GB at 8; this is a simultaneous peak, not the sum of each worker's own maximum). Summed RSS overstates (11 GB at 8) because shared pages of the opencode binary and node are counted per process; use PSS. Each TUI is ~0.9 to 1.5 GB RSS, in line with the docs' "about 1.2 GB per worker". For heavy repos add the tool children (lucy: +4.7 GB RSS per worker at parity), so size lucy-class concurrency at ~3.5 GB PSS per worker, not 1 GB.
* **CPU:** peak host CPU 68 to 69% of 16 cores, mean 14 to 17%: bursts come from vitest/`npm install` in the clones, not from the TUIs (which are idle while the model thinks). Worker CPU peaked at 5.3 to 5.9 cores.
* **`MemAvailable` delta (0.9 and 1.4 GB) is NOT a usable measure of the footprint** on this host: other agents and the page cache move it by gigabytes, and RSS/PSS sums are the real measure.
* **Time to first hook** was 8 to 11 s at every scale: launching more tasks did not slow TUI boot. Launch POSTs were issued sequentially and all succeeded.
* Scale tasks were checked for delivery only (commit, `Closes #273`, lint), not graded with `grade.sh` (parity already grades this case: PASS).

Artifacts: `docs/reports/opencode-scale-data/scale{4,8}-summary.json`, `scale{4,8}-host.csv` (2 s samples), `scale{4,8}-task<i>/{task.json,mem.csv,committed.patch,PR_BODY.md}`.

## Bugs / findings in `src/` and the gate (none blocking; nothing in `src/` was changed)

1. **Deliverable gate pushes workers to commit incidental lockfile churn** (`bin/kookr-opencode-gate.js`, message for "uncommitted changes to tracked files"). On `agent-notebook-273` the worker ran `npm install`, which touched `package-lock.json`; the gate said "Commit them (git add + git commit)", so the worker committed a 1-line `package-lock.json` change, making the diff 5 files vs 4 in the bake-off (`numstat.txt`: `0 1 package-lock.json`). The bake-off prompt explicitly forbids a blind `git add -A`. Proposed patch: extend the message to `Commit the files that belong to your change; restore unrelated ones (for example a lockfile touched by npm install) with git checkout -- <file> instead of committing them.` (one string in `checkDeliverable`, plus the matching assertion in the gate test). Not applied.
2. Harness-level (my script, fixed before the reported runs): grepping the opencode db for "rate limit"/"overloaded" gives false positives because the db stores the replay prompt and repo code verbatim (agent-notebook source contains "overloaded"); only structured markers are counted now. The first trial run of case 273 (killed grep stall, discarded) is not in any number above.
3. No other defects found: a 46 to 72 KB prompt goes through `POST /api/tasks` for the TUI fine; fresh `git clone` directories (not linked worktrees) are accepted as `cwd`; per-task `KOOKR_OPENCODE_ISSUE` and the gate base are applied per session; usage/cost is recorded at `/complete` on every run; no leftover processes or session dirs after teardown (checked: `/tmp/kookr-opencode-kookr-*` empty, no `oc-parity-*` dirs).

## Caveats

* n=1 per case for K (n=1 to 3 for B, n=1 for H). Differences of one verdict (lucy-3315) are within run-to-run noise: the bake-off itself shows `lucy-3265` delivered raw in 1 of 3 identical runs.
* The reference tests are interface-coupled: they are the fix PR's own tests, so a correct patch can fail them by naming an API differently (`agent-notebook-90`: ref expects the reserved-role error for `README`; all arms fail it). PASS means "matches the reference interface", not just "correct".
* The host is shared and was loaded by other agents' opencode/dtach/docker work; wall times and `MemAvailable` carry that noise. RSS/PSS attribution is by cwd+descendants of the clone, so processes that `chdir` out of the clone and are re-parented to init would be missed (not observed: per-worker trees of up to 42 processes were consistent with the test runners).
* K and B differ in environment (see "Notes on the tables"); the comparison is delivery-behaviour parity, not a controlled A/B.
* B "est $" and K `costUsd` use different price models; Hermes has no cost data.

## Re-run on the final code (seeded config + 512 MB RAM cap)

The runs above predate the boot-time seed (`KOOKR_OPENCODE_SEED_DIR`), the default 512 MB per-worker RAM cap (`KOOKR_OPENCODE_RAM_LIMIT_MB`) and the `KOOKR_OPENCODE_ENABLED` opt-in flag. The scale cases were repeated on the final code with the seed and the cap active (the harness now sets the flag and a temporary seed dir in its hermetic server env). The raw data directories are not part of this repository.

| metric | 4 workers | 8 workers |
|---|---|---|
| tasks delivered | 4/4 | 8/8 |
| wall seconds (min to max) | 180 to 260 | 184 to 300 |
| peak summed RSS (MB), uncapped run in brackets | 4950 (6681) | 9550 (11056) |
| peak summed PSS (MB), uncapped run in brackets | 3327 (4418) | 6384 (8108) |

* Per-task opencode TUI RSS is about 650 MB, down from 1.2 to 1.5 GB uncapped.
* Caveats: n=1 per scale; the host was shared and loaded by other work, so wall times and memory carry that noise.
