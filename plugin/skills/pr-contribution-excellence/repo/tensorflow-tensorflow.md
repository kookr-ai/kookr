# tensorflow/tensorflow Contribution Patterns

Last updated: 2026-04-08 | Distillation #1 | Based on 10 PRs analyzed

---

## Repository Conventions

### Merge process (Copybara)
- TensorFlow uses Google's internal monorepo. External PRs are imported via **copybara-service[bot]**, not merged directly on GitHub. The GitHub PR is a mirror; the real merge happens inside Google.
- Copybara **squash-merges** on import, so commit discipline on the GitHub branch is cosmetic — messy merge commits are fine. (Evidence: #112668 had 5 messy commits, #105000 had 3 merge-from-master commits, both merged without issue.)
- The `ready to pull` label signals a PR is cleared for copybara import. Only maintainers apply it.

### CLA is the first hard gate
- Google CLA (`google-cla[bot]`) fires within seconds of PR creation. Unsigned CLA blocks all review. (Evidence: #112909, #108327, #88124 all had CLA friction.)
- **Sign the CLA before opening your first PR.** The CLA failure deprioritizes your PR in triage.
- Corporate org forks (Intel-tensorflow, linux-on-ibm-z) have pre-signed corporate CLAs — no individual friction. (Evidence: #105000, #88124.)
- Common workaround: push an empty "Trigger CLA check" commit after signing. (Evidence: #112909.)

### CI (Kokoro) is a black box
- **Kokoro** is Google-internal CI. External contributors cannot trigger or debug it. Only maintainers apply `kokoro:force-run`.
- Post-approval merge delays of 2–7 weeks are common due to internal CI issues the contributor cannot see. (Evidence: #105000 had 7-week post-approval delay; #100869 had 15-day delay.)
- Strategy: polite periodic pings to the assigned maintainer asking what's blocking. (Evidence: #105000 author pinged 3 times.)

### Code style
- **C++:** Google C++ Style Guide. Use `clang-format --style=google`.
- **Python:** Google Python Style Guide. Use `pylint --rcfile=tensorflow/tools/ci_build/pylintrc`.
- **Test convention:** Use `@parameterized.parameters` for parameterized tests, not manual loops. (Evidence: #100869 reviewer explicitly requested this.)
- **Commit prefix:** Use component tags like `[TFLite]`, `[XLA:GPU]`, `[oneDNN]` in commit messages and PR titles. (Evidence: #62851, #105000.)
- **Copyright headers:** Required on all new files (Apache 2.0). Use the **current year** — wrong years (especially old ones like 2020) signal LLM-generated code and trigger reviewer suspicion. (Evidence: #108327 had 2020 copyright caught immediately.)

### Build system
- **Bazel** is the primary build system. Heavy — full builds take hours.
- Use TF SIG Build Docker images rather than installing locally.
- **License sections** required in BUILD files.

## Reviewer Expectations

### Key reviewers (as of 2026-04)
| Reviewer | Areas | Style |
|----------|-------|-------|
| mihaimaruseac | Core, security, Python | Thorough — requests tests, flags style issues, direct tone ("Please don't waste reviewer time") |
| cantonios | XLA, oneDNN, build system | Constructive design suggestions — prefers generalized solutions over point fixes |
| grantjensen | TFLite | Silent approver — rarely leaves comments |
| gbaned | Triage/assignment | Assigns reviewers, manages labels |
| keerthanakadiri | Triage, CLA reminders | Polite follow-ups, handles stale PR closure |

### What reviewers expect
1. **Tests are non-negotiable** for behavioral changes. Every merged PR that needed tests had them requested within the first review round. Deliver within 1-2 days. (Evidence: #105000, #100869.)
2. **Adopt reviewer design suggestions.** When a reviewer proposes a better approach (e.g., generalize a utility instead of point-fixing), adopt it. It leads to approval. (Evidence: #105000 improved from point fix to reusable utility; #100869 adopted `@parameterized`.)
3. **Understand every change you submit.** "I copied it from XLA" without understanding why undermines reviewer confidence. (Evidence: #102891.)
4. **Backward compatibility is mandatory** for utility functions. Use default parameters to preserve existing call sites. (Evidence: #105000 added `delimiters=","` default.)

### Follow-up etiquette
- **Do:** Ping specific reviewers with context ("@cantonios — any update on the internal CI blocker?").
- **Don't:** Post generic "following up" comments — maintainers call these spam. (Evidence: #88124 maintainer replied "Please stop spamming".)

## Process & Workflow

### Contribution timeline expectations
| PR Type | Typical Merge Time |
|---------|-------------------|
| Build fix (targeted, XS-S) | Same day to 2 weeks |
| Correctness fix (XS-S, domain expert) | 5 days to 3 weeks |
| Typo/docs fix (XS) | 10-14 days (queue depth) |
| Niche platform fix (XS) | 3-12 months |
| Large migration/feature (XL) | Likely never merges as single PR |

### The dual-review reality
- GitHub review is lightweight (often silent approvals with empty bodies). The real substantive review happens internally at Google after copybara import. (Evidence: #62851, #88124 had zero inline comments but passed internal review.)
- Don't judge a PR's review quality by its GitHub comments alone.

### New features → addons first
- Don't try to add new algorithms directly to core TF. They should go to `tensorflow/addons` for incubation first.

## Common Rejection Reasons

1. **Overambitious scope for first contribution.** XL PRs from unknown contributors get no reviewer investment. Start with XS/S. (Evidence: #108327 — 1500+ line first PR, stale-closed after 71 days.)
2. **Fork master contamination.** Pushing from fork's `master` bundles months of unrelated commits. Always use topic branches. (Evidence: #115135 — 5-line fix buried in 567-line diff.)
3. **Naive mechanical changes without verification.** Find-and-replace without reading each change site. 13% error rate in #111046 included syntax errors and corrupted docstrings.
4. **No issue linkage for large changes.** Unsolicited features/refactors without a tracked issue or RFC get no mandate from reviewers. (Evidence: #108327, #111046.)
5. **CLA never signed.** Blocks merge regardless of code quality. (Evidence: #108327, #111046.)
6. **LLM-generation red flags.** Wrong copyright years, repo-root junk files (summaries, standalone test scripts), formulaic descriptions, inability to squash commits. (Evidence: #108327, #115135, #111046.)

## Success Patterns

1. **Small, focused PRs with clear problem statements** get merged. 4 files or fewer, one concern, concrete bug description. (Evidence: all 6 merged PRs were size XS-M.)
2. **Link the motivating issue** when one exists. (Evidence: #100869 linked #97096; was merged in 17 days.)
3. **Second attempts work** when you incorporate all prior feedback. Close the messy PR, open a clean one. (Evidence: #100869 was a successful second attempt after #99904; #115135 self-corrected to #115190.)
4. **Corporate org forks** eliminate CLA friction and signal organizational backing. (Evidence: Intel-tensorflow, linux-on-ibm-z.)
5. **Respond to reviewer feedback within 24-48 hours.** Fast iteration correlates with fast approval. (Evidence: #100869 approved in 48 hours with next-day turnaround.)
6. **Be transparent about limitations.** Acknowledging known tech debt or gaps earns more trust than hiding them. (Evidence: #112668 author admitted hardcoded version was "not great".)
