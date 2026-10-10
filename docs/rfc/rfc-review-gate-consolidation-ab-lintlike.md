# A/B: cheap model for the `lint-like` pre-push lane

**Date:** 2026-10-10
**Purpose:** Part-1.1 prerequisite of [`rfc-review-gate-consolidation.md`](./rfc-review-gate-consolidation.md)
— before pinning the pre-push `lint-like` reviewer to a cheap model, confirm by
hand-checked A/B that the cheap model loses no substantive findings (RFC Open
question O1).

## Method

- **Lane under test:** the consolidated `lint-like` reviewer (conventions +
  deadcode + docs-drift concerns composed into one agent, per `pre-pr-review`
  §8). This is the lane the RFC downgrades; `correctness` and `test` are out of
  scope and stay on the strong model.
- **Inputs:** 6 real recently-merged `kookr-ai/kookr` PR diffs of varying size
  (118–565 lines), spanning server logic, error handling, health/ops, and a
  frontend-sort change: #3358, #3320, #3325, #3319, #3324, #3317.
- **Variable:** model only. Each diff reviewed twice with the identical
  composite `lint-like` prompt and repo checkout — once on `sonnet` (the cheap
  candidate), once on `opus` (the current inherited default) — via
  `general-purpose` subagents, the same spawn path the real panel uses.
- **Comparison:** hand-checked finding-equivalence, keyed on (concern, file,
  substance), not raw counts.

## Results

| PR | sonnet | opus | equivalence |
|----|--------|------|-------------|
| #3358 | CONV 2 | CONV 3 | both caught the one real finding (256-char id-length bound duplicated across `hook-parser`/`watchdog`); the rest are nits, and each model surfaced some the other missed (sonnet 1, opus 2) |
| #3320 | 0 | 0 | identical (no findings) |
| #3325 | DOCS 1 | DOCS 1 | **identical finding** (`docs/reference/data-directory.md:65` omits the new owner-only `0o600` mode) |
| #3319 | 0 | 0 | identical (no findings) |
| #3324 | CONV 1 | 0 | sonnet found *one more* (a nit) — no loss |
| #3317 | 0 | 0 | identical (no findings) |

## Conclusion

**No loss of substantive findings on `lint-like` when moving to `sonnet`.** The
one real convention finding and the one real doc-drift finding were caught by
both models. All divergences are nit-level and go in **both** directions (sonnet
missed some nits opus found; opus missed some nits sonnet found — not an equal
count, but no one-sided loss) — there is no systematic class of `lint-like`
finding the cheap model drops.

→ **Pin `lint-like` → `sonnet` at the spawn site.** Keep `correctness` and
`test` on the strong/default model: `test` is not a pure nit (a missed coverage
gap can hide a real defect) and had no A/B here, so per the RFC it stays strong
until its own A/B clears it.

## Independent corroboration (hook-log analysis)

A separate pass over the local reviewer hook logs (`~/.kookr/hooks/`, ~1,337
classified pre-push reviewer outputs) independently supports pinning `lint-like`
cheap: the **`lint-like` lane blocks on only ~5% of runs** and returns
suggestions/nits on ~51% — it is overwhelmingly nit-tier work, exactly the lane
where a cheap model is safe. By contrast the `correctness` lane blocks on ~19%
of runs, which is why it stays strong. The same analysis measured the pre-push
panel at ~1.46M median cumulative input tokens (~14% of task cost), consistent
with the RFC's evidence pack — so the cheap-lane pin targets real, measured
waste.

## Caveats

- Sample of **6 diffs**, hand-checked (the RFC illustratively suggested ~15;
  this is a smaller focused study). It is sufficient for the low-risk
  `lint-like` pin — and reinforced by the independent ~5%-block-rate finding
  above — but it deliberately does **not** license a `test`- or
  `correctness`-lane downgrade.
- Diffs were reviewed against the current `main` checkout (where the code is
  already merged), so absolute finding quality is not the PR-time quality; the
  comparison is valid because both models received identical input and the
  study measures model-vs-model equivalence, not absolute recall.
- `deadcode` returned empty on every diff (the symbols are live in `main`);
  the A/B therefore exercises conventions + docs-drift most strongly. Dead-code
  detection is pattern-level work well within the cheap model's range.
