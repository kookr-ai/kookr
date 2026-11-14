# Preference memory

Use when: an agent serves one person (an operator or user) over weeks or months and must learn their
preferences, keep up as they change, resolve contradictions, or decide when to ask instead of guessing.

A preference store is continual learning on a model of one person: each update must keep what is still
true. Superseding facts in general: [memory policy](agent-memory-policy.md) rule 5; regression gating:
[continual learning](agent-continual-learning.md). Most rules below rest on one benchmark each; rules that
rest on one self-built benchmark say so.

## Rules

1. **Expect the old preference to win unless the write says it changed.** The best of 25 models scored
   52.8% on long-horizon personalization; all 25 picked the pre-change preference on more than 35% of
   wrong answers, 58.8% when the change was only implied, even in 0-14 day histories (2604.17283, simulated
   users). Record each preference with its source (said or inferred), date, scope and status (active or
   superseded).
2. **Treat a contradiction as a possible scope split: keep both, with their conditions.** On 541
   irreducible personal-memory conflicts every model stayed under 15/20 even with oracle memory, and fixed
   rules (recency, majority, source priority) failed; extractors lost the conflict before reasoning (Letta
   kept it intact in 91.7% of cases, MemOS in 46.2%) (2608.13921). Supersede only when the new preference
   replaces the old one in the same scope; never append both and let retrieval pick, and never collapse two
   context-specific preferences into one "latest" value.
3. **Chase a superseded preference into what was built from it** (summaries, cached outputs, skills): they
   kept steering actions after their source was corrected, 92.4-99.7% stale use without repair
   (2605.07242; cascade repair: [lesson capture](post-task-lesson-capture.md) rule 15).
4. **Stated beats inferred.** Learning from choices beat a profile memory (about 84% vs 53%, 50 synthetic
   users), but agents relying on statistics alone scored about 10-15% on explicit requests (2606.05828).
   People re-labeled their own earlier choices at only about 0.67 F1 (2604.23815), so inferred preferences
   have a hard ceiling. Use inference to fill gaps; let any explicit statement override it.
5. **Ask when active preferences conflict in the current scope, or the request is ambiguous and the action
   is hard to undo; otherwise act and say which preference was applied.** Asking first raised
   ambiguous-request success from 52.9% to 97.5% and asked needlessly on 5.6% of clear requests
   (2606.16813, one 120-task benchmark by its authors). Clarification-seeking was every model's weakest
   skill on the conflict benchmark (2608.13921).
6. **Store corrections as scoped rules, not retrieved text, and do not turn one correction into a global
   rule.** Scoped rule directives reached 95% compliance against 55% for naive retrieval, injecting 159
   against 1,705 tokens; attaching reasoning to rules hurt compliance (2611.08644, one self-built
   71-scenario benchmark), which disagrees with the trigger-action-reason lesson form in [lesson
   capture](post-task-lesson-capture.md) rule 3.
7. **Keep safety checks independent of the preference store.** Benign personal memory raised
   harmful-request attack success by 15.8% to 243.7% across five memory frameworks and five LLMs, only when
   the memory's theme matched the request; a detection-and-reflection step cut it by about 27.4%
   (2601.17887).

## Gaps

- No measurement of memory-induced sycophancy over time, or of learning from a person's edits or
  accept/reject decisions.
- No measured question burden when asking; no short static profile versus managed memory comparison.
