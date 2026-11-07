# Value test: can Hermes triage issues and audit tests well enough to justify delegation?

**Date:** 2026-11-07 · **Parent:** `rfc-kookr-hermes-delegation.md` · **Outcome:** PROCEED (both groups pass)

The parent RFC gates slice 1 on this test. The pass/fail criteria were written **before** any output existed.

## Method
- **Inputs:** 10 open GitHub issues (4 from a private product repo, 3 from a private data-pipeline repo, 3 from this repo as a public control) and one test-quality audit of the data-pipeline repo ("repo-D"; the product repo is "repo-P").
- **Same task, same inputs, both sides.** Identical prompt files (a fixed JSON schema for triage; a fixed schema for the audit) and identical read-only, tracked-files-only checkouts. Hermes ran on a scratch worker (DeepSeek V4 Flash, read-only mount, `message/send`, 900 s reply timeout; the read-only mount and reply timeout were set with a patched scratch copy of the launcher, i.e. the equivalent of prerequisites P3 and P7). The Claude side ran independently as a Sonnet subagent that never saw Hermes output.
- **Blind judge:** an Opus-class agent saw each pair as "A"/"B" (assignment randomised with a recorded seed; mapping withheld), verified every claim against the issue text and the repository, and scored usefulness (1-5), hallucination, and for the audit the truth of every finding.
- **Pre-registered criteria:** (1) Hermes schema-valid rate >= 90%; (2) mean usefulness >= 3.5 and Hermes not more than 0.7 below Claude; (3) hallucination rate <= 20%; (4) audit precision >= 60% with >= 3 verified-true findings. Triage group = 1-3, audit group = 4.

## Results
| Item | Hermes | Claude | Better |
|---|---|---|---|
| repo-D #188 | 5 | 4 | Hermes |
| repo-D #191 | 4 | 4 | Hermes (one stale claim: PR described as draft) |
| repo-D #211 | 5 | 4 | Hermes |
| kookr #3482 | 5 | 4 | Hermes |
| kookr #3499 | 3 | 5 | Claude (Hermes sized finished work as XL) |
| kookr #3504 | 5 | 4 | Hermes |
| repo-P #3892 | 4 | 4 | Hermes (narrowly) |
| repo-P #3928 | 5 | 3 | Hermes |
| repo-P #3954 | 5 | 3 | Hermes |
| repo-P #3959 | 5 | 4 | Hermes |

- **Triage:** Hermes mean usefulness 4.60 vs Claude 3.90; Hermes preferred on 9 of 10. Schema-valid JSON 10/10 (no repair needed) and 69/69 cited paths exist. One hallucination flag for Hermes (10%), none for Claude.
- **Audit:** Hermes 8 verified-true, 1 partial, 0 false of 9 (precision 0.89). Claude 4 verified-true, 3 partial, 1 false of 8 (precision 0.50). The judge rated Hermes's findings more valuable (for example, 11 contract tests that silently return early in CI; an untested address-validation branch).
- **Criteria:** 1-3 PASS, 4 PASS. **Decision: build slice 1.**

## Operational findings (not gating, but they shape the build)
- **Concurrency:** 10 jobs in three batches took 891 s wall-clock vs 1413 s summed (1.6x); the clean batch of 4 reached 2.7x. Two batches were held up by approval stalls.
- **Approval stall:** `hx.sh` seeded `approvals.mode: auto`, which is not a valid value in this Hermes build, so it behaved as `manual`: any dangerous-looking command waited 300 s for a human. It caused 4 stalls of 300 s each across the run (two of them inside the audit, 600 s of its 1072 s). Fixed in jeanibarz/hermes-fleet#22 (valid modes; `smart` for read-only workers, verified with no stall).
- **Audit timed out at 900 s** (under the RFC's own design that run would have ended `worker_failed`; criterion 4 concerns precision, which was measured on the recovered answer) for that reason; the agent kept running and its answer was recovered from the worker's session store. A long-job design must not rely on the held request (parent RFC section 10).
- **Cost:** about USD 0.18 for all 12 Hermes sessions (a smoke test, 10 triage jobs and the audit). No text rewriting by outbound redaction was observed.

## Caveats
- **n = 10 issues and one audit**, taken in order from the open list, not randomly. Small sample.
- **The baseline was Sonnet**, not the strongest Claude model; the judge was Claude. The judge was blind and Claude lost, so self-preference is unlikely to explain the result, but a stronger Claude baseline could narrow the gap.
- **Repo state differed from issue text** in several cases (work already merged). Both sides saw the same checkout; Claude was more likely to notice that on kookr #3499 and Hermes on two others.
- The Hermes worker kept state between jobs (it saved skills in its own volume); no effect on outputs was observed.
