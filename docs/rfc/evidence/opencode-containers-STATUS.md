# opencode worker containers: status (durable)

Worktree `../kookr-oc-s2d` (S2d). Updated 2026-11-10. Phase A (no Kubernetes). Hard rules: never touch
`kookr-prod`, production Kookr (port 4800, `~/.kookr`) or the other worker's branches; live tests are hermetic.

| Deliverable | State |
| --- | --- |
| Spike 1 (hooks under `serve`) | done, hooks all fire: evidence/...spike1 |
| Spike 2 (container + opencode-a2a) | done (mock provider): evidence/...spike2 |
| Spike 3 (shared layered memory) | done, add path only; vote/remove proven in S3 |
| RFC `rfc-opencode-worker-containers.md` | v4, MERGED (#3541) after 2 critic rounds, consensus attack, independent review |
| S1 worker image | MERGED (#3546); 8/8 live checks; non-blocking notes in #3551 |
| S2a launch-mode seam | MERGED (#3553) |
| S2b reconciler / ports / `kookr containers` | MERGED (#3556); non-blocking notes #3557; not wired to the server (S2d) |
| S2c hook spool ingest | MERGED (#3570): `HookFileWatcher` file override + untrusted (lstat/O_NOFOLLOW) mode, `ContainerLedgerIngest`, key = taskId+token; follow-ups #3571 (items 1-2 fixed in S2d) |
| S2d container launch (`KOOKR_OPENCODE_CONTAINERS`) | in PR: routing + container adapter, clone/extract, hook path map, cap 1, reconciler wired; live script `scripts/opencode-containers-live.ts` 11/11 control-plane records (mock provider) + 3 real-model smokes. **Decision: A2A wrapper = command channel only (tasks never reach a terminal state with `returnImmediately`); plain opencode REST before S3** (see RFC "S2d result") |
| S3 productised memory writer | not started |
| S4 real-model capacity run (4 then 8) | not started |

Known gaps: first real-model RSS is 410-460 MiB (one worker; S4 measures 4 and 8); A2A F5 flip did not reproduce in 10 cancels + 3 real-model runs, but the wrapper never completes a task (decision above);
watchdog/probe/read-model not wired to the server; egress filtering not designed. Flaky unrelated tests: #3544.
Images kept for reuse: `opencode-worker:s1`, `opencode-worker-kookr:s1`.
