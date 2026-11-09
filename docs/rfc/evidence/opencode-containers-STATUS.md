# opencode worker containers: status (durable)

Worktree `../kookr-oc-containers`. Updated 2026-11-09. Phase A (no Kubernetes). Hard rules: never touch
`kookr-prod`, production Kookr (port 4800, `~/.kookr`) or the other worker's branches; live tests are hermetic.

| Deliverable | State |
| --- | --- |
| Spike 1 (hooks under `serve`) | done, hooks all fire: evidence/...spike1 |
| Spike 2 (container + opencode-a2a) | done (mock provider): evidence/...spike2 |
| Spike 3 (shared layered memory) | done, add path only; vote/remove proven in S3 |
| RFC `rfc-opencode-worker-containers.md` | v4, MERGED (#3541) after 2 critic rounds, consensus attack, independent review |
| S1 worker image | MERGED (#3546); 8/8 live checks; non-blocking notes in #3551 |
| S2a launch-mode seam | in PR (this change): session policy, gate base, launch-mode resolver extracted; TUI unchanged |
| S2b reconciler / ports / `kookr containers` | not started |
| S2c hook spool ingest | not started |
| S2d container launch (`KOOKR_OPENCODE_CONTAINERS`) | not started |
| S3 productised memory writer | not started |
| S4 real-model capacity run (4 then 8) | not started |

Known gaps: real-model RSS not yet measured; A2A cancel-with-stream flipped to FAILED once (unreproduced);
egress filtering not designed. Flaky unrelated tests: #3544.
Images kept for reuse: `opencode-worker:s1`, `opencode-worker-kookr:s1`.
