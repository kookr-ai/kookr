# Spike 3: shared layered memory with a single-writer service

Date 2026-11-09. 1 writer container + 4 worker containers (3 on project `projA`,
1 on `projB`) from the Spike 2 image on a user-defined docker network. Code:
`docs/rfc/evidence/prototype-opencode-worker/memory/` (`memory-writer.mjs`, `layered-pack.mjs`).
Reuses `nb` (agent-notebook 0.7.0) unchanged: same shelf files, same
`role@project` naming, same 200-char/50-entry rules and eviction.

## Design under test

- **One writer.** `memory-writer` is the only process with the store mounted
  read-write. Workers `POST /v1/lesson {lesson}` with a per-worker bearer
  token; the token fixes `{actor, project, role}`, so the target shelf is
  always `<role>@<project>` of that worker. All writes pass through one
  in-process queue and then `nb add` (nb's own mkdir lock is a second guard),
  and every request that reaches the queue (accepted or rejected by `nb`) is appended to an audit log (the prototype does not audit 401/400 pre-queue rejections; the RFC requires it).
- **Per-project read-only view.** After each write the writer republishes
  `views/<project>/` (that project's `*@project` shelves + the role-wide and
  `fleet-global` shelves) by per-file atomic rename. A worker mounts only its
  own view, read-only, so it cannot even read another project's shelf.
- **Layering at SessionStart.** `layered-pack <project> <role>` prints
  PROJECT (`role@project`, cap 4096 B) > DOMAIN (`role`, cap 2048 B) > GLOBAL
  (`fleet-global`, cap 1024 B), each in nb listing order (score-descending),
  with an "earlier layer wins" header and a marker naming omitted lessons.

## Results

| Test | Result |
| --- | --- |
| Worker a1 writes a lesson; a2 and a3 start a new session | both see it (a2=1, a3=1 hits) |
| Stale read | a pack composed before the write never changes (0 hits): a running worker keeps its start-of-session memory; lessons arrive at the next SessionStart. Intended (no mid-session prompt mutation). |
| Two concurrent writers, 15 parallel posts each (30) | all 30 present in the shelf, 30 new audit lines, 33 distinct audit `seq`, no overwrite; the view equals the store byte for byte |
| Reader during writes (60 `nb show` on a worker while 30 writes ran) | 0 malformed reads (shelf file is replaced atomically) |
| Project isolation | projB worker's pack has 0 projA lines; its mount has 0 projA files. A projA token that sends `project`/`shelf` in the body targeting projB is ignored: lesson lands in projA, projB shelf unchanged |
| Bad token | 401. Multi-line or empty lesson | 400. 250-char lesson | 422 with nb's message, audited as `rejected` |
| Worker tries to write the mounted store | refused (read-only; `nb add` fails with a lock error after its 12 s wait, so use a fast-fail check in the hook) |
| Precedence | layers printed project, domain, global with the header; with a deliberate conflict (global "use tabs" vs domain "2 spaces") both appear in order. The model, not code, resolves the conflict. |
| Caps | filling the project shelf to nb's 50-entry limit: nb evicts one entry per add (mostly `[+0]` ones, but once it evicted the seeded `[+1]` project lesson; cause not investigated, see risk 2); the pack kept the project layer at 4102 B (4096 cap + marker) with "12 more omitted" |

## Risks found

1. **Newest-lesson loss under the byte cap.** A head cut by score drops the most recent lessons (new lessons start
   at the lowest score and sort last). Kookr already solved this in `capShelfListing` (35 % of the cap reserved for the newest);
   the production composer must reuse it, not this spike's plain cut.
2. **nb eviction at the 50-entry cap** removed a `[+1]` lesson in one add while `[+0]` ones existed (not investigated). Existing nb
   behaviour, but a shared writable shelf makes a useful lesson's loss more likely; the RFC asks for an eviction note in the audit log.
3. **`nb show` writes a usage log** (`.nb-usage.log`) in the store dir; on a read-only mount it fails silently (exit 0). The usage
   ring is therefore not updated by workers; voting must go through the writer too (not built here).
4. **Conflict resolution is prompt-level only.** Precedence is an ordering plus an instruction; nothing enforces it.
5. A compromised worker can still write junk into its own project shelf (bounded by nb's 200-char/50-entry limits and the audit log).

## Not verified

- Voting/retro (`nb vote`, `nb rm`) through the writer: the spike only proves `add`. The `nb-retro` hook needs a writer verb per mutation.
- kb (knowledge base) sharing: kb needs an embedding provider and an index; not tested.
- Domain/global writes (curator path) and promotion workflow: designed in the RFC, not implemented.
- Writer crash/restart mid-publish (the view is per-file atomic, but project view consistency across several shelves is not).
