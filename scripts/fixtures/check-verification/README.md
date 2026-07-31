# check-verification fixtures

Recorded `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` responses, each
failing run enriched with its `check-runs/{id}/annotations` payload (the CLI
`scripts/check-verification.mjs` performs the same enrichment at runtime). They
back `scripts/check-verification.test.ts` so the classifier is exercised against
real GitHub JSON, including the actual 2026-07-30 billing-outage runs the feature
exists to catch.

| File | Source | Expected classification |
| --- | --- | --- |
| `lucy-1843-billing-failed.check-runs.json` | jeanibarz/lucy PR #1843 head `2a19034` — the real 2026-07-30 billing outage; every run "failed" in 3–10s with the "job was not started because recent account payments have failed" annotation | `never-executed` |
| `lucy-1844-billing-failed.check-runs.json` | jeanibarz/lucy PR #1844 head `b0b8e68` — same outage | `never-executed` |
| `kookr-genuine-executed-failure.check-runs.json` | kookr-ai/kookr `2f86ccd2` — the `macos` job genuinely ran 272s and failed with real `AssertionError` annotations, alongside passing `test`/`build`/`stt-tests` runs | `executed-red` |
| `lucy-green.check-runs.json` | jeanibarz/lucy `98d5a62` — the three `Dependabot` checks that genuinely ran and passed | `executed-green` |

Long annotation `message` strings in `kookr-genuine-executed-failure` are
truncated to 400 chars to keep the fixture small; every other field is verbatim
from `gh`.
