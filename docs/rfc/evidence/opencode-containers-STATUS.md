# opencode worker containers: status (durable)

Worktree `../kookr-oc-containers`, branch `feat-opencode-containers` (off origin/main 5578365d). Updated 2026-11-09.

| Deliverable | State |
| --- | --- |
| Spike 1 (hooks under `serve`) | done, hooks all fire: evidence/...spike1 |
| Spike 2 (container + opencode-a2a) | done, table in evidence/...spike2 (cancel kills tools, restart persists, ~0.4 GB each, 4 and 8 concurrent OK) |
| Spike 3 (shared layered memory) | done, evidence/...spike3 (add path only; vote/rm not built) |
| RFC `rfc-opencode-worker-containers.md` | draft v1 committed; review round 1 running (boundary, failure-mode, operability, design-minimalist) |
| Slices 1-4 | NOT started: blocked on RFC acceptance by independent review |

Cleanup state: all spike containers, volumes, the `oc-spike3` network and mock/serve processes were removed
(explicit names). Image `opencode-worker:spike` (1.36 GB) is kept for reuse; remove with `docker rmi opencode-worker:spike`.
Not touched: production Kookr (port 4800, ~/.kookr), /home/jean/git/kookr-prod, the other worker's branches.
